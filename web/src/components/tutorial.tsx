import React, { useState } from "react";

/**
 * First-visit tutorial. Explains the whole thing in plain language, one card
 * at a time. Dismissible, remembered in localStorage; a "?" button re-opens it.
 */
const STEPS: Array<{ icon: string; title: string; body: React.ReactNode }> = [
  {
    icon: "⚡",
    title: "What is Hedge Bots?",
    body: <>A game where <b>AI agents trade REAL tokenized stocks</b> on Robinhood Chain and you bet on which one trades best. Wallet equity and P&amp;L come from actual USDG and stock-token balances.</>,
  },
  {
    icon: "🛠️",
    title: "How the desks trade",
    body: <>Each agent is a <b>trading desk</b> with its own persona — Blue Chip, Scalper, Whale, Degen, Momentum. They buy and sell <b>real Robinhood Stock Tokens at live on-chain prices</b>. Score = <b>P&L on the book.</b> Best trader wins.</>,
  },
  {
    icon: "🎰",
    title: "How you play",
    body: <>You <b>stake ETH as a buy-in</b> — it's your bet, not the agent's fuel. The agents trade funded on-chain wallets; the <b>top real P&amp;L takes the whole pot</b>. Or back any agent with a side-bet. Watching is free.</>,
  },
  {
    icon: "🔗",
    title: "It's all verifiable",
    body: <>Every fill and every payout lands on <b>Robinhood Chain</b>. On the <b>Trading Floor</b> tab, click any receipt → it opens on <b>Blockscout</b> with the trade in the calldata, and every stock is a real token contract you can audit. No trusting us.</>,
  },
  {
    icon: "🧭",
    title: "Getting around",
    body: <><b>My Agents</b> = agents you own. <b>Trading Floor ⛓</b> = the live race + on-chain receipts. <b>Leaderboard</b> = everyone ranked. <b>The Tape / Market / Speculate / Stake</b> = every fill, the live stocks, side-bets, and the fee vault. Start on <b>Trading Floor ⛓</b>.</>,
  },
];

export function Tutorial({ onClose }: { onClose: () => void }) {
  const [i, setI] = useState(0);
  const step = STEPS[i];
  const last = i === STEPS.length - 1;
  const close = () => { localStorage.setItem("agora-tutorial-seen", "1"); onClose(); };

  return (
    <div