import { createHash } from "node:crypto";
import {
  JsonRpcProvider, Wallet, formatEther, parseEther, hexlify, toUtf8Bytes, isAddress, getAddress,
} from "ethers";

/**
 * THE CHAIN LAYER — Robinhood Chain (an Arbitrum-Orbit Ethereum L2, ETH gas).
 * Every on-chain concern lives here: provider, key handling, serialized
 * sending (one nonce lane per wallet), deterministic deposit addresses,
 * drain-to-treasury sweeps, and proof "memos" (JSON in tx calldata — the EVM
 * equivalent of a Solana memo, readable on Blockscout under "Raw input").
 */

// ------------------------------------------------------------------ network
export const RPC =
  process.env.RH_RPC ?? process.env.EVM_RPC ?? process.env.SOLANA_RPC /* legacy var, ignore if solana url */ ?? "https://rpc.testnet.chain.robinhood.com";
const rpcLooksSolana = /helius|solana/i.test(RPC);
export const RPC_URL = rpcLooksSolana ? "https://rpc.testnet.chain.robinhood.com" : RPC;

// Robinhood Chain: mainnet 4663 (0x123F), testnet 46630 (0xB626). The live
// chainId is re-read from the node at boot (detectChain) — these are defaults
// so /state and wallet add-chain params work before the first RPC roundtrip.
export const DEFAULT_CHAIN_ID = /testnet/i.test(RPC_URL) ? 46630 : 4663;

export interface ChainInfo {
  chainId: number;
  network: "mainnet" | "testnet" | "custom";
  name: string;
  rpc: string;
  explorer: string;       // Blockscout base, no trailing slash
  faucet: string | null;
}

function infoFor(chainId: number): ChainInfo {
  if (chainId === 4663) return {
    chainId, network: "mainnet", name: "Robinhood Chain",
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    explorer: process.env.EXPLORER_URL?.replace(/\/$/, "") ?? "https://robinhoodchain.blockscout.com",
    faucet: null,
  };
  if (chainId === 46630) return {
    chainId, network: "testnet", name: "Robinhood Chain Testnet",
    rpc: "https://rpc.testnet.chain.robinhood.com",
    explorer: process.env.EXPLORER_URL?.replace(/\/$/, "") ?? "https://explorer.testnet.chain.robinhood.com",
    faucet: "https://faucet.testnet.chain.robinhood.com",
  };
  return {
    chainId, network: "custom", name: `EVM chain ${chainId}`,
    rpc: RPC_URL,
    explorer: process.env.EXPLORER_URL?.replace(/\/$/, "") ?? "",
    faucet: null,
  };
}

export let chain: ChainInfo = infoFor(DEFAULT_CHAIN_ID);
// wallets add the chain by OUR advertised rpc (the public one), never a keyed url
chain = { ...chain, rpc: chain.network === "custom" ? RPC_URL : chain.rpc };

export const provider = new JsonRpcProvider(RPC_URL, undefined, { polling: true, pollingInterval: 1200 });

/** Ask the node who it actually is; corrects the default if RPC_URL is custom. */
export async function detectChain(): Promise<ChainInfo> {
  try {
    const net = await provider.getNetwork();
    chain = { ...infoFor(Number(net.chainId)), rpc: chain.rpc };
  } catch { /* keep defaults; the arena still boots and retries on use */ }
  return chain;
}

export const explorerTx = (hash: string) => (chain.explorer ? `${chain.explorer}/tx/${hash}` : "");
export const explorerAddress = (addr: string) => (chain.explorer ? `${chain.explorer}/address/${addr}` : "");

// ------------------------------------------------------------------- keys
/**
 * EVM secrets: 0x-prefixed (or bare) 32-byte hex private key, or a JSON byte
 * array of 32 bytes. Auto-generated keys persist to state/keys.json.
 */
export function decodeSecret(v?: string): Wallet | null {
  const t = v?.trim();
  if (!t) return null;
  try {
    if (t.startsWith("[")) {
      const bytes: number[] = JSON.parse(t);
      if (bytes.length !== 32) return null;
      return new Wallet(hexlify(Uint8Array.from(bytes)), provider);
    }
    const hex = t.startsWith("0x") ? t : `0x${t}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) return null;
    return new Wallet(hex, provider);
  } catch { return null; }
}

export const randomWallet = () => new Wallet(Wallet.createRandom().privateKey, provider);

/** Deterministic deposit wallet: sha256(treasuryKey | label) → private key.
 *  Stateless — the same treasury key always re-derives the same addresses. */
export function depositWallet(treasury: Wallet, label: string): Wallet {
  const seed = createHash("sha256").update(treasury.privateKey).update(label).digest();
  return new Wallet(hexlify(seed), provider);
}

export const validAddress = (v: unknown): string | null => {
  try { return getAddress(String(v)); } catch { return null; }
};

// ------------------------------------------------------------- eth <-> num
// Server-side accounting is in ETH floats (JSON-safe, display-ready); exact
// wei only exists at the moment a tx is built. Precision loss is <1e-15 ETH.
export const weiToEth = (wei: bigint): number => Number(formatEther(wei));
export const ethToWei = (eth: number): bigint => parseEther(Math.max(0, eth).toFixed(18));

// ------------------------------------------------------------------ sending
// ONE NONCE LANE PER WALLET: concurrent settlements from the same signer are
// serialized through a promise chain, so nonces never collide and a dropped
// tx can't wedge the ones behind it (each send re-reads the pending nonce).
const lanes = new Map<string, Promise<unknown>>();
function inLane<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = lanes.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  lanes.set(key, next.catch(() => {}));
  return next;
}

/** Share the wallet's nonce lane with higher-level contract interactions. */
export const withWalletLane = <T>(wallet: Wallet, fn: () => Promise<T>): Promise<T> =>
  inLane(wallet.address, fn);

export interface SendResult { hash: string; ethMoved: number; }

/** Transfer ETH (and/or anchor a memo) in ONE transaction. `memo` rides as
 *  calldata — Blockscout shows it under the tx's raw input, UTF-8 decodable. */
export async function sendEth(from: Wallet, to: string, wei: bigint, memo?: object): Promise<SendResult> {
  return inLane(from.address, async () => {
    const data = memo ? hexlify(toUtf8Bytes(JSON.stringify(memo))) : undefined;