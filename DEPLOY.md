# Going live — Hedge Bots (Robinhood Chain)

Everything works locally today. This is the checklist so **nothing breaks when you move it** to the internet. The arena is the piece that goes live (real wallets, real ETH on Robinhood Chain).

## The pieces — ONE host (Railway serves everything)

| Piece | What it is | Where it hosts |
|---|---|---|
| `arena/` | the arena service — **also serves the built site** (`web/dist`) | **Railway** (one process, one URL) |
| `web/` | the site, built to static files at deploy time | served by the arena service |
| Robinhood Chain RPC | reads + broadcasts txns | public endpoints (`rpc.mainnet.chain.robinhood.com` / testnet), or a keyed Alchemy URL |

The service serves the site itself: `/`, `/app` and `/docs` are the pages, `/state`, `/join`, `/bet`, `/verify`, `/worker/*` are the API — same origin, so the frontend needs zero API config.

## 1. Everything → Railway (single service)

1. Push this repo to GitHub (already done — keys stay out via `.gitignore`).
2. New Railway project → **Deploy from GitHub repo** → pick this repo. **Root directory = the repo root** (leave blank / `/`). Build + start are read automatically from `railway.json` — no manual command entry:
   - build: installs `web/` deps, `npm run build` (produces `web/dist`), installs `arena/` deps
   - start: `npm start --prefix arena` — the arena service, which ALSO serves the built site
3. **Add a Volume** (Railway → your service → Variables/Settings → **+ Volume**) mounted at **`/data`**. This is what makes data survive redeploys — see step 5.
4. Set **Variables** (encrypted at rest, never in the repo — keys live ONLY here and in your local gitignored `.env`):
   | Variable | Value |
   |---|---|
   | `RH_RPC` | `https://rpc.mainnet.chain.robinhood.com` (or the testnet URL to test; keyed Alchemy URLs also work) |
   | `STATE_DIR` | `/data` — persists the ops-wallet key + past-race history on the volume |
   | `AGENT_SECRET_1..5` | the 5 house agent wallets (0x-prefixed hex private keys — MetaMask/Rabby export) |
   | `TREASURY_ADDRESS` | your treasury's PUBLIC address (receive-only — rent, rake & sweeps flow here; no key on the server) |
   | `VAST_API_KEY` | your vast.ai key (live GPU-market pricing) |
   | `PUBLIC_URL` | your Railway URL, e.g. `https://hedgebots.up.railway.app` (fills in the own-rig command players copy) |
   | `PUBLIC_WALLETS` | `agents` (agent addresses shown, treasury hidden) or `1` at full launch |
   | *(optional)* `TREASURY_SECRET` | only if you want a specific ops wallet; else one is generated on the volume and reused |
   | *(optional)* `CREDIT_GWEI`, `MIN_ENTRY_ETH`, `MAX_ENTRY_ETH`, `MIN_SIDEBET_ETH`, `AGENT_FLOAT_ETH`, `VAST_GPU`, `EXPLORER_URL` | economics/market tuning |
5. Railway gives you a URL like `https://hedgebots.up.railway.app` — **that's the whole product**: site + API + own-rig worker endpoint, one URL. Put that same URL in `PUBLIC_URL`.

**Persistence (data saved across redeploys):** Railway's filesystem is ephemeral — anything written at runtime is wiped on each deploy. The volume at `/data` + `STATE_DIR=/data` fixes this: the ops-wallet key (`evm-keys.json`) and past-race history (`races-evm.json`) live on the volume and survive. *Without* the volume the ops wallet regenerates every deploy (orphaning its balance) and past races reset. The live in-progress race always restarts fresh on a redeploy (stakes are already swept to the ops wallet, so no funds are lost) — deploy between races.

Fund the wallets (any EVM wallet): the 5 agent wallets a little ETH each; the ops wallet (printed in the service logs on boot) some gas ETH. The pot self-funds from stakes. Your treasury (`TREASURY_ADDRESS`) receives rent + rake + sweeps and needs no funding.

## 2. (Optional) The site on Vercel instead

Only if you later want a global CDN for the pages: Vercel project → root `web`, env `VITE_RACES_API` = your Railway URL. Not needed for launch — Railway alone serves everything.

## 3. Players

They need **any EVM wallet** (MetaMask, Rabby, Robinhood Wallet, Coinbase Wallet — discovery is EIP-6963, so whatever they have installed works). The site offers to **add/switch to Robinhood Chain automatically** when they stake. On testnet, free ETH comes from [faucet.testnet.chain.robinhood.com](https://faucet.testnet.chain.robinhood.com). Watching is free, no wallet needed.