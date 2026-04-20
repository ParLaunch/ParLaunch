import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import AgentPage from "./AgentPage";
import Landing from "./Landing";
import Docs from "./Docs";
import "./theme.css";

// "/" = landing → "Enter Arena" → /app = THE dashboard (App), which holds
// the compute jobs + on-chain proofs too. /docs = the full manual.
// (the old /races Solana page retired with the move to Robinhood Chain)
const path = window.location.pathname;
const page = path.startsWith("/docs")
  ? <Docs />
  : path.startsWith("/agent/")
    ? <AgentPage />
    : (path.startsWith("/app") || path.startsWith("/arena") || path.startsWith("/races"))
      ? <App />
      : <Landing />;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{page}</React.StrictMode>
);
