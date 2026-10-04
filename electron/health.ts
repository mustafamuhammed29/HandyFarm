// Phase 4: fleet health scoring.
//
// This is a pure module with no I/O. It takes a `HealthInputs` snapshot, returns
// a 0-100 score plus a list of human-readable reasons, and compares against a
// threshold to decide whether the device should be quarantined.
//
// The scoring is monotonic: worse inputs always produce a lower (or equal) score
// — see the property test. That means the quarantine decision is monotonic too:
// crossing the threshold once is enough to justify quarantine, and you can never
// drift below the threshold while inputs are improving.

export type HealthStatus = 'unknown' | 'available' | 'healthy' | 'degraded' | 'quarantined';

export interface HealthInputs {
  /** getProperties attempt count over the current window. */
  propsAttempts: number;
  /** getProperties failure count over the current window. */
  propsFailures: number;
  /** USB reconnect events over the current window. */
  reconnectCount: number;
  /** Wall-clock duration of the window in milliseconds. */
  windowMs: number;
  /** Failed-job count from the scheduler audit log over the same window. */
  failedJobs: number;
  /** Total jobs the device appeared in over the same window. */
  totalJobs: number;
  /** Optional: device-reported battery level (0-100) for thermal/battery pressure. */
  batteryLevel?: number;
  /** Optional: time since the last successful heartbeat (ms). undefined = unknown. */
  msSinceLastHeartbeat?: number;
}

export interface HealthConfig {
  /** Score at or below which the device is auto-quarantined. Default 40. */
  quarantineThreshold: number;
  /** Score above which a previously-quarantined device is auto-cleared. Default 60. */
  recoveryThreshold: number;
  /** Weight for getProperties failure rate. 0-100. */
  weightPropsFailureRate: number;
  /** Weight for reconnect rate (events per minute). */
  weightReconnectRate: number;
  /** Weight for flakiness (failed jobs / total jobs). */
  weightFlakiness: number;
  /** Weight for stale-heartbeat signal. */
  weightHeartbeatStale: number;
}

export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  quarantineThreshold: 40,
  recoveryThreshold: 60,
  weightPropsFailureRate: 30,
  weightReconnectRate: 20,
  weightFlakiness: 35,
  weightHeartbeatStale: 15,
};

export interface HealthResult {
  /** 0-100; higher is healthier. */
  score: number;
  /** Per-signal 0-100 scores; useful for surfacing in the UI. */
  signals: {
    propsFailureRate: number;
    reconnectRate: number;
    flakiness: number;
    heartbeatFreshness: number;
  };
  /** Inputs that pulled the score down, with concrete numbers. */
  reasons: string[];
  /** Recommendation: should this device be quarantined? */
  status: HealthStatus;
}

const WINDOW_MS_PER_MIN = 60_000;

export function computeHealthScore(inputs: HealthInputs, config: HealthConfig = DEFAULT_HEALTH_CONFIG): HealthResult {
  const reasons: string[] = [];

  // Signal 1: getProperties failure rate (events / minute, capped)
  const propsFailureRate = propsSignal(inputs, config, reasons);

  // Signal 2: reconnect rate (events / minute, capped)
  const reconnectRate = reconnectSignal(inputs, config, reasons);

  // Signal 3: flakiness (failed / total jobs, in [0,1])
  const flakiness = flakinessSignal(inputs, config, reasons);

  // Signal 4: heartbeat freshness (1 if fresh, decays toward 0)
  const heartbeatFreshness = heartbeatSignal(inputs, reasons);

  // Weighted average of per-signal scores (each in [0, 100]) → final score.
  const totalWeight = config.weightPropsFailureRate + config.weightReconnectRate + config.weightFlakiness + config.weightHeartbeatStale;
  const weighted = (propsFailureRate * config.weightPropsFailureRate +
                    reconnectRate * config.weightReconnectRate +
                    flakiness * config.weightFlakiness +
                    heartbeatFreshness * config.weightHeartbeatStale) / Math.max(1, totalWeight);

  // Integer score 0-100, bounded.
  const score = Math.max(0, Math.min(100, Math.round(weighted)));

  let status: HealthStatus = 'healthy';
  if (score <= config.quarantineThreshold) status = 'quarantined';
  else if (score < config.recoveryThreshold) status = 'degraded';

  return {
    score,
    signals: { propsFailureRate, reconnectRate, flakiness, heartbeatFreshness },
    reasons,
    status,
  };
}

/**
 * Decide the resulting lease_state transition. Returns the new state and a reason
 * string suitable for surfacing in the UI. If no transition is needed, returns
 * the current state.
 *
 * Hysteresis: a device in `quarantined` stays there until score rises above
 * `recoveryThreshold`. A device in `available` only transitions to
 * `quarantined` when score falls below `quarantineThreshold`. This avoids
 * flapping near the threshold.
 */
export function transitionHealth(prevState: HealthStatus, result: HealthResult, config: HealthConfig = DEFAULT_HEALTH_CONFIG): { newState: HealthStatus; reason: string } {
  const reason = result.reasons.length > 0 ? result.reasons.join('; ') : `score=${result.score}`;

  if (prevState === 'quarantined') {
    if (result.score >= config.recoveryThreshold) {
      return { newState: 'available', reason: `health recovered (score=${result.score}): ${reason}` };
    }
    return { newState: 'quarantined', reason: `quarantined (score=${result.score}): ${reason}` };
  }

  if (result.status === 'quarantined') {
    return { newState: 'quarantined', reason: `auto-quarantined (score=${result.score}): ${reason}` };
  }

  return { newState: prevState, reason };
}

// ----- signals -----

function propsSignal(i: HealthInputs, _c: HealthConfig, reasons: string[]): number {
  if (i.propsAttempts === 0) return 100; // no data
  const rate = i.propsFailures / Math.max(1, i.propsAttempts);
  // 0% failures -> 100. 100% failures -> 0. Linear.
  const signal = Math.max(0, Math.min(100, Math.round(100 * (1 - rate))));
  if (rate > 0.20) reasons.push(`getProperties failure rate ${(rate * 100).toFixed(0)}% (${i.propsFailures}/${i.propsAttempts})`);
  return signal;
}

function reconnectSignal(i: HealthInputs, _c: HealthConfig, reasons: string[]): number {
  if (i.windowMs <= 0) return 100;
  const perMin = i.reconnectCount / (i.windowMs / WINDOW_MS_PER_MIN);
  // >= 6 events/min -> 0. 0 events/min -> 100. Linear.
  const signal = Math.max(0, Math.min(100, Math.round(100 - (perMin / 6) * 100)));
  if (perMin > 1) reasons.push(`reconnect rate ${perMin.toFixed(1)}/min (${i.reconnectCount} events)`);
  return signal;
}

function flakinessSignal(i: HealthInputs, _c: HealthConfig, reasons: string[]): number {
  if (i.totalJobs === 0) return 100; // no data
  const rate = i.failedJobs / Math.max(1, i.totalJobs);
  const signal = Math.max(0, Math.min(100, Math.round(100 * (1 - rate))));
  if (rate > 0.10) reasons.push(`test flakiness ${(rate * 100).toFixed(0)}% (${i.failedJobs}/${i.totalJobs})`);
  return signal;
}

function heartbeatSignal(i: HealthInputs, reasons: string[]): number {
  if (i.msSinceLastHeartbeat === undefined) return 100;
  // < 30s -> 100. 5 min -> 0. Linear.
  const STALE_AT_MS = 5 * 60_000;
  const ratio = Math.max(0, Math.min(1, i.msSinceLastHeartbeat / STALE_AT_MS));
  const signal = Math.max(0, Math.min(100, Math.round(100 * (1 - ratio))));
  if (i.msSinceLastHeartbeat > 60_000) reasons.push(`no heartbeat for ${(i.msSinceLastHeartbeat / 1000).toFixed(0)}s`);
  return signal;
}