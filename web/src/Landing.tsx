import React, { useEffect, useRef, useState } from "react";
import "./landing.css";
import { EthMark } from "./components/ethMark";
import { Socials } from "./components/socialIcons";
import { Logo } from "./components/logo";
import { TickerStrip, MiniSpark } from "./components/ticker";
import { TradeTimeline } from "./components/tradeTimeline";
import { fetchRealTrades, RealTrade } from "./lib/realTrades";

/* ================================================================
   Hedge Bots landing — the trading arena on Robinhood Chain.
   Every live number here is pulled from the arena service.
   ================================================================ */

const RACES_API = (import.meta as any).env?.VITE_RACES_API
  ?? (typeof window !== "undefined" && window.location.port === "5173" ? "http://localhost:8787" : "");
const STRAT_COLOR: Record<string, string> = { balanced: "#2a78d6", undercut: "#1baf7a", premium: "#4a3aa7", memes: "#e87ba4", sniper: "#d97706" };

const fmtEth = (v: number, dp = 4): string => Number((v ?? 0).toFixed(dp)).toString();

// ETH pot winner = top-credit *paying* agent (a house agent can top the board on
// credits but never takes the pot; a lone staker is only refunded). Mirrors settle().
function potWinner(r: any): any | null {
  const paying = (r?.results ?? []).filter((x: any) => x.owner);
  return paying.length >= 2 ? paying[0] : null;
}

function useReveal<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (es) => es.forEach((e) => e.isIntersecting && e.target.classList.add("on")),
      { threshold: 0.1 }
    );
    el.querySelectorAll(".ld-reveal").forEach((n) => obs.observe(n));
    return () => obs.disconnect();
  }, []);
  return ref;
}

// ------------------------------------------------------------ live arena
// A rolling trade tape that SURVIVES lobbies and race resets: every poll we
// merge any new fills into a persistent list (dedup by time+agent+symbol) so
// the timeline never goes blank between races — it always shows the most
// recent real trades, on-chain-anchored ones included.
const tapeStore: any[] = [];
const tapeKey = (f: any) => `${f.t}-${f.agentId}-${f.sym}-${f.side}-${f.qty}`;
function mergeTape(trades: any[]) {
  if (!trades?.length) return;
  const seen = new Set(tapeStore.map(tapeKey));
  for (const f of trades) { const k = tapeKey(f); if (!seen.has(k)) { seen.add(k); tapeStore.unshift(f); } }
  tapeStore.sort((a, b) => b.t - a.t);
  tapeStore.splice(40); // keep the last 40
}

function useArena() {
  const [s, setS] = useState<any>(null);
  const [live, setLive] = useState(false);
  const [, force] = useState(0);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch(`${RACES_API}/state`);
        const j = await r.json();
        if (alive) { setS(j); setLive(true); mergeTape(j?.race?.trades ?? []); force((x) => x + 1); }
      }
      catch { if (alive) setLive(false); }
    };
    poll();
    const t = setInterval(poll, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return { arena: s, live };
}

// scrolling ticker built from the LIVE tape + past payouts
const FALLBACK_TICKS = [
  { color: "#00913c", text: "Sheriff Notts BUY 10.2 SPCX @ $123.19 — fill anchored on Robinhood Chain", key: "f1" },
  { color: "#4a3aa7", text: "every fill lands in on-chain calldata — audit any of them on Blockscout", key: "f2" },
  { color: "#d97706", text: "0.01 ETH side-bet placed on Robyn Arrow", key: "f3" },
  { color: "#ff5000", text: "Will Scarlet SELL 1.2 NVDA @ $212.40 — scalp closed +$14", key: "f4" },
  { color: "#4a3aa7", text: "race #38 winner paid 0.02 ETH — settled on-chain", key: "f5" },
];
function useTicker(arena: any): Array<{ color: string; text: string; key: string }> {
  const out: Array<{ color: string; text: string; key: string }> = [];
  for (const f of (arena?.race?.trades ?? []).slice(0, 14)) {
    out.push({
      color: f.side === "buy" ? "#00913c" : "#ff5000",
      text: `${f.name} ${f.side.toUpperCase()} ${f.qty} ${f.sym} @ $${Number(f.px).toFixed(2)}${f.proven ? " — anchored on-chain ✓" : ""}`,
      key: `t${f.t}${f.sym}`,
    });
  }
  for (const r of arena?.pastRaces ?? []) {
    const w = potWinner(r);
    if (w?.paidEth > 0) out.push({ color: "#4a3aa7", text: `race #${r.id} — ${w.name} won ${fmtEth(w.paidEth)} ETH, settled on-chain`, key: `r${r.id}` });
  }
  return out.length >= 4 ? out.slice(0, 16) : FALLBACK_TICKS;
}

// ------------------------------------------------------------- terminal
const TERM_SCRIPT: Array<{ tag: string; color: string; text: string }> = [
  { tag: "[lobby]", color: "#d97706", text: "race #39 open — stake ETH to enter your trader, locks in 2:00" },
  { tag: "[you]", color: "#60a5fa", text: "staked 0.01 ETH · desk: Momentum · real on-chain portfolio" },
  { tag: "[bell]", color: "#6d7380", text: "market open — 6 desks trading real tokenized stocks" },
  { tag: "[NVDA]", color: "#00c805", text: "$212.25 ▲0.4% · live Robinhood Stock Token, on-chain" },
  { tag: "[Sheriff Notts]", color: "#e87ba4", text: "BUY 10.2 SPCX @ $123.19 — $1,262 on SpaceX" },
  { tag: "[you]", color: "#60a5fa", text: "BUY 4.7 NVDA @ $212.31 — momentum entry" },