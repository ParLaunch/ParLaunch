import { ethers } from "ethers";
import addresses from "../generated/addresses.json";
import CycleTokenAbi from "../generated/abi/CycleToken.json";
import AgentRegistryAbi from "../generated/abi/AgentRegistry.json";
import StakingVaultAbi from "../generated/abi/StakingVault.json";
import AgentSharesAbi from "../generated/abi/AgentShares.json";
import TaskMarketplaceAbi from "../generated/abi/TaskMarketplace.json";
import ComputeMarketAbi from "../generated/abi/ComputeMarket.json";
import PredictionMarketAbi from "../generated/abi/PredictionMarket.json";
import CycleFaucetAbi from "../generated/abi/CycleFaucet.json";

export const ADDR = addresses as typeof addresses & Record<string, any>;

/** Local sandbox (hardhat) uses a funded burner key; public networks use the
 *  visitor's own wallet (MetaMask etc). Reads never need a wallet at all -
 *  spectator mode is first-class. */
export const isLocalChain = Number(ADDR.chainId) === 31337;

export const provider = new ethers.JsonRpcProvider(ADDR.rpcUrl, Number(ADDR.chainId), {
  pollingInterval: isLocalChain ? 1500 : 4000,
  cacheTimeout: -1, // instant-mining local chain: never serve stale nonces
  staticNetwork: true,
});

// ---------------------------------------------------------------- signing
const MNEMONIC = "test test test test test test test test test test test junk";

let signer: ethers.Signer | null = null;
let signerAddress: string | null = null;

if (isLocalChain) {
  const node = ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/15`);
  const w = new ethers.Wallet(node.privateKey, provider);
  signer = w;
  signerAddress = w.address;
} else if ((window as any).ethereum) {
  // silent reconnect if the site was previously authorized
  (window as any).ethereum.request({ method: "eth_accounts" })
    .then(async (accounts: string[]) => {
      if (accounts.length > 0) {
        const bp = new ethers.BrowserProvider((window as any).ethereum);
        signer = await bp.getSigner();
        signerAddress = ethers.getAddress(accounts[0]);
      }
    })
    .catch(() => { /* spectator mode */ });
}

export function getAddress(): string { return signerAddress ?? ethers.ZeroAddress; }
export function isConnected(): boolean { return signerAddress !== null; }

/** Connect the visitor's wallet and make sure it's on the right chain. */
export async function connectWallet(): Promise<string> {
  if (isLocalChain) return signerAddress!;
  const eth = (window as any).ethereum;
  if (!eth) throw new Error("No wallet found - install MetaMask (metamask.io), then reload");

  const hexChainId = "0x" + Number(ADDR.chainId).toString(16);
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexChainId }] });
  } catch (err: any) {
    if (err?.code === 4902) {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: hexChainId,
          chainName: "Base Sepolia",
          rpcUrls: [ADDR.rpcUrl],
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          blockExplorerUrls: [ADDR.explorer || "https://sepolia.basescan.org"],
        }],
      });
    } else if (err?.code !== -32002) {
      throw err;
    }
  }
  const accounts: string[] = await eth.request({ method: "eth_requestAccounts" });
  const bp = new ethers.BrowserProvider(eth);
  signer = await bp.getSigner();
  signerAddress = ethers.getAddress(accounts[0]);
  approvedFor = null; // re-check allowances for the new signer
  return signerAddress;
}

function requireSigner(): ethers.Signer {
  if (!signer) throw new Error("Connect your wallet first (top right)");
  return signer;
}

// ---------------------------------------------------------------- handles
function c(addr: string, abi: ethers.InterfaceAbi, s: ethers.Signer | ethers.Provider) {
  return new ethers.Contract(addr, abi, s);
}

/** Read-only handles - always available, wallet or not. */
export const read = {
  cycle: c(ADDR.CycleToken, CycleTokenAbi, provider),
  registry: c(ADDR.AgentRegistry, AgentRegistryAbi, provider),
  vault: c(ADDR.StakingVault, StakingVaultAbi, provider),
  shares: c(ADDR.AgentShares, AgentSharesAbi, provider),
  tasks: c(ADDR.TaskMarketplace, TaskMarketplaceAbi, provider),
  compute: c(ADDR.ComputeMarket, ComputeMarketAbi, provider),
  predict: c(ADDR.PredictionMarket, PredictionMarketAbi, provider),
  faucet: c(ADDR.CycleFaucet, CycleFaucetAbi, provider),
};

/** Signing handles - resolve the CURRENT signer at call time. */
export const write = {
  get cycle() { return c(ADDR.CycleToken, CycleTokenAbi, requireSigner()); },
  get registry() { return c(ADDR.AgentRegistry, AgentRegistryAbi, requireSigner()); },
  get vault() { return c(ADDR.StakingVault, StakingVaultAbi, requireSigner()); },
  get shares() { return c(ADDR.AgentShares, AgentSharesAbi, requireSigner()); },
  get tasks() { return c(ADDR.TaskMarketplace, TaskMarketplaceAbi, requireSigner()); },
  get predict() { return c(ADDR.PredictionMarket, PredictionMarketAbi, requireSigner()); },
  get faucet() { return c(ADDR.CycleFaucet, CycleFaucetAbi, requireSigner()); },
};

/** The swarm's agent-creation API (runs with npm run demo). */
export const AGENTS_API = (import.meta as any).env?.VITE_AGENTS_API ?? "http://localhost:8790";

let approvedFor: string | null = null;
/** One-time max-approve of every protocol contract before the first action. */
export async function ensureApprovals(): Promise<void> {
  const me = getAddress();
  if (approvedFor === me) return;
  const spenders = [ADDR.StakingVault, ADDR.AgentShares, ADDR.TaskMarketplace, ADDR.PredictionMarket, ADDR.AgentRegistry];
  for (const s of spenders) {
    const allowance: bigint = await read.cycle.allowance(me, s);
    if (allowance < ethers.MaxUint256 / 2n) {
      await (await write.cycle.approve(s, ethers.MaxUint256)).wait();
    }
  }
  approvedFor = me;
}

// ---------------------------------------------------------------- utils
export const E = (n: string | number) => ethers.parseEther(String(n));

export function fmt(wei: bigint | undefined, dp = 1): string {
  if (wei === undefined) return "-";
  const v = Number(ethers.formatEther(wei));
  if (v === 0) return "0";
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + "M";
  if (v >= 10_000) return (v / 1000).toFixed(1) + "K";
  if (v >= 1000) return Math.round(v).toLocaleString("en-US");
  if (v < 0.01) return v.toExponential(1);
  return v.toFixed(dp);
}

export function shortAddr(a: string): string {
  return a.slice(0, 6) + ".." + a.slice(-4);
}

/** Stable agent color: identity follows the entity, never its rank.
 *  Validated LIGHT-surface categorical palette. */
const SERIES = ["#2a78d6", "#1baf7a", "#eda100", "#008300", "#4a3aa7", "#e34948", "#e87ba4", "#eb6834"];
export function agentColor(agentId: bigint | number): string {
  const idx = Math.max(0, Number(agentId) - 1);
  return SERIES[idx % SERIES.length];
}

export const TASK_STATUS = ["Open", "Assigned", "Submitted", "Completed", "Rejected", "Expired", "Cancelled"] as const;
export const STATUS_COLOR: Record<string, string> = {
  Open: "#2a78d6",
  Assigned: "#d97706",
  Submitted: "#ec835a",
  Completed: "#0ca30c",
  Rejected: "#d03b3b",
  Expired: "#d03b3b",
  Cancelled: "#8b8797",
};
