import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DeviceStore } from '../electron/db';
import { HealthMonitor } from '../electron/healthMonitor';

const execFileAsync = promisify(execFile);
const DEVICE = '106293738O006649';
const adb = (args: string[]) => execFileAsync('adb', ['-s', DEVICE, ...args], { timeout: 8000 });

// Live-only: requires a real connected device. Skipped unless HANDYFARM_LIVE_TESTS=1.
const ENABLED = process.env.HANDYFARM_LIVE_TESTS === '1';

interface DemoContext {
  tmpDir: string;
  store: DeviceStore;
  monitor: HealthMonitor;
  physId: string;
}

async function setupDemoContext(now: () => number): Promise<DemoContext> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-phase4-live-'));
  const store = new DeviceStore(path.join(tmpDir, 'phase4-live.db'));

  // Get the real device's physical ID.
  const { stdout: getpropOut } = await adb(['shell', 'getprop', 'ro.serialno']);
  const serial = getpropOut.trim();
  expect(serial.length).toBeGreaterThan(0);
  const physId = `phys_${serial}`;
  console.log(`[Live Demo] device serial=${serial} physicalId=${physId}`);

  const monitor = new HealthMonitor(store, {
    tickMs: 60_000, // don't auto-tick; we drive it explicitly
    windowMs: 60_000,
    staleLeaseMs: 60_000,
    now,
  });

  return { tmpDir, store, monitor, physId };
}

function cleanup(ctx: DemoContext) {
  ctx.monitor.stop();
  try { ctx.store.close(); } catch {}
  try { fs.rmSync(ctx.tmpDir, { recursive: true, force: true }); } catch {}
}

describe.skipIf(!ENABLED)('Phase 4 live demo — auto-quarantine and recovery on real device', () => {
  let ctx: DemoContext;

  beforeAll(async () => {
    ctx = await setupDemoContext(() => Date.now());
  }, 15_000);

  afterAll(() => {
    if (ctx) cleanup(ctx);
  });

  it('Step 1: device starts healthy (score 100, state available)', async () => {
    ctx.store.savePhysicalDeviceHealth({
      physicalDeviceId: ctx.physId,
      healthScore: 100,
      healthReasons: [],
      healthLastEvaluatedAt: 0,
    });
    const { evaluated, transitions } = await ctx.monitor.tick();
    expect(evaluated).toBe(1);
    expect(transitions).toBe(0);

    const lease = ctx.store.getLease(ctx.physId);
    expect(lease.state).toBe('available');

    const h = ctx.store.getPhysicalDeviceHealth(ctx.physId);
    expect(h.healthScore).toBe(100);
    console.log(`[Step 1] baseline OK: score=${h.healthScore}, lease=${lease.state}`);
  });

  it('Step 2: simulate props failures + reconnects + failed scheduler jobs → auto-quarantine', async () => {
    // 4 props failures in a row.
    for (let i = 0; i < 4; i++) ctx.store.recordPropsOutcome(ctx.physId, false);
    // 5 reconnects (>1/min threshold).
    for (let i = 0; i < 5; i++) ctx.store.recordReconnect(ctx.physId);
    // 4 failed audit entries + 1 passed (80% failure rate).
    for (let i = 0; i < 4; i++) {
      ctx.store.insertAuditEntry({
        jobId: `demo-fail-${i}`,
        deviceId: DEVICE,
        physicalDeviceId: ctx.physId,
        priority: 100,
        status: 'failed',
        scheduledAt: Date.now() - 5000,
        startedAt: Date.now() - 4500,
        completedAt: Date.now() - 4000,
        appliedDelayMs: 0,
        orderIndex: i + 1,
        error: 'simulated failure',
      });
    }
    ctx.store.insertAuditEntry({
      jobId: 'demo-pass-1', deviceId: DEVICE, physicalDeviceId: ctx.physId,
      priority: 100, status: 'completed',
      scheduledAt: Date.now() - 5000, startedAt: Date.now() - 4500, completedAt: Date.now() - 4000,
      appliedDelayMs: 0, orderIndex: 99,
    });

    const { transitions } = await ctx.monitor.tick();
    expect(transitions).toBeGreaterThanOrEqual(1);

    const lease = ctx.store.getLease(ctx.physId);
    expect(lease.state).toBe('quarantined');
    const h = ctx.store.getPhysicalDeviceHealth(ctx.physId);
    expect(h.healthScore).toBeLessThanOrEqual(40);
    const reasons = JSON.parse(h.healthReasonsJson);
    expect(reasons.length).toBeGreaterThan(0);
    console.log(`[Step 2] AUTO-QUARANTINE: score=${h.healthScore}, lease=${lease.state}`);
    console.log(`[Step 2] reasons: ${reasons.join(' | ')}`);
  }, 15_000);

  it('Step 3: lease attempt is refused while quarantined', async () => {
    const res = ctx.store.acquireLease(ctx.physId, 'demo-session', 5);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/quarantined/i);
    console.log(`[Step 3] lease correctly refused: ${res.error}`);
  });

  it('Step 4: counters reset → score recovers → monitor auto-clears quarantine', async () => {
    // Prune all audit entries so flakiness drops to no-data.
    ctx.store.pruneOldAudit(Date.now() - 1);

    // Zero the on-device counters (props failures, reconnects, reboots).
    // This simulates the natural expiry of the 5-minute sliding window in
    // production — the monitor's own resetHealthCountersIfStale would do
    // this on a real schedule; here we shortcut the wait.
    ctx.store.resetHealthCounters(ctx.physId);

    // Confirm counters are clean.
    const pre = ctx.store.getPhysicalDeviceHealth(ctx.physId);
    expect(pre.propsAttempts).toBe(0);
    expect(pre.propsFailures).toBe(0);
    expect(pre.reconnectCount).toBe(0);

    // Confirm the device is currently quarantined (carried over from Step 2).
    expect(ctx.store.getLease(ctx.physId).state).toBe('quarantined');

    // Now the monitor's tick should compute a fresh score (100, no signals)
    // and drive the lease back to 'available' through its recovery branch.
    const { transitions, evaluated } = await ctx.monitor.tick();
    expect(evaluated).toBe(1);
    expect(transitions).toBeGreaterThanOrEqual(1);

    const lease = ctx.store.getLease(ctx.physId);
    expect(lease.state).toBe('available');
    const h = ctx.store.getPhysicalDeviceHealth(ctx.physId);
    expect(h.healthScore).toBeGreaterThanOrEqual(60);
    console.log(`[Step 4] AUTO-RECOVERY: score=${h.healthScore}, lease=${lease.state}`);
  }, 15_000);
});