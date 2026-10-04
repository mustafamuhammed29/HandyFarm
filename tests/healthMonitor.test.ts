import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DeviceStore } from '../electron/db';
import { HealthMonitor } from '../electron/healthMonitor';

describe('Phase 4 HealthMonitor orchestrator', () => {
  let tmpDir: string;
  let store: DeviceStore;
  let monitor: HealthMonitor;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-mon-'));
    store = new DeviceStore(path.join(tmpDir, 'mon.db'));
    monitor = new HealthMonitor(store, {
      tickMs: 60_000, // don't auto-tick in tests
      windowMs: 60_000,
      staleLeaseMs: 30_000,
    });
  });

  afterEach(() => {
    monitor.stop();
    try { store.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('evaluates a healthy device with no signals → score 100', async () => {
    store.savePhysicalDeviceHealth({
      physicalDeviceId: 'phys-A',
      healthScore: 100,
      healthReasons: [],
      healthLastEvaluatedAt: 0,
    });
    const { evaluated, transitions } = await monitor.tick();
    expect(evaluated).toBe(1);
    expect(transitions).toBe(0);
    const h = store.getPhysicalDeviceHealth('phys-A');
    expect(h.healthScore).toBe(100);
  });

  it('drives a quarantined transition when multiple signals degrade', async () => {
    store.savePhysicalDeviceHealth({
      physicalDeviceId: 'phys-B',
      healthScore: 100,
      healthReasons: [],
      healthLastEvaluatedAt: 0,
    });
    // 1 success, 4 failures → 80% props failure rate.
    store.recordPropsOutcome('phys-B', true);
    for (let i = 0; i < 4; i++) store.recordPropsOutcome('phys-B', false);
    // 4 reconnects in 60s window → > 1/min, signals reconnect churn.
    for (let i = 0; i < 4; i++) store.recordReconnect('phys-B');
    // Inject failed-job audit entries so flakiness also pulls the score down.
    for (let i = 0; i < 3; i++) {
      store.insertAuditEntry({
        jobId: `fail-${i}`,
        deviceId: 'dev-B',
        physicalDeviceId: 'phys-B',
        priority: 100,
        status: 'failed',
        scheduledAt: Date.now() - 5000,
        startedAt: Date.now() - 4000,
        completedAt: Date.now() - 3000,
        appliedDelayMs: 0,
        orderIndex: i + 1,
        error: 'simulated',
      });
    }
    store.insertAuditEntry({
      jobId: 'pass-1', deviceId: 'dev-B', physicalDeviceId: 'phys-B',
      priority: 100, status: 'completed',
      scheduledAt: Date.now() - 5000, startedAt: Date.now() - 4000, completedAt: Date.now() - 3000,
      appliedDelayMs: 0, orderIndex: 99,
    });

    const { transitions } = await monitor.tick();
    expect(transitions).toBeGreaterThanOrEqual(1);

    const lease = store.getLease('phys-B');
    expect(lease.state).toBe('quarantined');
    const h = store.getPhysicalDeviceHealth('phys-B');
    expect(h.healthScore).toBeLessThanOrEqual(40);
    const reasons = JSON.parse(h.healthReasonsJson);
    expect(reasons.length).toBeGreaterThan(0);
  });

  it('recovers a quarantined device once counters reset', async () => {
    store.savePhysicalDeviceHealth({
      physicalDeviceId: 'phys-C',
      healthScore: 100,
      healthReasons: [],
      healthLastEvaluatedAt: 0,
    });
    // Force-quarantine.
    store.setDeviceLeaseState('phys-C', 'quarantined');

    // No bad signals — score should be high → transitionHealth returns 'available'.
    const { transitions } = await monitor.tick();
    expect(transitions).toBe(1);
    const lease = store.getLease('phys-C');
    expect(lease.state).toBe('available');
  });

  it('records presence events and quarantines a leased-but-absent device', async () => {
    store.savePhysicalDeviceHealth({
      physicalDeviceId: 'phys-D',
      healthScore: 100,
      healthReasons: [],
      healthLastEvaluatedAt: 0,
    });
    store.acquireLease('phys-D', 'session-x', 5);

    monitor.recordPresence('phys-D', 'absent');
    const { transitions } = await monitor.tick();
    expect(transitions).toBeGreaterThanOrEqual(1);
    const lease = store.getLease('phys-D');
    expect(lease.state).toBe('quarantined');
  });

  it('never auto-clears a maintenance device', async () => {
    store.savePhysicalDeviceHealth({
      physicalDeviceId: 'phys-E',
      healthScore: 30,
      healthReasons: ['old reasons'],
      healthLastEvaluatedAt: 0,
    });
    store.setDeviceLeaseState('phys-E', 'maintenance');

    const { transitions } = await monitor.tick();
    expect(transitions).toBe(0);
    const lease = store.getLease('phys-E');
    expect(lease.state).toBe('maintenance');
  });

  it('prunes audit entries older than the retention window', async () => {
    // Insert an old audit entry.
    store.insertAuditEntry({
      jobId: 'old-job', deviceId: 'd', priority: 100,
      status: 'completed', scheduledAt: 0, completedAt: 1,
      appliedDelayMs: 0, orderIndex: 1,
    });
    await monitor.tick();
    expect(store.getAuditForDevice('d', 0)).toHaveLength(0);
  });

  it('exposes stats', async () => {
    await monitor.tick();
    const stats = monitor.getStats();
    expect(stats.ticks).toBe(1);
    expect(stats.lastTickAt).toBeGreaterThan(0);
  });
});