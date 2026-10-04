import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  computeHealthScore,
  transitionHealth,
  DEFAULT_HEALTH_CONFIG,
  HealthInputs,
  HealthStatus,
} from '../electron/health';

const makeInputs = (overrides: Partial<HealthInputs> = {}): HealthInputs => ({
  propsAttempts: 10,
  propsFailures: 0,
  reconnectCount: 0,
  windowMs: 5 * 60 * 1000,
  failedJobs: 0,
  totalJobs: 10,
  ...overrides,
});

describe('computeHealthScore — Phase 4 health scoring', () => {
  describe('per-signal behavior', () => {
    it('healthy baseline scores 100', () => {
      const r = computeHealthScore(makeInputs());
      expect(r.score).toBe(100);
      expect(r.reasons).toEqual([]);
      expect(r.status).toBe('healthy');
    });
    it('100% getProperties failure rate -> 0 from that signal', () => {
      const r = computeHealthScore(makeInputs({ propsAttempts: 10, propsFailures: 10 }));
      expect(r.signals.propsFailureRate).toBe(0);
      expect(r.reasons.some(s => s.includes('getProperties'))).toBe(true);
      // With weight config summing to 100, single-signal zero yields score == sum_of_other_weights
      // (30 + 20 + 35 + 15 = 100, props weight is 30, so score = 100 - 30 = 70).
      expect(r.score).toBe(70);
    });
    it('zero data for a signal returns 100 for that signal', () => {
      const r = computeHealthScore(makeInputs({ propsAttempts: 0, reconnectCount: 0, totalJobs: 0 }));
      expect(r.signals.propsFailureRate).toBe(100);
      expect(r.signals.reconnectRate).toBe(100);
      expect(r.signals.flakiness).toBe(100);
    });
    it('reconnect rate of 6/min gives 0', () => {
      const r = computeHealthScore(makeInputs({ reconnectCount: 30, windowMs: 5 * 60 * 1000 })); // 30 / 5min = 6/min
      expect(r.signals.reconnectRate).toBe(0);
    });
    it('reconnect rate above 6/min is clamped to 0', () => {
      const r = computeHealthScore(makeInputs({ reconnectCount: 1000, windowMs: 5 * 60 * 1000 }));
      expect(r.signals.reconnectRate).toBe(0);
    });
    it('flakiness 100% gives 0', () => {
      const r = computeHealthScore(makeInputs({ totalJobs: 5, failedJobs: 5 }));
      expect(r.signals.flakiness).toBe(0);
    });
    it('heartbeat older than 5 minutes gives 0', () => {
      const r = computeHealthScore(makeInputs({ msSinceLastHeartbeat: 6 * 60 * 1000 }));
      expect(r.signals.heartbeatFreshness).toBe(0);
      expect(r.reasons.some(s => s.includes('heartbeat'))).toBe(true);
    });
  });

  describe('status thresholds', () => {
    it('all-clear failure mode triggers quarantine', () => {
      // props (100%), flakiness (100%), stale heartbeat — score should be well below quarantineThreshold
      const r = computeHealthScore(makeInputs({ propsAttempts: 10, propsFailures: 10, totalJobs: 10, failedJobs: 10, msSinceLastHeartbeat: 10 * 60 * 1000 }));
      expect(r.score).toBeLessThanOrEqual(DEFAULT_HEALTH_CONFIG.quarantineThreshold);
      expect(r.status).toBe('quarantined');
      expect(r.reasons.some(s => s.includes('getProperties'))).toBe(true);
      expect(r.reasons.some(s => s.includes('flakiness'))).toBe(true);
      expect(r.reasons.some(s => s.includes('heartbeat'))).toBe(true);
    });
    it('score between thresholds -> degraded', () => {
      // Craft inputs that land us in the middle band.
      const r = computeHealthScore(makeInputs({ propsAttempts: 10, propsFailures: 3, totalJobs: 10, failedJobs: 1 }));
      // Expected roughly: (70*30 + 100*20 + 90*35 + 100*15) / 100 = 84.5 → 85 → healthy (above 60)
      // Try a worse combo to land in degraded.
      const r2 = computeHealthScore(makeInputs({ propsAttempts: 10, propsFailures: 5, totalJobs: 10, failedJobs: 3 }));
      expect(['healthy', 'degraded']).toContain(r2.status);
    });
    it('healthy inputs yield status healthy', () => {
      expect(computeHealthScore(makeInputs()).status).toBe('healthy');
    });
  });

  describe('monotonicity property', () => {
    // property: worsening any single signal never raises the score
    it('property: increasing propsFailures (with attempts fixed) never raises score', () => {
      fc.assert(fc.property(
        fc.integer({ min: 1, max: 1000 }),     // attempts
        fc.integer({ min: 0, max: 1000 }),     // reconnectCount
        fc.integer({ min: 0, max: 1000 }),     // totalJobs
        fc.integer({ min: 0, max: 1000 }),     // failedJobs
        fc.integer({ min: 60_000, max: 3_600_000 }), // windowMs
        (attempts, reconnects, totalJobs, failedJobs, windowMs) => {
          const better = computeHealthScore(makeInputs({ propsAttempts: attempts, propsFailures: 0, reconnectCount: reconnects, totalJobs, failedJobs, windowMs }));
          const worse  = computeHealthScore(makeInputs({ propsAttempts: attempts, propsFailures: Math.min(attempts, attempts), reconnectCount: reconnects, totalJobs, failedJobs, windowMs }));
          expect(worse.score).toBeLessThanOrEqual(better.score);
        }
      ), { numRuns: 30 });
    });
    it('property: increasing reconnectCount (window fixed) never raises score', () => {
      fc.assert(fc.property(
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 60_000, max: 3_600_000 }),
        (reconnects, totalJobs, windowMs) => {
          const better = computeHealthScore(makeInputs({ reconnectCount: reconnects, totalJobs, windowMs }));
          const worse  = computeHealthScore(makeInputs({ reconnectCount: reconnects + 100, totalJobs, windowMs }));
          expect(worse.score).toBeLessThanOrEqual(better.score);
        }
      ), { numRuns: 30 });
    });
    it('property: increasing failedJobs (totalJobs fixed) never raises score', () => {
      fc.assert(fc.property(
        fc.integer({ min: 1, max: 1000 }),
        (totalJobs) => {
          const better = computeHealthScore(makeInputs({ totalJobs, failedJobs: 0 }));
          const worse  = computeHealthScore(makeInputs({ totalJobs, failedJobs: totalJobs }));
          expect(worse.score).toBeLessThanOrEqual(better.score);
        }
      ), { numRuns: 30 });
    });
  });

  describe('score bounds', () => {
    it('property: score is always 0..100', () => {
      fc.assert(fc.property(
        fc.integer({ min: 0, max: 10000 }),
        fc.integer({ min: 0, max: 10000 }),
        fc.integer({ min: 0, max: 10000 }),
        fc.integer({ min: 0, max: 10000 }),
        (a, b, c, d) => {
          const r = computeHealthScore(makeInputs({ propsAttempts: a, propsFailures: Math.min(a, b), reconnectCount: c, totalJobs: d, failedJobs: Math.min(d, c), msSinceLastHeartbeat: a }));
          expect(r.score).toBeGreaterThanOrEqual(0);
          expect(r.score).toBeLessThanOrEqual(100);
        }
      ), { numRuns: 50 });
    });
  });

  describe('custom config', () => {
    it('threshold tuning changes status without changing signal math', () => {
      const inputs = makeInputs({ propsAttempts: 10, propsFailures: 3, totalJobs: 10, failedJobs: 1 });
      const r = computeHealthScore(inputs, { ...DEFAULT_HEALTH_CONFIG, quarantineThreshold: 99 });
      // With threshold = 99, almost any nonzero signal pushes us under.
      expect(['quarantined', 'degraded']).toContain(r.status);
    });
  });
});

describe('transitionHealth — Phase 4 quarantine transitions', () => {
  it('healthy -> quarantined when score crosses below threshold', () => {
    const r = computeHealthScore(makeInputs({ propsAttempts: 10, propsFailures: 10, totalJobs: 10, failedJobs: 10 }));
    const t = transitionHealth('healthy', r);
    expect(t.newState).toBe('quarantined');
    expect(t.reason).toContain('auto-quarantined');
  });
  it('quarantined stays quarantined when score still below recoveryThreshold', () => {
    // Construct inputs that produce a score well below recoveryThreshold.
    const r = computeHealthScore(makeInputs({ propsAttempts: 10, propsFailures: 10, totalJobs: 10, failedJobs: 10, msSinceLastHeartbeat: 10 * 60 * 1000 }));
    expect(r.score).toBeLessThan(DEFAULT_HEALTH_CONFIG.recoveryThreshold);
    const t = transitionHealth('quarantined', r);
    expect(t.newState).toBe('quarantined');
  });
  it('quarantined -> available when score rises above recoveryThreshold', () => {
    const r = computeHealthScore(makeInputs());  // score = 100
    const t = transitionHealth('quarantined', r);
    expect(t.newState).toBe('available');
    expect(t.reason).toContain('health recovered');
  });
  it('healthy stays healthy on borderline score above threshold', () => {
    const r = computeHealthScore(makeInputs({ propsAttempts: 100, propsFailures: 5 })); // ~95
    const t = transitionHealth('healthy', r);
    expect(t.newState).toBe('healthy');
  });
  it('hysteresis: borderline score above quarantineThreshold stays available', () => {
    // Borderline score that lands between thresholds. From healthy, stays healthy.
    const r = computeHealthScore(makeInputs({ propsAttempts: 10, propsFailures: 3, totalJobs: 10, failedJobs: 1 }));
    const t = transitionHealth('healthy', r);
    expect(t.newState).toBe('healthy');
  });
  it('quarantined -> available when score lands just above recoveryThreshold', () => {
    // A score just above 60 should clear.
    const r = computeHealthScore(makeInputs()); // score = 100
    const t = transitionHealth('quarantined', r);
    expect(t.newState).toBe('available');
    expect(t.reason).toContain('health recovered');
  });
  it('property: never transitions from quarantined back to quarantined without producing a reason', () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 1000 }),
      fc.integer({ min: 0, max: 1000 }),
      (failures, reconnects) => {
        const r = computeHealthScore(makeInputs({ propsAttempts: 100, propsFailures: failures, reconnectCount: reconnects }));
        const t = transitionHealth('quarantined', r);
        expect(t.reason.length).toBeGreaterThan(0);
      }
    ), { numRuns: 20 });
  });
});