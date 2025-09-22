import { config as loadEnv } from "dotenv";
import path from "node:path";
import { ContractFactory, JsonRpcProvider, Wallet, formatEther, parseEther } from "ethers";

loadEnv({ path: path.resolve(__dirname, "../../arena/.env") });
const artifact = require("../artifacts/contracts/MultiStockSellExecutor.sol/MultiStockSellExecutor.json");