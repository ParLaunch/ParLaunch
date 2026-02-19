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
        {paused && <span title="wallet needs ETH for gas" style={{ color: "var(--critical)", fontSize: 10 }}>⚠ fund</span>}
      </span>
      {address ? (
        <a href={explorerAddressUrl(arena, address)} target="_blank" rel="noreferrer" title="open this wallet's full activity on Blockscout"
          style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--violet)", textDecoration: "none", whiteSpace: "nowrap" }}>
          {address.slice(0, 6)}..{address.slice(-4)} ↗
        </a>
      ) : (
        <span className="mut" style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, whiteSpace: "nowrap" }} title="announced at token launch">TBA</span>
      )}
      <span style={{ textAlign: "right", whiteSpace: "nowrap", lineHeight: 1.25 }}>
        <span className="num mono ink" style={{ fontSize: 12.5 }}>{tradingEquityUsd !== null && tradingEquityUsd !== undefined ? `$${Number(tradingEquityUsd).toFixed(2)}` : "…"}</span>
        {tradingPnlUsd !== null && tradingPnlUsd !== undefined && <span style={{ display: "block", color: tradingPnlUsd >= 0 ? "var(--good)" : "var(--critical)", fontFamily: "var(--font-mono)", fontSize: 9.5 }}>{tradingPnlUsd >= 0 ? "+$" : "−$"}{Math.abs(Number(tradingPnlUsd)).toFixed(4)} P&amp;L</span>}
        <span className="mut" style={{ display: "block", fontFamily: "var(--font-mono)", fontSize: 9 }}>{usdg !== null && usdg !== undefined ? `${Number(usdg).toFixed(2)} USDG` : ""}{eth !== null && eth !== undefined ? ` · ${Number(eth).toFixed(5)} ETH gas` : ""}</span>
        {(ethEarned > 0 || ethSpent > 0) && (
          <span style={{ display: "block", fontFamily: "var(--font-mono)", fontSize: 9.5, marginTop: 2 }} title="cumulative real ETH earned (wins) and spent (rent/losses) on-chain">
            <span style={{ color: "var(--good)" }}>▲{Number(ethEarned).toFixed(6)}</span>{" "}<span style={{ color: "var(--critical)" }}>▼{Number(ethSpent).toFixed(6)}</span>
          </span>
        )}
      </span>
      <span style={{ display: "flex", gap: 6, flexWrap: "wrap", minWidth: 0 }}>
        {(txs ?? []).slice(0, 3).map((t: any) => (
          <a key={t.hash} href={explorerTxUrl(arena, t.hash)} target="_blank" rel="noreferrer"
            style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--violet)", background: "var(--violet-soft)", borderRadius: 6, padding: "2px 7px", textDecoration: "none", whiteSpace: "nowrap" }}>
            {t.hash.slice(0, 6)}…{t.hash.slice(-4)}{t.at ? ` · ${timeAgo(t.at)}` : ""} ↗
          </a>
        ))}
        {(txs ?? []).length === 0 && <span className="mut" style={{ fontSize: 10.5 }}>{address ? "first tx incoming…" : "announced at token launch"}</span>}
      </span>
      {address ? (
        <a href={explorerAddressUrl(arena, address)} target="_blank" rel="noreferrer" className="mut"
          style={{ fontSize: 10.5, textDecoration: "none", whiteSpace: "nowrap" }}>all activity →</a>
      ) : <span className="mut" style={{ fontSize: 10.5, whiteSpace: "nowrap" }}>TBA</span>}
    </div>
  );

  return (
    <div className="card" style={{ borderColor: "rgba(217,119,6,0.35)", background: "linear-gradient(180deg, rgba(217,119,6,0.05), var(--surface))" }}>
      <h3><EthMark size={14} style={{ marginRight: 7 }} />House wallets — real agents, real transactions <span className="hbar" /><span className="livedot" /></h3>
      <div className="mut" style={{ fontSize: 11.5, marginBottom: 6 }}>
        Each house agent runs its own Robinhood Chain wallet. Displayed equity is its <b className="ink">actual USDG plus stock-token value</b>,
        and P&amp;L is the marked-to-market change since the race opened. Every trade hash opens directly on Blockscout.
        {w.maskNote && <> <b className="ink">🔒 {w.maskNote}</b> — the on-chain flows run the whole time.</>}
      </div>
      {w.agents.map((a: any) => (
        <Row key={a.name} {...a} tint={STRAT_COLOR[a.strategy] ?? "#2a78d6"} />
      ))}
      <Row {...w.treasury} tint="#16151d" name={w.treasury.address ? (w.treasury.receiveOnly ? "Treasury — receive-only: rent, rake & sweeps flow IN" : "House treasury — the pot, payouts, rewards & rake") : "Treasury — address TBA at token launch"} last />
    </div>
  );
}

// ---- the VISUAL race: countdown ring + animated bars (the "it's a race" bit)
export function VisualRace({ arena, myAddress }: { arena: any; myAddress?: string }) {
  const race = arena.race;
  if (!race) return null;
  const ranked = [...race.agents].filter((a: any) => a.funded).sort((a: any, b: any) => b.credits - a.credits);
  const max = Math.max(...ranked.map((a: any) => a.credits), 1);
  const now = Date.now();
  const inLobby = now < race.startsAt;
  const target = inLobby ? race.startsAt : race.endsAt;
  const total = inLobby ? (race.startsAt - race.openedAt) / 1000 : (race.endsAt - race.startsAt) / 1000;
  const secsLeft = Math.max(0, Math.floor((target - now) / 1000));
  const frac = Math.min(1, Math.max(0, secsLeft / total));
  const ringColor = inLobby ? "#d97706" : "var(--violet)";
  const R = 52, C = 2 * Math.PI * R;
  const mm = Math.floor(secsLeft / 60), ss = secsLeft % 60;

  return (
    <div className="card" style={{ background: inLobby ? "linear-gradient(180deg, rgba(217,119,6,0.06), var(--surface))" : "linear-gradient(180deg, var(--violet-glow), var(--surface))" }}>
      {inLobby && (
        <div style={{ textAlign: "center", marginBottom: 12, fontFamily: "var(--font-display)", fontWeight: 600, color: "var(--amber, #d97706)" }}>
          🟡 LOBBY OPEN — stake now to enter race #{race.id}. Entries lock in {mm}:{String(ss).padStart(2, "0")}, then the race runs.
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "150px 1fr 200px", gap: 20, alignItems: "center" }}>
        {/* countdown ring */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
          <svg width="130" height="130" viewBox="0 0 130 130">
            <circle cx="65" cy="65" r={R} fill="none" stroke="rgba(22,21,29,0.08)" strokeWidth="6" />
            <circle cx="65" cy="65" r={R} fill="none" stroke={ringColor} strokeWidth="6" strokeLinecap="round"
              strokeDasharray={C} strokeDashoffset={C * (1 - frac)} transform="rotate(-90 65 65)"
              style={{ transition: "stroke-dashoffset 950ms linear" }} />
            <text x="65" y="60" textAnchor="middle" fill="var(--ink)" fontSize="21" fontWeight="600" fontFamily="IBM Plex Mono, monospace">{mm}:{String(ss).padStart(2, "0")}</text>
            <text x="65" y="79" textAnchor="middle" fill="var(--muted)" fontSize="9" letterSpacing="1.5" fontFamily="Space Grotesk, sans-serif">{inLobby ? "TILL START" : `RACE #${race.id}`}</text>
          </svg>
          <span style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--muted)" }}>{inLobby ? "entries open" : "racing now"}</span>
        </div>

        {/* the animated race bars */}
        <div>
          {ranked.map((a: any, i: number) => {
            const w = Math.max(a.credits > 0 ? 3 : 0, (a.credits / max) * 100);
            const color = STRAT_COLOR[a.strategy] ?? "#2a78d6";
            const mine = myAddress && a.owner === myAddress;
            return (
              <div key={a.id} style={{ display: "grid", gridTemplateColumns: "26px 20px 120px 1fr 66px", gap: 8, alignItems: "center", height: 30 }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: i === 0 ? "var(--warning)" : "var(--muted)", fontWeight: i === 0 ? 700 : 400 }}>{i === 0 && a.credits > 0 ? "▲P1" : `P${i + 1}`}</span>
                <span className="dot" style={{ background: color, margin: 0 }} />
                <span style={{ fontSize: 12.5, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.name}{mine && <span style={{ color: "var(--violet)", fontSize: 9 }}> ·YOU</span>}</span>
                <div style={{ position: "relative", height: 14, borderLeft: "1px solid var(--border-strong)" }}>
                  <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${w}%`, background: color, borderRadius: "0 4px 4px 0", boxShadow: `0 1px 6px ${color}44`, transition: "width 700ms cubic-bezier(0.22,1,0.36,1)" }} />
                </div>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: a.credits >= 0 ? "var(--good)" : "var(--critical)", textAlign: "right" }}>{fmtPnl(a.credits)}</span>
              </div>
            );
          })}
          {ranked.length === 0 && <div className="mut" style={{ padding: "14px 0" }}>agents funding up…</div>}
        </div>

        {/* the stakes */}
        <div style={{ textAlign: "right" }}>
          <div className="mut" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.1em" }}>racing for</div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 22, fontWeight: 600, color: "var(--accent)" }}>{fmtEth(race.potEth)} <EthMark size={17} /></div>
          <div className="mut" style={{ fontSize: 11 }}>+ {fmtEth(race.sidePotEth)} <EthMark size={9} /> side pool</div>
          <div className="mut" style={{ fontSize: 11, marginTop: 4 }}>winner takes the pot</div>
        </div>
      </div>
    </div>
  );
}

const ctl: React.CSSProperties = { background: "var(--page)", border: "1px solid var(--border)", color: "var(--ink)", borderRadius: 8, padding: "6px 9px", fontFamily: "var(--font-mono)", fontSize: 12 };

// ============================================================ BuildAgentForm
// THE single create-agent flow. Identical wherever it's used.
export function BuildAgentForm() {
  const { arena } = useArena();
  const { wallet, connect } = useWallet();
  const [name, setName] = useState("");
  const [strategy, setStrategy] = useState("balanced");
  const [entryEth, setEntryEth] = useState(0.002);
  const [msg, setMsg] = useState<{ err: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const joinOpen = arena?.race ? Date.now() < arena.race.joinCutoff : false;
  const lobbyLeft = arena?.race ? Math.max(0, Math.floor((arena.race.startsAt - Date.now()) / 1000)) : 0;
  const nextLobby = arena?.race ? Math.max(0, Math.floor((arena.race.endsAt - Date.now()) / 1000)) : 0;
  const stakes = [0.002, 0.005, 0.01, 0.05, 0.1, 0.25];

  async function doConnect() {
    try { await connect(); setMsg(null); } catch (e: any) { setMsg({ err: true, text: String(e?.message ?? e).slice(0, 120) }); }
  }
  async function join() {
    if (!wallet || !arena) return;
    setBusy(true);
    setMsg({ err: false, text: "creating your agent…" });
    try {
      const res = await fetch(`${RACES_API}/join`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name || `${wallet.name}-agent`, strategy, owner: wallet.address, entryEth }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setMsg({ err: false, text: `approve the ${entryEth} ETH stake in ${wallet.name}…` });
      const tx = await payEntry(arena.chain, wallet.provider, wallet.address, data.depositAddress, data.entryWeiHex);
      setMsg({ err: false, text: `YOU'RE IN (${tx.slice(0, 12)}…). Your agent joins the race when the lobby closes.` });
    } catch (e: any) { setMsg({ err: true, text: String(e?.message ?? e).slice(0, 160) }); }
    finally { setBusy(false); }
  }

  return (
    <div className="card" style={{ borderColor: "var(--violet-border)", background: "linear-gradient(180deg, var(--violet-soft), var(--surface))" }}>
      <h3>Create your agent — it trades real tokenized stocks <span className="hbar" /></h3>
      {!wallet ? (
        <div className="row">
          <button className="primary" onClick={doConnect}>Connect Wallet</button>
          <span className="mut">stake real ETH on Robinhood Chain{arena?.network === "testnet" ? " (testnet)" : ""} · agents race real wallet equity · best P&amp;L takes the pot</span>
          {msg && <span className={msg.err ? "err" : "ok"}>{msg.text}</span>}
        </div>
      ) : (
        <>
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="mut mono" style={{ fontSize: 11 }}>{wallet.name} · {wallet.address.slice(0, 6)}..{wallet.address.slice(-4)}</span>
            <input style={{ ...ctl, width: 140 }} placeholder="agent name" maxLength={24} value={name} onChange={(e) => setName(e.target.value)} />
            <select style={ctl} value={strategy} onChange={(e) => setStrategy(e.target.value)}>
              {arena && Object.entries(arena.strategies).map(([id, st]: any) => <option key={id} value={id}>{st.name} — {st.blurb}</option>)}
            </select>
            <select style={ctl} value={entryEth} onChange={(e) => setEntryEth(Number(e.target.value))}>
              {stakes.map((v) => <option key={v} value={v}>{v} ETH stake</option>)}
            </select>
            <button className="primary" disabled={busy || !joinOpen} onClick={join}>{joinOpen ? "Stake & enter" : "entries locked"}</button>
          </div>

                    {joinOpen
            ? <div className="ok" style={{ fontSize: 12 }}>🟡 lobby open — entries lock in {Math.floor(lobbyLeft / 60)}:{String(lobbyLeft % 60).padStart(2, "0")}. Stake now to be in race #{arena?.race?.id}.</div>
            : <div className="mut" style={{ fontSize: 12 }}>race in progress — next lobby opens in {Math.floor(nextLobby / 60)}:{String(nextLobby % 60).padStart(2, "0")}.</div>}
          {msg && <div className={msg.err ? "err" : "ok"}>{msg.text}</div>}
        </>
      )}
      <div className="mut" style={{ fontSize: 11.5, marginTop: 10 }}>
        You <b className="ink">stake ETH</b> as your buy-in. House agents race using their <b className="ink">real USDG and Stock Tokens</b>;
        the best on-chain portfolio P&amp;L takes the pot, with every executed swap linked on Blockscout.
      </div>

      {/* who you're up against */}
      {arena?.race && (
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
          <div className="mut" style={{ fontSize: 10.5, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8 }}>
            You're up against — {arena.race.agents.filter((a: any) => a.funded).length} agents in race #{arena.race.id}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {[...arena.race.agents].filter((a: any) => a.funded).sort((a: any, b: any) => b.credits - a.credits).map((a: any) => (
              <span key={a.id} style={{
                display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "var(--font-mono)", fontSize: 11.5,
                padding: "4px 10px", borderRadius: 999, border: "1px solid var(--border)", background: "var(--surface-2)",
              }}>
                <span className="dot" style={{ background: STRAT_COLOR[a.strategy] ?? "#2a78d6", margin: 0 }} />
                <span className="ink">{a.name}</span>
                <span className="mut">{a.house ? "house" : "player"}</span>
                <span style={{ color: a.credits >= 0 ? "var(--good)" : "var(--critical)" }}>{fmtPnl(a.credits)}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================ ArenaLeaderboard
// Every agent, real on-chain compute earnings — current race + past winners.
export function ArenaLeaderboard() {
  const { arena, offline } = useArena();
  const { wallet } = useWallet();
  if (offline || !arena) return <div className="card"><h3>Leaderboard <span className="hbar" /></h3><div className="emptystate"><span className="big">⛓</span>the arena is reconnecting — one moment…</div></div>;

  const live = arena.race ? [...arena.race.agents].filter((a: any) => a.funded).sort((a: any, b: any) => b.credits - a.credits) : [];
  // hall of fame: past POT winners (real ETH champions, not house top-scorers)
  const champs = (arena.pastRaces ?? []).map((r: any) => ({ race: r.id, ...(potChampion(r) ?? {}) })).filter((c: any) => c.name);

  return (
    <>
      <div className="card">
        <h3>Live leaderboard — race #{arena.race?.id} <span className="hbar" /><span className="livedot" /></h3>
        <table>
          <thead><tr><th>#</th><th>Agent</th><th>Desk</th><th className="num">P&L</th><th className="num">W/L</th><th className="num">Equity</th></tr></thead>
          <tbody>
            {live.map((a: any, i: number) => (
              <tr key={a.id} style={wallet && a.owner === wallet.address ? { background: "var(--violet-soft)" } : undefined}>
                <td className="mut">{i + 1}</td>
                <td><a href={`/agent/${a.id}`} style={{ textDecoration: "none" }} title="open this desk's dashboard — trades, P&L, tx ids"><span className="dot" style={{ background: STRAT_COLOR[a.strategy] ?? "#2a78d6" }} /><span className="ink" style={{ borderBottom: "1px dashed var(--border-strong)" }}>{a.name}</span></a>{wallet && a.owner === wallet.address && <span style={{ color: "var(--violet)", fontSize: 10 }}> · YOURS</span>}{a.house ? <span className="mut" style={{ fontSize: 10 }}> · house</span> : <span className="mut" style={{ fontSize: 10 }}> · player</span>}{a.wallet && <> · <a href={explorerAddressUrl(arena, a.wallet)} target="_blank" rel="noreferrer" title={`${a.name}'s wallet on Blockscout`} style={{ color: "var(--violet)", fontFamily: "var(--font-mono)", fontSize: 10, textDecoration: "none" }}>{a.wallet.slice(0, 6)}..{a.wallet.slice(-4)} ↗</a></>}</td>
                <td className="mut" style={{ fontSize: 11 }}>{a.desk ?? arena.strategies?.[a.strategy]?.name}</td>
                <td className="num" style={{ color: a.credits >= 0 ? "var(--good)" : "var(--critical)" }}>{fmtPnl(a.credits)}</td>
                <td className="num">{a.jobsVerified}/{a.jobsRejected}</td>
                <td className="num">${(a.equityUsd ?? 0).toFixed(2)}</td>
              </tr>
            ))}
            {live.length === 0 && <tr><td colSpan={6} className="mut" style={{ padding: 14 }}>agents funding up…</td></tr>}
          </tbody>
        </table>
      </div>
      {champs.length > 0 && (
        <div className="card">
          <h3>Hall of fame — past champions <span className="hbar" /></h3>
          <table>
            <thead><tr><th>Race</th><th>Champion</th><th className="num">P&L</th><th className="num">ETH won</th><th>Proof</th></tr></thead>
            <tbody>
              {champs.map((c: any) => (
                <tr key={c.race}><td className="mut">#{c.race}</td><td className="ink">🥇 {c.name}</td><td className="num">{c.credits?.toFixed(0) ?? "—"}</td><td className="num" style={{ color: "var(--good)" }}>{c.paidEth > 0 ? <>{fmtEth(c.paidEth)} <EthMark size={10} /></> : "—"}</td><td>{c.tx ? <a href={explorerTxUrl(arena, c.tx)} target="_blank" rel="noreferrer" style={{ color: "var(--violet)", fontFamily: "var(--font-mono)", fontSize: 11.5 }}>on-chain ↗</a> : <span className="mut">—</span>}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ============================================================ MyComputeRoster
// The per-user dashboard: ETH balance, W/L, agents, compute — once connected.
export function MyComputeRoster() {
  const { arena, offline } = useArena();
  const { wallet, connect } = useWallet();
  const [bal, setBal] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    if (wallet && arena) {
      const load = () => getBalanceEth(arena.rpc, wallet.address).then((b) => alive && setBal(b)).catch(() => {});
      load();
      const t = setInterval(load, 8000);
      return () => { alive = false; clearInterval(t); };
    }
  }, [wallet?.address, arena?.rpc]);

  if (offline || !arena) return <div className="card"><h3>Your dashboard <span className="hbar" /></h3><div className="emptystate"><span className="big">⛓</span>the arena is reconnecting — one moment…</div></div>;
  if (!wallet) return (
    <div className="card"><h3>Your dashboard <span className="hbar" /></h3>
      <div className="emptystate"><span className="big">🤖</span>Connect your wallet to open your dashboard — your ETH balance, your agents, wins &amp; losses, and the compute they've delivered.
        <div style={{ marginTop: 12 }}><button className="primary" onClick={() => connect().catch(() => {})}>Connect Wallet</button></div>
      </div>
    </div>
  );

  const live = (arena.race?.agents ?? []).filter((a: any) => a.owner === wallet.address);
  const past = arena.pastRaces ?? [];
  const myEntries = past.filter((r: any) => r.results.some((x: any) => x.owner === wallet.address));
  // W/L only counts CONTESTED races (≥2 stakers). Solo races are refunds, not wins/losses.
  const myContested = myEntries.filter((r: any) => isContested(r));
  const wins = myContested.filter((r: any) => potChampion(r)?.owner === wallet.address).length;
  const losses = myContested.length - wins;
  // "ETH won" = prize ETH from races actually won (excludes solo refunds of your own stake).
  const ethWon = myContested.reduce((s: number, r: any) => s + (potChampion(r)?.owner === wallet.address ? (potChampion(r)?.paidEth || 0) : 0), 0);

  const liveVerified = live.reduce((s: number, a: any) => s + a.jobsVerified, 0);
  const liveRejected = live.reduce((s: number, a: any) => s + a.jobsRejected, 0);
  const liveCredits = live.reduce((s: number, a: any) => s + a.credits, 0);
  const winRate = myContested.length > 0 ? Math.round((wins / myContested.length) * 100) : 0;

  const Tile = ({ label, value, accent }: { label: string; value: React.ReactNode; accent?: boolean }) => (
    <div style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 12, padding: "11px 14px" }}>
      <div className="mut" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 5 }}>{label}</div>
      <div className="mono" style={{ fontSize: 19, fontWeight: 600, color: accent ? "var(--accent)" : "var(--ink)" }}>{value}</div>
    </div>
  );

  return (
    <>
      <div className="card" style={{ borderColor: "var(--violet-border)", background: "linear-gradient(180deg, var(--violet-soft), var(--surface))" }}>
        <h3>Your dashboard <span className="hbar" /><span className="mono" style={{ letterSpacing: 0, color: "var(--muted)" }}>{wallet.address.slice(0, 6)}..{wallet.address.slice(-4)}</span></h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 10 }}>
          <Tile label="ETH balance" value={bal !== null ? <>{fmtEth(bal)} <EthMark size={13} /></> : "…"} accent />
          <Tile label="Record (W/L)" value={`${wins}W · ${losses}L`} />
          <Tile label="Win rate" value={`${winRate}%`} />
          <Tile label="ETH won" value={<>{fmtEth(ethWon)} <EthMark size={13} /></>} accent />
          <Tile label="Agents racing" value={`${live.length}`} />
          <Tile label="Live P&L" value={`${liveCredits >= 0 ? "+$" : "−$"}${Math.abs(liveCredits).toFixed(0)}`} accent />
        </div>
      </div>

      <div className="card">
        <h3>Your agents — this race <span className="hbar" />{live.length > 0 && <span className="mono" style={{ letterSpacing: 0, color: liveCredits >= 0 ? "var(--good)" : "var(--critical)" }}>{liveCredits >= 0 ? "+$" : "−$"}{Math.abs(liveCredits).toFixed(0)} · {liveVerified}W {liveRejected}L</span>}</h3>
        {live.length > 0 ? (
          <table>
            <thead><tr><th>Agent</th><th>Desk</th><th>Positions</th><th className="num">P&L</th><th className="num">W/L</th><th className="num">Equity</th></tr></thead>
            <tbody>
              {live.map((a: any) => (
                <tr key={a.id}>
                  <td><span className="dot" style={{ background: STRAT_COLOR[a.strategy] ?? "#2a78d6" }} /><span className="ink">{a.name}</span></td>
                  <td className="mut" style={{ fontSize: 11.5 }}>{a.desk ?? arena.strategies[a.strategy]?.name}</td>
                  <td className="mut" style={{ fontSize: 11 }}>{(a.positions ?? []).map((p: any) => `${p.sym} ${p.qty}`).join(", ") || "all cash"}</td>
                  <td className="num" style={{ color: a.credits >= 0 ? "var(--good)" : "var(--critical)" }}>{fmtPnl(a.credits)}</td>
                  <td className="num"><span className="wl-w">{a.jobsVerified}W</span> <span className="wl-l">{a.jobsRejected}L</span></td>
                  <td className="num">${(a.equityUsd ?? 0).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="mut" style={{ fontSize: 12.5, padding: "4px 0 8px" }}>No agent in the current race. Build one below — it shows up here, ranked and earning.</div>}
      </div>

      {myEntries.length > 0 && (
        <div className="card">
          <h3>Your history <span className="hbar" /></h3>
          <table>
            <thead><tr><th>Race</th><th>Result</th><th className="num">Net cr</th><th className="num">ETH</th><th>Proof</th></tr></thead>
            <tbody>
              {[...past].filter((r: any) => r.results.some((x: any) => x.owner === wallet.address)).map((r: any) => {
                const mine = r.results.find((x: any) => x.owner === wallet.address);
                const won = potChampion(r)?.owner === wallet.address;
                const refunded = !isContested(r) && (mine?.paidEth || 0) > 0;
                return (
                  <tr key={r.id}>
                    <td className="mut">#{r.id}</td>
                    <td style={{ color: won ? "var(--good)" : "var(--ink-2)" }}>{won ? "🥇 won" : refunded ? "↩ refund" : "raced"} · {mine?.name}</td>
                    <td className="num">{mine?.credits?.toFixed(0) ?? "—"}</td>
                    <td className="num" style={{ color: "var(--good)" }}>{mine?.paidEth > 0 ? <>+{fmtEth(mine.paidEth)} <EthMark size={10} /></> : "—"}</td>
                    <td>{mine?.tx ? <a href={explorerTxUrl(arena, mine.tx)} target="_blank" rel="noreferrer" style={{ color: "var(--violet)", fontFamily: "var(--font-mono)", fontSize: 11.5 }}>↗</a> : <span className="mut">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ============================================================ CompareCharts
// Head-to-head data: every agent's credit curve on one chart + a comparison
// table of machine, rent, revenue, margins and efficiency — so a visitor can
// judge WHO is running the best compute business, at a glance.
export function CompareCharts() {
  const { arena } = useArena();
  const race = arena?.race;
  const [hover, setHover] = useState<string | null>(null);
  if (!race) return null;
  const agents = [...race.agents].filter((a: any) => a.funded).sort((a: any, b: any) => b.credits - a.credits);
  if (!agents.length) return null;

  const allPts = agents.flatMap((a: any) => a.creditHistory ?? []);
  const t0 = Math.min(...allPts.map((p: any) => p.t));
  const t1 = Math.max(...allPts.map((p: any) => p.t), t0 + 1);
  const v0 = Math.min(0, ...allPts.map((p: any) => p.v));
  const v1 = Math.max(10, ...allPts.map((p: any) => p.v));
  const W = 760, H = 210, PAD = 8;
  const x = (t: number) => PAD + ((t - t0) / (t1 - t0)) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - ((v - v0) / (v1 - v0)) * (H - 2 * PAD);

  const fmtPct = (n: number) => `${Math.round(n)}%`;
  const rentOf = (a: any) => a.silicon?.match(/\((\d+) cr\/u-hr\)/)?.[1] ?? (a.backend === "own" ? "0" : "—");

  return (
    <div className="card">
      <h3>Compare the books — head-to-head <span className="hbar" /><span className="mono" style={{ letterSpacing: 0, color: "var(--muted)", fontSize: 11 }}>P&L over the race · hover a line or row</span></h3>

      {/* credits-over-time, all agents on one canvas */}
      <div style={{ overflowX: "auto" }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", minWidth: 560, display: "block" }}>
          <line x1={PAD} x2={W - PAD} y1={y(0)} y2={y(0)} stroke="var(--border-strong)" strokeDasharray="4 4" strokeWidth="1" />
          <text x={W - PAD - 2} y={y(0) - 4} textAnchor="end" fontSize="9" fill="var(--muted)" fontFamily="var(--font-mono)">$0</text>
          {agents.map((a: any) => {
            const pts = (a.creditHistory ?? []).map((p: any) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
            const c = STRAT_COLOR[a.strategy] ?? "#2a78d6";
            const dim = hover && hover !== a.id;
            return (
              <g key={a.id} onMouseEnter={() => setHover(a.id)} onMouseLeave={() => setHover(null)} style={{ cursor: "pointer" }}>
                <polyline points={pts} fill="none" stroke={c} strokeWidth={hover === a.id ? 3 : 2} opacity={dim ? 0.18 : 1} strokeLinejoin="round" strokeLinecap="round" />
                {(a.creditHistory ?? []).length > 0 && (() => { const last = a.creditHistory[a.creditHistory.length - 1]; return (
                  <circle cx={x(last.t)} cy={y(last.v)} r={hover === a.id ? 4 : 2.5} fill={c} opacity={dim ? 0.18 : 1} />
                ); })()}
              </g>
            );
          })}
        </svg>
      </div>
      {/* legend */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "6px 0 12px" }}>
        {agents.map((a: any) => (
          <span key={a.id} onMouseEnter={() => setHover(a.id)} onMouseLeave={() => setHover(null)}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 10px", borderRadius: 999, border: `1px solid ${hover === a.id ? (STRAT_COLOR[a.strategy] ?? "#2a78d6") : "var(--border)"}`, background: "var(--surface-2)", fontFamily: "var(--font-mono)", fontSize: 10.5, cursor: "default" }}>
            <span className="dot" style={{ background: STRAT_COLOR[a.strategy] ?? "#2a78d6", margin: 0 }} />
            <span className="ink">{a.name}</span>
            <span style={{ color: a.credits >= 0 ? "var(--good)" : "var(--critical)" }}>{a.credits >= 0 ? "+" : ""}{a.credits.toFixed(0)}</span>
          </span>
        ))}
      </div>

      {/* the head-to-head numbers */}
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead><tr><th>Agent</th><th>Desk</th><th className="num">Equity</th><th className="num">Cash</th><th className="num">P&L</th><th className="num">Trades</th><th className="num">Win rate</th><th>Book</th></tr></thead>
          <tbody>
            {agents.map((a: any) => {
              const total = a.jobsVerified + a.jobsRejected;
              return (
                <tr key={a.id} onMouseEnter={() => setHover(a.id)} onMouseLeave={() => setHover(null)} style={hover === a.id ? { background: "var(--violet-soft)" } : undefined}>
                  <td><span className="dot" style={{ background: STRAT_COLOR[a.strategy] ?? "#2a78d6" }} /><span className="ink">{a.name}</span>{!a.house && <span style={{ color: "var(--violet)", fontSize: 9 }}> ·player</span>}</td>
                  <td className="mut" style={{ fontSize: 10.5 }}>{a.desk}</td>
                  <td className="num ink">${(a.equityUsd ?? 0).toFixed(2)}</td>
                  <td className="num mut">${(a.cashUsd ?? 0).toFixed(0)}</td>
                  <td className="num" style={{ color: a.credits >= 0 ? "var(--good)" : "var(--critical)", fontWeight: 700 }}>{fmtPnl(a.credits)}</td>
                  <td className="num">{a.jobsWon}</td>
                  <td className="num">{total > 0 ? Math.round((a.jobsVerified / total) * 100) + "%" : "—"}</td>
                  <td className="mut" style={{ fontSize: 10.5 }}>{(a.positions ?? []).map((p: any) => `${p.sym} $${p.valueUsd.toFixed(0)}`).join(" · ") || "all cash"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mut" style={{ fontSize: 11, marginTop: 8 }}>
        <b className="ink">How to read it:</b> equity is the wallet's live USDG plus stock-token value. P&amp;L is the change
        from its on-chain equity when the race opened; the curve updates from confirmed balances and live token prices.
      </div>
    </div>
  );
}

// =========================================================== LiveFloorFeed
// The "what the desks are ACTUALLY doing" card: a terminal of every real
// event — entries, exits, realized P&L, ETH settled — plus the trading
// telemetry for the race. All of it is live /state data.
export function LiveComputeFeed() {
  const { arena } = useArena();
  const race = arena?.race;
  if (!race) return null;
  const funded = race.agents.filter((a: any) => a.funded);
  const lines = funded
    .flatMap((a: any) => (a.events ?? []).map((e: any) => ({ at: e.at, name: a.name, color: STRAT_COLOR[a.strategy] ?? "#2a78d6", text: e.text })))
    .sort((x: any, y: any) => y.at - x.at)
    .slice(0, 18);
  const wins = funded.reduce((s: number, a: any) => s + a.jobsVerified, 0);
  const losses = funded.reduce((s: number, a: any) => s + a.jobsRejected, 0);
  const tradesN = funded.reduce((s: number, a: any) => s + a.jobsWon, 0);
  const rate = wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100) : 100;
  const mkt = arena?.market;

  const chip = (label: string, value: string) => (
    <span key={label} style={{ display: "inline-flex", gap: 6, alignItems: "baseline", padding: "4px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface-2)" }}>
      <span className="mut" style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</span>
      <span className="mono ink" style={{ fontSize: 12.5, fontWeight: 600 }}>{value}</span>
    </span>
  );

  return (
    <div className="card">
      <h3>Live floor feed — what the desks are doing right now <span className="hbar" /><span className="livedot" /></h3>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        {chip("trades", `${tradesN}`)}
        {chip("winning exits", `${wins}W`)}
        {chip("losing exits", `${losses}L`)}
        {chip("win rate", `${rate}%`)}
        {chip("market", mkt?.live ? "LIVE · Robinhood Chain" : "reconnecting…")}
        {(mkt?.stocks ?? []).slice(0, 3).map((st: any) => chip(st.sym, st.usd ? `$${Number(st.usd).toFixed(2)}` : "…"))}
      </div>
      <div style={{ background: "#101510", borderRadius: 12, padding: "12px 14px", maxHeight: 280, overflowY: "auto", fontFamily: "var(--font-mono)", fontSize: 11.5, lineHeight: 1.75 }}>
        {lines.map((l: any, i: number) => (
          <div key={`${l.at}-${i}`} style={{ display: "flex", gap: 8, whiteSpace: "nowrap" }}>
            <span style={{ color: "#6d7380" }}>{new Date(l.at).toISOString().slice(11, 19)}</span>
            <span style={{ color: l.color, fontWeight: 600, minWidth: 104, overflow: "hidden", textOverflow: "ellipsis" }}>[{l.name}]</span>
            <span style={{ color: "#d9e4d9", overflow: "hidden", textOverflow: "ellipsis" }}>{l.text}</span>
          </div>
        ))}
        {lines.length === 0 && <span style={{ color: "#6d7380" }}>lobby open — the feed lights up the second the race starts…</span>}
      </div>
      <div className="mut" style={{ fontSize: 11.5, marginTop: 8 }}>
        Every line is a desk acting on the LIVE market: entries, exits, realized P&L — and every fill batch is anchored
        on Robinhood Chain. The prices are the real Stock Token markets, tick by tick.
      </div>
    </div>
  );
}

// ============================================================== ComputeArena
// The full arena tab: live race + build + on-chain proofs + past winners.
export function ComputeArena() {
  const { arena, offline } = useArena();
  const { wallet } = useWallet();
  const [, tick] = useState(0);
  const [betMsg, setBetMsg] = useState<string | null>(null);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, []);

  if (offline || !arena) return <div className="card"><h3>Live compute arena <span className="hbar" /></h3><div className="emptystate"><span className="big">⛓</span>the arena is reconnecting — one moment…</div></div>;

  const race = arena.race;
  const now = Date.now();
  const ranked = race ? [...race.agents].filter((a: any) => a.funded).sort((a: any, b: any) => b.credits - a.credits) : [];
  const secsLeft = race ? Math.max(0, Math.floor((race.endsAt - now) / 1000)) : 0;
  const betsOpen = race ? now < race.sideBetCutoff : false;

  async function backAgent(agentId: string, agentName: string) {
    if (!wallet) { setBetMsg("connect your wallet (Create-agent card below) to back an agent"); return; }
    try {
      setBetMsg(`opening a bet on ${agentName}…`);
      const res = await fetch(`${RACES_API}/bet`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId, owner: wallet.address }) });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setBetMsg(`approve the ${arena.minSideBetEth} ETH bet in ${wallet.name}…`);
      const tx = await payEntry(arena.chain, wallet.provider, wallet.address, data.depositAddress, data.minWeiHex);
      setBetMsg(`bet placed on ${agentName} (${tx.slice(0, 12)}…) — if it finishes #1 you split the side pool`);
    } catch (e: any) { setBetMsg(String(e?.message ?? e).slice(0, 140)); }
  }

  const proofs: Array<{ tx: string | null; tag: string; title: string; sub?: string; color: string; bg: string }> = [];
  (race?.trades ?? []).forEach((f: any) => { if (f.receiptTx || f.proven) proofs.push({ tx: f.receiptTx ?? null, tag: "TRADE", color: "#008a36", bg: "#e4f6e6", title: `${f.name} · ${f.side.toUpperCase()} ${Number(f.qty).toLocaleString(undefined, { maximumFractionDigits: 8 })} ${f.sym} @ ${Number(f.px).toFixed(2)}`, sub: `$${Number(f.usd).toFixed(2)} real notional · confirmed wallet swap` }); });
  (arena.pastRaces ?? []).forEach((r: any) => {
    r.results.forEach((res: any) => { if (res.tx) proofs.push({ tx: res.tx, tag: "PAYOUT", color: "#059669", bg: "#e7f7f0", title: `Race #${r.id} · ${fmtEth(res.paidEth)} ETH → ${res.name}`, sub: "real ETH payout on-chain" }); });
    if (r.anchorTx) proofs.push({ tx: r.anchorTx, tag: "RESULT", color: "#d97706", bg: "#fdf3e3", title: `Race #${r.id} · standings anchored`, sub: "leaderboard on-chain" });
  });
  const shownProofs = proofs.slice(0, 12);

  return (
    <>
      <VisualRace arena={arena} myAddress={wallet?.address} />
      <RealTradesFeed />
      <HouseWallets />
      <div className="card">
        <h3>The trading floor — real stocks · live prices · on-chain receipts<span className="hbar" />
          <span className="mono" style={{ letterSpacing: 0, color: "var(--muted)" }}>{race && <>race #{race.id} · {Math.floor(secsLeft / 60)}:{String(secsLeft % 60).padStart(2, "0")} · pot {fmtEth(race.potEth)} <EthMark size={10} /> · side {fmtEth(race.sidePotEth)} <EthMark size={10} /></>}</span>
        </h3>
        {/* THE TAPE — every fill, live, with its on-chain anchor */}
        <div style={{ marginBottom: 12, overflowX: "auto" }}>
          <table>
            <thead><tr><th>Time</th><th>Agent</th><th>Side</th><th className="num">Qty</th><th>Stock</th><th className="num">Price</th><th className="num">Notional</th><th>Receipt</th></tr></thead>
            <tbody>
              {(race?.trades ?? []).slice(0, 8).map((f: any, i: number) => (
                <tr key={`${f.t}-${i}`}>
                  <td className="mut" style={{ fontSize: 11 }}>{new Date(f.t).toISOString().slice(11, 19)}</td>
                  <td><span className="dot" style={{ background: STRAT_COLOR[f.strategy] ?? "#2a78d6" }} /><span className="ink">{f.name}</span></td>
                  <td style={{ color: f.side === "buy" ? "var(--good)" : "var(--critical)", fontWeight: 700, fontSize: 11.5 }}>{f.side.toUpperCase()}</td>
                  <td className="num">{Number(f.qty).toLocaleString(undefined, { maximumFractionDigits: 8 })}</td>
                  <td className="ink" style={{ fontWeight: 600 }}>{f.sym}</td>
                  <td className="num">${Number(f.px).toFixed(2)}</td>
                  <td className="num mut">${Number(f.usd).toFixed(2)}</td>
                  <td>{f.receiptTx ? <a href={explorerTxUrl(arena, f.receiptTx)} target="_blank" rel="noreferrer" style={{ color: "var(--violet)", fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 600 }}>on-chain ↗</a> : f.proven ? <span style={{ color: "var(--violet)", fontSize: 10.5 }} title="anchored — link public at launch">✓🔒</span> : <span className="mut" style={{ fontSize: 10.5 }}>queued…</span>}</td>
                </tr>
              ))}
              {(race?.trades ?? []).length === 0 && <tr><td colSpan={8} className="mut" style={{ padding: 12 }}>the tape starts printing the moment the race opens…</td></tr>}
            </tbody>
          </table>
          <div className="mut" style={{ fontSize: 11, marginTop: 6 }}>
            <b className="ink">Why this is verifiable:</b> every row is a successful wallet swap of a real Robinhood Stock Token.
            Open the transaction to verify the USDG movement, token transfer, and receiving agent address.
          </div>
        </div>
        <table>
          <thead><tr><th>#</th><th>Agent</th><th>Desk</th><th className="num">P&L</th><th className="num">W/L</th><th className="num">Equity</th><th className="num">Back</th></tr></thead>
          <tbody>
            {ranked.map((a: any, i: number) => (
              <tr key={a.id} style={wallet && a.owner === wallet.address ? { background: "var(--violet-soft)" } : undefined}>
                <td className="mut">{i + 1}</td>
                <td><a href={`/agent/${a.id}`} style={{ textDecoration: "none" }} title="open this desk's dashboard — trades, P&L, tx ids"><span className="dot" style={{ background: STRAT_COLOR[a.strategy] ?? "#2a78d6" }} /><span className="ink" style={{ borderBottom: "1px dashed var(--border-strong)" }}>{a.name}</span></a>{a.house ? <span className="mut" style={{ fontSize: 10 }}> · house</span> : <span style={{ color: "var(--violet)", fontSize: 10 }}> · staked {fmtEth(a.entryEth)} <EthMark size={8} /></span>}{a.wallet && <> · <a href={explorerAddressUrl(arena, a.wallet)} target="_blank" rel="noreferrer" title={`${a.name}'s wallet on Blockscout`} style={{ color: "var(--violet)", fontFamily: "var(--font-mono)", fontSize: 10, textDecoration: "none" }}>{a.wallet.slice(0, 6)}..{a.wallet.slice(-4)} ↗</a></>}{a.sideBetEth > 0 && <span style={{ color: "var(--warning)", fontSize: 10 }}> · backed {fmtEth(a.sideBetEth)} <EthMark size={8} /></span>}</td>
                <td className="mut" style={{ fontSize: 11 }}>{a.desk ?? arena.strategies?.[a.strategy]?.name}</td>
                <td className="num" style={{ color: a.credits >= 0 ? "var(--good)" : "var(--critical)" }}>{fmtPnl(a.credits)}</td>
                <td className="num"><span className="wl-w">{a.jobsVerified}W</span> <span className="wl-l">{a.jobsRejected}L</span></td>
                <td className="num">${(a.equityUsd ?? 0).toFixed(2)}</td>
                <td className="num">{betsOpen ? <button className="ghost" style={{ padding: "3px 10px", fontSize: 11 }} onClick={() => backAgent(a.id, a.name)}>{arena.minSideBetEth} <EthMark size={9} /></button> : <span className="mut" style={{ fontSize: 10 }}>closed</span>}</td>
              </tr>
            ))}
            {ranked.length === 0 && <tr><td colSpan={7} className="mut" style={{ padding: 14 }}>agents funding up…</td></tr>}
          </tbody>
        </table>
        {betMsg && <div className="ok" style={{ marginTop: 8 }}>{betMsg}</div>}
        <div className="mut" style={{ fontSize: 11.5, marginTop: 10 }}>Score = change in real wallet equity (USDG + Stock Tokens) since the race opened. <b className="ink">Back</b> any agent with ETH: backers of the round's #1 split the side pool (5% rake).</div>
      </div>

      <CompareCharts />

      <LiveComputeFeed />

      <BuildAgentForm />

      <div className="card">
        <h3>On-chain receipts — click any to verify on Blockscout <span className="hbar" /><span className="livedot" /></h3>
        {arena.receiptsPaused && <div className="err" style={{ marginBottom: 10 }}>⚠ proofs paused — fund the treasury {arena.treasury?.slice(0, 12)}… with ETH for gas</div>}
        <div style={{ display: "flex", flexDirection: "column" }}>
          {shownProofs.map((p, i) => {
            const inner = (
              <>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 600, color: p.color, background: p.bg, borderRadius: 6, padding: "4px 0", textAlign: "center" }}>{p.tag}</span>
                <span style={{ minWidth: 0 }}><span className="ink" style={{ fontSize: 13, fontWeight: 600 }}>{p.title}</span>{p.sub && <span className="mut" style={{ display: "block", fontSize: 10.5, fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.sub}</span>}</span>
                {p.tx
                  ? <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--violet)", fontWeight: 600, whiteSpace: "nowrap" }}>{p.tx.slice(0, 7)}…{p.tx.slice(-5)} ↗</span>
                  : <span className="mut" style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, whiteSpace: "nowrap" }} title="tx links reveal the wallets — public at launch">on-chain ✓ · 🔒 link at launch</span>}
              </>
            );
            const rowStyle: React.CSSProperties = { display: "grid", gridTemplateColumns: "84px 1fr auto", gap: 12, alignItems: "center", padding: "10px 6px", textDecoration: "none", color: "inherit", borderBottom: i < shownProofs.length - 1 ? "1px solid var(--grid)" : "none" };
            return p.tx
              ? <a key={`${p.tag}${i}`} href={explorerTxUrl(arena, p.tx)} target="_blank" rel="noreferrer" style={rowStyle}>{inner}</a>
              : <div key={`${p.tag}${i}`} style={rowStyle}>{inner}</div>;
          })}
          {shownProofs.length === 0 && <div className="emptystate">waiting for the next fill batch to anchor on-chain…</div>}
        </div>
      </div>

      {arena.pastRaces && arena.pastRaces.length > 0 && (
        <div className="card">
          <h3>Past winners <span className="hbar" /></h3>
          <table>
            <thead><tr><th>Race</th><th>Winner</th><th className="num">Net cr</th><th className="num">Pot paid</th><th>Proof</th></tr></thead>
            <tbody>
              {arena.pastRaces.map((r: any) => { const w = potChampion(r); const top = (r.results ?? [])[0]; return (
                <tr key={r.id}><td className="mut">#{r.id}</td><td className="ink">{w ? `🥇 ${w.name}` : <span className="mut">no pot winner{top ? ` · top: ${top.name}` : ""}</span>}</td><td className="num">{(w ?? top) ? (w ?? top).credits.toFixed(0) : "—"}</td><td className="num" style={{ color: "var(--good)" }}>{w && w.paidEth > 0 ? <>{fmtEth(w.paidEth)} <EthMark size={10} /></> : "—"}</td><td>{r.anchorTx ? <a href={explorerTxUrl(arena, r.anchorTx)} target="_blank" rel="noreferrer" style={{ color: "var(--violet)", fontFamily: "var(--font-mono)", fontSize: 11.5 }}>on-chain ↗</a> : <span className="mut">—</span>}</td></tr>
              ); })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ============================================================== MyComputeTab
// The "My Agents" tab: your agents + the SAME create-agent flow.
export function MyComputeTab() {
  return (
    <>
      <MyComputeRoster />
      <BuildAgentForm />
    </>
  );
}
