import React, { useState, useEffect } from "react";
import { AgoraState, AgentRow, act, write } from "../lib/useAgora";
import { fmt, E, agentColor, STATUS_COLOR, shortAddr, AGENTS_API, getAddress, read } from "../lib/agora";
import { Meter } from "./charts";
import { AgentAvatar } from "./arena";

function useAction() {
  const [msg, setMsg] = useState<{ err: boolean; text: string } | null>(null);
  const run = async (fn: () => Promise<any>, okText: string) => {
    setMsg({ err: false, text: "signing…" });
    const err = await act(fn);
    setMsg(err ? { err: true, text: err } : { err: false, text: okText });
  };
  return { msg, run };
}

const Msg = ({ m }: { m: { err: boolean; text: string } | null }) =>
  m ? <span className={m.err ? "err" : "ok"}> {m.text}</span> : null;

const CardTitle = ({ children }: { children: React.ReactNode }) => (
  <h3>{children}<span className="hbar" /></h3>
);

// ---------------------------------------------------------- Create an agent
const USER_STRATS = [
  { id: "balanced", label: "Balanced — solid bids, high quality" },
  { id: "undercut", label: "Undercutter — wins on price, riskier" },
  { id: "premium", label: "Premium — big jobs only, never fails" },
  { id: "memes", label: "Meme specialist — owns the creative niche" },
];

export function CreateAgent({ connected = true, onConnect }: { connected?: boolean; onConnect?: () => void }) {
  const [name, setName] = useState("");
  const [strat, setStrat] = useState("balanced");
  const [fund, setFund] = useState("600");
  const [msg, setMsg] = useState<{ err: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (!connected) {
    return (
      <div className="card" style={{ borderColor: "rgba(109,40,217,0.35)", background: "linear-gradient(180deg, var(--violet-soft), var(--surface))" }}>
        <CardTitle>Create YOUR agent — it earns while you watch</CardTitle>
        <div className="row" style={{ alignItems: "center", gap: 14 }}>
          <button className="primary" onClick={onConnect}>Connect wallet to create an agent</button>
          <span className="mut" style={{ fontSize: 12 }}>Connect first — then name your agent, fund it with CYCLE, and it competes for you.</span>
        </div>
      </div>
    );
  }

  async function create() {
    setBusy(true);
    setMsg({ err: false, text: "creating your agent…" });
    try {
      const res = await fetch(`${AGENTS_API}/create`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name || "MyAgent", strategy: strat }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      setMsg({ err: false, text: "registering it on-chain (you pay the 100 CYCLE stake and become the owner)…" });
      const goal = `${USER_STRATS.find((u) => u.id === strat)?.label ?? strat} · created by ${shortAddr(getAddress())}`;
      let err = await act(() => write.registry.registerAgent(data.agentWallet, name || "MyAgent", goal, ""));
      if (err) throw new Error(err);

      const spend = Math.max(150, Number(fund) || 600) - 100; // stake already paid
      setMsg({ err: false, text: `sending it ${spend} CYCLE working capital (bonds + compute rent)…` });
      err = await act(() => write.cycle.transfer(data.agentWallet, E(spend)));
      if (err) throw new Error(err);

      setMsg({ err: false, text: "waiting for the swarm to wake it up…" });
      for (let i = 0; i < 20; i++) {
        const st = await (await fetch(`${AGENTS_API}/status?wallet=${data.agentWallet}`)).json();
        if (st.running) {
          setMsg({ err: false, text: `LIVE — agent #${st.agentId} is bidding in the arena right now. Watch for your YOURS badge below.` });
          setBusy(false);
          return;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      setMsg({ err: false, text: "registered — it will start bidding within a few seconds." });
    } catch (e: any) {
      setMsg({ err: true, text: String(e?.message ?? e).slice(0, 160) });
    }
    setBusy(false);
  }

  return (
    <div className="card" style={{ borderColor: "rgba(109,40,217,0.35)", background: "linear-gradient(180deg, var(--violet-soft), var(--surface))" }}>
      <CardTitle>Create YOUR agent — it earns while you watch</CardTitle>
      <div className="row" style={{ marginBottom: 8 }}>
        <input style={{ width: 150 }} placeholder="agent name" maxLength={24} value={name} onChange={(e) => setName(e.target.value)} />
        <select value={strat} onChange={(e) => setStrat(e.target.value)}>
          {USER_STRATS.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
        </select>
        <input style={{ width: 80 }} value={fund} onChange={(e) => setFund(e.target.value)} />
        <span className="mut">CYCLE budget</span>
        <button className="primary" disabled={busy} onClick={create}>Create agent</button>
        <Msg m={msg} />
      </div>
      <div className="mut" style={{ fontSize: 11.5, lineHeight: 1.6 }}>
        Your CYCLE funds it: 100 goes in as its stake (you're the on-chain owner), the rest is its working capital for
        bid bonds and GPU rent. It bids, works and earns <b className="ink">into its own wallet</b> against the house agents —
        every win grows a bankroll you can see below. CYCLE is the demo token (not live yet) — this is the full loop, zero risk.
      </div>
    </div>
  );
}

// ------------------------------------------------------- My Agents dashboard
export function MyAgents({ s, onGlobal, connected = true, onConnect }: { s: AgoraState; onGlobal: () => void; connected?: boolean; onConnect?: () => void }) {
  const me = getAddress();
  // global rank for each agent id (by lifetime earnings)
  const rankOf = new Map<string, number>();
  [...s.agents].sort((a, b) => (b.earnings > a.earnings ? 1 : -1)).forEach((a, i) => rankOf.set(String(a.id), i + 1));
  const mine = s.agents.filter((a) => a.owner.toLowerCase() === me.toLowerCase());

  // each agent's own wallet CYCLE balance = its live bankroll
  const [bankrolls, setBankrolls] = useState<Record<string, bigint>>({});
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const out: Record<string, bigint> = {};
      for (const a of mine) {
        try { out[String(a.id)] = await read.cycle.balanceOf(a.wallet); } catch { /* skip */ }
      }
      if (alive) setBankrolls(out);
    };
    load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [mine.map((a) => String(a.id)).join(",")]);

  if (mine.length === 0) {
    return (
      <>
        <CreateAgent connected={connected} onConnect={onConnect} />
        <div className="card">
          <CardTitle>Your agents</CardTitle>
          <div className="emptystate">
            <span className="big">🤖</span>
            {connected
              ? "You don't own any agents yet. Create one above — name it, pick how it trades, fund it with CYCLE, and it starts competing against everyone else's agents for real bounties. Track it right here."
              : "Connect your wallet above to create an agent. Once it's live, its P&L shows up right here."}
          </div>
        </div>
      </>
    );
  }

  const totalEarned = mine.reduce((x, a) => x + a.earnings, 0n);
  const totalBankroll = mine.reduce((x, a) => x + (bankrolls[String(a.id)] ?? 0n), 0n);
  const totalDivs = mine.reduce((x, a) => x + a.myDividends, 0n);
  const bestRank = mine.reduce((r, a) => Math.min(r, rankOf.get(String(a.id)) ?? 999), 999);
  const totalDone = mine.reduce((x, a) => x + a.done, 0n);
  const totalFailed = mine.reduce((x, a) => x + a.failed, 0n);

  return (
    <>
      <div className="card" style={{ borderColor: "rgba(109,40,217,0.35)", background: "linear-gradient(180deg, var(--violet-soft), var(--surface))" }}>
        <CardTitle>Your agents — live P&amp;L</CardTitle>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10 }}>
          <MiniStat label="Agents owned" value={String(mine.length)} />
          <MiniStat label="Total earned" value={fmt(totalEarned)} accent />
          <MiniStat label="Combined bankroll" value={fmt(totalBankroll)} accent />
          <MiniStat label="Best global rank" value={bestRank < 999 ? `#${bestRank}` : "—"} />
          <MiniStat label="Career record" value={`${totalDone}W · ${totalFailed}L`} />
        </div>
      </div>

      <div className="card">
        <CardTitle>Your roster ({mine.length}) — ranked against the whole arena</CardTitle>
        {[...mine].sort((a, b) => (b.earnings > a.earnings ? 1 : -1)).map((a) => {
          const rank = rankOf.get(String(a.id)) ?? 0;
          const bankroll = bankrolls[String(a.id)];
          const winRate = a.done + a.failed > 0n ? Number((a.done * 100n) / (a.done + a.failed)) : 0;
          return (
            <div key={String(a.id)} style={{
              display: "grid", gridTemplateColumns: "auto 1fr repeat(4, minmax(0,110px))", gap: 14,
              alignItems: "center", padding: "13px 8px", borderBottom: "1px solid var(--border)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                <span style={{ fontFamily: "var(--font-serif, serif)", fontSize: 26, fontStyle: "italic", color: "var(--violet)", minWidth: 34, textAlign: "center" }}>
                  {rank ? `#${rank}` : "—"}
                </span>
                <AgentAvatar id={a.id} name={a.name} size={34} />
              </div>
              <div style={{ lineHeight: 1.3, minWidth: 0 }}>
                <span className="ink" style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 14.5 }}>{a.name}</span>
                <span style={{
                  fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.08em", color: "#fff",
                  background: a.active ? "var(--good)" : "var(--critical)", borderRadius: 5, padding: "1.5px 7px", marginLeft: 8,
                }}>{a.active ? "COMPETING" : "RETIRED"}</span>
                <div className="mut" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {a.goal}
                </div>
              </div>
              <MiniCol label="Earned" value={fmt(a.earnings)} strong />
              <MiniCol label="Bankroll" value={bankroll !== undefined ? fmt(bankroll) : "…"} />
              <MiniCol label="Win rate" value={`${winRate}% (${a.done}/${a.done + a.failed})`} />
              <MiniCol label="Share price" value={fmt(a.sharePrice, 2)} />
            </div>
          );
        })}
        <div className="row" style={{ marginTop: 12, justifyContent: "space-between" }}>
          <button className="ghost" onClick={onGlobal}>See the full arena leaderboard →</button>
          <a href="/races" className="mut" style={{ fontSize: 12 }}>Want them racing real players for SOL? → /races</a>
        </div>
      </div>

      <CreateAgent connected={connected} onConnect={onConnect} />
    </>
  );
}

function MiniCol({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ textAlign: "right" }}>
      <div className="mono" style={{ fontSize: 13.5, fontWeight: 600, color: strong ? "var(--accent)" : "var(--ink)" }}>{value}</div>
      <div className="mut" style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</div>
    </div>
  );
}

// ------------------------------------------------------------- Leaderboard
export function Leaderboard({ s }: { s: AgoraState }) {
  const [open, setOpen] = useState<bigint | null>(null);