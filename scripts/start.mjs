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