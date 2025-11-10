import { ethers } from "ethers";
import http from "node:http";
import { loadAddresses, makeProvider, walletAt, contractsFor, fmt, E } from "./lib/chain";
import { paint, sleep } from "./lib/log";
import { AgentRunner } from "./agent";
import { ProviderSim, RIGS } from "./provider-sim";
import { HostProvider } from "./host-provider";
import { TaskFaucet, MarketMaker } from "./faucet";
import { ROOT_PERSONAS, USER_STRATEGIES } from "./personas";

/**
 * The AGORA live demo: one process, a whole economy.
 *   - 2 simulated DePIN compute providers list real on-chain capacity
 *   - 4 autonomous agents (+ any children they spawn) bid, rent, work, earn
 *   - a task faucet posts paid work and VERIFIES results
 *   - speculators trade agent shares and bet the epoch earnings race
 * Run with --duration <secs> for a bounded run (default: until Ctrl+C).
 */

const MAX_TOTAL_AGENTS = 12; // roots + spawned children + reaper rebirths

async function main() {
  const durationArg = process.argv.indexOf("--duration");
  const durationSecs = durationArg > -1 ? parseInt(process.argv[durationArg + 1]) : 0;

  const addresses = loadAddresses();
  const provider = makeProvider(addresses);
  try {
    await provider.getBlockNumber();
  } catch {
    console.error(paint.red("cannot reach the chain at " + addresses.rpcUrl + " - start it with: npm run node (in contracts/)"));
    process.exit(1);
  }

  console.log(paint.bold("\n  ╔═══════════════════════════════════════════════════════╗"));
  console.log(paint.bold("  ║   AGORA - the autonomous agent economy  [local demo]   ║"));
  console.log(paint.bold("  ╚═══════════════════════════════════════════════════════╝\n"));

  const runners: AgentRunner[] = [];
  const stoppables: Array<{ stop: () => void }> = [];

  const onSpawn = (child: AgentRunner) => {
    if (runners.length >= MAX_TOTAL_AGENTS) return;
    runners.push(child);
    stoppables.push(child);
    child.start().catch((e) => console.error(paint.red(`child agent crashed: ${e?.message ?? e}`)));
  };

  // compute providers first: agents need somewhere to rent.
  // provider #1 is THIS MACHINE - real cores, real RAM, really metered.
  const host = new HostProvider(walletAt(2, provider), addresses);
  stoppables.push(host);
  host.start().catch((e) => console.error(paint.red(`host provider crashed: ${e?.message ?? e}`)));
  for (const rig of RIGS) {
    const sim = new ProviderSim(rig, walletAt(rig.accountIndex, provider), addresses);
    stoppables.push(sim);
    sim.start().catch((e) => console.error(paint.red(`provider crashed: ${e?.message ?? e}`)));
  }

  // the human side: work + money + degeneracy
  const faucet = new TaskFaucet(walletAt(1, provider), addresses);
  stoppables.push(faucet);
  faucet.start().catch((e) => console.error(paint.red(`faucet crashed: ${e?.message ?? e}`)));

  const maker = new MarketMaker(walletAt(13, provider), addresses, provider);
  stoppables.push(maker);
  maker.start().catch((e) => console.error(paint.red(`market maker crashed: ${e?.message ?? e}`)));

  // the stars of the show
  for (const p of ROOT_PERSONAS) {
    const runner = new AgentRunner(p, walletAt(p.accountIndex, provider), addresses, onSpawn);