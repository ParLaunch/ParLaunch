import { config as loadEnv } from "dotenv";
import path from "node:path";
import { ContractFactory, JsonRpcProvider, Wallet, formatEther, parseEther } from "ethers";

loadEnv({ path: path.resolve(__dirname, "../../arena/.env") });

const artifact = require("../artifacts/contracts/MultiStockTradeExecutor.sol/MultiStockTradeExecutor.json");
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const MAX_DEPLOY_GAS_ETH = parseEther("0.00025");

async function main() {
  const live = process.argv.includes("--live");
  const key = process.env.AGENT_SECRET_1;
  if (!key) throw new Error("AGENT_SECRET_1 is required");
  const provider = new JsonRpcProvider(RPC);
  const network = await provider.getNetwork();
  if (network.chainId !== 4663n) throw new Error(`refusing chain ${network.chainId}; expected 4663`);
  const wallet = new Wallet(key, provider);
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const deployTx = await factory.getDeployTransaction();
  const [gas, fees, balance] = await Promise.all([
    provider.estimateGas({ ...deployTx, from: wallet.address }),
    provider.getFeeData(),
    provider.getBalance(wallet.address),
  ]);
  const gasPrice = fees.maxFeePerGas ?? fees.gasPrice;
  if (!gasPrice) throw new Error("RPC returned no gas price");
  const projected = ((gas * 12n) / 10n) * gasPrice;
  if (projected > MAX_DEPLOY_GAS_ETH) {
    throw new Error(`gas safety stop: ${formatEther(projected)} ETH > ${formatEther(MAX_DEPLOY_GAS_ETH)} ETH`);
  }
  if (balance < projected) throw new Error("deployer lacks gas reserve");
  console.log(JSON.stringify({ mode: live ? "LIVE" : "DRY_RUN", deployer: wallet.address, estimatedGas: gas.toString(), projectedGasEth: formatEther(projected) }, null, 2));
  if (!live) return;
  const executor = await factory.deploy();
  const receipt = await executor.deploymentTransaction()!.wait(1);
  if (!receipt || receipt.status !== 1) throw new Error("deployment reverted");
  console.log(JSON.stringify({ result: "DEPLOYED", executor: await executor.getAddress(), tx: receipt.hash, gasUsed: receipt.gasUsed.toString() }, null, 2));
}
