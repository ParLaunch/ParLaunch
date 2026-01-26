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