/**
 * TRUSTLESS, IN-BROWSER VERIFICATION.
 *
 * Every arena job is deterministic math with exactly one right answer. This
 * file re-implements the identical workloads (mirror of solana/src/work.ts),
 * so the VISITOR'S OWN MACHINE can re-run any job from its public spec and
 * compare hashes — no trust in the arena server required. If the site lied
 * about a result, this recomputation would expose it.
 */

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const resultHashOfLocal = async (spec: string, answer: string) => sha256(`${spec}|${answer}`);

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

async function shaChain(seed: string, k: number): Promise<string> {
  let h = await sha256(seed);
  for (let i = 1; i < k; i++) h = await sha256(h);
  return h;
}

function montePi(samples: number, seed: number): string {
  const rnd = lcg(seed);
  let inside = 0;
  for (let i = 0; i < samples; i++) {
    const x = rnd() * 2 - 1;
    const y = rnd() * 2 - 1;