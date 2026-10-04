import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  evaluateSafety,
  buildResumeState,
  isStaleHeartbeat,
  type LeaseStateSnapshot,
  type DeviceStatusEvent,
} from '../electron/runSafety';

describe('evaluateSafety — Phase 4 run safety', () => {
  describe('leased device disappearance', () => {
    it('leased + just absent → quarantine', () => {
      const leases: LeaseStateSnapshot[] = [
        { physicalDeviceId: 'p1', state: 'leased', lastHeartbeatAt: 1000 },
      ];
      const events: DeviceStatusEvent[] = [
        { physicalDeviceId: 'p1', presence: 'absent', observedAt: 2000 },
      ];
      const v = evaluateSafety(2000, leases, events, 30_000);
      expect(v.toQuarantine).toEqual([{ physicalDeviceId: 'p1', reason: 'leased device disappeared mid-run' }]);
      expect(v.toClear).toEqual([]);
    });
    it('leased + still present → no action', () => {
      const leases: LeaseStateSnapshot[] = [{ physicalDeviceId: 'p1', state: 'leased', lastHeartbeatAt: 1000 }];
      const events: DeviceStatusEvent[] = [{ physicalDeviceId: 'p1', presence: 'present', observedAt: 2000 }];
      const v = evaluateSafety(2000, leases, events, 30_000);
      expect(v.toQuarantine).toEqual([]);
    });
    it('available device + absent → no auto-quarantine (no lease to protect)', () => {
      const leases: LeaseStateSnapshot[] = [{ physicalDeviceId: 'p1', state: 'available' }];
      const events: DeviceStatusEvent[] = [{ physicalDeviceId: 'p1', presence: 'absent', observedAt: 2000 }];
      const v = evaluateSafety(2000, leases, events, 30_000);
      expect(v.toQuarantine).toEqual([]);
    });
    it('maintenance device → never auto-quarantine regardless of presence', () => {
      const leases: LeaseStateSnapshot[] = [{ physicalDeviceId: 'p1', state: 'maintenance' }];
      const events: DeviceStatusEvent[] = [{ physicalDeviceId: 'p1', presence: 'absent', observedAt: 2000 }];
      const v = evaluateSafety(2000, leases, events, 30_000);
      expect(v.toQuarantine).toEqual([]);
    });
    it('unknown device → never auto-quarantine (no data)', () => {
      const leases: LeaseStateSnapshot[] = [{ physicalDeviceId: 'p1', state: 'unknown' }];
      const events: DeviceStatusEvent[] = [{ physicalDeviceId: 'p1', presence: 'absent', observedAt: 2000 }];
      const v = evaluateSafety(2000, leases, events, 30_000);
      expect(v.toQuarantine).toEqual([]);
    });
  });

  describe('stale heartbeats', () => {
    it('leased with stale heartbeat → quarantine', () => {
      const leases: LeaseStateSnapshot[] = [
        { physicalDeviceId: 'p1', state: 'leased', lastHeartbeatAt: 1000 },
      ];
      const v = evaluateSafety(1000 + 60_001, leases, [], 60_000);
      expect(v.toQuarantine.length).toBe(1);
      expect(v.toQuarantine[0].physicalDeviceId).toBe('p1');
      expect(v.toQuarantine[0].reason).toMatch(/heartbeat stale/);
    });
    it('leased with fresh heartbeat → no action', () => {
      const leases: LeaseStateSnapshot[] = [
        { physicalDeviceId: 'p1', state: 'leased', lastHeartbeatAt: 1000 },
      ];
      const v = evaluateSafety(1000 + 5000, leases, [], 60_000);
      expect(v.toQuarantine).toEqual([]);
    });
    it('leased with no heartbeat recorded → no action (undefined is not stale)', () => {
      const leases: LeaseStateSnapshot[] = [{ physicalDeviceId: 'p1', state: 'leased' }];
      const v = evaluateSafety(2_000_000, leases, [], 60_000);
      expect(v.toQuarantine).toEqual([]);
    });
  });

  describe('quarantined handling', () => {
    it('does NOT auto-clear quarantined devices — only health signals do', () => {
      const leases: LeaseStateSnapshot[] = [
        { physicalDeviceId: 'p1', state: 'quarantined', lastHeartbeatAt: 1000 },
      ];
      const v = evaluateSafety(2000, leases, [{ physicalDeviceId: 'p1', presence: 'present', observedAt: 2000 }], 30_000);
      expect(v.toQuarantine).toEqual([]);
      expect(v.toClear).toEqual([]);
    });
  });

  describe('multi-device', () => {
    it('only acts on devices that actually changed', () => {
      const leases: LeaseStateSnapshot[] = [
        { physicalDeviceId: 'p1', state: 'leased', lastHeartbeatAt: 5000 },
        { physicalDeviceId: 'p2', state: 'leased', lastHeartbeatAt: 5000 },
        { physicalDeviceId: 'p3', state: 'available' },
      ];
      const events: DeviceStatusEvent[] = [
        { physicalDeviceId: 'p2', presence: 'absent', observedAt: 6000 },
      ];
      const v = evaluateSafety(6000, leases, events, 30_000);
      expect(v.toQuarantine.length).toBe(1);
      expect(v.toQuarantine[0].physicalDeviceId).toBe('p2');
    });
  });

  describe('isStaleHeartbeat helper', () => {
    it('returns false for non-leased states', () => {
      fc.assert(fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (now, staleMs, hb) => {
          const lease: LeaseStateSnapshot = { physicalDeviceId: 'p1', state: 'available', lastHeartbeatAt: hb };
          expect(isStaleHeartbeat(now, lease, staleMs)).toBe(false);
        }
      ), { numRuns: 20 });
    });
  });
});

describe('buildResumeState — Phase 4 resumable runs', () => {
  it('groups by groupId and tracks completed/total counts', () => {
    const entries = [
      { runId: 'r1', groupId: 'r1', jobId: 'j1', status: 'completed' },
      { runId: 'r1', groupId: 'r1', jobId: 'j2', status: 'failed' },
      { runId: 'r1', groupId: 'r1', jobId: 'j3', status: 'queued' },
      { runId: 'r2', groupId: 'r2', jobId: 'j4', status: 'completed' },
    ];
    const state = buildResumeState(entries);
    expect(state.groupProgress.size).toBe(2);
    const r1 = state.groupProgress.get('r1')!;
    expect(r1.total).toBe(3);
    expect(r1.completed.size).toBe(2); // j1 + j2
    expect(r1.completed.has('j1')).toBe(true);
    expect(r1.completed.has('j2')).toBe(true);
    expect(r1.completed.has('j3')).toBe(false);
  });
  it('falls back to runId when groupId is absent', () => {
    const state = buildResumeState([{ runId: 'r1', jobId: 'j1', status: 'completed' }]);
    expect(state.groupProgress.has('r1')).toBe(true);
  });
  it('handles empty input', () => {
    const state = buildResumeState([]);
    expect(state.groupProgress.size).toBe(0);
  });
  it('property: completed <= total for every group', () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        runId: fc.constantFrom('r1', 'r2', 'r3'),
        jobId: fc.string({ minLength: 1, maxLength: 8 }),
        status: fc.constantFrom('completed', 'failed', 'queued', 'running', 'cancelled'),
      }), { maxLength: 50 }),
      (entries) => {
        const state = buildResumeState(entries);
        for (const e of state.groupProgress.values()) {
          expect(e.completed.size).toBeLessThanOrEqual(e.total);
        }
      }
    ), { numRuns: 30 });
  });
});