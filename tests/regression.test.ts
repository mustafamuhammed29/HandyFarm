import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DeviceStore } from '../electron/db';
import { Scheduler } from '../electron/scheduler';
import { runRegressionWithLease, isLeaseEligibleForRun } from '../electron/regression';

describe('Phase 5 — regression orchestrator', () => {
  let tmpDir: string;
  let store: DeviceStore;
  let scheduler: Scheduler;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-regression-'));
    store = new DeviceStore(path.join(tmpDir, 'regr.db'));
    scheduler = new Scheduler({ globalConcurrencyCap: 2 });
  });

  afterEach(() => {
    scheduler.stop();
    try { store.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  describe('Phase 4 health gating', () => {
    it('refuses to run on a quarantined device', () => {
      store.savePhysicalDeviceHealth({
        physicalDeviceId: 'phys_q', healthScore: 100, healthReasons: [], healthLastEvaluatedAt: 0,
      });
      store.setDeviceLeaseState('phys_q', 'quarantined');
      const gate = isLeaseEligibleForRun(store, 'phys_q');
      expect(gate.eligible).toBe(false);
      expect(gate.reason).toMatch(/quarantined/);
    });

    it('allows run on an available device', () => {
      store.savePhysicalDeviceHealth({
        physicalDeviceId: 'phys_a', healthScore: 100, healthReasons: [], healthLastEvaluatedAt: 0,
      });
      const gate = isLeaseEligibleForRun(store, 'phys_a');
      expect(gate.eligible).toBe(true);
    });
  });

  describe('lease lifecycle', () => {
    it('acquires and releases the lease even when the run errors', async () => {
      store.savePhysicalDeviceHealth({
        physicalDeviceId: 'phys_1', healthScore: 100, healthReasons: [], healthLastEvaluatedAt: 0,
      });
      const result = await runRegressionWithLease(store, scheduler, {
        runner: 'miniflow',
        flow: { flowContent: '- sleep: 5\n' },
        runId: 'r-1',
        sessionId: 'ci-runner',
        deviceId: 'phys_1',
        ttlMinutes: 5,
      });
      // Lease must be released regardless of status.
      expect(store.getLease('phys_1').state).not.toBe('leased');
      expect(result.runId).toBe('r-1');
    });

    it('refuses when device does not resolve', async () => {
      const result = await runRegressionWithLease(store, scheduler, {
        runner: 'miniflow',
        flow: { flowContent: '- sleep: 5\n' },
        runId: 'r-2',
        sessionId: 'ci-runner',
        deviceId: 'phys_unknown',
      });
      expect(result.status).toBe('refused');
    });

    it('refuses when the device is quarantined', async () => {
      store.savePhysicalDeviceHealth({
        physicalDeviceId: 'phys_quar', healthScore: 100, healthReasons: [], healthLastEvaluatedAt: 0,
      });
      store.setDeviceLeaseState('phys_quar', 'quarantined');
      const result = await runRegressionWithLease(store, scheduler, {
        runner: 'miniflow',
        flow: { flowContent: '- sleep: 5\n' },
        runId: 'r-3',
        sessionId: 'ci-runner',
        deviceId: 'phys_quar',
      });
      expect(result.status).toBe('refused');
      expect(result.summary).toMatch(/quarantined/);
    });

    it('runs a miniflow end-to-end and persists an audit entry', async () => {
      store.savePhysicalDeviceHealth({
        physicalDeviceId: 'phys_run', healthScore: 100, healthReasons: [], healthLastEvaluatedAt: 0,
      });
      const result = await runRegressionWithLease(store, scheduler, {
        runner: 'miniflow',
        flow: { flowContent: '- sleep: 1\n' },
        runId: 'r-run',
        sessionId: 'ci-runner',
        deviceId: 'phys_run',
      });
      expect(result.status).toBe('passed');
      expect(result.miniflow).toBeDefined();
      expect(result.auditJobId).toBeTruthy();
      // Audit row should be persisted.
      const audit = store.getAuditForDevice('phys_run', Date.now() - 60_000);
      expect(audit.length).toBeGreaterThan(0);
    });
  });
});