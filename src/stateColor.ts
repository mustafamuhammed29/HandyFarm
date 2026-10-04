// Phase 6 UI overhaul: pure helpers that map HandyFarm state → CSS variable
// tokens. Every component that surfaces a "device state" uses these so the
// visual language stays consistent.

export type DeviceConnectionStatus = 'device' | 'offline' | 'disconnect' | 'unauthorized' | 'weak-connection' | 'unknown';
export type LeaseState = 'available' | 'leased' | 'cooling_down' | 'quarantined' | 'maintenance';
export type HealthTier = 'healthy' | 'degraded' | 'at_risk' | 'quarantined' | 'unknown';
export type BaselineStatus = 'verified' | 'drifted' | 'unbaselined';

/**
 * Health score → state tier. Tiers match the Phase 4 hysteresis:
 *   quarantine at ≤ 40
 *   recovery at ≥ 60
 *   healthy at ≥ 80
 *   degraded in between
 *   unknown when no signal yet
 */
export function healthTier(score: number, leaseState: LeaseState): HealthTier {
  if (leaseState === 'quarantined') return 'quarantined';
  if (score >= 80) return 'healthy';
  if (score >= 60) return 'degraded';
  if (score > 0) return 'at_risk';
  return 'unknown';
}

export function healthTierColorVar(tier: HealthTier): string {
  switch (tier) {
    case 'healthy': return 'var(--state-healthy)';
    case 'degraded': return 'var(--state-warning)';
    case 'at_risk': return 'var(--state-degraded)';
    case 'quarantined': return 'var(--state-quarantined)';
    case 'unknown': return 'var(--state-unknown)';
  }
}

export function healthTierLabel(tier: HealthTier): string {
  switch (tier) {
    case 'healthy': return 'Healthy';
    case 'degraded': return 'Degraded';
    case 'at_risk': return 'At risk';
    case 'quarantined': return 'Quarantined';
    case 'unknown': return 'No data';
  }
}

/**
 * Lease state → color token. Quarantined is the highest-precedence state
 * and overrides everything else (see resolveDeviceStateColor).
 */
export function leaseColorVar(state: LeaseState): string {
  switch (state) {
    case 'leased': return 'var(--state-leased)';
    case 'cooling_down': return 'var(--state-warning)';
    case 'quarantined': return 'var(--state-quarantined)';
    case 'maintenance': return 'var(--state-unknown)';
    case 'available': return 'var(--state-healthy)';
  }
}

export function connectionColorVar(status: DeviceConnectionStatus): string {
  switch (status) {
    case 'device': return 'var(--state-healthy)';
    case 'unauthorized': return 'var(--state-warning)';
    case 'weak-connection': return 'var(--state-degraded)';
    case 'offline':
    case 'disconnect':
      return 'var(--state-offline)';
    default:
      return 'var(--state-unknown)';
  }
}

/**
 * Precedence-ordered single color for "what is the most important thing to
 * see at a glance on this device?":
 *   quarantined (Phase 4 override) > offline > leased > healthy
 *
 * Use this for the left border or the row status dot.
 */
export function resolveDeviceStateColor(
  status: DeviceConnectionStatus,
  leaseState: LeaseState,
): string {
  if (leaseState === 'quarantined') return 'var(--state-quarantined)';
  if (status !== 'device') return connectionColorVar(status);
  if (leaseState === 'leased') return 'var(--state-leased)';
  return 'var(--state-healthy)';
}

/**
 * Short human label for a connection status. Used in the row + the modal.
 */
export function connectionLabel(status: DeviceConnectionStatus): string {
  switch (status) {
    case 'device': return 'Online';
    case 'unauthorized': return 'Unauthorized';
    case 'weak-connection': return 'Weak connection';
    case 'offline': return 'Offline';
    case 'disconnect': return 'Disconnected';
    default: return 'Unknown';
  }
}

/**
 * Lease badge label with embedded countdown. `leaseExpiresAt` is a ms
 * timestamp; pass an explicit `nowMs` for testability.
 */
export function leaseLabel(
  state: LeaseState,
  leasedBy: string | undefined,
  leaseExpiresAt: number | undefined,
  nowMs: number,
): { label: string; countdownSec: number | undefined } {
  if (state === 'leased') {
    const remSec = leaseExpiresAt ? Math.max(0, Math.ceil((leaseExpiresAt - nowMs) / 1000)) : 0;
    const remMin = Math.floor(remSec / 60);
    const remStr = remMin > 0 ? `${remMin}m` : `${remSec}s`;
    return { label: `${leasedBy || 'Leased'} (${remStr})`, countdownSec: remSec };
  }
  if (state === 'cooling_down') {
    const remSec = leaseExpiresAt ? Math.max(0, Math.ceil((leaseExpiresAt - nowMs) / 1000)) : 5;
    return { label: `Cooling (${remSec}s)`, countdownSec: remSec };
  }
  if (state === 'quarantined') return { label: 'Quarantined', countdownSec: undefined };
  if (state === 'maintenance') return { label: 'Maintenance', countdownSec: undefined };
  return { label: 'Available', countdownSec: undefined };
}