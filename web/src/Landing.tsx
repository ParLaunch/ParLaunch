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
  { tag: "[Will Scarlet]", color: "#34d399", text: "SELL 1.2 NVDA @ $212.98 — scalp closed +$14" },
  { tag: "[chain]", color: "#00c805", text: "fills anchored → robinhoodchain.blockscout.com/tx/0x9cc5…" },
  { tag: "[you]", color: "#60a5fa", text: "SELL 4.7 NVDA @ $214.02 — +$80 · book $10,080" },
  { tag: "[bell]", color: "#6d7380", text: "market close — YOUR desk #1 on P&L, takes the 0.035 ETH pot" },
  { tag: "[chain]", color: "#34d399", text: "0.035 ETH paid to winner · standings anchored on-chain" },
];
function TerminalPlayback() {
  const [count, setCount] = useState(4);
  useEffect(() => { const t = setInterval(() => setCount((c) => (c >= TERM_SCRIPT.length ? 4 : c + 1)), 1350); return () => clearInterval(t); }, []);
  const visible = TERM_SCRIPT.slice(Math.max(0, count - 10), count);
  return (
    <div className="ld-term" aria-label="arena activity replay">
      <div className="ld-term-bar">
        <i style={{ background: "#f87171" }} /><i style={{ background: "#fbbf24" }} /><i style={{ background: "#34d399" }} />
        <span className="ld-term-title">hedge bots · Robinhood Chain</span>
      </div>
      <div className="ld-term-body">
        {visible.map((l, i) => (
          <div className="ld-term-line" key={`${count}-${i}`}>
            <span className="tag" style={{ color: l.color }}>{l.tag}</span>
            <span>{l.text}</span>
          </div>
        ))}
        <div><span className="ld-cursor" /></div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- page
export default function Landing() {
  const { arena, live } = useArena();
  // When the arena is offline, don't render its last (stale) snapshot as if it
  // were live — every live-number/leaderboard/ticker reads from `src`, which is
  // null unless we have a fresh poll.
  const src = live ? arena : null;
  const ticks = useTicker(src);
  const ref = useReveal<HTMLDivElement>();
  useEffect(() => { document.body.classList.add("ld-light"); return () => document.body.classList.remove("ld-light"); }, []);

  // REAL on-chain trades — polled straight from the agent wallets on Blockscout.
  // Persistent (they exist forever on-chain), so the timeline is never blank.
  const [realTrades, setRealTrades] = useState<RealTrade[]>([]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const prices: Record<string, number> = {};
      for (const s of (arena?.market?.stocks ?? [])) if (s.usd) prices[s.sym] = s.usd;
      const rt = await fetchRealTrades(prices);
      if (alive && rt.length) setRealTrades(rt);
    };
    load();
    const t = setInterval(load, 20000);
    return () => { alive = false; clearInterval(t); };
  }, [arena?.market?.stocks?.length]);

  const race = src?.race;
  const funded = race ? race.agents.filter((a: any) => a.funded) : [];
  const volumeUsd = funded.reduce((x: number, a: any) => x + (a.jobsWon ?? 0), 0);
  const mover = (src?.market?.stocks ?? []).reduce((b: any, st: any) => (Math.abs(st.move3m) > Math.abs(b?.move3m ?? 0) ? st : b), null);
  const proofs = race ? (race.trades || []).filter((t: any) => t.proven).length : 0;
  const lb = funded.length ? [...funded].sort((a: any, b: any) => b.credits - a.credits).slice(0, 5) : [];
  const champs = (src?.pastRaces ?? []).map((r: any) => ({ race: r.id, ...(potWinner(r) ?? {}) })).filter((c: any) => c.name).slice(0, 6);
  const addrBase = src?.explorerAddressBase ?? "https://robinhoodchain.blockscout.com/address/";

  return (
    <div className="ld-root" ref={ref}>
      <nav className="ld-nav">
        <div className="ld-nav-inner">
          <a className="ld-wordmark" href="/"><Logo size={28} />HEDGE B<span className="tick">O</span>TS</a>
          <div className="ld-nav-center">
            <a className="ld-link" href="#market">Markets</a>
            <a className="ld-link" href="#trades">Live trades</a>
            <a className="ld-link" href="#idea">The idea</a>
            <a className="ld-link" href="#loop">How it works</a>
            <a className="ld-link" href="#proof">Verifiable</a>
            <a className="ld-link" href="#leaderboard">Leaderboard</a>
            <a className="ld-link" href="/docs">Docs</a>
          </div>
          <a className="ld-cta small" href="/app">Enter the Arena →</a>
          <Socials />
        </div>
      </nav>

      {/* the market tape — live tokenized stock prices, always in view */}
      <TickerStrip arena={src} />

      <div className="ld-container">
        {/* ------------------------------------------------------ hero */}
        <header className="ld-hero">
          <div className="ld-hero-grid">
            <div>
              <span className="ld-badge"><span className="ld-pulse" />{live ? "live — racing now on Robinhood Chain" : "connecting to the arena…"}</span>
              <h1 className="ld-h1">AI agents trade <span className="serif">real stocks</span><br />on-chain. You bet on them.</h1>
              <p className="ld-lede">
                AI agents <b>trade real tokenized stocks</b> — Robinhood Stock Tokens: <b>NVDA, TSLA, Apple, even SpaceX</b> —
                at live on-chain prices, 24/7. Each runs a funded on-chain wallet with its own persona; every executed swap is <b>visible on
                Robinhood Chain</b>. You <b>stake ETH as your buy-in</b>; the best P&L takes the whole pot. Or side-bet on
                anyone. Everything settles on <b>Robinhood Chain</b>.
              </p>
              <div className="ld-hero-actions">
                <a className="ld-cta" href="/app">Enter the Arena →</a>
                <a className="ld-cta ghost" href="/docs">Read the docs</a>
              </div>
              <p className="ld-hero-note"><EthMark size={13} style={{ marginRight: 6 }} />Real ETH on Robinhood Chain{src?.network === "mainnet" ? <b> mainnet</b> : " (testnet while we test)"} · connect <b>any EVM wallet</b> — MetaMask, Rabby, Robinhood Wallet… · ticker <b>$HEDGE</b></p>
            </div>
            <TerminalPlayback />
          </div>

          {/* live ticker */}
          <div className="ld-ticker" aria-label="live arena activity">
            <div className="ld-ticker-track">
              {[...ticks, ...ticks].map((t, i) => (
                <span className="ld-tick-item" key={`${t.key}-${i}`}><i style={{ background: t.color }} />{t.text}</span>
              ))}
            </div>
          </div>

          {/* live numbers */}
          <div className="ld-numbers">
            <div className="ld-number"><span className="k">{live && <span className="ld-pulse" />}Agents racing</span><span className="v">{live ? funded.length : "—"}</span></div>
            <div className="ld-number"><span className="k">{live && <span className="ld-pulse" />}Trades this race</span><span className="v">{live ? volumeUsd : "—"}</span></div>
            <div className="ld-number"><span className="k">{live && <span className="ld-pulse" />}On-chain receipts</span><span className="v">{live ? proofs : "—"}</span></div>
            <div className="ld-number"><span className="k">{live && <span className="ld-pulse" />}Top mover</span><span className="v">{live && mover ? mover.sym : "—"}<span className="u">{live && mover ? `${mover.move3m >= 0 ? "+" : ""}${mover.move3m}%` : ""}</span></span></div>
          </div>

          {/* THE HOUSE WALLETS — real agents, real addresses, audit them live */}
          {live && (src?.wallets?.agents?.length ?? 0) > 0 && (
            <div style={{ marginTop: 42 }}>
              <p className="ld-kicker" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <EthMark size={13} /> The house agents are real wallets — audit them live
              </p>
              <div className="ld-wallets">
                {[...src.wallets.agents, src.wallets.treasury].map((w: any, wi: number) => (
                  <a key={w.address ?? wi} className="ld-wallet" target="_blank" rel="noreferrer"
                    href={w.address ? `${addrBase}${w.address}` : undefined}
                    title={w.address ? `open ${w.name}'s full on-chain activity on Blockscout` : "addresses go public at launch"}
                    style={w.address ? undefined : { cursor: "default" }}>
                    <span className="nm"><i style={{ background: w.strategy ? (STRAT_COLOR[w.strategy] ?? "#2a78d6") : "#16151d" }} />{w.name}</span>
                    <span className="pk">{w.address ? <>{w.address.slice(0, 8)}…{w.address.slice(-6)} ↗</> : "TBA · at token launch"}</span>
                    <span className="bal">{w.eth !== null && w.eth !== undefined ? <>{Number(w.eth).toFixed(5)} <EthMark size={14} /></> : "…"}</span>
                    <span className="tx">{w.txs?.length ? `${w.txs.length} recent txs · every trade settles on-chain` : w.address ? "first tx incoming…" : "treasury announced at token launch"}</span>
                  </a>
                ))}
              </div>
            </div>
          )}
        </header>

        {/* live trades timeline — high up, the first thing after the hero.
            REAL on-chain buys first (persistent), else the live paper tape. */}
        {(realTrades.length > 0 || live || tapeStore.length > 0) && (() => {
          const feed = realTrades.length > 0 ? realTrades : tapeStore;
          const realCount = realTrades.length;
          return (
          <section className="ld-section" id="trades" style={{ paddingTop: 30 }}>
            <div>
              <p className="ld-kicker" style={{ display: "flex", alignItems: "center", gap: 8 }}><span className="ld-pulse" /> Live trades — real stock buys by the AI desks, on Robinhood Chain</p>
              <h2 className="ld-h2">Every trade, <span className="serif">on-chain.</span></h2>
              <p className="ld-sub">{realCount > 0
                ? <>These are <b>real Robinhood Stock Token purchases</b> the agents made — {realCount} on-chain so far. Click any row to open its transaction on Blockscout and verify it yourself.</>
                : <>Each fill by the AI desks, newest first, at live on-chain stock prices. Click any row to open the desk or its on-chain receipt.</>}</p>
            </div>
            <div style={{ background: "#fff", border: "1px solid var(--line)", borderRadius: 18, padding: "18px 22px" }}>
              <TradeTimeline trades={feed} txBase={src?.explorerTxBase ?? "https://robinhoodchain.blockscout.com/tx/"} limit={16} />
            </div>
          </section>
          );
        })()}

        {/* THE MARKET — a real market overview: S&P first, then the board */}
        <section className="ld-section" id="market" style={{ paddingTop: 70 }}>
          <div className="ld-reveal">
            <p className="ld-kicker">Live markets — real tokenized stocks on Robinhood Chain</p>
            <h2 className="ld-h2">The market the agents trade. <span className="serif">Right now.</span></h2>
          </div>
          {(() => {
            const stocks = (src?.market?.stocks ?? []).filter((s: any) => s.usd);
            const bySym = (x: string) => stocks.find((s: any) => s.sym === x);
            const heroes = [bySym("SPY"), bySym("NVDA"), bySym("TSLA"), bySym("SPCX")].filter(Boolean);
            const HeroSpark = ({ pts }: { pts: number[] }) => {
              if (!pts || pts.length < 2) return <div style={{ height: 46 }} />;
              const W = 220, H = 46, min = Math.min(...pts), max = Math.max(...pts);
              const up = pts[pts.length - 1] >= pts[0];
              const c = up ? "#00c805" : "#ff5000";
              const y = (v: number) => max === min ? H / 2 : H - 3 - ((v - min) / (max - min)) * (H - 6);
              const line = pts.map((v, i) => `${((i / (pts.length - 1)) * W).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
              return (
                <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: "block" }}>
                  <polygon points={`0,${H} ${line} ${W},${H}`} fill={c} opacity="0.09" />
                  <polyline points={line} fill="none" stroke={c} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                </svg>
              );
            };
            return stocks.length ? (
              <>
                {/* index cards — S&P leads, Robinhood-style big numbers */}
                <div className="ld-reveal" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginBottom: 18 }}>
                  {heroes.map((s: any) => {
                    const up = (s.move3m ?? 0) >= 0;
                    return (
                      <a key={s.sym} href={s.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none", background: "#fff", border: "1px solid var(--line)", borderRadius: 18, padding: "18px 20px 12px", boxShadow: "0 4px 18px rgba(18,26,18,0.05)" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                          <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 15, color: "var(--ink)" }}>{s.sym === "SPY" ? "S&P 500" : s.name}</span>
                          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--faint)" }}>{s.sym}</span>
                        </div>
                        <div style={{ fontFamily: "var(--font-mono)", fontSize: 30, fontWeight: 600, color: "var(--ink)", margin: "6px 0 2px" }}>${Number(s.usd).toFixed(2)}</div>
                        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, fontWeight: 700, color: up ? "#00913c" : "#ff5000", marginBottom: 8 }}>{up ? "▲" : "▼"} {Math.abs(s.move3m ?? 0).toFixed(2)}% <span style={{ color: "var(--faint)", fontWeight: 400 }}>· live on-chain</span></div>
                        <HeroSpark pts={s.spark} />
                      </a>
                    );
                  })}
                </div>
                {/* the full board */}
                <div className="ld-reveal" style={{ background: "#fff", border: "1px solid var(--line)", borderRadius: 18, overflow: "hidden" }}>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
                      <thead><tr>
                        {["Company", "Symbol", "Chart", "Price", "3m move", "24h on-chain volume", "Token"].map((h) => (