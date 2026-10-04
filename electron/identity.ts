import crypto from 'crypto';

export interface PhysicalDeviceMapping {
  physicalDeviceId: string;
  currentTransportId: string;
  lastSeenTransportId: string;
  serials: string[];
  updatedAt?: number;
}

export interface DeviceHardwareProps {
  bootSerial?: string;
  serial?: string;
  productDevice?: string;
  buildFingerprint?: string;
  companionUuid?: string;
}

/**
 * Generate a provider-assigned stable physicalDeviceId.
 * Prefer ro.boot.serialno over ro.serialno as primary key.
 * Fall back to persistent first-party companion app UUID when serial is empty or suspect.
 * Fall back to composite of ro.product.device + ro.build.fingerprint.
 */
export function generatePhysicalDeviceId(props: DeviceHardwareProps): string {
  const isSuspect = (s?: string) => {
    if (!s) return true;
    const lower = s.trim().toLowerCase();
    return lower === 'unknown' || lower === '0123456789abcdef' || lower === '0123456789' || lower.length < 3;
  };

  // 1. Primary: ro.boot.serialno
  const bootSerial = props.bootSerial?.trim();
  if (bootSerial && !isSuspect(bootSerial)) {
    return `phys_${bootSerial}`;
  }

  // 2. Fallback: ro.serialno
  const serial = props.serial?.trim();
  if (serial && !isSuspect(serial)) {
    return `phys_${serial}`;
  }

  // 3. Fallback: Persistent companion app UUID (stable across Wi-Fi/USB and app updates)
  const companionUuid = props.companionUuid?.trim();
  if (companionUuid && companionUuid.length > 5) {
    return `phys_app_${companionUuid}`;
  }

  // 4. Fallback: composite of ro.product.device + ro.build.fingerprint
  const device = props.productDevice?.trim() || 'device';
  const fingerprint = props.buildFingerprint?.trim() || 'unknown';
  const composite = `${device}:${fingerprint}`;
  const hash = crypto.createHash('sha256').update(composite).digest('hex').substring(0, 16);
  return `phys_${device}_${hash}`;
}
