import { config as loadEnv } from "dotenv";
import path from "node:path";
import { Contract, JsonRpcProvider, Wallet, formatEther, formatUnits, parseEther, parseUnits } from "ethers";

loadEnv({ path: path.resolve(__dirname, "../../arena/.env") });

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const EXECUTOR = "0x97e00bB5C8991Ebe4750058ac62bd86fF521DEf5";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const QUOTER = "0x8dc178efb8111bb0973dd9d722ebeff267c98f94";
const ZERO = "0x0000000000000000000000000000000000000000";
const AMOUNT = parseUnits("0.25", 6);
const MAX_GAS_PER_WALLET = parseEther("0.0001");
const TESTS = [
  ["NVDA", "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC"],
  ["AAPL", "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9"],
  ["MSFT", "0xe93237C50D904957Cf27E7B1133b510C669c2e74"],
  ["TSLA", "0x322F0929c4625eD5bAd873c95208D54E1c003b2d"],
  ["META", "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35"],
] as const;
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
];
const STOCK_ABI = ["function balanceOf(address) view returns (uint256)"];
const POOL_KEY = "tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";
const QUOTER_ABI = [`function quoteExactInputSingle(tuple(${POOL_KEY} poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)`];
const EXECUTOR_ABI = ["function buyStock(address,uint256,uint256,uint256) returns (uint256)"];

async function main() {
  const live = process.argv.includes("--live");
  const provider = new JsonRpcProvider(RPC);
  if ((await provider.getNetwork()).chainId !== 4663n) throw new Error("wrong chain");
  if ((await provider.getCode(EXECUTOR)) === "0x") throw new Error("executor is not deployed");
  const wallets = TESTS.map((_, i) => {