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