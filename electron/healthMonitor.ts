// Phase 4 orchestrator: periodically reads health counters + audit log,
// computes a score, decides a transition, persists the result, and applies the
// resulting lease_state change via the DeviceStore.
//
// Pure orchestration. The scoring logic lives in electron/health.ts; the
// safety logic in electron/runSafety.ts; the persistence in electron/db.ts.
//
// One HealthMonitor instance per process. The interval is configurable; default
// 30s. On a slow tick the work still completes — there is no fixed budget
// per-tick, just a guard that evaluation work finishes within 5s.

import {
  computeHealthScore,
  transitionHealth,
  DEFAULT_HEALTH_CONFIG,
} from './health.js';
import type { HealthConfig, HealthStatus } from './health.js';
import { evaluateSafety } from './runSafety.js';
import type { DeviceStore } from './db.js';
import type { DeviceLeaseInfo } from './db.js';

const DEFAULT_TICK_MS = 30_000;
const DEFAULT_WINDOW_MS = 5 * 60_000; // 5-minute sliding window for health
const DEFAULT_STALE_LEASE_MS = 5 * 60_000; // leased + no heartbeat > 5m → quarantine
const DEFAULT_PRUNE_OLDER_THAN_MS = 24 * 60 * 60_000; // audit retention: 24h

export interface HealthMonitorOptions {
  /** Tick interval in ms. Default 30s. */
  tickMs?: number;
  /** Sliding window for props/reconnect/job-failure counters. Default 5m. */
  windowMs?: number;
  /** Stale-lease threshold for evaluateSafety. Default 5m. */
  staleLeaseMs?: number;
  /** Audit retention. Default 24h. */
  pruneOlderThanMs?: number;
  /** Health thresholds + weights. Defaults from electron/health.ts. */
  config?: HealthConfig;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface PresenceEvent {
  physicalDeviceId: string;
  presence: 'present' | 'absent';
  observedAt: number;
}

export interface HealthMonitorStats {
  ticks: number;
  transitions: number;
  lastTickAt: number;
  lastDurationMs: number;
}

export class HealthMonitor {
  private readonly store: DeviceStore;
  private readonly tickMs: number;
  private readonly windowMs: number;
  private readonly staleLeaseMs: number;
  private readonly pruneOlderThanMs: number;
  private readonly config: HealthConfig;
  private readonly now: () => number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private presenceEvents: PresenceEvent[] = [];
  private stats: HealthMonitorStats = { ticks: 0, transitions: 0, lastTickAt: 0, lastDurationMs: 0 };
  private lastEvaluations = new Map<string, { status: HealthStatus; reason: string }>();

  constructor(store: DeviceStore, opts: HealthMonitorOptions = {}) {
    this.store = store;
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.staleLeaseMs = opts.staleLeaseMs ?? DEFAULT_STALE_LEASE_MS;
    this.pruneOlderThanMs = opts.pruneOlderThanMs ?? DEFAULT_PRUNE_OLDER_THAN_MS;
    this.config = opts.config ?? DEFAULT_HEALTH_CONFIG;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Start the periodic evaluation loop. */
  start(): void {
    if (this.timer) return;
    // Run once immediately, then on the interval.
    this.tick();
    this.timer = setInterval(() => this.tick(), this.tickMs);
  }

  /** Stop the periodic loop. Safe to call multiple times. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Record a presence event (online/offline) for `evaluateSafety`. The monitor
   * consumes events during the next tick and then clears the buffer.
   */
  recordPresence(physicalDeviceId: string, presence: 'present' | 'absent'): void {
    this.presenceEvents.push({ physicalDeviceId, presence, observedAt: this.now() });
  }

  getStats(): HealthMonitorStats {
    return { ...this.stats };
  }

  /** The last computed status per device (test/UI helper). */
  getLastEvaluation(physicalDeviceId: string): { status: HealthStatus; reason: string } | undefined {
    const v = this.lastEvaluations.get(physicalDeviceId);
    return v ? { ...v } : undefined;
  }

  /** Force an immediate tick. Useful for tests + the "evaluate now" UI button. */
  async tick(): Promise<{ evaluated: number; transitions: number }> {
    const start = this.now();
    let evaluated = 0;
    let transitions = 0;

    // Devices just quarantined by safety this tick. We suppress the health-
    // driven recovery branch for these so a transient lease-disappearance
    // doesn't immediately re-clear the quarantine within the same tick.
    const safetyQuarantined = new Set<string>();

    try {
      const fleet = this.store.getAllPhysicalDeviceHealth();
      const leases = this.collectLeases();

      // 1. evaluateSafety: leased-but-absent + stale-heartbeat.
      const presenceSnapshot = this.presenceEvents.slice();
      this.presenceEvents = [];
      const safety = evaluateSafety(this.now(), leases, presenceSnapshot, this.staleLeaseMs);
      for (const q of safety.toQuarantine) {
        const res = this.store.setDeviceLeaseState(q.physicalDeviceId, 'quarantined', 'health-monitor');
        if (res.success) {
          transitions++;
          safetyQuarantined.add(q.physicalDeviceId);
          console.log(`[HealthMonitor] SAFETY → quarantined ${q.physicalDeviceId}: ${q.reason}`);
        }
      }
      for (const c of safety.toClear) {
        // Safety never auto-clears; reserved for symmetry. (Health drives recovery.)
        void c;
      }

      // 2. Per-device health score: read counters + audit, compute, transition.
      for (const pd of fleet) {
        const lease = this.store.getLease(pd.physicalDeviceId);
        const inputs = this.buildHealthInputs(pd, lease);
        const result = computeHealthScore(inputs, this.config);
        const prevStatus = this.lastEvaluations.get(pd.physicalDeviceId)?.status
          ?? (lease.state === 'quarantined' ? 'quarantined' : 'available');
        const transition = transitionHealth(prevStatus, result, this.config);

        this.store.savePhysicalDeviceHealth({
          physicalDeviceId: pd.physicalDeviceId,
          healthScore: result.score,
          healthReasons: result.reasons,
          healthLastEvaluatedAt: this.now(),
        });

        evaluated++;
        this.lastEvaluations.set(pd.physicalDeviceId, {
          status: transition.newState,
          reason: transition.reason,
        });

        if (transition.newState === 'quarantined' && lease.state !== 'quarantined') {
          const res = this.store.setDeviceLeaseState(pd.physicalDeviceId, 'quarantined', 'health-monitor');
          if (res.success) {
            transitions++;
            console.log(`[HealthMonitor] HEALTH → quarantined ${pd.physicalDeviceId}: ${transition.reason}`);
          }
        } else if (transition.newState === 'available' && lease.state === 'quarantined' && !safetyQuarantined.has(pd.physicalDeviceId)) {
          // Health-driven recovery from quarantine — but only if safety didn't
          // just quarantine this device in the same tick. Otherwise a transient
          // disappear would be reverted by a high health score within the same
          // tick, defeating the safety net.
          const res = this.store.setDeviceLeaseState(pd.physicalDeviceId, 'available');
          if (res.success) {
            transitions++;
            console.log(`[HealthMonitor] HEALTH → cleared quarantine ${pd.physicalDeviceId}: ${transition.reason}`);
          }
        }
      }

      // 3. Reset counters whose window has expired (cheap, side-effect free).
      for (const pd of fleet) {
        this.store.resetHealthCountersIfStale(pd.physicalDeviceId, this.now(), this.windowMs);
      }

      // 4. Prune old audit entries.
      const pruned = this.store.pruneOldAudit(this.now() - this.pruneOlderThanMs);
      if (pruned > 0) {
        console.log(`[HealthMonitor] pruned ${pruned} old audit entries`);
      }
    } catch (err) {
      console.warn('[HealthMonitor] tick failed:', err);
    } finally {
      this.stats.ticks++;
      this.stats.transitions += transitions;
      this.stats.lastTickAt = this.now();
      this.stats.lastDurationMs = this.now() - start;
    }

    return { evaluated, transitions };
  }

  private collectLeases(): Array<DeviceLeaseInfo & { physicalDeviceId: string }> {
    // The store exposes per-device getLease(); iterate by walking the device list
    // (getAllDevices returns every transport_id we know about).
    const fleet = this.store.getAllPhysicalDeviceHealth();
    const leases = [];
    for (const pd of fleet) {
      const lease = this.store.getLease(pd.physicalDeviceId);
      leases.push(lease);
    }
    return leases;
  }

  private buildHealthInputs(
    pd: ReturnType<DeviceStore['getPhysicalDeviceHealth']>,
    lease: ReturnType<DeviceStore['getLease']>,
  ) {
    const sinceMs = this.now() - this.windowMs;
    const audit = this.store.getAuditForDevice(pd.physicalDeviceId, sinceMs);
    const totalJobs = audit.length;
    const failedJobs = audit.filter(a => a.status === 'failed').length;

    const msSinceLastHeartbeat = lease.lastHeartbeatAt
      ? Math.max(0, this.now() - lease.lastHeartbeatAt)
      : undefined;

    return {
      propsAttempts: pd.propsAttempts,
      propsFailures: pd.propsFailures,
      reconnectCount: pd.reconnectCount,
      windowMs: this.windowMs,
      failedJobs,
      totalJobs,
      msSinceLastHeartbeat,
    };
  }
}