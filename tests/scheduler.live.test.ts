import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Scheduler } from '../electron/scheduler';

const execFileAsync = promisify(execFile);
const DEVICE = '106293738O006649';
const adbShell = (args) => execFileAsync('adb', ['-s', DEVICE, 'shell', ...args], { timeout: 8000 });

// Live-only: requires a real connected device. Skipped unless HANDYFARM_LIVE_TESTS=1.
const ENABLED = process.env.HANDYFARM_LIVE_TESTS === '1';

describe.skipIf(!ENABLED)('Scheduler — live device fan-out (Phase 3)', () => {
  it('runs a 10-job fan-out against the real connected device and produces a reconstructable audit log', async () => {
    const N = 10;
    const s = new Scheduler({
      globalConcurrencyCap: 3,
      rateLimit: { maxJobs: 4, windowMs: 5000 },
      defaultDelay: { minMs: 100, maxMs: 400 },
    });
    // We only care about final-state entries; getAudit() returns one row per job (the
    // same `audit` object that mutates through queued → running → completed).
    const t0 = Date.now();
    for (let i = 0; i < N; i++) {
      s.submit({
        groupId: 'live-fanout',
        label: `probe-${i}`,
        priority: i < 2 ? 10 : 50,  // first two jobs get higher priority
        action: async () => {
          // Real work: an actual adb shell command against the device.
          const { stdout } = await adbShell(['echo', `fanout-${i}-${Date.now() - t0}`]);
          expect(stdout.trim()).toMatch(/^fanout-\d+-\d+$/);
        },
      });
    }
    await s.drain();
    const elapsed = Date.now() - t0;
    const jobAudits = s.getAudit().filter(a => a.groupId === 'live-fanout');
    expect(jobAudits.length).toBe(N);
    for (const a of jobAudits) {
      expect(a.status).toBe('completed');
      expect(a.completedAt).toBeGreaterThanOrEqual(a.startedAt ?? 0);
      expect(a.appliedDelayMs).toBeGreaterThanOrEqual(100);
      expect(a.appliedDelayMs).toBeLessThanOrEqual(400);
    }

    // orderIndex is monotonic across all 10 jobs.
    const indices = jobAudits.map(a => a.orderIndex);
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1]);
    }

    // Concurrency cap respected (max 3 running at once) — rough proxy via elapsed time.
    expect(elapsed).toBeGreaterThan(500);

    // Print the audit log so a human can verify the timeline.
    console.log('\n=== Scheduler audit log (' + N + ' jobs, ' + elapsed + 'ms total) ===');
    for (const a of jobAudits) {
      const delay = a.appliedDelayMs.toString().padStart(3);
      const start = a.startedAt !== undefined ? (a.startedAt - t0).toString().padStart(4) : '----';
      const dur   = (a.completedAt - (a.startedAt ?? a.scheduledAt)).toString().padStart(3);
      const prio  = a.priority.toString().padStart(3);
      console.log(`  prio=${prio}  delay=${delay}ms  start=+${start}ms  dur=${dur}ms  status=${a.status.padEnd(9)} label=${a.label}  orderIndex=${a.orderIndex}`);
    }
    console.log('');
  }, 30000);
});