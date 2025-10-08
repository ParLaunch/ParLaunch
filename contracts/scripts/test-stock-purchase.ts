import { config as loadEnv } from "dotenv";
import path from "node:path";
import {
  Contract,
  ContractFactory,
  JsonRpcProvider,
  Wallet,
  formatEther,
  formatUnits,
  parseEther,
  parseUnits,
} from "ethers";

loadEnv({ path: path.resolve(__dirname, "../../arena/.env") });

const artifact = require("../artifacts/contracts/StockTradeExecutor.sol/StockTradeExecutor.json");

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const QUOTER = "0x8dc178efb8111bb0973dd9d722ebeff267c98f94";
const AMOUNT_IN = parseUnits("0.25", 6);
const MAX_GAS_COST = parseEther("0.0002");
// Fork total: 1,103,196 gas. This leaves ~10% headroom while preserving the
// absolute 0.0002 ETH live safety ceiling below.
const CONSERVATIVE_GAS_UNITS = 1_220_000n;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
const POOL_KEY = "tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";
const QUOTER_ABI = [
  `function quoteExactInputSingle(tuple(${POOL_KEY} poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)`,
];

async function main() {
  const live = process.argv.includes("--live");
  const key = process.env.AGENT_SECRET_1;
  if (!key) throw new Error("AGENT_SECRET_1 is required in arena/.env");

  const provider = new JsonRpcProvider(RPC);
  const network = await provider.getNetwork();
  if (network.chainId !== 4663n) throw new Error(`refusing chain ${network.chainId}; expected 4663`);

  const buyer = new Wallet(key, provider);