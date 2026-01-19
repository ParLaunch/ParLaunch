import "dotenv/config";
import { JsonRpcProvider, Wallet, Contract, AbiCoder, Interface, formatEther, formatUnits, parseEther, parseUnits } from "ethers";

/**
 * REAL RWA TRADE — swap ETH ⇄ Robinhood Stock Tokens on Robinhood Chain
 * through Uniswap v4 (UniversalRouter), as two single-hop swaps:
 *   BUY:  ETH -> USDG (fee 460 pool) then USDG -> NVDA (fee 3000 pool)
 *   SELL: NVDA -> USDG then USDG -> ETH
 *
 *   npx tsx src/trade.ts --agent 1 --action quote --usd 10
 *   npx tsx src/trade.ts --agent 1 --action buy   --usd 2
 *   npx tsx src/trade.ts --agent 1 --action sell
 *   npx tsx src/trade.ts --agent 1 --action balances
 */

const provider = new JsonRpcProvider("https://rpc.mainnet.chain.robinhood.com");

const UNIVERSAL_ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904";
const V4_QUOTER = "0x8dc178efb8111bb0973dd9d722ebeff267c98f94";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

const ETH = "0x0000000000000000000000000000000000000000";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";

// verified-live hookless pools
const KEY_ETH_USDG = { currency0: ETH, currency1: USDG, fee: 460, tickSpacing: 9, hooks: ETH };
const KEY_USDG_NVDA = { currency0: USDG, currency1: NVDA, fee: 3000, tickSpacing: 60, hooks: ETH };

const abi = AbiCoder.defaultAbiCoder();
const POOLKEY = "tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)";
const PATHKEY = "tuple(address intermediateCurrency, uint24 fee, int24 tickSpacing, address hooks, bytes hookData)";
const EXACT_IN = `tuple(address currencyIn, ${PATHKEY}[] path, uint256[] minHopPriceX36, uint128 amountIn, uint128 amountOutMinimum)`;

const AGENTS = ["AGENT_SECRET_1", "AGENT_SECRET_2", "AGENT_SECRET_3", "AGENT_SECRET_4", "AGENT_SECRET_5"];
const NAMES = ["Friar Tuck", "Will Scarlet", "Little John", "Sheriff Notts", "Robyn Arrow"];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
];
const PERMIT2_ABI = [
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function allowance(address,address,address) view returns (uint160,uint48,uint48)",
];
const QUOTER_ABI = [
  `function quoteExactInputSingle(tuple(${POOLKEY} poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)`,
];
const UR = new Interface(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);

const arg = (n: string, d = "") => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? String(process.argv[i + 1]) : d; };
const explorer = (h: string) => `https://robinhoodchain.blockscout.com/tx/${h}`;

async function quoteSingle(poolKey: any, zeroForOne: boolean, amountIn: bigint): Promise<bigint> {
  const q = new Contract(V4_QUOTER, QUOTER_ABI, provider);
  const [out] = await q.quoteExactInputSingle.staticCall({ poolKey, zeroForOne, exactAmount: amountIn, hookData: "0x" });
  return out;
}

/** One single-hop v4 swap through the UniversalRouter. */
async function swapSingle(w: Wallet, poolKey: any, zeroForOne: boolean, amountIn: bigint, minOut: bigint, label: string): Promise<string> {
  const currencyIn = zeroForOne ? poolKey.currency0 : poolKey.currency1;
  const currencyOut = zeroForOne ? poolKey.currency1 : poolKey.currency0;
  const actions = "0x070b0e"; // SWAP_EXACT_IN · SETTLE · TAKE
  const params = [
    abi.encode([EXACT_IN], [{
      currencyIn,
      path: [{
        intermediateCurrency: currencyOut,
        fee: poolKey.fee,
        tickSpacing: poolKey.tickSpacing,
        hooks: poolKey.hooks,
        hookData: "0x",
      }],
      minHopPriceX36: [],
      amountIn,
      amountOutMinimum: minOut,
    }]),
    abi.encode(["address", "uint256", "bool"], [currencyIn, amountIn, true]),
    abi.encode(["address", "address", "uint256"], [currencyOut, w.address, 0]),
  ];
  const input = abi.encode(["bytes", "bytes[]"], [actions, params]);
  const data = UR.encodeFunctionData("execute", ["0x10", [input], Math.floor(Date.now() / 1000) + 300]);
  const value = currencyIn === ETH ? amountIn : 0n;
  console.log(`  ${label} …`);
  const tx = await w.sendTransaction({ to: UNIVERSAL_ROUTER, data, value });
  const rc = await tx.wait();
  console.log(`  ${rc?.status === 1 ? "CONFIRMED" : "REVERTED"} · ${explorer(tx.hash)}`);
  if (rc?.status !== 1) throw new Error("swap reverted");
  return tx.hash;
}

/** ERC-20 input needs the Permit2 rails once per token: token->Permit2->Router. */
async function ensurePermit2(w: Wallet, token: string, need: bigint): Promise<void> {
  const t = new Contract(token, ERC20_ABI, w);
  if ((await t.allowance(w.address, PERMIT2)) < need) {
    console.log("  approving token -> Permit2 …");
    await (await t.approve(PERMIT2, (1n << 255n))).wait();
  }
  const p2 = new Contract(PERMIT2, PERMIT2_ABI, w);
  const [amt] = await p2.allowance(w.address, token, UNIVERSAL_ROUTER);
  if (BigInt(amt) < need) {
    console.log("  approving Permit2 -> UniversalRouter …");
    await (await p2.approve(token, UNIVERSAL_ROUTER, (1n << 160n) - 1n, 281474976710655n)).wait();
  }
}

async function main() {
  const idx = Math.max(1, Math.min(5, Number(arg("agent", "1")))) - 1;
  const key = process.env[AGENTS[idx]];
  if (!key) { console.error(`missing ${AGENTS[idx]} in .env`); process.exit(1); }
  const w = new Wallet(key, provider);