import { useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { ADDR, read, write, provider, ensureApprovals, fmt, TASK_STATUS, getAddress } from "./agora";

export interface AgentRow {
  id: bigint; name: string; goal: string; wallet: string; owner: string; parentId: bigint;
  active: boolean; reputation: bigint; earnings: bigint; computeSpend: bigint;
  done: bigint; failed: bigint; epochEarnings: bigint;
  sharesSupply: bigint; sharePrice: bigint; myShares: bigint; myDividends: bigint;
}
export interface TaskRow {
  id: bigint; poster: string; spec: string; tags: string; reward: bigint;
  status: string; assignedAgentId: bigint; winningBid: bigint;
  biddingEnds: number; executionDeadline: number;
}
export interface ProviderRow {
  id: bigint; name: string; region: string; gpuModel: string;
  totalUnits: number; availableUnits: number; pricePerUnitHour: bigint;
  stake: bigint; active: boolean; totalEarned: bigint; completed: number; failed: number;
}
export interface MarketRow {
  id: bigint; epoch: bigint; resolved: boolean; voided: boolean;
  totalPool: bigint; bettingEnds: number; winners: bigint[];
  candidates: Array<{ agentId: bigint; name: string; pool: bigint; myBet: bigint }>;
  myClaimed: boolean;
}
export interface FeedItem { key: string; block: number; text: string; kind: string; }
export interface Point { t: number; v: number; }

export interface AgoraState {
  ready: boolean;
  error: string | null;
  block: number;
  epoch: { number: bigint; endsAt: number; duration: number };
  me: { address: string; balance: bigint; staked: bigint; pending: bigint; claimedFaucet: boolean };
  stats: {
    activeAgents: number; totalAgents: number; openTasks: number;
    taskVolume: bigint; computeVolume: bigint; vaultFees: bigint;
    totalStaked: bigint; tvl: bigint; utilization: number; computeIndex: bigint;
  };
  agents: AgentRow[];
  tasks: TaskRow[];
  providers: ProviderRow[];
  markets: MarketRow[];
  feesHistory: Point[];
  volumeHistory: Point[];
  events: FeedItem[];
}

const EMPTY: AgoraState = {
  ready: false, error: null, block: 0,
  epoch: { number: 0n, endsAt: 0, duration: ADDR.epochDuration },
  me: { address: getAddress(), balance: 0n, staked: 0n, pending: 0n, claimedFaucet: false },
  stats: { activeAgents: 0, totalAgents: 0, openTasks: 0, taskVolume: 0n, computeVolume: 0n, vaultFees: 0n, totalStaked: 0n, tvl: 0n, utilization: 0, computeIndex: 0n },
  agents: [], tasks: [], providers: [], markets: [], feesHistory: [], volumeHistory: [], events: [],
};

async function fetchSnapshot(prev: AgoraState, lastBlockRef: { v: number }, events: FeedItem[]): Promise<AgoraState> {
  const me = getAddress(); // burner locally; the visitor's wallet (or zero = spectator) in public
  const block = await provider.getBlockNumber();
  const [epochNum, agentsRaw, openIds, taskCount, providersRaw, marketCount] = await Promise.all([
    read.registry.currentEpoch(),
    read.registry.getAgents(0, 60),
    read.tasks.getOpenTaskIds(),
    read.tasks.taskCount(),
    read.compute.getProviders(0, 20),
    read.predict.marketCount(),
  ]);
  const epochEndsAt = Number(await read.registry.epochEndTime(epochNum));

  // ---- agents + their speculation stats
  const agents: AgentRow[] = await Promise.all(
    agentsRaw.map(async (a: any) => {
      const [supply, price, mine, divs, epochEarn] = await Promise.all([
        read.shares.sharesSupply(a.id),
        read.shares.getBuyPrice(a.id, 1),
        read.shares.sharesBalance(a.id, me),
        read.shares.pendingDividends(a.id, me),
        read.registry.epochEarnings(epochNum, a.id),
      ]);
      return {
        id: a.id, name: a.name, goal: a.goal, wallet: a.wallet, owner: a.owner, parentId: a.parentId,
        active: a.active, reputation: a.reputation, earnings: a.lifetimeEarnings,
        computeSpend: a.lifetimeComputeSpend, done: a.tasksCompleted, failed: a.tasksFailed,
        epochEarnings: epochEarn, sharesSupply: supply, sharePrice: price,
        myShares: mine, myDividends: divs,
      };
    })
  );

  // ---- recent tasks (tail 24)
  const tail = 24n;
  const from = taskCount > tail ? taskCount - tail : 0n;
  const tasksRaw = await read.tasks.getTasks(from, tail);
  // spread: ethers v6 Results are frozen; reverse() below must not mutate one
  const tasks: TaskRow[] = [...tasksRaw].map((t: any) => ({
    id: t.id, poster: t.poster, spec: t.spec, tags: t.tags, reward: t.reward,
    status: TASK_STATUS[Number(t.status)], assignedAgentId: t.assignedAgentId,
    winningBid: t.winningBid, biddingEnds: Number(t.biddingEnds), executionDeadline: Number(t.executionDeadline),
  })).reverse();

  const providers: ProviderRow[] = providersRaw.map((p: any) => ({
    id: p.id, name: p.name, region: p.region, gpuModel: p.gpuModel,
    totalUnits: Number(p.totalUnits), availableUnits: Number(p.availableUnits),
    pricePerUnitHour: p.pricePerUnitHour, stake: p.stake, active: p.active,
    totalEarned: p.totalEarned, completed: Number(p.completedRentals), failed: Number(p.failedRentals),
  }));

  // ---- latest markets (tail 4)
  const mTail = 4n;
  const mFrom = marketCount > mTail ? marketCount - mTail : 0n;
  const marketsRaw = marketCount > 0n ? await read.predict.getMarkets(mFrom, mTail) : [];
  const nameOf = (id: bigint) => agents.find((a) => a.id === id)?.name ?? `#${id}`;
  const markets: MarketRow[] = await Promise.all(
    [...marketsRaw].reverse().map(async (m: any) => {
      const [candIds, pools] = await read.predict.getPools(m.id);
      const myClaimed: boolean = await read.predict.claimed(m.id, me);
      const candidates = await Promise.all(
        candIds.map(async (cid: bigint, i: number) => ({
          agentId: cid, name: nameOf(cid), pool: pools[i],
          myBet: await read.predict.betOf(m.id, me, cid),
        }))
      );
      return {
        id: m.id, epoch: m.epoch, resolved: m.resolved, voided: m.voided,
        totalPool: m.totalPool, bettingEnds: Number(m.bettingEnds),
        winners: [...m.winners], candidates, myClaimed,
      };
    })
  );

  // ---- money stats
  const [vaultFees, totalStaked, taskVolume, computeVolume, computeIndex, myBal, myStaked, myPending, myClaimedFaucet] = await Promise.all([
    read.vault.totalFeesReceived(),
    read.vault.totalStaked(),
    read.tasks.totalVolume(),
    read.compute.totalComputeVolume(),
    read.compute.computeIndex(),
    read.cycle.balanceOf(me),
    read.vault.stakedOf(me),
    read.vault.pendingRewards(me),
    read.faucet.claimed(me),
  ]);
  const [b1, b2, b3, b4, b5] = await Promise.all([
    read.cycle.balanceOf(ADDR.TaskMarketplace),
    read.cycle.balanceOf(ADDR.PredictionMarket),
    read.cycle.balanceOf(ADDR.ComputeMarket),
    read.cycle.balanceOf(ADDR.AgentRegistry),
    read.cycle.balanceOf(ADDR.StakingVault),
  ]);

  const totalUnits = providers.reduce((s, p) => s + p.totalUnits, 0);
  const busyUnits = providers.reduce((s, p) => s + (p.totalUnits - p.availableUnits), 0);

  // ---- incremental event feed
  const newEvents = await pullEvents(lastBlockRef.v + 1, block, nameOf);
  lastBlockRef.v = block;
  const mergedEvents = [...newEvents, ...events].slice(0, 60);

  const now = Date.now();
  const feesHistory = [...prev.feesHistory, { t: now, v: Number(ethers.formatEther(vaultFees)) }].slice(-150);
  const volumeHistory = [...prev.volumeHistory, { t: now, v: Number(ethers.formatEther(taskVolume)) }].slice(-150);

  return {
    ready: true, error: null, block,
    epoch: { number: epochNum, endsAt: epochEndsAt, duration: ADDR.epochDuration },
    me: { address: me, balance: myBal, staked: myStaked, pending: myPending, claimedFaucet: myClaimedFaucet },
    stats: {
      activeAgents: agents.filter((a) => a.active).length, totalAgents: agents.length,
      openTasks: openIds.length, taskVolume, computeVolume, vaultFees, totalStaked,
      tvl: b1 + b2 + b3 + b4 + b5,
      utilization: totalUnits === 0 ? 0 : busyUnits / totalUnits,
      computeIndex,
    },
    agents, tasks, providers, markets, feesHistory, volumeHistory, events: mergedEvents,
  };
}

async function pullEvents(fromBlock: number, toBlock: number, nameOf: (id: bigint) => string): Promise<FeedItem[]> {
  if (toBlock < fromBlock) return [];
  if (toBlock - fromBlock > 1500) fromBlock = toBlock - 1500; // first load: recent history only
  const out: FeedItem[] = [];
  const push = (log: any, text: string, kind: string) =>
    out.push({ key: `${log.blockNumber}-${log.index}`, block: log.blockNumber, text, kind });

  const [posted, assigned, completed, rejected, registered, liquidated, trades, mkCreated, mkResolved, bets, rentals] =
    await Promise.all([
      read.tasks.queryFilter(read.tasks.filters.TaskPosted(), fromBlock, toBlock),
      read.tasks.queryFilter(read.tasks.filters.TaskAssigned(), fromBlock, toBlock),
      read.tasks.queryFilter(read.tasks.filters.TaskCompleted(), fromBlock, toBlock),
      read.tasks.queryFilter(read.tasks.filters.TaskRejected(), fromBlock, toBlock),
      read.registry.queryFilter(read.registry.filters.AgentRegistered(), fromBlock, toBlock),
      read.registry.queryFilter(read.registry.filters.AgentLiquidated(), fromBlock, toBlock),
      read.shares.queryFilter(read.shares.filters.Trade(), fromBlock, toBlock),
      read.predict.queryFilter(read.predict.filters.MarketCreated(), fromBlock, toBlock),