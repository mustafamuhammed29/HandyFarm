import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fc from 'fast-check';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { DeviceStore, LeaseState, DeviceLeaseInfo } from '../electron/db.ts';

describe('Area 2: Device Lease State Machine & Lifecycle Transitions', () => {
  let tmpDir: string;
  let dbPath: string;
  let jsonPath: string;
  let store: DeviceStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handyfarm-lease-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    jsonPath = path.join(tmpDir, 'devices.json');
    store = new DeviceStore(dbPath, jsonPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  describe('Core Transitions & Expiry', () => {
    const physId = 'phys_device_alpha_1';

    it('Initial state is available', () => {
      const lease = store.getLease(physId);
      expect(lease.state).toBe('available');
      expect(lease.leasedBy).toBeUndefined();
      expect(lease.leaseExpiresAt).toBeUndefined();
    });

    it('Transitions available -> leased via acquireLease', () => {
      const now = 1000000000;
      vi.setSystemTime(now);

      const res = store.acquireLease(physId, 'session_A', 15);
      expect(res.success).toBe(true);
      expect(res.lease).toBeDefined();
      expect(res.lease?.state).toBe('leased');
      expect(res.lease?.leasedBy).toBe('session_A');
      expect(res.lease?.leaseExpiresAt).toBe(now + 15 * 60 * 1000);
      expect(res.lease?.lastHeartbeatAt).toBe(now);

      const current = store.getLease(physId);
      expect(current.state).toBe('leased');
      expect(current.leasedBy).toBe('session_A');
    });

    it('Rejects lease acquisition by session_B when session_A holds an active lease', () => {
      store.acquireLease(physId, 'session_A', 15);
      const resB = store.acquireLease(physId, 'session_B', 15);

      expect(resB.success).toBe(false);
      expect(resB.error).toContain("leased by session 'session_A'");
      expect(store.getLease(physId).leasedBy).toBe('session_A');
    });

    it('Allows same session_A to re-acquire / update its own lease', () => {
      store.acquireLease(physId, 'session_A', 10);
      const resAgain = store.acquireLease(physId, 'session_A', 20);
      expect(resAgain.success).toBe(true);
      expect(resAgain.lease?.leasedBy).toBe('session_A');
    });

    it('Heartbeat extends lease duration for active holder', () => {
      const t0 = 1000000;
      vi.setSystemTime(t0);
      store.acquireLease(physId, 'session_A', 10);

      const t1 = t0 + 5 * 60 * 1000; // 5 mins later
      vi.setSystemTime(t1);

      const hb = store.heartbeatLease(physId, 'session_A', 15);
      expect(hb.success).toBe(true);
      expect(hb.leaseExpiresAt).toBe(t1 + 15 * 60 * 1000);

      const lease = store.getLease(physId);
      expect(lease.lastHeartbeatAt).toBe(t1);
      expect(lease.leaseExpiresAt).toBe(t1 + 15 * 60 * 1000);
    });

    it('Heartbeat rejected if attempted by non-holder session', () => {
      store.acquireLease(physId, 'session_A', 10);
      const hb = store.heartbeatLease(physId, 'session_attacker', 15);
      expect(hb.success).toBe(false);
      expect(hb.error).toContain('No active lease held by this session');
    });

    it('Release transitions leased -> cooling_down for 5-second grace period', () => {
      const t0 = 1000000;
      vi.setSystemTime(t0);
      store.acquireLease(physId, 'session_A', 10);

      const rel = store.releaseLease(physId, 'session_A');
      expect(rel.success).toBe(true);

      const current = store.getLease(physId);
      expect(current.state).toBe('cooling_down');
      expect(current.leasedBy).toBeUndefined();
      expect(current.leaseExpiresAt).toBe(t0 + 5000);
    });

    it('Cooling down rejects acquisition until 5 seconds have elapsed', () => {
      const t0 = 1000000;
      vi.setSystemTime(t0);
      store.acquireLease(physId, 'session_A', 10);
      store.releaseLease(physId, 'session_A');

      // Attempt acquisition at t0 + 2000 (still cooling down)
      vi.setSystemTime(t0 + 2000);
      const acq = store.acquireLease(physId, 'session_B', 10);
      expect(acq.success).toBe(false);
      expect(acq.error).toContain('cooling down');

      // Advance time past 5 seconds (t0 + 6000)
      vi.setSystemTime(t0 + 6000);
      // Sweep returns it to available
      const sweep = store.sweepExpiredLeases();
      expect(sweep.changedLeases.length).toBeGreaterThanOrEqual(1);

      const afterSweep = store.getLease(physId);
      expect(afterSweep.state).toBe('available');

      // Now session_B can acquire successfully
      const acq2 = store.acquireLease(physId, 'session_B', 10);
      expect(acq2.success).toBe(true);
      expect(acq2.lease?.leasedBy).toBe('session_B');
    });

    it('Sweep automatically returns unrenewed expired leases to available', () => {
      const t0 = 1000000;
      vi.setSystemTime(t0);
      store.acquireLease(physId, 'session_A', 1); // 1 minute TTL

      // Advance 61 seconds (expired)
      vi.setSystemTime(t0 + 61 * 1000);

      const sweep = store.sweepExpiredLeases();
      expect(sweep.changedLeases.some(l => l.physicalDeviceId === physId && l.state === 'available')).toBe(true);

      const current = store.getLease(physId);
      expect(current.state).toBe('available');
      expect(current.leasedBy).toBeUndefined();
    });

    it('Allows takeover of an expired lease by a new session even before sweep runs', () => {
      const t0 = 1000000;
      vi.setSystemTime(t0);
      store.acquireLease(physId, 'session_A', 1);

      // Advance past TTL without running sweep
      vi.setSystemTime(t0 + 70 * 1000);

      // session_B acquires directly
      const acqB = store.acquireLease(physId, 'session_B', 10);
      expect(acqB.success).toBe(true);
      expect(acqB.lease?.leasedBy).toBe('session_B');
    });

    it('Quarantine & Maintenance states block acquisition until reset', () => {
      store.setDeviceLeaseState(physId, 'quarantined');
      expect(store.getLease(physId).state).toBe('quarantined');
      let acq = store.acquireLease(physId, 'session_A', 10);
      expect(acq.success).toBe(false);
      expect(acq.error).toContain('quarantined');

      store.setDeviceLeaseState(physId, 'maintenance');
      expect(store.getLease(physId).state).toBe('maintenance');
      acq = store.acquireLease(physId, 'session_A', 10);
      expect(acq.success).toBe(false);
      expect(acq.error).toContain('maintenance');

      store.setDeviceLeaseState(physId, 'available');
      acq = store.acquireLease(physId, 'session_A', 10);
      expect(acq.success).toBe(true);
    });

    it('Force release overrides session ownership', () => {
      store.acquireLease(physId, 'session_A', 10);
      // Non-force by session_B fails
      const relFail = store.releaseLease(physId, 'session_B', false);
      expect(relFail.success).toBe(false);

      // Force release succeeds
      const relForce = store.releaseLease(physId, 'session_B', true);
      expect(relForce.success).toBe(true);
      expect(store.getLease(physId).state).toBe('cooling_down');
    });
  });

  describe('Database Persistence Across Restarts', () => {
    it('Persists lease state across DeviceStore re-instantiations', () => {
      const physId = 'phys_persist_test';
      store.acquireLease(physId, 'session_persisted', 25);
      store.flushWrites();

      // Close store and instantiate a fresh one pointing to the same SQLite DB
      store.close();
      const newStore = new DeviceStore(dbPath, jsonPath);

      const lease = newStore.getLease(physId);
      expect(lease.state).toBe('leased');
      expect(lease.leasedBy).toBe('session_persisted');
      expect(lease.leaseExpiresAt).toBeGreaterThan(Date.now());
      newStore.close();
    });
  });

  describe('Property-Based State Machine Invariants (fast-check)', () => {
    type Action =
      | { type: 'acquire'; session: string; ttl: number }
      | { type: 'release'; session: string; force: boolean }
      | { type: 'heartbeat'; session: string; ext: number }
      | { type: 'sweep' }
      | { type: 'setMode'; mode: 'available' | 'quarantined' | 'maintenance' }
      | { type: 'advanceTime'; deltaMs: number };

    const actionArbitrary: fc.Arbitrary<Action> = fc.oneof(
      fc.record({
        type: fc.constant('acquire'),
        session: fc.constantFrom('session_1', 'session_2', 'session_3'),
        ttl: fc.integer({ min: 1, max: 60 })
      }),
      fc.record({
        type: fc.constant('release'),
        session: fc.constantFrom('session_1', 'session_2', 'session_3'),
        force: fc.boolean()
      }),
      fc.record({
        type: fc.constant('heartbeat'),
        session: fc.constantFrom('session_1', 'session_2', 'session_3'),
        ext: fc.integer({ min: 1, max: 30 })
      }),
      fc.constant({ type: 'sweep' } as Action),
      fc.record({
        type: fc.constant('setMode'),
        mode: fc.constantFrom<'available' | 'quarantined' | 'maintenance'>('available', 'quarantined', 'maintenance')
      }),
      fc.record({
        type: fc.constant('advanceTime'),
        deltaMs: fc.integer({ min: 1000, max: 20 * 60 * 1000 })
      })
    );

    it('Property: State invariants hold across arbitrary operational sequences', () => {
      fc.assert(
        fc.property(
          fc.array(actionArbitrary, { minLength: 5, maxLength: 50 }),
          (actions) => {
            const devId = 'phys_prop_test_device';
            let simulatedTime = 1700000000000;
            vi.setSystemTime(simulatedTime);

            // Reset lease for this run
            store.setDeviceLeaseState(devId, 'available');

            for (const act of actions) {
              switch (act.type) {
                case 'advanceTime':
                  simulatedTime += act.deltaMs;
                  vi.setSystemTime(simulatedTime);
                  break;
                case 'acquire':
                  store.acquireLease(devId, act.session, act.ttl);
                  break;
                case 'release':
                  store.releaseLease(devId, act.session, act.force);
                  break;
                case 'heartbeat':
                  store.heartbeatLease(devId, act.session, act.ext);
                  break;
                case 'sweep':
                  store.sweepExpiredLeases();
                  break;
                case 'setMode':
                  store.setDeviceLeaseState(devId, act.mode);
                  break;
              }

              // Invariant verification after every single action:
              const lease = store.getLease(devId);

              // Invariant 1: Valid state enum
              expect(['available', 'leased', 'cooling_down', 'quarantined', 'maintenance']).toContain(lease.state);

              // Invariant 2: When available, quarantined, or maintenance, leasedBy must be undefined or null
              if (lease.state === 'available' || lease.state === 'quarantined' || lease.state === 'maintenance' || lease.state === 'cooling_down') {
                expect(lease.leasedBy).toBeUndefined();
              }

              // Invariant 3: When leased, leasedBy must be a non-empty string and leaseExpiresAt must be a positive integer
              if (lease.state === 'leased') {
                expect(typeof lease.leasedBy).toBe('string');
                expect(lease.leasedBy!.length).toBeGreaterThan(0);
                expect(typeof lease.leaseExpiresAt).toBe('number');
                expect(lease.leaseExpiresAt!).toBeGreaterThan(0);
              }

              // Invariant 4: When cooling_down, leaseExpiresAt must be defined
              if (lease.state === 'cooling_down') {
                expect(typeof lease.leaseExpiresAt).toBe('number');
              }
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});
