// Phase 5: regression orchestrator — wires maestro/mini-flow execution with
// the Phase 1 lease lifecycle, Phase 3 scheduler audit, and Phase 4 health
// gating (never auto-run on a quarantined device).
//
// The orchestrator is intentionally small. The hard work lives in
// electron/maestro.ts (real Maestro CLI), electron/miniFlow.ts (offline
// fallback), and the DeviceStore / Scheduler we already have.

import { runMaestroFlow } from './maestro.js';
import { runMiniFlow } from './miniFlow.js';
import { probeMaestro } from './maestro.js';
import type { MaestroRunSpec, MaestroRunResult } from './maestro.js';
import type { MiniFlowSpec, MiniFlowRunResult } from './miniFlow.js';
import type { DeviceStore } from './db.js';
import type { Scheduler } from './scheduler.js';

export type RegressionRunner = 'maestro' | 'miniflow';

export interface RegressionSpec {
  runner: RegressionRunner;
  flow: MaestroRunSpec | MiniFlowSpec;
  /** Logical run id; surfaces in audit + the lease. */
  runId: string;
  /** Caller-supplied session id; surfaced in the lease and used as lease-holder. */
  sessionId: string;
  /** Device to run against: either a transport_id, a physical_device_id, or a serial. */
  deviceId: string;
  /** TTL in minutes for the lease held during the run. Default 30. */
  ttlMinutes?: number;
  /** Optional: explicit adb serial; defaults to the device's serial. */
  adbSerial?: string;
}

export interface RegressionResult {
  runId: string;
  runner: RegressionRunner;
  status: 'passed' | 'failed' | 'cancelled' | 'error' | 'refused';
  /** The Phase 1 lease held during the run. */
  lease?: { state: string; leasedBy?: string; leaseExpiresAt?: number };
  /** Maestro or mini-flow outcome — exactly one of these is set. */
  maestro?: MaestroRunResult;
  miniflow?: MiniFlowRunResult;
  /** Human-readable summary suitable for the UI / audit. */
  summary: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  /** The audit row that was persisted. */
  auditJobId: string;
}

/**
 * Refuse to run regression on devices that are not lease-eligible. Phase 4
 * gating: quarantined or maintenance devices are never auto-selected.
 */
export function isLeaseEligibleForRun(store: DeviceStore, physicalDeviceId: string): { eligible: boolean; reason?: string } {
  const lease = store.getLease(physicalDeviceId);
  if (lease.state === 'quarantined') return { eligible: false, reason: 'device is quarantined (Phase 4 health gate)' };
  if (lease.state === 'maintenance') return { eligible: false, reason: 'device is in maintenance' };
  if (lease.state === 'cooling_down') return { eligible: false, reason: 'device is cooling down after a previous lease' };
  return { eligible: true };
}

/**
 * Run a regression flow end-to-end with lease lifecycle:
 *   1. Validate the device is eligible (Phase 4 gating).
 *   2. acquireLease for the run's TTL.
 *   3. Run the flow (maestro or mini-flow).
 *   4. Heartbeat the lease every 30s.
 *   5. releaseLease in finally — even on error.
 *   6. Persist an audit entry on the device's behalf.
 */
export async function runRegressionWithLease(
  store: DeviceStore,
  _scheduler: Scheduler,
  spec: RegressionSpec,
): Promise<RegressionResult> {
  const startedAt = Date.now();
  const ttlMinutes = spec.ttlMinutes ?? 30;
  const summaryParts: string[] = [];
  let auditJobId = '';
  let leaseInfo: RegressionResult['lease'];

  // Resolve physicalDeviceId + adbSerial
  const physId = resolvePhysicalDeviceId(store, spec.deviceId);
  const adbSerial = spec.adbSerial || physId?.replace(/^phys_/, '');

  if (!physId) {
    return {
      runId: spec.runId,
      runner: spec.runner,
      status: 'refused',
      summary: 'unable to resolve physical device id for the run',
      startedAt, completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      auditJobId: '',
    };
  }

  // Phase 4 gating.
  const gate = isLeaseEligibleForRun(store, physId);
  if (!gate.eligible) {
    return {
      runId: spec.runId,
      runner: spec.runner,
      status: 'refused',
      summary: `refused: ${gate.reason}`,
      startedAt, completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      auditJobId: '',
    };
  }

  // Acquire lease.
  const acquired = store.acquireLease(physId, spec.sessionId, ttlMinutes);
  if (!acquired.success || !acquired.lease) {
    return {
      runId: spec.runId,
      runner: spec.runner,
      status: 'refused',
      summary: `lease acquire failed: ${acquired.error}`,
      startedAt, completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      auditJobId: '',
    };
  }
  leaseInfo = acquired.lease;
  summaryParts.push(`lease acquired by '${spec.sessionId}' (TTL ${ttlMinutes}m)`);

  // Start heartbeat (every 30s, until lease is released).
  const heartbeat = setInterval(() => {
    try {
      const hb = store.heartbeatLease(physId, spec.sessionId);
      if (!hb.success) {
        console.warn(`[Regression] heartbeat failed for ${physId}: ${hb.error}`);
      }
    } catch (err) {
      console.warn(`[Regression] heartbeat error:`, err);
    }
  }, 30_000);

  let result: RegressionResult;
  try {
    if (spec.runner === 'maestro') {
      // If the maestro CLI is not installed, surface a clean error rather than
      // a confusing execFile ENOENT. The caller can retry with runner='miniflow'.
      const probe = await probeMaestro((spec.flow as MaestroRunSpec).maestroPath);
      if (!probe.ok) {
        result = await runMiniflowPath(store, spec, physId, adbSerial, leaseInfo, startedAt,
          `maestro CLI not found (tried '${probe.tried}'). Install maestro or retry with runner='miniflow'.`);
      } else {
        const mr = await runMaestroFlow(spec.flow as MaestroRunSpec, adbSerial || physId);
        auditJobId = mr.jobId;
        result = {
          runId: spec.runId,
          runner: 'maestro',
          status: mr.status === 'passed' ? 'passed' : mr.status === 'failed' ? 'failed' : mr.status === 'cancelled' ? 'cancelled' : 'error',
          lease: leaseInfo,
          maestro: mr,
          summary: `maestro ${mr.status} (exit=${mr.exitCode}, ${mr.durationMs}ms, ${mr.parsedFailures.length} failures)`,
          startedAt, completedAt: Date.now(), durationMs: Date.now() - startedAt,
          auditJobId,
        };
      }
    } else {
      result = await runMiniflowPath(store, spec, physId, adbSerial, leaseInfo, startedAt);
    }
  } catch (err: any) {
    result = {
      runId: spec.runId,
      runner: spec.runner,
      status: 'error',
      lease: leaseInfo,
      summary: `error: ${err?.message || String(err)}`,
      startedAt, completedAt: Date.now(), durationMs: Date.now() - startedAt,
      auditJobId,
    };
  } finally {
    clearInterval(heartbeat);
    const released = store.releaseLease(physId, spec.sessionId, true); // force=true: we own it
    if (released.success) summaryParts.push('lease released');
  }

  // Persist audit.
  try {
    const auditJobId = result.auditJobId || crypto.randomUUID();
    store.insertAuditEntry({
      jobId: auditJobId,
      runId: spec.runId,
      groupId: `regression-${spec.runId}`,
      deviceId: spec.deviceId,
      physicalDeviceId: physId,
      label: `regression-${spec.runner}-${result.status}`,
      priority: 50,
      status: result.status === 'passed' ? 'completed' : (result.status === 'refused' ? 'cancelled' : 'failed'),
      scheduledAt: startedAt,
      startedAt,
      completedAt: result.completedAt,
      appliedDelayMs: 0,
      orderIndex: 0,
      error: result.status === 'error' ? result.summary : undefined,
      result: { runId: spec.runId, summary: result.summary },
    });
  } catch (err) {
    console.warn('[Regression] failed to persist audit entry:', err);
  }

  result.summary = `${summaryParts.join('; ')} → ${result.summary}`;
  return result;
}

async function runMiniflowPath(
  _store: DeviceStore,
  spec: RegressionSpec,
  physId: string,
  adbSerial: string | undefined,
  leaseInfo: RegressionResult['lease'],
  startedAt: number,
  override?: string,
): Promise<RegressionResult> {
  if (override) {
    return {
      runId: spec.runId,
      runner: spec.runner,
      status: 'error',
      lease: leaseInfo,
      summary: override,
      startedAt, completedAt: Date.now(), durationMs: Date.now() - startedAt,
      auditJobId: '',
    };
  }
  // We need an execAdb hook that targets adbSerial. The mini-flow runner
  // expects the caller to provide this hook; we wrap child_process.execFile
  // here.
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  const hooks = {
    execAdb: async (args: string[]) => {
      try {
        const { stdout, stderr } = await execFileAsync('adb', ['-s', adbSerial || physId, ...args], { timeout: 30_000 });
        return { stdout, stderr, code: 0 };
      } catch (err: any) {
        return { stdout: err?.stdout || '', stderr: err?.stderr || String(err), code: err?.code || 1 };
      }
    },
  };
  const mr = await runMiniFlow(spec.flow as MiniFlowSpec, hooks);
  return {
    runId: spec.runId,
    runner: spec.runner,
    status: mr.status === 'passed' ? 'passed' : mr.status === 'failed' ? 'failed' : 'error',
    lease: leaseInfo,
    miniflow: mr,
    summary: `miniflow ${mr.status} (${mr.durationMs}ms, ${mr.steps.length} steps)`,
    startedAt, completedAt: Date.now(), durationMs: Date.now() - startedAt,
    auditJobId: mr.jobId,
  };
}

function resolvePhysicalDeviceId(store: DeviceStore, deviceIdOrPhysId: string): string | undefined {
  // 1. Transport id → follow to physical id.
  const dev = store.getDevice(deviceIdOrPhysId);
  if (dev?.physicalDeviceId) return dev.physicalDeviceId;

  // 2. Lookup by physical mapping table (covers serial-as-key cases).
  const mapping = store.getPhysicalMapping(deviceIdOrPhysId);
  if (mapping?.physicalDeviceId) return mapping.physicalDeviceId;

  // 3. Only accept phys_* ids that match an existing row — refuse unknown.
  if (deviceIdOrPhysId.startsWith('phys_')) {
    const all = store.getAllPhysicalDeviceHealth();
    if (all.some(p => p.physicalDeviceId === deviceIdOrPhysId)) return deviceIdOrPhysId;
    return undefined;
  }

  return undefined;
}