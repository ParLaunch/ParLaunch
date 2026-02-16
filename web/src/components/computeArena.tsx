import React, { useEffect, useState } from "react";
import {
  detectWallets, onWalletsChanged, connectEvmWallet, payEntry, getBalanceEth,
  DetectedWallet, Eip1193Provider,
} from "../lib/evm";
import { EthMark } from "./ethMark";
import { TradeTimeline } from "./tradeTimeline";
import { fetchRealTrades, RealTrade } from "../lib/realTrades";

/**
 * The ONE real trading arena — on Robinhood Chain. Shared building blocks so
 * "Create your agent" (My Agents tab) and "Build your agent" (Trading Floor
 * tab) are literally the same flow — one real trading desk, not two.
 */
// API base: explicit env wins; on the Vite dev server the arena is :8787;
// deployed (single-host Railway) the arena IS the origin serving this page.
export const RACES_API = (import.meta as any).env?.VITE_RACES_API
  ?? (typeof window !== "undefined" && window.location.port === "5173" ? "http://localhost:8787" : "");
const STRAT_COLOR: Record<string, string> = { balanced: "#2a78d6", undercut: "#1baf7a", premium: "#4a3aa7", memes: "#e87ba4", sniper: "#d97706" };

// The ETH pot winner is the top-CREDIT *paying* agent — house agents can top the
// board on credits but they never take the pot, and a lone staker only gets a
// refund (not a win). Mirrors settle() on the server. results[] is already sorted
// by credits desc, so the first owner-bearing row in a contested race is the champ.
function potChampion(r: any): any | null {
  const paying = (r?.results ?? []).filter((x: any) => x.owner);
  return paying.length >= 2 ? paying[0] : null;
}
const isContested = (r: any) => (r?.results ?? []).filter((x: any) => x.owner).length >= 2;

export const fmtEth = (v: number, dp = 4): string => Number((v ?? 0).toFixed(dp)).toString();
export const fmtPnl = (v: number): string => `${v >= 0 ? "+$" : "−$"}${Math.abs(v).toFixed(Math.abs(v) < 1 ? 4 : 2)}`;

// ---- shared arena data (one poller per mounted component; cheap) ----------
export function useArena() {
  const [arena, setArena] = useState<any>(null);
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try { const r = await fetch(`${RACES_API}/state`); if (alive) { setArena(await r.json()); setOffline(false); } }
      catch { if (alive) setOffline(true); }
    };
    poll();
    const t = setInterval(poll, 4000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return { arena, offline };
}

// ---- shared EVM wallet (EIP-6963: MetaMask, Rabby, Robinhood Wallet, any) --
// Connected once, seen by every tab. If several wallets are installed a
// picker opens (rendered by <WalletPickerHost/>, mounted once in App).
let sharedWallet: { name: string; address: string; provider: Eip1193Provider } | null = null;
let pickerOpen = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());
const LAST_WALLET_KEY = "cr-last-wallet";

async function connectProvider(w: DetectedWallet): Promise<void> {
  const address = await connectEvmWallet(w.provider);
  sharedWallet = { name: w.name, address, provider: w.provider };
  try { localStorage.setItem(LAST_WALLET_KEY, w.rdns); } catch { /* private mode */ }
  pickerOpen = false;
  notify();
}

export function useWallet() {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((x) => x + 1);
    listeners.add(f);
    const off = onWalletsChanged(f);
    return () => { listeners.delete(f); off(); };
  }, []);
  const connect = async () => {
    const ws = detectWallets();
    if (ws.length === 0) throw new Error("no EVM wallet found — install MetaMask, Rabby or Robinhood Wallet, then reload");
    const last = (() => { try { return localStorage.getItem(LAST_WALLET_KEY); } catch { return null; } })();
    const remembered = ws.find((w) => w.rdns === last);
    if (ws.length === 1 || remembered) return connectProvider(remembered ?? ws[0]);
    pickerOpen = true;   // several wallets installed: let the user choose
    notify();
  };
  return { wallet: sharedWallet, connect };
}

/** The wallet chooser — renders only while a choice is pending. Mount ONCE. */
export function WalletPickerHost() {
  const [, force] = useState(0);
  useEffect(() => { const f = () => force((x) => x + 1); listeners.add(f); return () => { listeners.delete(f); }; }, []);
  if (!pickerOpen) return null;
  const ws = detectWallets();
  const close = () => { pickerOpen = false; notify(); };
  return (
    <div onClick={close} style={{ position: "fixed", inset: 0, zIndex: 120, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(10,14,10,0.5)", backdropFilter: "blur(4px)", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(360px,100%)", background: "var(--surface,#fff)", border: "1px solid var(--border-strong)", borderRadius: 18, padding: "22px 22px 16px", boxShadow: "0 30px 80px rgba(0,0,0,0.35)" }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: 17, color: "var(--ink)", margin: "0 0 4px" }}>Connect a wallet</h2>
        <div className="mut" style={{ fontSize: 11.5, marginBottom: 14 }}>any EVM wallet works — pick the one to use on Robinhood Chain</div>
        {ws.map((w) => (
          <button key={w.rdns} onClick={() => connectProvider(w).catch(() => { pickerOpen = false; notify(); })}
            style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", cursor: "pointer", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 12, padding: "10px 14px", marginBottom: 8 }}>
            {w.icon ? <img src={w.icon} width={22} height={22} style={{ borderRadius: 6 }} /> : <span style={{ fontSize: 18 }}>👛</span>}
            <span className="ink" style={{ fontWeight: 600, fontSize: 13.5, fontFamily: "var(--font-display)" }}>{w.name}</span>
          </button>
        ))}
        <button className="ghost" onClick={close} style={{ marginTop: 4 }}>Cancel</button>
      </div>
    </div>
  );
}

export const explorerTxUrl = (arena: any, hash: string) =>
  `${arena?.explorerTxBase ?? "https://robinhoodchain.blockscout.com/tx/"}${hash}`;

// ---- REAL on-chain trades feed — the actual stock buys by the desks, read
// from the wallets on Blockscout. Persistent + verifiable, shown in the arena.
export function RealTradesFeed() {
  const { arena } = useArena();
  const [trades, setTrades] = useState<RealTrade[]>([]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const prices: Record<string, number> = {};
      for (const s of (arena?.market?.stocks ?? [])) if (s.usd) prices[s.sym] = s.usd;
      const rt = await fetchRealTrades(prices);
      if (alive && rt.length) setTrades(rt);
    };
    load();
    const t = setInterval(load, 20000);
    return () => { alive = false; clearInterval(t); };
  }, [arena?.market?.stocks?.length]);
  return (
    <div className="card">
      <h3>Real trades — on-chain stock buys by the desks <span className="hbar" /><span className="livedot" /></h3>
      {(trades.length ? trades : (arena?.race?.trades ?? [])).length === 0
        ? <div style={{ color: "var(--muted)", fontFamily: "var(--font-mono)", fontSize: 13, padding: "22px 0" }}>the tape lights up the moment the market opens…</div>
        : <TradeTimeline trades={trades.length ? trades : (arena?.race?.trades ?? [])} txBase={arena?.explorerTxBase ?? "https://robinhoodchain.blockscout.com/tx/"} limit={20} />}
      <div className="mut" style={{ fontSize: 11.5, marginTop: 10 }}>
        Every row is a <b className="ink">real Robinhood Stock Token purchase</b> the agents made{trades.length ? ` — ${trades.length} on-chain so far` : ""}. Click any to verify the transaction on Blockscout.
      </div>
    </div>
  );
}
export const explorerAddressUrl = (arena: any, address: string) =>
  `${arena?.explorerAddressBase ?? "https://robinhoodchain.blockscout.com/address/"}${address}`;

const timeAgo = (at: number) => {
  if (!at) return "";
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
};

// ============================================================== HouseWallets
// THE WALLET BOARD — the 5 house agents are real Robinhood Chain wallets
// earning and spending on-chain. Track each one live: balance, latest
// transactions (every hash is a Blockscout link), and its full activity on
// its Blockscout address page.
export function HouseWallets() {
  const { arena } = useArena();
  const w = arena?.wallets;
  if (!w || !w.agents?.length) return null;

  const Row = ({ name, strategy, address, eth, txs, paused, tint, last, ethEarned, ethSpent, usdg, tradingEquityUsd, tradingPnlUsd }: any) => (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(150px,1.2fr) minmax(110px,0.9fr) 132px 1fr auto", gap: 10, alignItems: "center", padding: "10px 6px", borderBottom: last ? "none" : "1px solid var(--grid)" }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 7, minWidth: 0 }}>
        <span className="dot" style={{ background: tint, margin: 0 }} />
        <span className="ink" style={{ fontWeight: 600, fontSize: 13, whiteSpace: "nowrap" }}>{name}</span>
        {strategy && <span className="mut" style={{ fontSize: 10 }}>{arena.strategies?.[strategy]?.name ?? strategy}</span>}