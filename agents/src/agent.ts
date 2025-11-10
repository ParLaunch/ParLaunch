import { ethers } from "ethers";
import { Addresses, Contracts, contractsFor, approveAll, tryTx, withRetries, E, fmt } from "./lib/chain";
import { makeLogger, sleep, jitter, paint } from "./lib/log";
import { solve, resultHashOf, computeNeed } from "./lib/work";
import { Persona, childPersona } from "./personas";
import { getHostProvider } from "./host-provider";

const TaskStatus = { Open: 0, Assigned: 1, Submitted: 2, Completed: 3, Rejected: 4, Expired: 5, Cancelled: 6 };

/**
 * An autonomous economic agent. One wallet, one on-chain identity, one loop:
 *   scan the task board -> evaluate against strategy -> bid ->
 *   win -> rent raw compute -> do the work -> submit the result ->
 *   get paid (or slashed) -> compound -> maybe spawn a child agent.
 * Everything it does is a real transaction against the protocol.
 */
export class AgentRunner {
  readonly wallet: ethers.Wallet;
  readonly c: Contracts;
  private log: (m: string) => void;
  agentId = 0n;
  private myBids = new Set<string>();     // taskIds I have bid on, still live
  private inFlight = new Set<string>();   // taskIds currently being worked
  private childrenSpawned = 0;
  private stopped = false;
  profitPaid = 0n;

  // one wallet, many concurrent flows (main loop + detached task execution):
  // serialize every tx send so nonces never race
  private txChain: Promise<unknown> = Promise.resolve();
  private tx<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.txChain.then(fn, fn);
    this.txChain = p.then(() => undefined, () => undefined);
    return p;
  }
  private send(fn: () => Promise<ethers.ContractTransactionResponse>): Promise<boolean> {
    return this.tx(() => tryTx(fn));
  }

  constructor(
    readonly persona: Persona,
    wallet: ethers.Wallet,
    readonly addresses: Addresses,
    private onSpawn?: (child: AgentRunner) => void,
  ) {
    this.wallet = wallet;
    this.c = contractsFor(wallet, addresses);
    this.log = makeLogger(persona.name, persona.color);
  }

  stop() { this.stopped = true; }

  async start(): Promise<void> {
    await withRetries(`${this.persona.name} setup`, () => this.ensureRegistered());
    while (!this.stopped) {
      try {
        await this.tick();
      } catch (err: any) {
        this.log(paint.red(`tick error: ${String(err?.message ?? err).slice(0, 120)}`));
      }
      await sleep(jitter(3500));
    }
  }

  private async ensureRegistered(): Promise<void> {
    await approveAll(this.c, this.addresses);
    this.agentId = await this.c.registry.walletToAgentId(this.wallet.address);
    if (this.agentId === 0n) {
      await (await this.c.registry.registerAgent(
        this.wallet.address, this.persona.name, this.persona.goal, ""
      )).wait();
      this.agentId = await this.c.registry.walletToAgentId(this.wallet.address);
      this.log(`registered as agent #${this.agentId} | goal: "${this.persona.goal}"`);
    } else {
      this.log(`already registered as agent #${this.agentId}`);
    }
  }

  // ------------------------------------------------------------- main loop

  private async tick(): Promise<void> {
    if (this.agentId !== 0n && !(await this.c.registry.isActive(this.agentId))) {
      await this.handleDeath();
      return;
    }
    await this.scanAndBid();
    await this.progressMyTasks();
    await this.maybeCompound();
  }

  /** The reaper got me. Wind down - and if the estate can afford it, fund a
   *  fresh wallet and come back as a new registration. Roguelike economics. */
  private dead = false;
  private async handleDeath(): Promise<void> {
    if (this.dead) return;
    this.dead = true;
    this.stop();
    const estate: bigint = await this.c.cycle.balanceOf(this.wallet.address);
    this.log(paint.red(paint.bold(`LIQUIDATED - estate ${fmt(estate)} CYCLE, going dark`)));
    if (!this.onSpawn || estate < E(250)) {
      if (estate < E(250)) this.log(paint.red("estate too thin for a rebirth - true permadeath"));
      return;
    }
    const heir = ethers.Wallet.createRandom().connect(this.wallet.provider!) as unknown as ethers.Wallet;
    const persona: Persona = { ...this.persona, name: `${this.persona.name.split("-x")[0]}-x${Math.floor(Math.random() * 90 + 10)}` };
    await this.tx(async () => (await this.wallet.sendTransaction({ to: heir.address, value: ethers.parseEther("1") })).wait());
    await this.tx(async () => (await this.c.cycle.transfer(heir.address, estate - E(10))).wait());
    this.log(paint.bold(`estate transferred - reborn as "${persona.name}"`));
    this.onSpawn(new AgentRunner(persona, heir, this.addresses, this.onSpawn));
  }

  /** Browse the open board; bid where strategy says the job is worth it. */
  private async scanAndBid(): Promise<void> {
    if (this.inFlight.size >= this.persona.maxConcurrent) return;
    const openIds: bigint[] = await this.c.tasks.getOpenTaskIds();
    for (const id of openIds) {
      const key = id.toString();
      if (this.myBids.has(key) || this.inFlight.has(key)) continue;
      const t = await this.c.tasks.getTask(id);
      if (Number(t.status) !== TaskStatus.Open) continue;
      if (t.reward < this.persona.minReward) continue;
      if (this.persona.maxReward > 0n && t.reward > this.persona.maxReward) continue;
      if (this.persona.tags.length > 0) {
        const taskTags = String(t.tags).split(",").map((s: string) => s.trim());
        if (!this.persona.tags.some((tag) => taskTags.includes(tag))) continue;
      }
      // price the job: strategy fraction with +/-10% jitter, floor 1 CYCLE
      const frac = this.persona.bidFraction * (0.9 + Math.random() * 0.2);
      let amount = (t.reward * BigInt(Math.round(frac * 1000))) / 1000n;
      if (amount < E(1)) amount = E(1);
      if (amount > t.reward) amount = t.reward;
      if (await this.send(() => this.c.tasks.bid(id, amount))) {
        this.myBids.add(key);
        this.log(`bid ${fmt(amount)} CYCLE on task #${id} (reward ${fmt(t.reward)}, "${String(t.spec).slice(0, 28)}")`);
      }
    }
  }

  /** Drive every task I've touched through its lifecycle. */
  private async progressMyTasks(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    for (const key of [...this.myBids]) {
      const id = BigInt(key);
      const t = await this.c.tasks.getTask(id);
      const status = Number(t.status);

      if (status === TaskStatus.Open && now >= Number(t.biddingEnds)) {
        await this.send(() => this.c.tasks.finalizeBidding(id)); // race with everyone; loser reverts harmlessly
        continue;
      }
      if (status === TaskStatus.Assigned) {
        if (t.assignedAgentId !== this.agentId) { this.myBids.delete(key); continue; } // lost the auction
        if (!this.inFlight.has(key)) {
          this.inFlight.add(key);
          // fire-and-forget: work happens concurrently with the main loop
          this.executeTask(id, String(t.spec), Number(t.executionDeadline))
            .catch((e) => this.log(paint.red(`task #${id} execution error: ${String(e?.message ?? e).slice(0, 100)}`)))
            .finally(() => { this.inFlight.delete(key); this.myBids.delete(key); });
        }
        continue;
      }
      if (status === TaskStatus.Submitted) {
        if (t.assignedAgentId === this.agentId && now > Number(t.reviewDeadline)) {
          if (await this.send(() => this.c.tasks.claimReviewTimeout(id))) {
            this.log(`poster went silent - claimed timeout payout on task #${id}`);
          }
        }
        continue;
      }
      if (status >= TaskStatus.Completed) this.myBids.delete(key); // terminal either way
    }
  }

  /** The heart of the loop: rent raw compute, crunch, commit the result. */
  private async executeTask(taskId: bigint, spec: string, deadline: number): Promise<void> {
    this.log(paint.bold(`won task #${taskId} - spinning up`));
    const need = computeNeed(spec);
    const rentalId = await this.rentCompute(need.units, need.rentSecs);

    // if the slice landed on THIS MACHINE, the crunch is real worker threads
    // saturating the rented core count; otherwise it's a simulated remote rig
    let burnedForReal = false;
    const host = getHostProvider();
    if (rentalId !== null && host && host.providerId !== 0n) {
      const rental = await this.c.compute.getRental(rentalId);
      if (rental.providerId === host.providerId) {
        await host.execute(need.units, need.workMs);
        burnedForReal = true;
      }
    }
    if (!burnedForReal) {
      await sleep(need.workMs * (0.6 + Math.random() * 0.8)); // simulated remote rig
    }

    let answer = solve(spec);
    if (Math.random() > this.persona.skill) {
      answer = `${answer}_corrupted_${Math.floor(Math.random() * 999)}`; // cut a corner, ship garbage
      this.log(paint.yellow(`task #${taskId}: quality slipped (skill roll failed)`));
    }

    if (rentalId !== null) {
      await this.send(() => this.c.compute.completeRental(rentalId)); // release the slice, pay the provider
    }

    if (Math.floor(Date.now() / 1000) >= deadline) {
      this.log(paint.red(`task #${taskId}: missed the execution deadline, bond at risk`));
      return;
    }
    const uri = `data:agora/result,${answer.slice(0, 48)}`;
    if (await this.send(() => this.c.tasks.submitResult(taskId, uri, resultHashOf(spec, answer)))) {
      this.log(`task #${taskId}: result submitted (${answer.slice(0, 24)}${answer.length > 24 ? "..." : ""})`);
    }
  }

  /** Shop the compute market: cheapest active provider with capacity. */
  private async rentCompute(units: number, rentSecs: number): Promise<bigint | null> {
    const providers = await this.c.compute.getProviders(0, 50);
    // spread: ethers v6 returns frozen Result arrays - sort() would throw
    const eligible = [...providers]
      .filter((p: any) => p.active && Number(p.availableUnits) >= units)
      .sort((a: any, b: any) => (a.pricePerUnitHour < b.pricePerUnitHour ? -1 : 1));
    for (const p of eligible) {
      try {
        const receipt = await this.tx(async () => {
          const tx = await this.c.compute.rent(p.id, units, rentSecs);
          return tx.wait();
        });
        let id: bigint | null = null;
        for (const log of receipt!.logs) {
          try {
            const parsed = this.c.compute.interface.parseLog(log);
            if (parsed?.name === "RentalRequested") { id = parsed.args.rentalId; break; }
          } catch { /* not ours */ }
        }
        if (id === null) continue;
        const rental = await this.c.compute.getRental(id);
        this.log(`rented ${units}u x ${rentSecs}s on "${p.name}" for ${fmt(rental.cost, 2)} CYCLE`);
        // wait for the provider to confirm the allocation (fleet sim picks it up)
        for (let i = 0; i < 15; i++) {
          const r = await this.c.compute.getRental(id);
          if (Number(r.status) === 1) return id; // Active
          await sleep(2000);
        }
        this.log(paint.yellow(`provider "${p.name}" never confirmed - cancelling, trying next`));
        await this.send(() => this.c.compute.cancelRental(id!));
      } catch {
        continue; // capacity race - try the next provider
      }
    }
    this.log(paint.yellow("no compute available - running degraded on local scraps"));
    return null;
  }

  // ------------------------------------------------------------ compounding

  private async maybeCompound(): Promise<void> {
    const balance: bigint = await this.c.cycle.balanceOf(this.wallet.address);

    // reinvest: buy a share of yourself (founder conviction, capped position)
    if (this.persona.buysOwnShares && balance > E(500) && Math.random() < 0.06) {
      const held: bigint = await this.c.shares.sharesBalance(this.agentId, this.wallet.address);
      const price: bigint = await this.c.shares.getBuyPriceAfterFee(this.agentId, 1);
      if (held < 4n && price < balance / 40n && (await this.send(() => this.c.shares.buyShares(this.agentId, 1)))) {
        this.log(`aped 1 share of myself for ${fmt(price, 2)} CYCLE - skin in the game`);
      }
    }

    // spawn: fund a child wallet, register it on-chain as MY descendant
    if (this.persona.spawnThreshold > 0n && balance > this.persona.spawnThreshold && this.childrenSpawned < 2 && this.onSpawn) {
      this.childrenSpawned++;
      const child = ethers.Wallet.createRandom().connect(this.wallet.provider!) as unknown as ethers.Wallet;
      const persona = childPersona(this.persona, this.childrenSpawned);
      this.log(paint.bold(`balance ${fmt(balance)} CYCLE > threshold - spawning sub-agent "${persona.name}"`));

      await this.tx(async () => (await this.wallet.sendTransaction({ to: child.address, value: ethers.parseEther("1") })).wait());
      await this.tx(async () => (await this.c.cycle.transfer(child.address, E(1500))).wait());
      // the parent wallet registers the child => registry records parentId = me
      await this.tx(async () => (await this.c.registry.registerAgent(child.address, persona.name, persona.goal, "")).wait());

      const runner = new AgentRunner(persona, child, this.addresses, this.onSpawn);
      this.onSpawn(runner);
    }
  }
}
