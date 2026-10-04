import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { Scheduler } from '../electron/scheduler';

// Tiny no-op action we can use for throughput tests.
const quickAction = async () => {
  // simulate small work without long sleeps so tests stay fast
  return 1;
};

const slowAction = (ms: number) => async () => {
  await new Promise<void>(r => setTimeout(r, ms));
};

describe('Scheduler — Phase 3 fan-out primitive', () => {
  describe('concurrency cap', () => {
    it('property: never runs more than cap concurrent jobs', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 8 }),      // cap
          fc.integer({ min: 1, max: 30 }),     // number of jobs
          fc.integer({ min: 5, max: 30 }),     // per-job duration ms
          async (cap, n, dur) => {
            const observed: number[] = [];
            const s = new Scheduler({
              globalConcurrencyCap: cap,
              now: () => Date.now(),
            });
            let active = 0;
            for (let i = 0; i < n; i++) {
              s.submit({
                action: async () => {
                  active++;
                  observed.push(active);
                  await new Promise<void>(r => setTimeout(r, dur));
                  active--;
                  observed.push(active);
                },
              });
            }
            await s.drain();
            for (const v of observed) {
              expect(v).toBeLessThanOrEqual(cap);
            }
          }
        ),
        { numRuns: 12, endOnFailure: true }
      );
    });
    it('explicit cap=3 with 10 jobs: max concurrent observed = 3', async () => {
      const s = new Scheduler({ globalConcurrencyCap: 3 });
      let max = 0;
      let active = 0;
      for (let i = 0; i < 10; i++) {
        s.submit({
          action: async () => {
            active++;
            if (active > max) max = active;
            await new Promise<void>(r => setTimeout(r, 15));
            active--;
          },
        });
      }
      await s.drain();
      expect(max).toBe(3);
    });
  });

  describe('per-job delay', () => {
    it('applies a delay within the configured window', async () => {
      const s = new Scheduler({
        globalConcurrencyCap: 5,
        defaultDelay: { minMs: 50, maxMs: 150 },
      });
      const t0 = Date.now();
      const startTimes: number[] = [];
      s.submit({
        action: () => {
          startTimes.push(Date.now() - t0);
          return Promise.resolve();
        },
      });
      s.submit({
        action: () => {
          startTimes.push(Date.now() - t0);
          return Promise.resolve();
        },
      });
      await s.drain();
      for (const t of startTimes) {
        expect(t).toBeGreaterThanOrEqual(45);   // small clock slack
        expect(t).toBeLessThanOrEqual(200);
      }
    });
    it('per-job delay overrides default', async () => {
      const s = new Scheduler({
        globalConcurrencyCap: 5,
        defaultDelay: { minMs: 200, maxMs: 200 },
      });
      const t0 = Date.now();
      let elapsed = -1;
      s.submit({
        delay: { minMs: 0, maxMs: 0 },
        action: () => { elapsed = Date.now() - t0; return Promise.resolve(); },
      });
      await s.drain();
      expect(elapsed).toBeLessThan(50);
    });
  });

  describe('rate limit', () => {
    it('does not exceed rateLimit.maxJobs within windowMs', async () => {
      const windowMs = 100;
      const maxJobs = 3;
      const s = new Scheduler({
        globalConcurrencyCap: 100, // no concurrency ceiling
        rateLimit: { maxJobs, windowMs },
      });
      const completedTimestamps: number[] = [];
      const t0 = Date.now();
      for (let i = 0; i < 10; i++) {
        s.submit({
          action: () => {
            completedTimestamps.push(Date.now() - t0);
            return Promise.resolve();
          },
        });
      }
      await s.drain();
      // For each sliding window of length windowMs, count completions; must not exceed maxJobs.
      // We approximate by bucketing into fixed windows.
      let maxInWindow = 0;
      const stride = 1; // ms resolution
      for (let w = 0; w < windowMs; w += stride) {
        let count = 0;
        for (const t of completedTimestamps) {
          if (t >= w && t < w + windowMs) count++;
        }
        if (count > maxInWindow) maxInWindow = count;
      }
      expect(maxInWindow).toBeLessThanOrEqual(maxJobs);
    });
  });

  describe('priority ordering', () => {
    it('priority ordering: preemption by later-submitted higher-priority job', async () => {
      // Cap=1. Fill the slot with a long-running low-priority job; then queue more.
      // Then submit a high-priority job AFTER; the queue must be re-sorted so the new
      // high-priority job runs next, ahead of the already-queued low-priority jobs.
      const s = new Scheduler({ globalConcurrencyCap: 1 });
      const order: string[] = [];
      // p100 runs first (empty slot).
      s.submit({ priority: 100, label: 'p100', action: async () => { order.push('p100'); return new Promise<void>(r => setTimeout(r, 60)); } });
      // p100-b and p10 queue behind it (both must wait).
      s.submit({ priority: 100, label: 'p100-b', action: async () => { order.push('p100-b'); return new Promise<void>(r => setTimeout(r, 30)); } });
      s.submit({ priority: 10,  label: 'p10',    action: async () => { order.push('p10');    return new Promise<void>(r => setTimeout(r, 30)); } });
      // p1 is submitted last. Because cap=1, p100 is running, but the queue is sorted by
      // priority so p1 jumps the queue and runs immediately after p100.
      s.submit({ priority: 1,   label: 'p1',     action: async () => { order.push('p1');     return new Promise<void>(r => setTimeout(r, 30)); } });
      await s.drain();
      expect(order).toEqual(['p100', 'p1', 'p10', 'p100-b']);
    });
  });

  describe('cancellation', () => {
    it('cancel() removes a queued job before start and marks audit cancelled', async () => {
      const s = new Scheduler({ globalConcurrencyCap: 1, defaultDelay: { minMs: 100, maxMs: 100 } });
      const order: string[] = [];
      s.submit({ action: () => { order.push('A'); return Promise.resolve(); } });
      const r = s.submit({ action: () => { order.push('B'); return Promise.resolve(); } });
      // Cancel B before its delay timer fires.
      s.cancel(r.jobId, 'test_cancel');
      await s.drain();
      expect(order).toEqual(['A']);
      const audit = s.getAudit().find(e => e.jobId === r.jobId);
      expect(audit?.status).toBe('cancelled');
      expect(audit?.error).toBe('test_cancel');
    });
    it('cancelGroup() cancels every job with matching groupId', async () => {
      const s = new Scheduler({ globalConcurrencyCap: 1, defaultDelay: { minMs: 80, maxMs: 80 } });
      const ids = ['a', 'b', 'c', 'd'].map(letter => s.submit({ groupId: 'run-1', action: async () => {} }).jobId);
      s.cancelGroup('run-1');
      await s.drain();
      for (const id of ids) {
        expect(s.getAudit().find(e => e.jobId === id)?.status).toBe('cancelled');
      }
    });
    it('aborts a running job via the signal', async () => {
      const s = new Scheduler({ globalConcurrencyCap: 1 });
      let aborted = false;
      const r = s.submit({
        action: (sig) => new Promise<void>((_, reject) => {
          sig.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
        }),
      });
      // Give the scheduler a tick to start the job.
      await new Promise(r => setTimeout(r, 5));
      s.cancel(r.jobId);
      await s.drain();
      expect(aborted).toBe(true);
      expect(s.getAudit().find(e => e.jobId === r.jobId)?.status).toBe('cancelled');
    });
  });

  describe('TTL', () => {
    it('cancels a queued job whose TTL expires before start', async () => {
      const s = new Scheduler({ globalConcurrencyCap: 1, defaultDelay: { minMs: 200, maxMs: 200 } });
      const r = s.submit({ ttlMs: 30, action: async () => {} });
      await new Promise(rr => setTimeout(rr, 80));
      expect(s.getAudit().find(e => e.jobId === r.jobId)?.status).toBe('cancelled');
    });
  });

  describe('audit log completeness', () => {
    it('reconstructs a run: orderIndex is monotonic, every job has terminal status', async () => {
      const s = new Scheduler({ globalConcurrencyCap: 2, defaultDelay: { minMs: 10, maxMs: 20 } });
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) {
        ids.push(s.submit({ label: `job-${i}`, action: async () => { await new Promise(r => setTimeout(r, 5)); } }).jobId);
      }
      await s.drain();
      const audit = s.getAudit();
      // Every submitted id present in audit.
      for (const id of ids) {
        expect(audit.find(a => a.jobId === id)).toBeDefined();
      }
      // Order indices strictly increasing in submit order.
      for (let i = 0; i < audit.length; i++) {
        expect(audit[i].orderIndex).toBe(i + 1);
      }
      // Every entry reaches a terminal status.
      for (const a of audit) {
        expect(['completed', 'failed', 'cancelled']).toContain(a.status);
      }
      // Every entry has a completedAt timestamp.
      for (const a of audit) {
        expect(a.completedAt).toBeGreaterThan(a.scheduledAt);
      }
      // appliedDelayMs falls within window.
      for (const a of audit) {
        expect(a.appliedDelayMs).toBeGreaterThanOrEqual(10);
        expect(a.appliedDelayMs).toBeLessThanOrEqual(20);
      }
    });
    it('property: audit entry orderIndex is globally unique and monotonic across runs', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 4 }),
          fc.integer({ min: 1, max: 10 }),
          async (cap, n) => {
            const s = new Scheduler({ globalConcurrencyCap: cap });
            for (let i = 0; i < n; i++) {
              s.submit({ action: async () => {} });
            }
            await s.drain();
            const audit = s.getAudit();
            const indices = audit.map(a => a.orderIndex);
            expect(new Set(indices).size).toBe(indices.length);
            for (let i = 1; i < indices.length; i++) {
              expect(indices[i]).toBeGreaterThan(indices[i - 1]);
            }
          }
        ),
        { numRuns: 10 }
      );
    });
  });

  describe('drain', () => {
    it('resolves only after every job has settled', async () => {
      const s = new Scheduler({ globalConcurrencyCap: 2 });
      s.submit({ action: slowAction(50) });
      s.submit({ action: slowAction(50) });
      s.submit({ action: slowAction(50) });
      s.submit({ action: slowAction(50) });
      const statsBefore = s.getStats();
      await s.drain();
      const statsAfter = s.getStats();
      expect(statsBefore.queued + statsBefore.running).toBeGreaterThan(0);
      expect(statsAfter.queued).toBe(0);
      expect(statsAfter.running).toBe(0);
    });
  });

  describe('events', () => {
    it('emits audit updates via onAudit listener', async () => {
      const s = new Scheduler({ globalConcurrencyCap: 1 });
      const events: string[] = [];
      s.onAudit(a => events.push(`${a.jobId}:${a.status}`));
      const r = s.submit({ action: quickAction });
      await s.drain();
      // expect at least: queued, running, completed
      expect(events).toContain(`${r.jobId}:queued`);
      expect(events).toContain(`${r.jobId}:running`);
      expect(events).toContain(`${r.jobId}:completed`);
    });
  });

  describe('failure', () => {
    it('marks a job failed when action throws', async () => {
      const s = new Scheduler({ globalConcurrencyCap: 1 });
      const r = s.submit({ action: async () => { throw new Error('boom'); } });
      await s.drain();
      const a = s.getAudit().find(e => e.jobId === r.jobId);
      expect(a?.status).toBe('failed');
      expect(a?.error).toBe('boom');
    });
  });

  describe('input validation', () => {
    it('rejects globalConcurrencyCap < 1', () => {
      expect(() => new Scheduler({ globalConcurrencyCap: 0 })).toThrow();
      expect(() => new Scheduler({ globalConcurrencyCap: -1 })).toThrow();
    });
    it('rejects invalid defaultDelay range', () => {
      expect(() => new Scheduler({ globalConcurrencyCap: 1, defaultDelay: { minMs: 100, maxMs: 50 } })).toThrow();
      expect(() => new Scheduler({ globalConcurrencyCap: 1, defaultDelay: { minMs: -10, maxMs: 0 } })).toThrow();
    });
  });
});