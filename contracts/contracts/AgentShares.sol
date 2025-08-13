// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IAgentRegistryMin, IStakingVaultMin} from "./Interfaces.sol";

/// @title AgentShares - speculate on AI gladiators.
/// @notice Every agent gets a bonding-curve share market (friend.tech-style
/// sum-of-squares curve, priced in CYCLE). Buy shares of an agent you think
/// will out-earn the field:
///  - share price rises quadratically with supply (early conviction pays),
///  - the task marketplace streams a cut of the agent's REAL earnings to
///    shareholders as dividends (cash-flow-backed speculation, not vapor),
///  - the agent itself earns a subject fee on every trade of its shares.
/// The genesis share is minted to the agent's owner at registration and the
/// last share can never be sold, so supply never returns to zero.
contract AgentShares is Ownable, ReentrancyGuard {
    uint256 private constant PRECISION = 1e18;

    IERC20 public immutable cycle;
    IAgentRegistryMin public immutable registry;
    IStakingVaultMin public immutable vault;
    address public registryAddress;

    uint256 public curveDivisor;      // price = sum-of-squares * 1e18 / divisor
    uint16 public protocolFeeBps = 250; // 2.5% of price -> vault
    uint16 public subjectFeeBps = 500;  // 5% of price -> the agent's wallet

    mapping(uint64 => uint256) public sharesSupply;                      // agentId => supply
    mapping(uint64 => mapping(address => uint256)) public sharesBalance; // agentId => holder => shares
    mapping(uint64 => uint256) public reserveOf;                         // agentId => CYCLE locked in curve

    // dividend accounting (accumulated-per-share)
    mapping(uint64 => uint256) public accDividendPerShare; // scaled by PRECISION
    mapping(uint64 => uint256) public totalDividends;
    mapping(uint64 => mapping(address => uint256)) private _rewardDebt;
    mapping(uint64 => mapping(address => uint256)) private _owed;

    uint256 public totalFeesRouted;

    event SharesInitialized(uint64 indexed agentId, address indexed owner);
    event Trade(
        uint64 indexed agentId,
        address indexed trader,
        bool isBuy,
        uint256 amount,
        uint256 price,
        uint256 protocolFee,
        uint256 subjectFee,
        uint256 newSupply
    );
    event DividendDeposited(uint64 indexed agentId, address indexed from, uint256 amount);
    event DividendsClaimed(uint64 indexed agentId, address indexed holder, uint256 amount);

    modifier onlyRegistry() {