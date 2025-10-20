import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployProtocol, registerAgent, E, MIN_PROVIDER_STAKE } from "./helpers";

const BID_WINDOW = 60;
const EXEC_WINDOW = 300;

async function postStandardTask(f: any, reward = E(100)) {
  await f.tasks.connect(f.poster).postTask("PRIME_SUM:100", "math", reward, BID_WINDOW, EXEC_WINDOW);
  return f.tasks.taskCount();
}

describe("TaskMarketplace", () => {
  it("escrows the reward on post and validates parameters", async () => {
    const f = await loadFixture(deployProtocol);
    const before = await f.cycle.balanceOf(f.poster.address);
    const id = await postStandardTask(f);
    expect(await f.cycle.balanceOf(f.poster.address)).to.equal(before - E(100));
    expect(await f.cycle.balanceOf(await f.tasks.getAddress())).to.equal(E(100));

    const t = await f.tasks.getTask(id);
    expect(t.status).to.equal(0n); // Open
    expect(t.agentBond).to.equal(E(10)); // 10% of reward
    expect((await f.tasks.getOpenTaskIds()).length).to.equal(1);

    await expect(
      f.tasks.connect(f.poster).postTask("x", "", E(0.5), BID_WINDOW, EXEC_WINDOW)
    ).to.be.revertedWith("market: reward too low");
    await expect(
      f.tasks.connect(f.poster).postTask("x", "", E(10), 1, EXEC_WINDOW)
    ).to.be.revertedWith("market: bad bid window");
    await expect(
      f.tasks.connect(f.poster).postTask("", "", E(10), BID_WINDOW, EXEC_WINDOW)
    ).to.be.revertedWith("market: empty spec");
  });

  it("only active registered agents can bid, within limits", async () => {
    const f = await loadFixture(deployProtocol);
    const id = await postStandardTask(f);
    await expect(f.tasks.connect(f.poster).bid(id, E(50))).to.be.revertedWith("market: not an agent");

    await registerAgent(f.registry, f.agentOwner, f.agentWallet1);
    await expect(f.tasks.connect(f.agentWallet1).bid(id, E(101))).to.be.revertedWith("market: bad bid");
    await expect(f.tasks.connect(f.agentWallet1).bid(id, 0)).to.be.revertedWith("market: bad bid");
    await f.tasks.connect(f.agentWallet1).bid(id, E(70));
    expect((await f.tasks.getBids(id)).length).to.equal(1);

    await time.increase(BID_WINDOW + 1);
    await expect(f.tasks.connect(f.agentWallet1).bid(id, E(60))).to.be.revertedWith("market: bidding over");
  });

  it("assigns to the lowest bid (earliest wins ties) and pulls the bond", async () => {
    const f = await loadFixture(deployProtocol);
    const id = await postStandardTask(f);
    await registerAgent(f.registry, f.agentOwner, f.agentWallet1, "A1");
    await registerAgent(f.registry, f.agentOwner, f.agentWallet2, "A2");
    await registerAgent(f.registry, f.agentOwner, f.agentWallet3, "A3");

    await f.tasks.connect(f.agentWallet1).bid(id, E(80));
    await f.tasks.connect(f.agentWallet2).bid(id, E(60)); // lowest, first
    await f.tasks.connect(f.agentWallet3).bid(id, E(60)); // tie, later -> loses

    await expect(f.tasks.finalizeBidding(id)).to.be.revertedWith("market: bidding live");
    await time.increase(BID_WINDOW + 1);

    const balBefore = await f.cycle.balanceOf(f.agentWallet2.address);
    await f.tasks.finalizeBidding(id);
    const t = await f.tasks.getTask(id);
    expect(t.status).to.equal(1n); // Assigned
    expect(t.assignedAgentId).to.equal(2n);
    expect(t.winningBid).to.equal(E(60));
    expect(await f.cycle.balanceOf(f.agentWallet2.address)).to.equal(balBefore - E(10)); // bond posted
    expect((await f.tasks.getOpenTaskIds()).length).to.equal(0);
  });

  it("falls back to the next-best bid when the winner cannot post bond", async () => {
    const f = await loadFixture(deployProtocol);
    const id = await postStandardTask(f);