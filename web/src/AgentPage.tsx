import React, { useEffect, useState } from "react";
import { RACES_API, fmtEth } from "./components/computeArena";
import { EthMark } from "./components/ethMark";
import { Logo } from "./components/logo";
import { fetchHoldings, Holdings } from "./lib/holdings";

/**
 * /agent/<id> — one desk, fully auditable. The complete trade log with every
 * fill's on-chain anchor tx, open positions marked at live prices, the equity
 * curve, W/L — and for house desks the real wallet, one click from Blockscout.
 */
const STRAT_COLOR: Record<string, string> = { balanced: "#2a78d6", undercut: "#1baf7a", premium: "#4a3aa7", memes: "#e87ba4", sniper: "#d97706" };

const fmtUsd = (v: number, dp = 2) => `$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
const pnlFmt = (v: number) => `${v >= 0 ? "+" : "−"}${fmtUsd(v)}`;
const timeFmt = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false });

function EquityChart({ pts, bankroll }: { pts: Array<{ t: number; equityUsd: number }>; bankroll: number }) {
  if (!pts || pts.length < 2) return <div className="mut" style={{ padding: "18px 0" }}>the curve draws as the desk trades…</div>;
  const W = 860, H = 190, PAD = 10;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const vs = pts.map((p) => p.equityUsd);
  const v0 = Math.min(...vs, bankroll), v1 = Math.max(...vs, bankroll);
  const x = (t: number) => PAD + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * PAD);
  const y = (v: number) => v1 === v0 ? H / 2 : H - PAD - ((v - v0) / (v1 - v0)) * (H - 2 * PAD);
  const up = vs[vs.length - 1] >= bankroll;
  const c = up ? "#00c805" : "#ff5000";
  const line = pts.map((p) => `${x(p.t).toFixed(1)},${y(p.equityUsd).toFixed(1)}`).join(" ");
  return (
    <div style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", minWidth: 560, display: "block" }}>
        <line x1={PAD} x2={W - PAD} y1={y(bankroll)} y2={y(bankroll)} stroke="var(--border-strong)" strokeDasharray="4 4" strokeWidth="1" />
        <text x={W - PAD - 2} y={y(bankroll) - 5} textAnchor="end" fontSize="10" fill="var(--muted)" fontFamily="var(--font-mono)">${bankroll.toLocaleString()} start</text>
        <polygon points={`${PAD},${H - PAD} ${line} ${x(t1)},${H - PAD}`} fill={c} opacity="0.07" />
        <polyline points={line} fill="none" stroke={c} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(t1)} cy={y(vs[vs.length - 1])} r="3.5" fill={c} />
      </svg>
    </div>
  );
}

export default function AgentPage() {
  const id = window.location.pathname.replace(/^\/agent\/?/, "").replace(/\/$/, "");
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch(`${RACES_API}/agent?id=${encodeURIComponent(id)}`);
        const j = await r.json();
        if (!alive) return;
        if (j.error) setErr(j.error); else { setData(j); setErr(null); }
      } catch { if (alive) setErr("arena unreachable"); }
    };
    poll();
    const t = setInterval(poll, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [id]);

  const a = data?.agent;
  const tint = a ? (STRAT_COLOR[a.strategy] ?? "#2a78d6") : "#2a78d6";

  // REAL on-chain holdings — the wallet's actual ETH, USDG and stock tokens.
  const [holdings, setHoldings] = useState<Holdings | null>(null);
  const wallet = a?.wallet;
  useEffect(() => {
    if (!wallet) return;
    let alive = true;
    const load = async () => {
      try {
        const st = await (await fetch(`${RACES_API}/state`)).json();
        const prices: Record<string, number> = {};
        for (const s of (st?.market?.stocks ?? [])) if (s.usd) prices[s.sym] = s.usd;
        const h = await fetchHoldings(wallet, prices);
        if (alive) setHoldings(h);
      } catch { /* keep last */ }
    };
    load();
    const t = setInterval(load, 15000);
    return () => { alive = false; clearInterval(t); };
  }, [wallet]);

  return (
    <div className="app">
      <div className="topbar">
        <div>
          <a href="/app" className="brand" style={{ textDecoration: "none" }}><Logo size={28} />HEDGE B<span className="tick">O</span>TS</a>
          <span className="tagline">desk dashboard — every trade on-chain, verify everything yourself</span>
        </div>
        <div className="spacer" />
        <a href="/app" className="ghost" style={{ textDecoration: "none", padding: "7px 16px", borderRadius: 999, border: "1px solid var(--border-strong)", color: "var(--ink)", fontSize: 12, fontWeight: 700 }}>← back to the arena</a>
      </div>

      {err && <div className="card"><div className="emptystate"><span className="big">🤖</span>{err} — this desk may be from a finished race. <a href="/app" style={{ color: "var(--violet)" }}>Back to the live race →</a></div></div>}
      {!err && !a && <div className="card"><div className="emptystate">loading the book…</div></div>}

      {a && (
        <>
          {/* who */}
          <div className="card" style={{ borderColor: "var(--violet-border)", background: "linear-gradient(180deg, var(--violet-soft), var(--surface))" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
              <span style={{ width: 44, height: 44, borderRadius: 14, background: tint, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 20, fontWeight: 700, fontFamily: "var(--font-display)" }}>{a.name.replace(/[^A-Za-z0-9]/g, "")[0]}</span>
              <div style={{ minWidth: 200 }}>
                <div style={{ fontFamily: "var(--font-display)", fontSize: 21, fontWeight: 700, color: "var(--ink)" }}>{a.name}</div>
                <div className="mut" style={{ fontSize: 12 }}>{a.desk} desk — "{a.blurb}" · {a.house ? "house desk" : "player desk"} · race #{data.race.id} ({data.race.phase})</div>
              </div>
              <div className="spacer" />
              {a.walletUrl
                ? <a href={a.walletUrl} target="_blank" rel="noreferrer" className="chip" style={{ textDecoration: "none", color: "var(--violet)", fontWeight: 600 }}>wallet {String(a.wallet).slice(0, 6)}…{String(a.wallet).slice(-4)} — full on-chain history ↗</a>
                : a.wallet
                  ? <span className="chip">owner {String(a.wallet).slice(0, 6)}…{String(a.wallet).slice(-4)}</span>
                  : <span className="chip" title="revealed at launch">wallet 🔒 TBA</span>}
            </div>
          </div>

          {/* REAL on-chain holdings — the wallet's actual balances, live */}
          <div className="tiles">
            <div className="tile hero">
              <div className="label">Real wallet value</div>
              <div className="value">{fmtUsd(a.equityUsd)}</div>
              <div className="sub">USDG + stocks held on-chain</div>
            </div>
            <div className="tile"><div className="label">ETH (gas)</div><div className="value">{a.eth !== null && a.eth !== undefined ? Number(a.eth).toFixed(5) : "…"}<span style={{ fontSize: 12, color: "var(--muted)" }}> Ξ</span></div><div className="sub">native balance</div></div>
            <div className="tile"><div className="label">USDG (cash)</div><div className="value">{fmtUsd(a.cashUsd)}</div><div className="sub">real wallet balance</div></div>
            <div className="tile"><div className="label">Stocks held</div><div className="value">{fmtUsd(Math.max(0, a.equityUsd - a.cashUsd))}</div><div className="sub">{a.positions.length} on-chain position{a.positions.length === 1 ? "" : "s"}</div></div>
            <div className="tile"><div className="label">Real trades</div><div className="value">{a.trades}</div><div className="sub">confirmed on-chain</div></div>
            <div className="tile"><div className="label">Race P&L</div><div className="value" style={{ color: a.pnlUsd >= 0 ? "var(--good)" : "var(--critical)" }}>{pnlFmt(a.pnlUsd)}</div><div className="sub">on-chain equity change</div></div>
          </div>

          {/* real stock positions held on-chain */}