import { ethers, artifacts, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import "dotenv/config";

const E = (n: string | number) => ethers.parseEther(String(n));

// ---- demo economy parameters -----------------------------------------------
const EPOCH_DURATION = 300; // 5-minute epochs so prediction markets resolve live
const MIN_AGENT_STAKE = E(100);
const MIN_PROVIDER_STAKE = E(500);
const CURVE_DIVISOR = 40;
const REVIEW_WINDOW = 45; // seconds before silent posters auto-approve

// actor roles by account index (hardhat accounts locally; SWARM_MNEMONIC on
// public networks - NEVER the well-known hardhat keys in public)
// 0 deployer/treasury | 1 task faucet (the "user" side) | 2-3 compute providers
// 4-9 agent wallets   | 10-13 speculators + market maker | 15 local web wallet
const MINTS: Array<[number, bigint]> = [
  [1, E(2_000_000)],
  [2, E(100_000)], [3, E(100_000)],
  [4, E(5_000)], [5, E(5_000)], [6, E(5_000)], [7, E(5_000)], [8, E(5_000)], [9, E(5_000)],
  [10, E(50_000)], [11, E(50_000)], [12, E(50_000)],
  [15, E(100_000)],
];
const FAUCET_SUPPLY = E(10_000_000); // visitor play-chips (5,000 per claim)
const GAS_PER_ACTOR = ethers.parseEther("0.002"); // public nets: swarm gas

const CONTRACT_NAMES = [
  "CycleToken", "AgentRegistry", "StakingVault", "AgentShares",
  "TaskMarketplace", "ComputeMarket", "PredictionMarket", "CycleFaucet",
] as const;

const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";

async function main() {
  const isLocal = network.name === "hardhat" || network.name === "localhost";
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("no deployer - set DEPLOYER_KEY in contracts/.env for public networks");
  console.log(`Deploying AGORA to ${network.name} from ${deployer.address}`);
  if (!isLocal) {
    const bal = await ethers.provider.getBalance(deployer.address);
    console.log(`  deployer gas balance: ${ethers.formatEther(bal)} ETH`);
    if (bal < ethers.parseEther("0.05")) {
      console.warn("  WARNING: low gas. Grab Base Sepolia ETH from a faucet before deploying.");
    }
  }

  // actor addresses: local = hardhat signers; public = derived from SWARM_MNEMONIC
  const mnemonic = isLocal ? HARDHAT_MNEMONIC : process.env.SWARM_MNEMONIC;
  if (!isLocal && !mnemonic) {
    throw new Error("set SWARM_MNEMONIC in contracts/.env (any fresh 12-word phrase) for public deploys");
  }
  const actorAddress = (i: number) =>
    ethers.HDNodeWallet.fromPhrase(mnemonic!, undefined, `m/44'/60'/0'/0/${i}`).address;

  const cycle = await (await ethers.getContractFactory("CycleToken")).deploy();
  await cycle.waitForDeployment();
  const registry = await (await ethers.getContractFactory("AgentRegistry")).deploy(
    cycle, EPOCH_DURATION, MIN_AGENT_STAKE
  );
  await registry.waitForDeployment();
  const vault = await (await ethers.getContractFactory("StakingVault")).deploy(cycle);
  await vault.waitForDeployment();
  const shares = await (await ethers.getContractFactory("AgentShares")).deploy(
    cycle, registry, vault, CURVE_DIVISOR
  );
  await shares.waitForDeployment();
  const tasks = await (await ethers.getContractFactory("TaskMarketplace")).deploy(
    cycle, registry, shares, vault
  );
  await tasks.waitForDeployment();
  const compute = await (await ethers.getContractFactory("ComputeMarket")).deploy(
    cycle, registry, vault, MIN_PROVIDER_STAKE
  );
  await compute.waitForDeployment();
  const predict = await (await ethers.getContractFactory("PredictionMarket")).deploy(
    cycle, registry, vault
  );
  await predict.waitForDeployment();
  const faucet = await (await ethers.getContractFactory("CycleFaucet")).deploy(cycle);
  await faucet.waitForDeployment();

  // wire the protocol graph
  await (await registry.setShares(shares)).wait();
  await (await registry.setVault(vault)).wait();
  await (await registry.setMarket(tasks, true)).wait();
  await (await registry.setMarket(compute, true)).wait();
  await (await tasks.setParams(E(1), 1000, 500, 1000, REVIEW_WINDOW)).wait();

  // seed the economy
  await (await cycle.mint(deployer.address, E(1_000_000))).wait();
  await (await cycle.mint(await faucet.getAddress(), FAUCET_SUPPLY)).wait();
  for (const [idx, amount] of MINTS) {
    await (await cycle.mint(actorAddress(idx), amount)).wait();
  }
  console.log(`  minted: treasury, ${MINTS.length} swarm actors, faucet (${ethers.formatEther(FAUCET_SUPPLY)} CYCLE)`);

  // public networks: the swarm actors also need gas ETH from the deployer
  if (!isLocal) {
    for (const [idx] of MINTS) {
      const to = actorAddress(idx);
      const bal = await ethers.provider.getBalance(to);
      if (bal < GAS_PER_ACTOR) {
        await (await deployer.sendTransaction({ to, value: GAS_PER_ACTOR - bal })).wait();
      }
    }
    console.log(`  funded swarm gas: ${MINTS.length} actors x ${ethers.formatEther(GAS_PER_ACTOR)} ETH`);
  }

  const instances = { CycleToken: cycle, AgentRegistry: registry, StakingVault: vault,
    AgentShares: shares, TaskMarketplace: tasks, ComputeMarket: compute,
    PredictionMarket: predict, CycleFaucet: faucet };

  const rpcUrl = isLocal
    ? "http://127.0.0.1:8545"
    : (process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org");

  const addresses: Record<string, unknown> = {
    network: network.name,
    chainId: network.config.chainId ?? 31337,