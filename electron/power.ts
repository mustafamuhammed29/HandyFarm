// Phase 4: power / USB topology + bandwidth budget.
//
// Phase 4 deliberately scopes this to what the host + ADB can actually observe.
// Consumer USB hubs almost never expose per-port current over the standard host
// APIs, and our shop runs on Windows without lsusb or sysfs. The pragmatic
// observability story is:
//
//   - Per-device ADB-side power: probe /sys/class/power_supply on the device when
//     available; fall back to `dumpsys battery` for level/charging-state only.
//   - Per-host USB topology: best-effort via Windows WMI (PnPEntity), gracefully
//     degraded when unavailable.
//   - Bandwidth: compute from active screencap streams and other known per-device
//     costs; cap the Phase 3 scheduler automatically when the estimate nears a
//     configured budget.
//
// The exported `getAdaptiveConcurrencyCap` is the load-bearing piece for Phase 3
// integration: the scheduler reads it and caps itself accordingly.

export interface PowerSample {
  deviceId: string;
  /** Reported battery level 0-100, undefined if unknown. */
  batteryLevel?: number;
  /** Whether the device is currently charging (drains CPU/heat when fast-charging under load). */
  charging?: boolean;
  /** USB current draw in mA, if available. Always undefined on consumer hubs. */
  usbCurrentMa?: number;
  /** Active screencap bitrate in kbps for this device. */
  screencapKbps?: number;
}

export interface AdaptiveCapInputs {
  /** Configured global cap from the scheduler options. */
  baseCap: number;
  /** Total estimated bandwidth across all active streams in kbps. */
  totalBandwidthKbps: number;
  /** Configured bandwidth budget in kbps (e.g., USB 2.0 hi-speed = 480_000 kbps nominal). */
  bandwidthBudgetKbps: number;
  /** Soft floor: never return a cap below this even if budget is tight. */
  floorCap?: number;
}

export interface AdaptiveCapResult {
  /** The cap the scheduler should use this tick. */
  cap: number;
  /** 0-1, how saturated the bandwidth budget is. */
  bandwidthUtilization: number;
  /** True if the cap was reduced from the base. */
  wasReduced: boolean;
}

const DEFAULT_FLOOR_CAP = 1;

/**
 * Returns the concurrency cap the scheduler should use given current bandwidth use
 * vs. budget. The cap scales linearly with available budget; once utilization
 * hits 100%, the cap drops to the configured floor.
 */
export function getAdaptiveConcurrencyCap(inputs: AdaptiveCapInputs): AdaptiveCapResult {
  const requestedFloor = inputs.floorCap ?? DEFAULT_FLOOR_CAP;
  if (requestedFloor > inputs.baseCap) {
    throw new Error(`getAdaptiveConcurrencyCap: floorCap (${requestedFloor}) cannot exceed baseCap (${inputs.baseCap}) — base is the configured ceiling`);
  }
  const floor = requestedFloor;
  const util = inputs.bandwidthBudgetKbps > 0
    ? Math.min(1.5, inputs.totalBandwidthKbps / inputs.bandwidthBudgetKbps)
    : 0;
  let cap: number;
  if (util <= 1) {
    // Linear scale from base at 0 utilization down to floor at 100%.
    cap = Math.round(inputs.baseCap - (inputs.baseCap - floor) * util);
  } else {
    // Over budget: clamp to floor.
    cap = floor;
  }
  cap = Math.max(floor, Math.min(inputs.baseCap, cap));
  return {
    cap,
    bandwidthUtilization: Math.min(1, util),
    wasReduced: cap < inputs.baseCap,
  };
}

/**
 * Estimate per-device bandwidth from screencap settings. Conservative defaults
 * for the live-view H.264 stream at 5 Mbps and the shell/text input bandwidth
 * (negligible).
 */
export function estimateDeviceBandwidthKbps(opts: { screencapKbps?: number }): number {
  return Math.max(0, opts.screencapKbps ?? 5000);
}

/**
 * Sum the per-device bandwidth estimates into a fleet total.
 */
export function estimateFleetBandwidthKbps(devices: Array<{ screencapKbps?: number }>): number {
  return devices.reduce((sum, d) => sum + estimateDeviceBandwidthKbps(d), 0);
}

/**
 * Per-device ADB-side power probe. Tries `/sys/class/power_supply/battery/current_now`
 * first (mA), then `dumpsys battery` for level/charging. Returns a `PowerSample`
 * whose fields are populated only when the device reports them.
 *
 * The caller (main.ts) supplies an executor so the function stays pure and
 * testable. `executor` invokes a shell command on the device and returns stdout.
 */
export interface AdbExecutor {
  (args: string[]): Promise<{ stdout: string; stderr?: string }>;
}

export async function probeDevicePower(deviceId: string, exec: AdbExecutor): Promise<PowerSample> {
  const sample: PowerSample = { deviceId };

  // 1. Try sysfs current_now (some devices expose this on older Android).
  try {
    const r = await exec(['-s', deviceId, 'shell', 'cat', '/sys/class/power_supply/battery/current_now']);
    const v = parseInt(r.stdout.trim(), 10);
    if (Number.isFinite(v) && v !== 0) sample.usbCurrentMa = v;
  } catch { /* not available */ }

  // 2. dumpsys battery — always available, gives level + charging.
  try {
    const r = await exec(['-s', deviceId, 'shell', 'dumpsys', 'battery']);
    const text = r.stdout;
    const level = text.match(/level:\s*(\d+)/);
    if (level) sample.batteryLevel = parseInt(level[1], 10);
    const acOn = /AC powered:\s*true/i.test(text) || /USB powered:\s*true/i.test(text) || /Wireless powered:\s*true/i.test(text);
    const acOff = /AC powered:\s*false/i.test(text) && /USB powered:\s*false/i.test(text) && /Wireless powered:\s*false/i.test(text);
    if (acOn) sample.charging = true;
    else if (acOff) sample.charging = false;
    // else: stays undefined — we don't know yet
  } catch { /* not available */ }

  return sample;
}

/**
 * Host-side USB topology. Best-effort. On Windows we use the PnP WMI provider via
 * `wmic` if available; otherwise we return an empty map and the rest of Phase 4
 * continues to work — the topology layer is informational, not load-bearing.
 */
export interface HostUsbTopology {
  hubs: Array<{ id: string; name: string }>;
  /** deviceId -> port path on the hub it sits on, if known. */
  devicePaths: Map<string, string>;
}

export interface HostCommandExecutor {
  (args: string[]): Promise<{ stdout: string; stderr?: string }>;
}

/**
 * Best-effort host USB topology detection. Returns an empty topology on hosts
 * where the probe isn't available; never throws.
 */
export async function probeHostUsbTopology(exec: HostCommandExecutor): Promise<HostUsbTopology> {
  const topology: HostUsbTopology = { hubs: [], devicePaths: new Map() };
  try {
    // Windows: enumerate USB hubs via PnP. Other platforms: empty result is fine.
    const r = await exec(['wmic', 'path', 'Win32_PnPEntity', 'where', 'PNPClass="USB"', 'get', 'Name,DeviceID', '/format:csv']);
    for (const line of r.stdout.split('\n')) {
      // Lines look like: Node,DeviceID,Name
      const parts = line.split(',');
      if (parts.length < 3) continue;
      const name = parts.slice(2).join(',').trim();
      if (name && /hub/i.test(name)) {
        topology.hubs.push({ id: parts[1].trim(), name });
      }
    }
  } catch { /* wmic unavailable or not on PATH */ }
  return topology;
}