import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  getAdaptiveConcurrencyCap,
  estimateDeviceBandwidthKbps,
  estimateFleetBandwidthKbps,
  probeDevicePower,
  type AdbExecutor,
} from '../electron/power';

const stubExecutor = (responses: Record<string, string>): AdbExecutor => async (args) => {
  const cmd = args.join(' ');
  for (const [k, v] of Object.entries(responses)) {
    if (cmd.includes(k)) return { stdout: v };
  }
  return { stdout: '' };
};

describe('getAdaptiveConcurrencyCap — Phase 4 power budget', () => {
  it('returns baseCap when bandwidth utilization is zero', () => {
    const r = getAdaptiveConcurrencyCap({ baseCap: 5, totalBandwidthKbps: 0, bandwidthBudgetKbps: 100_000 });
    expect(r.cap).toBe(5);
    expect(r.bandwidthUtilization).toBe(0);
    expect(r.wasReduced).toBe(false);
  });
  it('reduces linearly to floor at 100% utilization', () => {
    const r = getAdaptiveConcurrencyCap({ baseCap: 10, totalBandwidthKbps: 50_000, bandwidthBudgetKbps: 100_000 });
    expect(r.cap).toBeLessThan(10);
    expect(r.cap).toBeGreaterThan(1);
    expect(r.bandwidthUtilization).toBe(0.5);
    expect(r.wasReduced).toBe(true);
  });
  it('clamps to floor at full utilization', () => {
    const r = getAdaptiveConcurrencyCap({ baseCap: 10, totalBandwidthKbps: 100_000, bandwidthBudgetKbps: 100_000, floorCap: 2 });
    expect(r.cap).toBe(2);
    expect(r.wasReduced).toBe(true);
  });
  it('clamps to floor on over-budget (utilization > 1)', () => {
    const r = getAdaptiveConcurrencyCap({ baseCap: 10, totalBandwidthKbps: 200_000, bandwidthBudgetKbps: 100_000, floorCap: 1 });
    expect(r.cap).toBe(1);
    expect(r.bandwidthUtilization).toBe(1);
    expect(r.wasReduced).toBe(true);
  });
  it('property: cap is monotonically non-increasing in utilization', () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 20 }),
      fc.integer({ min: 0, max: 1_000_000 }),
      (baseCap, bandwidthKbps) => {
        const lower = getAdaptiveConcurrencyCap({ baseCap, totalBandwidthKbps: bandwidthKbps / 2, bandwidthBudgetKbps: bandwidthKbps });
        const higher = getAdaptiveConcurrencyCap({ baseCap, totalBandwidthKbps: bandwidthKbps, bandwidthBudgetKbps: bandwidthKbps });
        expect(higher.cap).toBeLessThanOrEqual(lower.cap);
      }
    ), { numRuns: 30 });
  });
  it('property: cap is bounded by [floorCap, baseCap]', () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 20 }),
      fc.integer({ min: 1, max: 5 }),
      fc.integer({ min: 0, max: 5_000_000 }),
      fc.integer({ min: 1, max: 5_000_000 }),
      (baseCap, floorCap, totalKbps, budgetKbps) => {
        // floorCap must be <= baseCap; otherwise it's a config error and we throw.
        if (floorCap > baseCap) return;
        const r = getAdaptiveConcurrencyCap({ baseCap, floorCap, totalBandwidthKbps: totalKbps, bandwidthBudgetKbps: budgetKbps });
        expect(r.cap).toBeGreaterThanOrEqual(floorCap);
        expect(r.cap).toBeLessThanOrEqual(baseCap);
      }
    ), { numRuns: 30 });
  });
  it('throws if floorCap > baseCap (configuration error)', () => {
    expect(() => getAdaptiveConcurrencyCap({ baseCap: 1, floorCap: 5, totalBandwidthKbps: 0, bandwidthBudgetKbps: 1000 })).toThrow();
  });
  it('zero-budget returns baseCap (no information means no reduction)', () => {
    const r = getAdaptiveConcurrencyCap({ baseCap: 7, totalBandwidthKbps: 0, bandwidthBudgetKbps: 0 });
    expect(r.cap).toBe(7);
    expect(r.bandwidthUtilization).toBe(0);
  });
});

describe('estimateDeviceBandwidthKbps / estimateFleetBandwidthKbps', () => {
  it('defaults to 5 Mbps when no screencapKbps given', () => {
    expect(estimateDeviceBandwidthKbps({})).toBe(5000);
  });
  it('uses provided screencapKbps', () => {
    expect(estimateDeviceBandwidthKbps({ screencapKbps: 2500 })).toBe(2500);
  });
  it('clamps negative to 0', () => {
    expect(estimateDeviceBandwidthKbps({ screencapKbps: -100 })).toBe(0);
  });
  it('fleet sum matches', () => {
    expect(estimateFleetBandwidthKbps([{ screencapKbps: 1000 }, { screencapKbps: 2000 }, {}])).toBe(1000 + 2000 + 5000);
  });
});

describe('probeDevicePower', () => {
  it('extracts level and charging from dumpsys battery', async () => {
    const dumpsys = `Current Battery Service state:
      AC powered: false
      USB powered: true
      level: 73
      scale: 100
      status: 2`;
    const r = await probeDevicePower('dev1', stubExecutor({
      'dumpsys battery': dumpsys,
    }));
    expect(r.batteryLevel).toBe(73);
    expect(r.charging).toBe(true);
    expect(r.usbCurrentMa).toBeUndefined(); // sysfs cat returned empty
  });
  it('reads sysfs current_now when available', async () => {
    const r = await probeDevicePower('dev1', stubExecutor({
      'dumpsys battery': 'level: 50',
      'current_now': '450',
    }));
    expect(r.usbCurrentMa).toBe(450);
  });
  it('returns empty sample when nothing is reachable', async () => {
    const r = await probeDevicePower('dev1', stubExecutor({}));
    expect(r.batteryLevel).toBeUndefined();
    expect(r.charging).toBeUndefined();
    expect(r.usbCurrentMa).toBeUndefined();
  });
  it('charging=false when no power source detected', async () => {
    const r = await probeDevicePower('dev1', stubExecutor({
      'dumpsys battery': 'AC powered: false\nUSB powered: false\nWireless powered: false\nlevel: 40',
    }));
    expect(r.charging).toBe(false);
    expect(r.batteryLevel).toBe(40);
  });
});