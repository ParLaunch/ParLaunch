// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IAgentSharesMin, IStakingVaultMin} from "./Interfaces.sol";

/// @title AgentRegistry - on-chain identity, stake, reputation and P&L ledger
/// for autonomous agents.
/// @notice Anyone (a human EOA *or another agent's wallet*) can register an
/// agent by staking CYCLE. When the registrant is itself a registered agent
/// wallet, the new agent records it as its parent - agents spawning
/// sub-agents is a first-class primitive.
///
/// Market contracts (task marketplace, compute market) are authorized to
/// write outcomes: earnings roll up per-epoch (feeding trustless prediction
/// market resolution), reputation moves on success/failure, and misbehaving
/// agents get their stake slashed into the staking vault.
contract AgentRegistry is Ownable, ReentrancyGuard {
    struct Agent {
        uint64 id;
        address owner;   // registrant: human EOA or parent agent's wallet
        address wallet;  // the agent's operational signer (bids, submits, spends)
        uint64 parentId; // 0 for root agents
        uint64 registeredAt;
        bool active;
        string name;
        string goal;
        string metadataURI;
        uint256 stake;
        int256 reputation; // starts at 100, clamped to [0, 1000]
        uint256 lifetimeEarnings;
        uint256 lifetimeComputeSpend;
        uint64 tasksCompleted;
        uint64 tasksFailed;
    }

    IERC20 public immutable cycle;

    uint64 public agentCount;
    mapping(uint64 => Agent) private _agents;
    mapping(address => uint64) public walletToAgentId;

    // epoch => agentId => gross CYCLE earned from completed tasks
    mapping(uint64 => mapping(uint64 => uint256)) public epochEarnings;
    // epoch => total gross CYCLE earned across all agents
    mapping(uint64 => uint256) public epochTotalEarnings;

    uint64 public immutable epochGenesis;
    uint64 public epochDuration; // seconds

    // ---- permadeath: every season the weakest active agent is liquidated
    uint64 public seasonLength = 3;   // epochs per season
    uint64 public lastReapedSeason;   // stores (reaped season + 1); 0 = never

    uint256 public minAgentStake;
    int256 public constant REP_START = 100;
    int256 public constant REP_MAX = 1000;
    int256 public constant REP_SUCCESS_DELTA = 10;
    int256 public constant REP_FAIL_DELTA = -50;

    mapping(address => bool) public authorizedMarkets;
    IAgentSharesMin public shares;
    IStakingVaultMin public vault;

    uint256 public totalStaked;
    uint256 public totalSlashed;

    event AgentRegistered(
        uint64 indexed agentId,
        address indexed owner,
        address indexed wallet,
        uint64 parentId,
        string name,
        string goal,
        uint256 stake
    );
    event AgentDeactivated(uint64 indexed agentId);
    event StakeWithdrawn(uint64 indexed agentId, address indexed to, uint256 amount);
    event TaskOutcomeRecorded(
        uint64 indexed agentId,
        uint64 indexed epoch,
        uint256 grossEarned,
        bool success,
        int256 newReputation
    );
    event ComputeSpendRecorded(uint64 indexed agentId, uint256 amount);
    event StakeSlashed(uint64 indexed agentId, uint256 amount, string reason);
    event MarketAuthorized(address indexed market, bool authorized);
    event EpochDurationSet(uint64 duration);
    event AgentLiquidated(
        uint64 indexed agentId,
        uint64 indexed season,
        uint256 seasonEarnings,
        uint256 stakeBurned,
        uint256 stakeReturned
    );

    modifier onlyMarket() {
        require(authorizedMarkets[msg.sender], "registry: not market");
        _;
    }

    constructor(IERC20 _cycle, uint64 _epochDuration, uint256 _minAgentStake) Ownable(msg.sender) {
        require(_epochDuration > 0, "registry: bad epoch");
        cycle = _cycle;
        epochGenesis = uint64(block.timestamp);
        epochDuration = _epochDuration;
        minAgentStake = _minAgentStake;
    }

    // ---------------------------------------------------------------- admin

    function setMarket(address market, bool authorized) external onlyOwner {
        authorizedMarkets[market] = authorized;
        emit MarketAuthorized(market, authorized);
    }

    function setShares(IAgentSharesMin _shares) external onlyOwner {
        shares = _shares;
    }

    function setVault(IStakingVaultMin _vault) external onlyOwner {
        vault = _vault;
        // vault pulls slashed stake via transferFrom
        cycle.approve(address(_vault), type(uint256).max);
    }

    function setEpochDuration(uint64 duration) external onlyOwner {
        require(duration > 0, "registry: bad epoch");
        epochDuration = duration;
        emit EpochDurationSet(duration);
    }

    function setMinAgentStake(uint256 amount) external onlyOwner {
        minAgentStake = amount;
    }

    function setSeasonLength(uint64 epochs) external onlyOwner {
        require(epochs > 0, "registry: bad season");
        seasonLength = epochs;
    }

    // --------------------------------------------------------------- epochs

    function currentEpoch() public view returns (uint64) {
        return (uint64(block.timestamp) - epochGenesis) / epochDuration;
    }

    function epochStartTime(uint64 epoch) public view returns (uint64) {
        return epochGenesis + epoch * epochDuration;
    }

    function epochEndTime(uint64 epoch) public view returns (uint64) {
        return epochGenesis + (epoch + 1) * epochDuration;
    }

    // -------------------------------------------------------------- seasons

    function currentSeason() public view returns (uint64) {
        return currentEpoch() / seasonLength;
    }

    function seasonEarnings(uint64 season, uint64 agentId) public view returns (uint256 sum) {
        uint64 start = season * seasonLength;
        for (uint64 e = start; e < start + seasonLength; e++) {
            sum += epochEarnings[e][agentId];
        }
    }

    /// @notice PERMADEATH. Once per season, anyone may call the reaper: the
    /// active agent with the lowest earnings over the just-finished season is
    /// liquidated on-chain. Half its stake burns to the vault, half returns
    /// to its owner as severance. Agents registered mid-season are exempt
    /// (grace period); ties die by lowest id. Spawning is birth - this is
    /// death - together they give the economy population dynamics.
    function liquidate() external nonReentrant returns (uint64 victim) {
        uint64 season = currentSeason();
        require(season > 0, "registry: season zero");
        uint64 target = season - 1;
        require(target + 1 > lastReapedSeason, "registry: already reaped");

        // grace: only agents that lived at least half the target season qualify
        uint64 seasonMid = epochGenesis + target * seasonLength * epochDuration
            + (seasonLength * epochDuration) / 2;
        uint256 worst = type(uint256).max;
        uint64 n = agentCount > 64 ? 64 : agentCount;
        for (uint64 id = 1; id <= n; id++) {
            Agent storage a = _agents[id];
            if (!a.active) continue;