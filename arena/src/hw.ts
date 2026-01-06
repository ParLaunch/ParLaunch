import os from "node:os";
import { execSync } from "node:child_process";
import { Worker } from "node:worker_threads";

/**
 * REAL hardware, really metered. This module detects the actual machine -
 * GPU (nvidia-smi if present, WMI otherwise), logical cores, RAM - and
 * executes rented jobs on worker threads that saturate the rented core
 * count with dense matrix math while holding a real RAM allocation.
 * Usage is measured, not simulated.
 */

export interface HardwareInfo {
  hostname: string;
  cpuModel: string;
  cores: number;
  ramGB: number;
  gpuName: string;
  hasNvidiaSmi: boolean;
}

export function detectHardware(): HardwareInfo {
  const cpus = os.cpus();
  let gpuName = "";
  let hasNvidiaSmi = false;
  try {
    gpuName = execSync("nvidia-smi --query-gpu=name --format=csv,noheader", { timeout: 4000 })
      .toString().trim().split("\n")[0];
    hasNvidiaSmi = true;
  } catch {
    try {
      // Windows fallback: WMI video controller name
      gpuName = execSync(
        'powershell -NoProfile -Command "(Get-CimInstance Win32_VideoController | Select-Object -First 1 -ExpandProperty Name)"',
        { timeout: 8000 }
      ).toString().trim();
    } catch {
      gpuName = "CPU-only";
    }
  }
  return {
    hostname: os.hostname(),
    cpuModel: cpus[0]?.model?.trim() ?? "unknown CPU",
    cores: cpus.length,
    ramGB: Math.round(os.totalmem() / 1024 ** 3),
    gpuName: gpuName || "unknown GPU",
    hasNvidiaSmi,
  };
}

/** Live NVIDIA telemetry (utilization %, VRAM MB) when nvidia-smi exists. */