import { ethers } from "ethers";
import { Addresses, Contracts, contractsFor, tryTx, withRetries, E } from "./lib/chain";
import { makeLogger, sleep, jitter, paint } from "./lib/log";
import { detectHardware, HostCompute, HardwareInfo, BurnReport } from "./lib/hardware";

/**
 * THIS MACHINE as a compute provider. Detects the real hardware, lists it
 * on the ComputeMarket under its real name, confirms allocations, and
 * executes rented slices on actual worker threads via HostCompute.
 * The Vulkan sim stays around as a flaky remote competitor; this one is real.
 */
let singleton: HostProvider | null = null;
export function getHostProvider(): HostProvider | null { return singleton; }

export class HostProvider {
  readonly hw: HardwareInfo;
  readonly compute: HostCompute;
  private c: Contracts;
  private log: (m: string) => void;
  providerId = 0n;
  private stopped = false;
  totalCpuSeconds = 0;
  totalGflops = 0;

  constructor(readonly wallet: ethers.Wallet, addresses: Addresses, readonly pricePerUnitHour: bigint = E(25)) {
    this.hw = detectHardware();
    // leave 2 cores for the OS / the rest of the demo
    this.compute = new HostCompute(Math.max(2, this.hw.cores - 2));
    this.c = contractsFor(wallet, addresses);
    this.log = makeLogger("ThisMachine", "blue");
    singleton = this;
  }

  stop() { this.stopped = true; }

  async start(): Promise<void> {
    await withRetries("host provider setup", () => this.ensureRegistered());
    while (!this.stopped) {
      try {
        await this.confirmPending();
      } catch (err: any) {
        this.log(paint.red(`tick error: ${String(err?.message ?? err).slice(0, 100)}`));
      }
      await sleep(jitter(2500));
    }
  }

  private async ensureRegistered(): Promise<void> {
    const computeAddr = await this.c.compute.getAddress();
    const allowance: bigint = await this.c.cycle.allowance(this.wallet.address, computeAddr);
    if (allowance < ethers.MaxUint256 / 2n) {
      await (await this.c.cycle.approve(computeAddr, ethers.MaxUint256)).wait();
    }
    this.providerId = await this.c.compute.accountToProviderId(this.wallet.address);
    if (this.providerId === 0n) {
      const units = this.compute.maxThreads;
      await (await this.c.compute.registerProvider(
        `${this.hw.hostname} · this machine`,
        "localhost",
        `${this.hw.gpuName} · ${this.hw.cpuModel} · ${this.hw.ramGB}GB RAM`,
        units,
        this.pricePerUnitHour // undercuts the sim rig: agents prefer real silicon
      )).wait();
      this.providerId = await this.c.compute.accountToProviderId(this.wallet.address);
      this.log(paint.bold(
        `listed REAL hardware as provider #${this.providerId}: ${units} threads of "${this.hw.cpuModel}", GPU "${this.hw.gpuName}"${this.hw.hasNvidiaSmi ? " (live telemetry on)" : ""}`
      ));
    }
  }

  private async confirmPending(): Promise<void> {
    const count: bigint = await this.c.compute.rentalCount();
    const from = count > 30n ? count - 30n : 0n;
    const rentals = await this.c.compute.getRentals(from, 31);
    for (const r of rentals) {
      if (r.providerId !== this.providerId || Number(r.status) !== 0) continue;
      if (await tryTx(() => this.c.compute.confirmRental(r.id))) {
        this.log(`confirmed rental #${r.id}: ${r.units} real threads for agent #${r.agentId}`);
      }
    }
  }

  /** Called by agents whose rental landed on this machine: burn for real. */
  async execute(units: number, durationMs: number): Promise<BurnReport> {
    const report = await this.compute.burn(units, durationMs);
    this.totalCpuSeconds += report.cpuSecondsTotal;
    this.totalGflops += report.gflopsTotal;
    const gpu = report.gpuAfter
      ? ` · GPU ${report.gpuBefore?.utilPct ?? 0}%→${report.gpuAfter.utilPct}% (${Math.round(report.gpuAfter.memMB / 1024 * 10) / 10}GB VRAM)`
      : "";
    this.log(
      `burned ${report.cpuSecondsTotal.toFixed(1)} CPU-seconds across ${report.threads} threads · ` +
      `${report.gflopsTotal.toFixed(1)} GFLOP · ${report.ramMBHeld}MB RAM held${gpu} · lifetime ${this.totalCpuSeconds.toFixed(0)}s / ${this.totalGflops.toFixed(0)} GFLOP`
    );
    return report;
  }
}
