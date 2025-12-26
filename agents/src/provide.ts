import { loadAddresses, makeProvider, walletAt, contractsFor, E, fmt } from "./lib/chain";
import { HostProvider } from "./host-provider";
import { paint, sleep } from "./lib/log";

/**
 * `npm run provide` - turn THIS COMPUTER into a listed compute provider.
 *
 * Detects your real hardware, stakes CYCLE, lists your cores on the
 * ComputeMarket, confirms allocations, executes rented slices on actual
 * worker threads, and prints an earnings ticker. This is the supply-side
 * primitive: any machine, one command, on the market.
 *
 *   npm run provide -- --account 8 --price 20
 *
 * (Adapters for remote fleets - vast.ai, Akash, io.net - implement the same
 * HostProvider surface: list, confirm, execute, settle.)
 */
async function main() {
  const argv = process.argv;
  const arg = (name: string, dflt: number) => {
    const i = argv.indexOf(`--${name}`);
    return i > -1 ? Number(argv[i + 1]) : dflt;
  };
  const accountIndex = arg("account", 8);
  const price = arg("price", 20);

  const addresses = loadAddresses();
  const provider = makeProvider(addresses);
  try {
    await provider.getBlockNumber();
  } catch {
    console.error(paint.red(`chain unreachable at ${addresses.rpcUrl} - run: npm start (or npm run node + npm run deploy)`));
    process.exit(1);
  }

  const wallet = walletAt(accountIndex, provider);
  const c = contractsFor(wallet, addresses);
  const host = new HostProvider(wallet, addresses, E(price));

  console.log(paint.bold("\n  ┌─────────────────────────────────────────────────────┐"));
  console.log(paint.bold("  │  AGORA PROVIDER - your machine is joining the pool  │"));
  console.log(paint.bold("  └─────────────────────────────────────────────────────┘\n"));
  console.log(`  host      ${host.hw.hostname}`);
  console.log(`  cpu       ${host.hw.cpuModel} (${host.hw.cores} threads, ${host.compute.maxThreads} listed)`);
  console.log(`  gpu       ${host.hw.gpuName}${host.hw.hasNvidiaSmi ? "  [live telemetry]" : ""}`);
  console.log(`  ram       ${host.hw.ramGB} GB`);
  console.log(`  price     ${price} CYCLE / unit-hour`);
  console.log(`  wallet    ${wallet.address}\n`);

  const startBal: bigint = await c.cycle.balanceOf(wallet.address);
  host.start().catch((e) => {
    console.error(paint.red(`provider crashed: ${e?.message ?? e}`));
    process.exit(1);
  });

  // earnings ticker
  while (true) {
    await sleep(30_000);
    const bal: bigint = await c.cycle.balanceOf(wallet.address);
    const delta = bal - startBal;
    console.log(paint.bold(
      `  ── session P&L ${delta >= 0n ? "+" : ""}${fmt(delta, 2)} CYCLE · ` +
      `${host.totalCpuSeconds.toFixed(0)} CPU-seconds sold · ${host.totalGflops.toFixed(0)} GFLOP delivered`
    ));
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
