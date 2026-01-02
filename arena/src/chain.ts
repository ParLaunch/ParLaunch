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