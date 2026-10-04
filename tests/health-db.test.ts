import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DeviceStore } from '../electron/db';

describe('Phase 4 health + audit DB integration', () => {
  let tmpDir: string;
  let dbPath: string;
  let store: DeviceStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-phase4-'));
    dbPath = path.join(tmpDir, 'test.db');
    store = new DeviceStore(dbPath);
  });

  afterEach(() => {
    try { store.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  describe('audit log persistence', () => {
    it('inserts and reads back audit entries with sliding-window cutoff', () => {
      const now = Date.now();
      store.insertAuditEntry({
        jobId: 'job-a',
        runId: 'run-1',
        groupId: 'grp-x',
        deviceId: 'dev-1',
        physicalDeviceId: 'phys-1',
        label: 'test-a',
        priority: 100,
        status: 'completed',
        scheduledAt: now - 60_000,
        startedAt: now - 60_000,
        completedAt: now - 30_000,
        appliedDelayMs: 250,
        orderIndex: 1,
      });
      store.insertAuditEntry({
        jobId: 'job-b',
        deviceId: 'dev-1',
        physicalDeviceId: 'phys-1',
        priority: 100,
        status: 'failed',
        scheduledAt: now - 90_000,
        completedAt: now - 80_000, // too old
        appliedDelayMs: 0,
        orderIndex: 2,
        error: 'boom',
      });

      const recent = store.getAuditForDevice('dev-1', now - 60_000);
      expect(recent).toHaveLength(1);
      expect(recent[0].jobId).toBe('job-a');
      expect(recent[0].status).toBe('completed');

      const all = store.getAuditForDevice('dev-1', 0);
      expect(all).toHaveLength(2);
    });

    it('prunes audit entries older than the cutoff', () => {
      const now = Date.now();
      store.insertAuditEntry({
        jobId: 'old', deviceId: 'd', priority: 100,
        status: 'completed', scheduledAt: now - 1000, completedAt: now - 1000,
        appliedDelayMs: 0, orderIndex: 1,
      });
      store.insertAuditEntry({
        jobId: 'new', deviceId: 'd', priority: 100,
        status: 'completed', scheduledAt: now, completedAt: now,
        appliedDelayMs: 0, orderIndex: 2,
      });
      const pruned = store.pruneOldAudit(now - 500);
      expect(pruned).toBe(1);
      expect(store.getAuditForDevice('d', 0)).toHaveLength(1);
    });
  });

  describe('health counter read/write', () => {
    it('returns safe defaults for never-seen device', () => {
      const h = store.getPhysicalDeviceHealth('phys-unknown');
      expect(h.healthScore).toBe(100);
      expect(h.propsAttempts).toBe(0);
      expect(h.reconnectCount).toBe(0);
    });

    it('saves and reads back health score + reasons JSON', () => {
      store.savePhysicalDeviceHealth({
        physicalDeviceId: 'phys-1',
        healthScore: 35,
        healthReasons: ['props failures high', 'reconnect churn'],
        healthLastEvaluatedAt: Date.now(),
      });
      const h = store.getPhysicalDeviceHealth('phys-1');
      expect(h.healthScore).toBe(35);
      const reasons = JSON.parse(h.healthReasonsJson);
      expect(reasons).toEqual(['props failures high', 'reconnect churn']);
    });
  });

  describe('counter increment', () => {
    it('records props attempts and failures separately', () => {
      // Upsert via the existing path so the row exists.
      store.savePhysicalDeviceHealth({
        physicalDeviceId: 'phys-2',
        healthScore: 100,
        healthReasons: [],
        healthLastEvaluatedAt: Date.now(),
      });

      for (let i = 0; i < 4; i++) store.recordPropsOutcome('phys-2', true);
      for (let i = 0; i < 2; i++) store.recordPropsOutcome('phys-2', false);

      const h = store.getPhysicalDeviceHealth('phys-2');
      expect(h.propsAttempts).toBe(6);
      expect(h.propsFailures).toBe(2);
    });

    it('records reconnect events', () => {
      store.savePhysicalDeviceHealth({
        physicalDeviceId: 'phys-3',
        healthScore: 100,
        healthReasons: [],
        healthLastEvaluatedAt: Date.now(),
      });
      store.recordReconnect('phys-3');
      store.recordReconnect('phys-3');
      const h = store.getPhysicalDeviceHealth('phys-3');
      expect(h.reconnectCount).toBe(2);
      expect(h.lastStatusChangeAt).toBeGreaterThan(0);
    });
  });

  describe('window reset', () => {
    it('resets props counters when the window has elapsed', () => {
      store.savePhysicalDeviceHealth({
        physicalDeviceId: 'phys-w',
        healthScore: 100,
        healthReasons: [],
        healthLastEvaluatedAt: 0,
      });
      // Inject props failures.
      for (let i = 0; i < 5; i++) store.recordPropsOutcome('phys-w', false);
      const before = store.getPhysicalDeviceHealth('phys-w');
      expect(before.propsFailures).toBe(5);

      // Reset with windowMs=10s, now far in the future.
      store.resetHealthCountersIfStale('phys-w', before.propsWindowStartedAt + 11_000, 10_000);
      const after = store.getPhysicalDeviceHealth('phys-w');
      expect(after.propsAttempts).toBe(0);
      expect(after.propsFailures).toBe(0);
    });

    it('does NOT reset when the window has not elapsed', () => {
      store.savePhysicalDeviceHealth({
        physicalDeviceId: 'phys-w2',
        healthScore: 100,
        healthReasons: [],
        healthLastEvaluatedAt: 0,
      });
      store.recordPropsOutcome('phys-w2', false);
      const before = store.getPhysicalDeviceHealth('phys-w2');
      // Window = 60s, current now = before window start → should not reset.
      store.resetHealthCountersIfStale('phys-w2', before.propsWindowStartedAt + 500, 60_000);
      const after = store.getPhysicalDeviceHealth('phys-w2');
      expect(after.propsFailures).toBe(1);
    });
  });

  describe('fleet snapshot', () => {
    it('returns all rows even with no entries', () => {
      const fleet = store.getAllPhysicalDeviceHealth();
      expect(Array.isArray(fleet)).toBe(true);
    });
  });
});