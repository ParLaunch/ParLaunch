import { Contract, Wallet, formatEther, formatUnits, parseEther, parseUnits } from "ethers";
import { chain, provider, withWalletLane } from "./chain";

export const LIQUID_STOCKS = {
  NVDA: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
  TSLA: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
  AAPL: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
  MSFT: "0xe93237C50D904957Cf27E7B1133b510C669c2e74",
  SPY: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C",
  META: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35",
  GOOGL: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3",
} as const;

export type LiquidStockSymbol = keyof typeof LIQUID_STOCKS;
export const LIQUID_SYMBOLS = Object.keys(LIQUID_STOCKS) as LiquidStockSymbol[];

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const QUOTER = "0x8dc178efb8111bb0973dd9d722ebeff267c98f94";
const ZERO = "0x0000000000000000000000000000000000000000";
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
const POOL_KEY = "tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";
const QUOTER_ABI = [
  `function quoteExactInputSingle(tuple(${POOL_KEY} poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)`,
];
const EXECUTOR_ABI = [
  "function buyStock(address stockToken,uint256 usdgIn,uint256 minStockOut,uint256 deadline) returns (uint256)",
];
const SELL_EXECUTOR_ABI = [
  "function sellStock(address stockToken,uint256 stockIn,uint256 minUsdgOut,uint256 deadline) returns (uint256)",
];

export interface StockPurchase {
  symbol: LiquidStockSymbol;
  token: string;
  usdgSpent: string;
  stockReceived: string;
  approvalTx?: string;
  purchaseTx: string;
}

export interface StockSale {
  symbol: LiquidStockSymbol;
  token: string;
  stockSold: string;
  usdgReceived: string;
  approvalTx?: string;
  saleTx: string;
}

export interface StockBuyOptions {
  executor: string;
  amountUsdg: number;
  slippageBps: number;
  maxGasEth: number;
}

/** Buy one exact, capped USDG clip. Approval and purchase share the wallet nonce lane. */
export async function buyStockToken(
  wallet: Wallet,
  symbol: LiquidStockSymbol,
  options: StockBuyOptions,
): Promise<StockPurchase> {
  if (chain.chainId !== 4663) throw new Error(`stock buys require Robinhood Chain mainnet, got ${chain.chainId}`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(options.executor)) throw new Error("invalid STOCK_EXECUTOR_ADDRESS");
  if (!(options.amountUsdg >= 0.01 && options.amountUsdg <= 5)) throw new Error("live stock clip must be 0.01-5.00 USDG");
  if (!(options.slippageBps >= 1 && options.slippageBps <= 300)) throw new Error("slippage must be 1-300 bps");
  if (!(options.maxGasEth > 0 && options.maxGasEth <= 0.001)) throw new Error("invalid gas ceiling");

  return withWalletLane(wallet, async () => {
    const token = LIQUID_STOCKS[symbol];
    const amountIn = parseUnits(options.amountUsdg.toFixed(6), 6);
    const usdg = new Contract(USDG, ERC20_ABI, wallet);
    const stock = new Contract(token, ERC20_ABI, wallet);
    const executor = new Contract(options.executor, EXECUTOR_ABI, wallet);
    const quoter = new Contract(QUOTER, QUOTER_ABI, wallet);
    const [balance, before, allowance, fees] = await Promise.all([
      usdg.balanceOf(wallet.address),
      stock.balanceOf(wallet.address),
      usdg.allowance(wallet.address, options.executor),
      provider.getFeeData(),
    ]);
    if (balance < amountIn) throw new Error(`wallet has less than ${options.amountUsdg.toFixed(2)} USDG`);

    const usdgFirst = BigInt(USDG) < BigInt(token);
    const [quotedOut] = await quoter.quoteExactInputSingle.staticCall({
      poolKey: {
        currency0: usdgFirst ? USDG : token,
        currency1: usdgFirst ? token : USDG,
        fee: 3000,
        tickSpacing: 60,
        hooks: ZERO,
      },
      zeroForOne: usdgFirst,
      exactAmount: amountIn,
      hookData: "0x",
    });
    const minOut = (quotedOut * BigInt(10_000 - options.slippageBps)) / 10_000n;
    const deadline = Math.floor(Date.now() / 1000) + 180;
    const gasPrice = fees.maxFeePerGas ?? fees.gasPrice;
    if (!gasPrice) throw new Error("RPC returned no gas price");

    // Fork measurements are ~233k gas per buy; 400k leaves broad headroom.
    // Add 100k only if an ERC-20 approval is required.
    const conservativeGas = 400_000n + (allowance < amountIn ? 100_000n : 0n);
    const projectedGas = conservativeGas * gasPrice;
    const maxGas = parseEther(options.maxGasEth.toFixed(18));
    if (projectedGas > maxGas) {
      throw new Error(`gas safety stop: projected ${formatEther(projectedGas)} ETH > ${formatEther(maxGas)} ETH`);
    }
    if (await provider.getBalance(wallet.address) < projectedGas) throw new Error("wallet lacks gas reserve");

    let approvalTx: string | undefined;
    if (allowance < amountIn) {
      const tx = await usdg.approve(options.executor, amountIn);
      const receipt = await tx.wait(1);
      if (!receipt || receipt.status !== 1) throw new Error("USDG approval reverted");
      approvalTx = tx.hash;
    }
    const tx = await executor.buyStock(token, amountIn, minOut, deadline);
    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) throw new Error("stock purchase reverted");
    const received = (await stock.balanceOf(wallet.address)) - before;
    if (received < minOut) throw new Error("purchase delivered less than minimum output");

    return {
      symbol,
      token,
      usdgSpent: formatUnits(amountIn, 6),
      stockReceived: formatUnits(received, 18),
      approvalTx,
      purchaseTx: tx.hash,
    };
  });
}

/** Sell the wallet's full balance of one supported stock token back to USDG. */
export async function sellStockToken(
  wallet: Wallet,
  symbol: LiquidStockSymbol,
  options: Omit<StockBuyOptions, "amountUsdg"> & { stockAmount?: string },
): Promise<StockSale | null> {
  if (chain.chainId !== 4663) throw new Error(`stock sells require Robinhood Chain mainnet, got ${chain.chainId}`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(options.executor)) throw new Error("invalid STOCK_SELL_EXECUTOR_ADDRESS");
  if (!(options.slippageBps >= 1 && options.slippageBps <= 300)) throw new Error("slippage must be 1-300 bps");
  if (!(options.maxGasEth > 0 && options.maxGasEth <= 0.001)) throw new Error("invalid gas ceiling");

  return withWalletLane(wallet, async () => {
    const token = LIQUID_STOCKS[symbol];
    const stock = new Contract(token, ERC20_ABI, wallet);
    const usdg = new Contract(USDG, ERC20_ABI, wallet);
    const executor = new Contract(options.executor, SELL_EXECUTOR_ABI, wallet);
    const quoter = new Contract(QUOTER, QUOTER_ABI, wallet);
    const [fullBalance, allowance, beforeUsdg, fees] = await Promise.all([
      stock.balanceOf(wallet.address),
      stock.allowance(wallet.address, options.executor),
      usdg.balanceOf(wallet.address),
      provider.getFeeData(),
    ]);
    const requested = options.stockAmount ? parseUnits(options.stockAmount, 18) : fullBalance;
    const stockIn = requested < fullBalance ? requested : fullBalance;
    if (stockIn === 0n) return null;

    const tokenFirst = BigInt(token) < BigInt(USDG);
    const [quotedOut] = await quoter.quoteExactInputSingle.staticCall({
      poolKey: {
        currency0: tokenFirst ? token : USDG,
        currency1: tokenFirst ? USDG : token,
        fee: 3000,
        tickSpacing: 60,
        hooks: ZERO,
      },
      zeroForOne: tokenFirst,
      exactAmount: stockIn,
      hookData: "0x",
    });
    const minOut = (quotedOut * BigInt(10_000 - options.slippageBps)) / 10_000n;
    const gasPrice = fees.maxFeePerGas ?? fees.gasPrice;
    if (!gasPrice) throw new Error("RPC returned no gas price");
    const conservativeGas = 400_000n + (allowance < stockIn ? 100_000n : 0n);
    const projectedGas = conservativeGas * gasPrice;
    const maxGas = parseEther(options.maxGasEth.toFixed(18));
    if (projectedGas > maxGas) throw new Error(`gas safety stop: projected ${formatEther(projectedGas)} ETH > ${formatEther(maxGas)} ETH`);
    if (await provider.getBalance(wallet.address) < projectedGas) throw new Error("wallet lacks gas reserve");

    let approvalTx: string | undefined;
    if (allowance < stockIn) {
      const tx = await stock.approve(options.executor, stockIn);
      const receipt = await tx.wait(1);
      if (!receipt || receipt.status !== 1) throw new Error("stock approval reverted");
      approvalTx = tx.hash;
    }
    const tx = await executor.sellStock(token, stockIn, minOut, Math.floor(Date.now() / 1000) + 180);
    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) throw new Error("stock sale reverted");
    const received = (await usdg.balanceOf(wallet.address)) - beforeUsdg;
    if (received < minOut) throw new Error("sale delivered less than minimum output");
    return {
      symbol,
      token,
      stockSold: formatUnits(stockIn, 18),
      usdgReceived: formatUnits(received, 6),
      approvalTx,
      saleTx: tx.hash,
    };
  });
}
