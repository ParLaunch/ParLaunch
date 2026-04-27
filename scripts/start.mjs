/**
 * One-command AGORA: chain -> deploy -> agent swarm -> dashboard.
 * Usage: npm start   (Ctrl+C stops everything)
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const children = [];

const COLORS = { chain: "\x1b[90m", deploy: "\x1b[36m", agents: "\x1b[0m", web: "\x1b[35m" };

function run(tag, cmd, args, cwd, { pipe = true } = {}) {
  const child = spawn(cmd, args, { cwd: path.join(root, cwd), shell: true });
  children.push(child);
  const color = COLORS[tag] ?? "\x1b[0m";
  const prefix = `${color}[${tag}]\x1b[0m `;
  if (pipe) {
    const fwd = (stream, out) =>
      stream.on("data", (d) =>
        String(d).split(/\r?\n/).filter(Boolean).forEach((l) => out.write(prefix + l + "\n"))
      );
    fwd(child.stdout, process.stdout);
    fwd(child.stderr, process.stderr);
  }
  return child;
}

async function waitForRpc(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}',
      });
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new Error(`chain did not come up at ${url} within ${timeoutMs / 1000}s`);
}

function shutdown(code = 0) {
  for (const c of children) {
    try { c.kill("SIGINT"); } catch { /* already gone */ }
  }
  // give children a beat to die, then hard-exit
  setTimeout(() => process.exit(code), 1500);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log("\x1b[1m\nAGORA - bringing up the whole economy...\x1b[0m\n");

// 1. chain (quiet - hardhat node logs every tx, far too chatty)
run("chain", "npx", ["hardhat", "node"], "contracts", { pipe: false });
console.log("[chain] starting hardhat node on http://127.0.0.1:8545 ...");
await waitForRpc("http://127.0.0.1:8545");
console.log("[chain] up.");

// 2. deploy + export ABIs/addresses
await new Promise((resolve, reject) => {
  const d = run("deploy", "npx", ["hardhat", "run", "scripts/deploy.ts", "--network", "localhost"], "contracts");
  d.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`deploy failed (${code})`))));
});

// 3. the agent swarm + human-side sim
run("agents", "npx", ["tsx", "src/demo.ts"], "agents");

// 4. Hedge Bots arena (Robinhood Chain)
run("arena", "npx", ["tsx", "src/service.ts"], "arena");

// 5. dashboard
run("web", "npx", ["vite", "--port", "5173"], "web");
console.log("\x1b[1m\n  landing:  http://localhost:5173\n  arena:    http://localhost:5173/app\n  docs:     http://localhost:5173/docs  (Ctrl+C stops everything)\n\x1b[0m");
