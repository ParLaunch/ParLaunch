import { createHash } from "node:crypto";

/**
 * The WORK. Compute jobs are deterministic, machine-verifiable workloads:
 * the arena posts a spec, an agent computes the answer on real silicon
 * (vast.ai GPU, the arena host, or the owner's own rig), and the arena
 * re-derives the answer to verify the submitted hash. Revenue is earned,
 * never granted.
 *
 * Spec grammar: "KIND:arg1,arg2"
 */

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const resultHashOf = (spec: string, answer: string) => sha256(`${spec}|${answer}`);

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function primeSum(n: number): bigint {
  const limit = Math.max(1000, Math.floor(n * (Math.log(n + 1) + Math.log(Math.log(n + 3))) * 1.3) + 100);
  const sieve = new Uint8Array(limit + 1);
  let count = 0;
  let sum = 0n;
  for (let i = 2; i <= limit && count < n; i++) {
    if (!sieve[i]) {
      count++;
      sum += BigInt(i);
      for (let j = i * i; j <= limit; j += i) sieve[j] = 1;
    }
  }
  return sum;
}

function shaChain(seed: string, k: number): string {
  let h = sha256(seed);
  for (let i = 1; i < k; i++) h = sha256(h);
  return h;
}

function montePi(samples: number, seed: number): string {
  const rnd = lcg(seed);
  let inside = 0;
  for (let i = 0; i < samples; i++) {
    const x = rnd() * 2 - 1;
    const y = rnd() * 2 - 1;
    if (x * x + y * y <= 1) inside++;
  }
  return ((4 * inside) / samples).toFixed(4);
}

function matmulTrace(seed: number, n: number): bigint {
  const rnd = lcg(seed);
  const a: number[][] = [];
  for (let i = 0; i < n; i++) {
    a.push([]);
    for (let j = 0; j < n; j++) a[i].push(Math.floor(rnd() * 1000));
  }
  let tr = 0n;
  for (let i = 0; i < n; i++)
    for (let k = 0; k < n; k++) tr += BigInt(a[i][k] * a[k][i]);
  return tr;
}

const MEME_SUBJECTS = ["gpu-poor devs", "the compute cartel", "agent #4", "liquidity", "my sub-agent", "the mempool", "validators", "a lone H100"];
const MEME_VERBS = ["outbidding", "rugging", "compounding into", "yield farming", "shitposting about", "frontrunning", "staking against", "diamond-handing"];
const MEME_PUNCH = ["and it's beautiful", "wagmi (machine edition)", "sers, we are the exit liquidity", "raw compute never sleeps", "the flippening is compute", "gm = gpu morning", "this epoch we eat", "slashed but not shaken"];

function meme(seed: number): string {
  const rnd = lcg(seed);
  const pick = (arr: string[]) => arr[Math.floor(rnd() * arr.length)];
  return `${pick(MEME_SUBJECTS)} ${pick(MEME_VERBS)} ${pick(MEME_SUBJECTS)} - ${pick(MEME_PUNCH)}`;
}

/** Guards user-supplied specs (e.g. /verify) so a huge param can't freeze the
 *  single-threaded server. Generated jobs are already within these bounds. */
export function isSpecSafe(spec: string): boolean {
  const [kind, argstr] = spec.split(":");
  const args = (argstr ?? "").split(",");
  const n = (i: number) => parseInt(args[i]);
  switch (kind) {
    case "PRIME_SUM": return n(0) > 0 && n(0) <= 20_000;
    case "SHA_CHAIN": return (args[0]?.length ?? 0) <= 80 && n(1) > 0 && n(1) <= 2_000;
    case "MONTE_PI": return n(0) > 0 && n(0) <= 500_000 && Number.isFinite(n(1));
    case "MATMUL_TRACE": return Number.isFinite(n(0)) && n(1) > 0 && n(1) <= 96;
    case "MEME": return Number.isFinite(n(0));
    default: return false;
  }
}

export function solve(spec: string): string {
  const [kind, argstr] = spec.split(":");
  const args = (argstr ?? "").split(",");
  switch (kind) {
    case "PRIME_SUM": return primeSum(parseInt(args[0])).toString();
    case "SHA_CHAIN": return shaChain(args[0], parseInt(args[1]));
    case "MONTE_PI": return montePi(parseInt(args[0]), parseInt(args[1]));
    case "MATMUL_TRACE": return matmulTrace(parseInt(args[0]), parseInt(args[1])).toString();
    case "MEME": return meme(parseInt(args[0]));
    default: throw new Error(`unknown job kind: ${kind}`);
  }
}

// ---------------------------------------------------------------- job model
export interface ComputeJob {