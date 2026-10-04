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
}

/**
 * Generate a provider-assigned stable physicalDeviceId.
 * Prefer ro.boot.serialno over ro.serialno as primary key.
 * Fall back to composite of ro.product.device + ro.build.fingerprint.
 */
export function generatePhysicalDeviceId(props: DeviceHardwareProps): string {
  // 1. Primary: ro.boot.serialno
  const bootSerial = props.bootSerial?.trim();
  if (bootSerial && bootSerial.toLowerCase() !== 'unknown' && bootSerial.length > 2) {
    return `phys_${bootSerial}`;
  }

  // 2. Fallback: ro.serialno
  const serial = props.serial?.trim();
  if (serial && serial.toLowerCase() !== 'unknown' && serial.length > 2) {
    return `phys_${serial}`;
  }

  // 3. Fallback: composite of ro.product.device + ro.build.fingerprint
  const device = props.productDevice?.trim() || 'device';
  const fingerprint = props.buildFingerprint?.trim() || 'unknown';
  const composite = `${device}:${fingerprint}`;
  const hash = crypto.createHash('sha256').update(composite).digest('hex').substring(0, 16);
  return `phys_${device}_${hash}`;
}
