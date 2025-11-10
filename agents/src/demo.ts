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
    runners.push(runner);
    stoppables.push(runner);
    runner.start().catch((e) => console.error(paint.red(`agent ${p.name} crashed: ${e?.message ?? e}`)));
    await sleep(900); // stagger startup
  }

  // ------------------------------------- user-created agents (terminal UI)
  // POST /create {name, strategy} -> fresh agent wallet (key stays here; the
  // server runs the brain). The USER then registers it on-chain from their
  // own wallet (they pay the stake, they're the on-chain owner) and sends it
  // working CYCLE. Once registered we gas it and start the loop.
  interface PendingUserAgent { wallet: ethers.Wallet; personaKey: string; name: string; running: boolean; }
  const userAgents = new Map<string, PendingUserAgent>();
  const gasFunder = walletAt(1, provider); // 10k test ETH available locally
  const statusReg = contractsFor(provider, addresses).registry;

  const api = http.createServer(async (req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,OPTIONS" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "OPTIONS") return send(204, {});
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/create") {
      let body = ""; req.on("data", (d) => (body += d));
      req.on("end", () => {
        try {
          const { name, strategy } = JSON.parse(body || "{}");
          if (!name || String(name).length > 24) return send(400, { error: "name required (max 24 chars)" });
          if (!USER_STRATEGIES[strategy]) return send(400, { error: "unknown strategy" });
          if (runners.length >= MAX_TOTAL_AGENTS + 8) return send(400, { error: "arena is full right now" });
          const w = ethers.Wallet.createRandom().connect(provider) as unknown as ethers.Wallet;
          userAgents.set(w.address.toLowerCase(), { wallet: w, personaKey: strategy, name: String(name), running: false });
          console.log(paint.bold(`  [api] user agent "${name}" (${strategy}) awaiting on-chain registration at ${w.address}`));
          send(200, { agentWallet: w.address, minStake: "100", suggestedFund: "600" });
        } catch (e: any) { send(400, { error: String(e?.message ?? e).slice(0, 120) }); }
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/status") {
      const addr = String(url.searchParams.get("wallet") ?? "").toLowerCase();
      const p = userAgents.get(addr);
      if (!p) return send(404, { error: "unknown agent wallet" });
      const id = await statusReg.walletToAgentId(p.wallet.address).catch(() => 0n);
      return send(200, { registered: id !== 0n, running: p.running, agentId: String(id) });
    }
    send(404, { error: "not found" });
  });
  api.listen(8790, () => console.log(paint.gray("  [api] agent-creation API on http://localhost:8790")));

  // watcher: once the user registers + funds, gas it and wake the brain
  const userWatcher = setInterval(async () => {
    for (const p of userAgents.values()) {
      if (p.running) continue;
      try {
        const id: bigint = await statusReg.walletToAgentId(p.wallet.address);
        if (id === 0n) continue;
        const gas = await provider.getBalance(p.wallet.address);
        if (gas < ethers.parseEther("0.2")) {
          await (await gasFunder.sendTransaction({ to: p.wallet.address, value: ethers.parseEther("0.5") })).wait();
        }
        p.running = true;
        const persona = USER_STRATEGIES[p.personaKey].make(p.name);
        const runner = new AgentRunner(persona, p.wallet, addresses, onSpawn);
        runners.push(runner);
        stoppables.push(runner);
        runner.start().catch((e) => console.error(paint.red(`user agent crashed: ${e?.message ?? e}`)));
        console.log(paint.bold(`  [api] user agent "${p.name}" is LIVE (agent #${id}) - bidding in the arena`));
      } catch { /* next sweep */ }
    }