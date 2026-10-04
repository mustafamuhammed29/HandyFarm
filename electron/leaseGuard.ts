import type { DeviceStore, DeviceData } from './db.js';

export interface LeaseGuardResult {
  allowed: boolean;
  error?: string;
}

/**
 * Pure evaluation function for exclusive device lease access on destructive actions.
 * Allows action if device is available or caller sessionId holds the active lease.
 * Blocks if device is leased by another session, cooling down, quarantined, or in maintenance.
 */
export function evaluateDeviceLeaseGuard(
  deviceStore: DeviceStore,
  deviceId: string,
  sessionId?: string,
  onLeaseExpired?: (deviceId: string, patch: Partial<DeviceData>) => void
): LeaseGuardResult {
  let physId = deviceId;
  const dev = deviceStore.getDevice(deviceId);
  if (dev) {
    physId = dev.physicalDeviceId || `phys_${dev.serial || dev.id}`;
  } else {
    const mapping = deviceStore.getPhysicalMapping(deviceId) || deviceStore.findPhysicalMappingByTransport(deviceId);
    if (mapping?.physicalDeviceId) {
      physId = mapping.physicalDeviceId;
    }
  }
  const lease = deviceStore.getLease(physId);

  // If cooling_down, quarantined, or maintenance, reject immediately
  if (lease.state === 'cooling_down') {
    const remaining = lease.leaseExpiresAt ? Math.max(0, Math.ceil((lease.leaseExpiresAt - Date.now()) / 1000)) : 5;
    return { allowed: false, error: `Device is cooling down (${remaining}s remaining). Exclusive actions are temporarily blocked.` };
  }
  if (lease.state === 'quarantined') {
    return { allowed: false, error: 'Device is quarantined. Exclusive actions are blocked.' };
  }
  if (lease.state === 'maintenance') {
    return { allowed: false, error: 'Device is under maintenance. Exclusive actions are blocked.' };
  }

  // If leased, verify caller sessionId matches lease holder
  if (lease.state === 'leased') {
    const now = Date.now();
    if (lease.leaseExpiresAt && lease.leaseExpiresAt <= now) {
      // Lease TTL expired without renewal -> auto-release
      const { changedLeases, affectedDeviceIds } = deviceStore.sweepExpiredLeases();
      if (changedLeases.length > 0 && onLeaseExpired) {
        for (const id of affectedDeviceIds) {
          const dev = deviceStore.getDevice(id);
          if (dev) {
            onLeaseExpired(id, {
              leaseState: dev.leaseState,
              leasedBy: dev.leasedBy ?? (null as any),
              leaseExpiresAt: dev.leaseExpiresAt ?? (null as any),
              lastHeartbeatAt: dev.lastHeartbeatAt ?? (null as any)
            });
          }
        }
      }
      return { allowed: true };
    }
    if (!sessionId || sessionId !== lease.leasedBy) {
      const expiresStr = lease.leaseExpiresAt ? new Date(lease.leaseExpiresAt).toLocaleTimeString() : 'unknown';
      return { allowed: false, error: `Device is leased by session '${lease.leasedBy}' until ${expiresStr}. Exclusive action rejected.` };
    }
  }

  return { allowed: true };
}
