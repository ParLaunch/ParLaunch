import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployProtocol, registerAgent, E, EPOCH_DURATION, MIN_AGENT_STAKE } from "./helpers";

describe("CycleToken", () => {
  it("caps supply at 1B and restricts minting to owner", async () => {
    const { cycle, poster } = await loadFixture(deployProtocol);
    await expect(cycle.connect(poster).mint(poster.address, 1n)).to.be.revertedWithCustomError(
      cycle, "OwnableUnauthorizedAccount"
    );
    const total = await cycle.totalSupply();
    const cap = await cycle.cap();
    await expect(cycle.mint(poster.address, cap - total + 1n)).to.be.revertedWithCustomError(
      cycle, "ERC20ExceededCap"
    );
    await cycle.mint(poster.address, cap - total); // exactly to cap is fine
    expect(await cycle.totalSupply()).to.equal(cap);
  });
});

describe("AgentRegistry", () => {
  it("registers an agent: pulls stake, sets fields, mints genesis share", async () => {
    const f = await loadFixture(deployProtocol);
    const before = await f.cycle.balanceOf(f.agentOwner.address);

    const id = await registerAgent(f.registry, f.agentOwner, f.agentWallet1, "Nexus-7");
    expect(id).to.equal(1n);

    const a = await f.registry.getAgent(1);
    expect(a.owner).to.equal(f.agentOwner.address);
    expect(a.wallet).to.equal(f.agentWallet1.address);
    expect(a.parentId).to.equal(0n);
    expect(a.active).to.equal(true);
    expect(a.stake).to.equal(MIN_AGENT_STAKE);
    expect(a.reputation).to.equal(100n);

    expect(await f.cycle.balanceOf(f.agentOwner.address)).to.equal(before - MIN_AGENT_STAKE);
    // genesis share
    expect(await f.shares.sharesSupply(1)).to.equal(1n);
    expect(await f.shares.sharesBalance(1, f.agentOwner.address)).to.equal(1n);
  });

  it("rejects duplicate wallets, zero wallet and bad names", async () => {
    const f = await loadFixture(deployProtocol);
    await registerAgent(f.registry, f.agentOwner, f.agentWallet1);
    await expect(
      f.registry.connect(f.poster).registerAgent(f.agentWallet1.address, "X", "", "")
    ).to.be.revertedWith("registry: wallet taken");
    await expect(
      f.registry.connect(f.poster).registerAgent(ethers.ZeroAddress, "X", "", "")
    ).to.be.revertedWith("registry: zero wallet");
    await expect(
      f.registry.connect(f.poster).registerAgent(f.agentWallet2.address, "", "", "")
    ).to.be.revertedWith("registry: bad name");
  });

  it("records parent when an agent wallet spawns a sub-agent", async () => {
    const f = await loadFixture(deployProtocol);
    await registerAgent(f.registry, f.agentOwner, f.agentWallet1, "Parent");
    // the PARENT AGENT'S WALLET registers a child, staking from its own funds
    await f.registry.connect(f.agentWallet1).registerAgent(f.agentWallet2.address, "Child", "spawned", "");
    const child = await f.registry.getAgent(2);
    expect(child.parentId).to.equal(1n);
    expect(child.owner).to.equal(f.agentWallet1.address);
  });

  it("gates outcome recording to authorized markets and clamps reputation", async () => {
    const f = await loadFixture(deployProtocol);
    await registerAgent(f.registry, f.agentOwner, f.agentWallet1);
    await expect(
      f.registry.connect(f.poster).recordTaskOutcome(1, E(10), true)
    ).to.be.revertedWith("registry: not market");

    await f.registry.setMarket(f.deployer.address, true); // deployer acts as market
    const epoch = await f.registry.currentEpoch();

    await f.registry.recordTaskOutcome(1, E(10), true);
    let a = await f.registry.getAgent(1);
    expect(a.reputation).to.equal(110n);
    expect(a.lifetimeEarnings).to.equal(E(10));
    expect(a.tasksCompleted).to.equal(1n);
    expect(await f.registry.epochEarnings(epoch, 1)).to.equal(E(10));
    expect(await f.registry.epochTotalEarnings(epoch)).to.equal(E(10));

    // three failures: 110 -> 60 -> 10 -> clamped at 0
    for (let i = 0; i < 3; i++) await f.registry.recordTaskOutcome(1, 0, false);
    a = await f.registry.getAgent(1);
    expect(a.reputation).to.equal(0n);
    expect(a.tasksFailed).to.equal(3n);
    expect(a.lifetimeEarnings).to.equal(E(10)); // failures earn nothing
  });

  it("slashes stake into the vault and deactivates when stake collapses", async () => {
    const f = await loadFixture(deployProtocol);
    await registerAgent(f.registry, f.agentOwner, f.agentWallet1);
    await f.registry.setMarket(f.deployer.address, true);

    await f.registry.slashStake(1, E(30), "bad result");
    let a = await f.registry.getAgent(1);
    expect(a.stake).to.equal(E(70));
    expect(a.active).to.equal(true);
    expect(await f.vault.totalFeesReceived()).to.equal(E(30));

    // stake drops to 20 < minStake/2 = 50 -> deactivated; slash caps at stake
    await f.registry.slashStake(1, E(50), "again");
    a = await f.registry.getAgent(1);
    expect(a.stake).to.equal(E(20));
    expect(a.active).to.equal(false);

    await f.registry.slashStake(1, E(9999), "overkill caps at stake");
    a = await f.registry.getAgent(1);
    expect(a.stake).to.equal(0n);
  });

  it("returns remaining stake to the owner after deactivation", async () => {
    const f = await loadFixture(deployProtocol);