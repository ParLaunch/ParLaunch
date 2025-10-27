import { expect } from "chai";
import { ethers } from "hardhat";
import { config as loadEnv } from "dotenv";
import path from "node:path";

loadEnv({ path: path.resolve(__dirname, "../../arena/.env") });

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const QUOTER = "0x8dc178efb8111bb0973dd9d722ebeff267c98f94";
const ZERO = ethers.ZeroAddress;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
const POOL_KEY = "tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";
const QUOTER_ABI = [
  `function quoteExactInputSingle(tuple(${POOL_KEY} poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)`,
];

describe("StockTradeExecutor (Robinhood Chain fork)", function () {
  it("spends exactly 0.25 USDG and emits an auditable NVDA purchase", async function () {
    const key = process.env.AGENT_SECRET_1;
    if (!key) throw new Error("AGENT_SECRET_1 is required in arena/.env");
    const buyer = new ethers.Wallet(key, ethers.provider);
    const usdg = new ethers.Contract(USDG, ERC20_ABI, buyer);
    const nvda = new ethers.Contract(NVDA, ERC20_ABI, buyer);
    const amountIn = ethers.parseUnits("0.25", 6);

    expect(await usdg.balanceOf(buyer.address)).to.be.gte(amountIn);

    const Factory = await ethers.getContractFactory("StockTradeExecutor", buyer);
    const executor = await Factory.deploy();
    const deployReceipt = await executor.deploymentTransaction()!.wait();

    const quoter = new ethers.Contract(QUOTER, QUOTER_ABI, buyer);
    const [quotedOut] = await quoter.quoteExactInputSingle.staticCall({
      poolKey: { currency0: USDG, currency1: NVDA, fee: 3000, tickSpacing: 60, hooks: ZERO },
      zeroForOne: true,
      exactAmount: amountIn,
      hookData: "0x",
    });
    const minOut = (quotedOut * 99n) / 100n;

    const approveTx = await usdg.approve(await executor.getAddress(), amountIn);
    const approveReceipt = await approveTx.wait();
    const beforeUsdg = await usdg.balanceOf(buyer.address);
    const beforeNvda = await nvda.balanceOf(buyer.address);

    console.log("fork executor", await executor.getAddress(), "quoted", quotedOut.toString());
    try {
      await executor.buyStock.staticCall(
        amountIn,
        minOut,
        Math.floor(Date.now() / 1000) + 300,
      );
    } catch (error: any) {
      console.log("fork revert", error?.data ?? error?.info?.error?.data ?? error?.message);
      throw error;
    }

    const purchaseTx = await executor.buyStock(
      amountIn,
      minOut,
      Math.floor(Date.now() / 1000) + 300,
    );
    const purchaseReceipt = await purchaseTx.wait();
    const afterUsdg = await usdg.balanceOf(buyer.address);
    const afterNvda = await nvda.balanceOf(buyer.address);

    expect(beforeUsdg - afterUsdg).to.equal(amountIn);
    expect(afterNvda - beforeNvda).to.be.gte(minOut);
    await expect(purchaseTx)
      .to.emit(executor, "StockPurchased")
      .withArgs(buyer.address, "NVDA", NVDA, amountIn, afterNvda - beforeNvda);

    console.log(JSON.stringify({
      executor: await executor.getAddress(),
      quotedNvda: ethers.formatUnits(quotedOut, 18),
      receivedNvda: ethers.formatUnits(afterNvda - beforeNvda, 18),
      gas: {
        deploy: deployReceipt!.gasUsed.toString(),
        approve: approveReceipt!.gasUsed.toString(),
        purchase: purchaseReceipt!.gasUsed.toString(),
      },
    }));
  });
});
