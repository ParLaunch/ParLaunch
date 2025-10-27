import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployProtocol, registerAgent, E, EPOCH_DURATION, CURVE_DIVISOR } from "./helpers";

describe("AgentShares", () => {
  it("prices on a sum-of-squares curve and only the registry can init", async () => {
    const f = await loadFixture(deployProtocol);
    await expect(f.shares.connect(f.poster).initShares(99, f.poster.address)).to.be.revertedWith(
      "shares: not registry"
    );
    // supply 1, buy 1 -> 1^2 / 40 CYCLE
    expect(await f.shares.getPrice(1, 1)).to.equal(E(1) / CURVE_DIVISOR);
    // supply 1, buy 3 -> (1+4+9)/40
    expect(await f.shares.getPrice(1, 3)).to.equal((E(1) * 14n) / CURVE_DIVISOR);
    // monotonic in supply
    expect(await f.shares.getPrice(10, 1)).to.be.greaterThan(await f.shares.getPrice(9, 1));
  });

  it("buys route fees to the vault and the agent; reserve tracks the curve", async () => {
    const f = await loadFixture(deployProtocol);
    await registerAgent(f.registry, f.agentOwner, f.agentWallet1);
    await expect(f.shares.connect(f.speculator1).buyShares(99, 1)).to.be.revertedWith("shares: not initialized");

    const price = await f.shares.getBuyPrice(1, 4); // supply 1 -> (1+4+9+16)/40 = 0.75
    expect(price).to.equal(E(0.75));
    const protoFee = (price * 250n) / 10_000n;
    const subjFee = (price * 500n) / 10_000n;

    const buyerBefore = await f.cycle.balanceOf(f.speculator1.address);
    const walletBefore = await f.cycle.balanceOf(f.agentWallet1.address);
    const vaultBefore = await f.vault.totalFeesReceived();

    await f.shares.connect(f.speculator1).buyShares(1, 4);

    expect(await f.cycle.balanceOf(f.speculator1.address)).to.equal(buyerBefore - price - protoFee - subjFee);
    expect(await f.cycle.balanceOf(f.agentWallet1.address)).to.equal(walletBefore + subjFee);
    expect((await f.vault.totalFeesReceived()) - vaultBefore).to.equal(protoFee);
    expect(await f.shares.sharesSupply(1)).to.equal(5n);
    expect(await f.shares.reserveOf(1)).to.equal(price);
  });

  it("sell returns curve value minus fees; the genesis share can never be sold", async () => {
    const f = await loadFixture(deployProtocol);
    await registerAgent(f.registry, f.agentOwner, f.agentWallet1);
    await f.shares.connect(f.speculator1).buyShares(1, 4);

    await expect(f.shares.connect(f.speculator1).sellShares(1, 5)).to.be.revertedWith("shares: insufficient");
    // agentOwner holds only the genesis share; selling it would zero supply
    await f.shares.connect(f.speculator1).sellShares(1, 4);
    await expect(f.shares.connect(f.agentOwner).sellShares(1, 1)).to.be.revertedWith(
      "shares: cannot sell last share"
    );

    // roundtrip drains the reserve exactly
    expect(await f.shares.reserveOf(1)).to.equal(0n);
    expect(await f.shares.sharesSupply(1)).to.equal(1n);
  });

  it("streams dividends pro-rata to holders at deposit time", async () => {
    const f = await loadFixture(deployProtocol);
    await registerAgent(f.registry, f.agentOwner, f.agentWallet1);
    await f.shares.connect(f.speculator1).buyShares(1, 3); // holders: owner 1, spec1 3 (supply 4)

    await f.shares.connect(f.poster).depositDividend(1, E(8)); // anyone can fund dividends
    expect(await f.shares.pendingDividends(1, f.speculator1.address)).to.equal(E(6));
    expect(await f.shares.pendingDividends(1, f.agentOwner.address)).to.equal(E(2));

    // late buyer earns nothing from past dividends
    await f.shares.connect(f.speculator2).buyShares(1, 4);
    expect(await f.shares.pendingDividends(1, f.speculator2.address)).to.equal(0n);

    const before = await f.cycle.balanceOf(f.speculator1.address);
    await f.shares.connect(f.speculator1).claimDividends(1);
    expect(await f.cycle.balanceOf(f.speculator1.address)).to.equal(before + E(6));
    await expect(f.shares.connect(f.speculator1).claimDividends(1)).to.be.revertedWith("shares: nothing owed");

    // selling after a deposit keeps already-earned dividends
    await f.shares.connect(f.poster).depositDividend(1, E(16)); // supply 8: spec1 3/8 = 6, spec2 4/8 = 8
    await f.shares.connect(f.speculator1).sellShares(1, 3);
    expect(await f.shares.pendingDividends(1, f.speculator1.address)).to.equal(E(6));
  });
});

describe("PredictionMarket", () => {
  async function setupRace(f: any) {
    await registerAgent(f.registry, f.agentOwner, f.agentWallet1, "Alpha");
    await registerAgent(f.registry, f.agentOwner, f.agentWallet2, "Beta");
    await registerAgent(f.registry, f.agentOwner, f.agentWallet3, "Gamma");
    await f.registry.setMarket(f.deployer.address, true); // deployer writes earnings directly
    const epoch = await f.registry.currentEpoch();
    await f.predict.createMarket(epoch, [1, 2, 3]);
    return epoch;
  }

  it("validates market creation", async () => {
    const f = await loadFixture(deployProtocol);
    await registerAgent(f.registry, f.agentOwner, f.agentWallet1);
    await registerAgent(f.registry, f.agentOwner, f.agentWallet2);
    const epoch = await f.registry.currentEpoch();
    await expect(f.predict.createMarket(epoch, [1])).to.be.revertedWith("predict: 2-8 candidates");
    await expect(f.predict.createMarket(epoch, [1, 1])).to.be.revertedWith("predict: duplicate");
    await expect(f.predict.createMarket(epoch, [1, 99])).to.be.revertedWith("predict: unknown agent");
    await time.increase(EPOCH_DURATION);
    await expect(f.predict.createMarket(epoch, [1, 2])).to.be.revertedWith("predict: epoch past");
  });

  it("runs a full parimutuel cycle with trustless resolution from the earnings ledger", async () => {
    const f = await loadFixture(deployProtocol);
    const epoch = await setupRace(f);

    await f.predict.connect(f.speculator1).bet(1, 1, E(100)); // backs Alpha
    await f.predict.connect(f.speculator2).bet(1, 2, E(300)); // backs Beta
    await f.predict.connect(f.poster).bet(1, 1, E(100));      // backs Alpha
    await expect(f.predict.connect(f.poster).bet(1, 99, E(10))).to.be.revertedWith("predict: not a candidate");
    await expect(f.predict.connect(f.poster).bet(1, 1, E(0.5))).to.be.revertedWith("predict: below min");

    // Alpha out-earns Beta in this epoch
    await f.registry.recordTaskOutcome(1, E(500), true);
    await f.registry.recordTaskOutcome(2, E(200), true);

    await expect(f.predict.resolve(1)).to.be.revertedWith("predict: epoch live");
    await time.increase(EPOCH_DURATION);
    await expect(f.predict.connect(f.poster).bet(1, 1, E(10))).to.be.revertedWith("predict: betting over");
    await f.predict.resolve(1);

    const m = await f.predict.getMarket(1);
    expect(m.resolved).to.equal(true);
    expect(m.voided).to.equal(false);
    expect(m.winners.length).to.equal(1);
    expect(m.winners[0]).to.equal(1n);

    // pool 500, fee 3% = 15, payout pool 485 split across 200 winning stake
    const s1Before = await f.cycle.balanceOf(f.speculator1.address);
    await f.predict.connect(f.speculator1).claim(1);
    expect(await f.cycle.balanceOf(f.speculator1.address)).to.equal(s1Before + E(242.5));
    await expect(f.predict.connect(f.speculator1).claim(1)).to.be.revertedWith("predict: claimed");
    await expect(f.predict.connect(f.speculator2).claim(1)).to.be.revertedWith("predict: nothing to claim");
    expect(await f.vault.totalFeesReceived()).to.equal(E(15));
  });

  it("splits exact ties across the tied camps", async () => {
    const f = await loadFixture(deployProtocol);
    const epoch = await setupRace(f);
    await f.predict.connect(f.speculator1).bet(1, 1, E(100));
    await f.predict.connect(f.speculator2).bet(1, 2, E(100));
    await f.registry.recordTaskOutcome(1, E(500), true);
    await f.registry.recordTaskOutcome(2, E(500), true);
    await time.increase(EPOCH_DURATION);
    await f.predict.resolve(1);

    const m = await f.predict.getMarket(1);
    expect(m.winners.length).to.equal(2);
    // both camps are winners: everyone gets back stake minus rake
    const before = await f.cycle.balanceOf(f.speculator1.address);
    await f.predict.connect(f.speculator1).claim(1);
    expect(await f.cycle.balanceOf(f.speculator1.address)).to.equal(before + E(97));
  });

  it("voids (full refunds, no rake) on zero-earning epochs and unbacked winners", async () => {
    const f = await loadFixture(deployProtocol);
    const epoch = await setupRace(f);
    await f.predict.connect(f.speculator1).bet(1, 1, E(100));
    await time.increase(EPOCH_DURATION);
    await f.predict.resolve(1); // nobody earned anything
    expect((await f.predict.getMarket(1)).voided).to.equal(true);
    const before = await f.cycle.balanceOf(f.speculator1.address);
    await f.predict.connect(f.speculator1).claim(1);
    expect(await f.cycle.balanceOf(f.speculator1.address)).to.equal(before + E(100));

    // second market: winner exists but nobody backed it
    const epoch2 = await f.registry.currentEpoch();
    await f.predict.createMarket(epoch2, [1, 2, 3]);
    await f.predict.connect(f.speculator2).bet(2, 2, E(50));
    await f.registry.recordTaskOutcome(3, E(999), true); // Gamma wins, zero backers
    await time.increase(EPOCH_DURATION);
    await f.predict.resolve(2);
    expect((await f.predict.getMarket(2)).voided).to.equal(true);
    const b2 = await f.cycle.balanceOf(f.speculator2.address);
    await f.predict.connect(f.speculator2).claim(2);
    expect(await f.cycle.balanceOf(f.speculator2.address)).to.equal(b2 + E(50));
  });
});
