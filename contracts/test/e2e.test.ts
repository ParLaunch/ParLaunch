import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployProtocol, E, EPOCH_DURATION } from "./helpers";

/// One full turn of the economy, woven end-to-end, closing with hard
/// conservation checks: every escrow unwinds, every fee lands in the vault,
/// and not a single wei of CYCLE leaks or mints out of thin air.
describe("AGORA end-to-end economy", () => {
  const BID_WINDOW = 60;
  const EXEC_WINDOW = 600;

  it("agents earn, compute is rented, speculators settle, fees accrue to stakers - and CYCLE is conserved", async () => {
    const f = await loadFixture(deployProtocol);
    const {
      cycle, registry, vault, shares, tasks, compute, predict,
      deployer, poster, agentOwner, agentWallet1, agentWallet2, agentWallet3,
      providerAcct, speculator1, speculator2, staker,
    } = f;

    // ------------------------------------------------ stake first, earn all fees
    await vault.connect(staker).stake(E(1000));

    // ------------------------------------------------ actors enter the economy
    await registry.connect(agentOwner).registerAgent(agentWallet1.address, "Nexus-7", "maximize task profit", "");
    await registry.connect(agentOwner).registerAgent(agentWallet2.address, "SageMind", "premium quality work", "");
    // Nexus-7's wallet spawns a sub-agent: machine begets machine
    await registry.connect(agentWallet1).registerAgent(agentWallet3.address, "Nexus-Jr", "inherit and grind", "");
    expect((await registry.getAgent(3)).parentId).to.equal(1n);

    await compute.connect(providerAcct).registerProvider("RigOne", "us-east", "H100", 16, E(2));

    // early conviction: speculator1 buys Nexus-7 shares before it proves itself
    await shares.connect(speculator1).buyShares(1, 3); // price 0.35, proto 0.00875, subject 0.0175

    // a prediction market opens on the epoch's earnings race
    const epoch = await registry.currentEpoch();
    await predict.createMarket(epoch, [1, 2, 3]);
    await predict.connect(speculator1).bet(1, 1, E(50));   // backs Nexus-7
    await predict.connect(speculator2).bet(1, 2, E(100));  // backs SageMind

    // ------------------------------------------------ three tasks hit the board
    await tasks.connect(poster).postTask("PRIME_SUM:5000", "math", E(100), BID_WINDOW, EXEC_WINDOW);
    await tasks.connect(poster).postTask("MATMUL_TRACE:7,64", "math,heavy", E(200), BID_WINDOW, EXEC_WINDOW);
    await tasks.connect(poster).postTask("MEME:420", "creative", E(150), BID_WINDOW, EXEC_WINDOW);

    await tasks.connect(agentWallet1).bid(1, E(60));
    await tasks.connect(agentWallet2).bid(1, E(80));
    await tasks.connect(agentWallet2).bid(2, E(140));
    await tasks.connect(agentWallet3).bid(3, E(90));
    await tasks.connect(agentWallet2).bid(3, E(100));

    await time.increase(BID_WINDOW + 1);
    await tasks.finalizeBidding(1); // Nexus-7 at 60
    await tasks.finalizeBidding(2); // SageMind at 140
    await tasks.finalizeBidding(3); // Nexus-Jr at 90
    expect((await tasks.getTask(1)).assignedAgentId).to.equal(1n);
    expect((await tasks.getTask(2)).assignedAgentId).to.equal(2n);
    expect((await tasks.getTask(3)).assignedAgentId).to.equal(3n);

    // ------------------------------------------------ winners rent raw compute
    await compute.connect(agentWallet1).rent(1, 4, 1800);  // 4 CYCLE
    await compute.connect(agentWallet2).rent(1, 8, 3600);  // 16 CYCLE
    await compute.connect(agentWallet3).rent(1, 2, 1800);  // 2 CYCLE
    for (const r of [1, 2, 3]) await compute.connect(providerAcct).confirmRental(r);
    await compute.connect(agentWallet1).completeRental(1);
    await compute.connect(agentWallet2).completeRental(2);
    await compute.connect(agentWallet3).completeRental(3);
    expect((await compute.getProvider(1)).availableUnits).to.equal(16);

    // ------------------------------------------------ results land; economics settle
    await tasks.connect(agentWallet1).submitResult(1, "data:result1", ethers.id("r1"));
    await tasks.connect(agentWallet2).submitResult(2, "data:result2", ethers.id("r2"));
    await tasks.connect(agentWallet3).submitResult(3, "data:result3", ethers.id("r3"));

    await tasks.connect(poster).approveResult(1);
    await tasks.connect(poster).approveResult(2);
    await tasks.connect(poster).rejectResult(3, "hash mismatch"); // Jr fumbled

    // reputation & the epoch ledger reflect reality
    expect((await registry.getAgent(1)).reputation).to.equal(110n);
    expect((await registry.getAgent(2)).reputation).to.equal(110n);
    expect((await registry.getAgent(3)).reputation).to.equal(50n);
    expect(await registry.epochEarnings(epoch, 1)).to.equal(E(60));
    expect(await registry.epochEarnings(epoch, 2)).to.equal(E(140));
    expect(await registry.epochEarnings(epoch, 3)).to.equal(0n);
    expect(await registry.epochTotalEarnings(epoch)).to.equal(E(200));
    expect((await registry.getAgent(1)).lifetimeComputeSpend).to.equal(E(4));

    // dividends: Nexus-7's 6 CYCLE dividend split 1:3 owner:speculator1
    expect(await shares.pendingDividends(1, agentOwner.address)).to.equal(E(1.5));
    expect(await shares.pendingDividends(1, speculator1.address)).to.equal(E(4.5));
    expect(await shares.pendingDividends(2, agentOwner.address)).to.equal(E(14));

    // ------------------------------------------------ the epoch race resolves trustlessly
    await time.increase(EPOCH_DURATION);
    await predict.resolve(1);
    const market = await predict.getMarket(1);
    expect(market.voided).to.equal(false);
    expect(market.winners.length).to.equal(1);
    expect(market.winners[0]).to.equal(2n); // SageMind out-earned the field

    const spec2Before = await cycle.balanceOf(speculator2.address);
    await predict.connect(speculator2).claim(1);
    expect(await cycle.balanceOf(speculator2.address)).to.equal(spec2Before + E(145.5)); // (150 - 3%) all his
    await expect(predict.connect(speculator1).claim(1)).to.be.revertedWith("predict: nothing to claim");

    // ------------------------------------------------ everyone cashes out
    await shares.connect(agentOwner).claimDividends(1);
    await shares.connect(agentOwner).claimDividends(2);
    await shares.connect(speculator1).claimDividends(1);

    // every fee stream landed in the vault for the sole staker:
    // tasks 3 + 7 + 7.5(bond burn) | compute 0.1 + 0.4 + 0.05 | shares 0.00875 | predict 4.5
    const expectedFees = E(22.55875);
    expect(await vault.totalFeesReceived()).to.equal(expectedFees);
    expect(await vault.pendingRewards(staker.address)).to.equal(expectedFees);
    await vault.connect(staker).claim();
    await vault.connect(staker).unstake(E(1000));

    // ------------------------------------------------ conservation: nothing leaks
    expect(await cycle.balanceOf(await tasks.getAddress())).to.equal(0n);      // all escrow unwound
    expect(await cycle.balanceOf(await predict.getAddress())).to.equal(0n);    // pool fully paid
    expect(await cycle.balanceOf(await vault.getAddress())).to.equal(0n);      // claimed + unstaked
    expect(await cycle.balanceOf(await compute.getAddress())).to.equal(E(500)); // provider stake only
    expect(await cycle.balanceOf(await registry.getAddress())).to.equal(E(300)); // 3 agent stakes
    expect(await cycle.balanceOf(await shares.getAddress())).to.equal(E(0.35)); // curve reserve only

    const holders = [
      deployer, poster, agentOwner, agentWallet1, agentWallet2, agentWallet3,
      providerAcct, speculator1, speculator2, staker,
    ];
    let sum = 0n;
    for (const h of holders) sum += await cycle.balanceOf(h.address);
    for (const c of [registry, vault, shares, tasks, compute, predict]) {
      sum += await cycle.balanceOf(await c.getAddress());
    }
    expect(sum).to.equal(await cycle.totalSupply());
    expect(await cycle.totalSupply()).to.equal(E(10_000_000)); // exactly what was minted
  });
});
