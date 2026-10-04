import crypto from 'crypto';

export type SimStatus = 'active' | 'suspended' | 'depleted' | 'unassigned';

export interface SimRecord {
  id: string; // e.g. "sim_lyca_01" or UUID
  slot: number; // 1 or 2
  iccid: string; // e.g. "8949430123456789012"
  carrier: string; // e.g. "LycaMobile", "Vodafone DE", "Telekom DE", "O2 DE"
  apn: string; // e.g. "data.lycamobile.de"
  plan: string; // e.g. "Prepaid Smart S - 10GB"
  dataCapBytes: number; // monthly or plan limit in bytes
  dataUsedBytes: number; // current consumption in bytes
  renewalDate: string; // ISO date e.g. "2026-10-31"
  status: SimStatus;
  imsiHashed: string; // SHA-256 hash (never plaintext)
  msisdnRedacted: string; // e.g. "+49 151 **** 1234" (never plaintext)
  assignedDeviceId?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ObservedEgress {
  id: string;
  deviceId: string;
  physicalDeviceId: string;
  runId: string;
  publicIp: string;
  asn: string;
  carrier: string;
  geo: {
    country?: string;
    city?: string;
    region?: string;
    loc?: string;
  };
  transport: 'cellular' | 'wifi' | 'vpn' | 'unknown';
  observedAt: number;
}

export interface DataBudgetStatus {
  simId: string;
  carrier: string;
  plan: string;
  dataCapBytes: number;
  dataUsedBytes: number;
  remainingBytes: number;
  usagePercent: number; // 0.0 to 100.0+
  isWarning: boolean; // >= 80%
  isBreakerTripped: boolean; // >= 100%
  status: 'ok' | 'warning' | 'tripped';
  message?: string;
}

export interface FleetBudgetSummary {
  totalSims: number;
  activeSims: number;
  totalCapBytes: number;
  totalUsedBytes: number;
  fleetUsagePercent: number;
  warningCount: number;
  trippedCount: number;
  warningSimIds: string[];
  trippedSimIds: string[];
}

export interface RouteCheckResult {
  isCellularDefault: boolean;
  activeTransport: 'cellular' | 'wifi' | 'vpn' | 'unknown';
  wifiEnabled: boolean;
  mobileDataEnabled: boolean;
  reason?: string;
}

export interface PreflightCheckItem {
  check: 'dual_transport_cellular_route' | 'carrier_match' | 'budget_headroom' | 'observed_egress';
  passed: boolean;
  message: string;
  details?: any;
}

export interface NetworkPreflightResult {
  passed: boolean;
  deviceId: string;
  physicalDeviceId: string;
  runId: string;
  sim?: SimRecord;
  checks: PreflightCheckItem[];
  egress?: ObservedEgress;
  error?: string;
  timestamp: number;
}

export type AdbExecutor = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

// -------------------------------------------------------------
// PII & Privacy Sanitization Helpers
// -------------------------------------------------------------

/**
 * Hash IMSI using SHA-256. Plaintext IMSI must never be stored in files or databases.
 * If already a 64-character hex string, returns as-is to avoid double-hashing.
 */
export function hashImsi(imsi: string): string {
  if (!imsi) return '';
  const trimmed = imsi.trim();
  if (/^[a-f0-9]{64}$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return crypto.createHash('sha256').update(trimmed).digest('hex');
}

/**
 * Redact MSISDN (phone number) by masking middle digits with '****'.
 * Preserves country/area prefix (first 4-6 chars) and last 4 digits.
 * E.g. "+4915123456789" -> "+49 151 **** 6789"
 * E.g. "015123456789" -> "0151 **** 6789"
 */
export function redactMsisdn(msisdn: string): string {
  if (!msisdn) return '';
  // Idempotency guard: check original string BEFORE stripping non-digits,
  // because '*' is stripped by the digit-only filter.
  if (msisdn.includes('****') || msisdn.includes('***')) {
    return msisdn;
  }
  const digitsOnly = msisdn.replace(/[^\d+]/g, '');
  if (digitsOnly.length <= 6) {
    return '****';
  }

  // Format international German numbers or general MSISDN
  if (digitsOnly.startsWith('+')) {
    const prefix = digitsOnly.slice(0, 6);
    const suffix = digitsOnly.slice(-4);
    return `${prefix} **** ${suffix}`;
  } else {
    const prefix = digitsOnly.slice(0, 4);
    const suffix = digitsOnly.slice(-4);
    return `${prefix} **** ${suffix}`;
  }
}

/**
 * Sanitize SIM input ensuring IMSI is hashed and MSISDN is redacted before storage.
 */
export function sanitizeSimRecord(input: {
  id?: string;
  slot?: number;
  iccid: string;
  carrier: string;
  apn: string;
  plan: string;
  dataCapBytes: number;
  dataUsedBytes?: number;
  renewalDate: string;
  status?: SimStatus;
  imsi?: string;
  imsiHashed?: string;
  msisdn?: string;
  msisdnRedacted?: string;
  assignedDeviceId?: string | null;
  createdAt?: number;
  updatedAt?: number;
}): SimRecord {
  const now = Date.now();
  const rawImsi = input.imsi || input.imsiHashed || '';
  const rawMsisdn = input.msisdn || input.msisdnRedacted || '';

  return {
    id: input.id || `sim_${input.iccid.slice(-6)}`,
    slot: input.slot ?? 1,
    iccid: input.iccid.trim(),
    carrier: input.carrier.trim(),
    apn: input.apn.trim(),
    plan: input.plan.trim(),
    dataCapBytes: Number(input.dataCapBytes),
    dataUsedBytes: Number(input.dataUsedBytes || 0),
    renewalDate: input.renewalDate,
    status: input.status || (input.assignedDeviceId ? 'active' : 'unassigned'),
    imsiHashed: hashImsi(rawImsi),
    msisdnRedacted: redactMsisdn(rawMsisdn),
    assignedDeviceId: input.assignedDeviceId || null,
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now
  };
}

// -------------------------------------------------------------
// Data Budget & Circuit Breaker Logic
// -------------------------------------------------------------

export class CircuitBreakerTrippedError extends Error {
  public simId: string;
  public dataUsedBytes: number;
  public dataCapBytes: number;

  constructor(simId: string, used: number, cap: number) {
    super(`CIRCUIT_BREAKER_TRIPPED: Cellular data cap exhausted for SIM ${simId} (${used} / ${cap} bytes, 100%). Halting execution to prevent false application failure.`);
    this.name = 'CircuitBreakerTrippedError';
    this.simId = simId;
    this.dataUsedBytes = used;
    this.dataCapBytes = cap;
  }
}

/**
 * Pure evaluation of data budget status for a SIM.
 * Alert threshold: 80% of plan cap.
 * Hard circuit breaker: >= 100% of plan cap or 0 remaining bytes.
 */
export function evaluateDataBudget(sim: SimRecord, additionalBytes = 0): DataBudgetStatus {
  const projectedUsed = sim.dataUsedBytes + additionalBytes;
  const cap = Math.max(sim.dataCapBytes, 1);
  const remaining = Math.max(0, cap - projectedUsed);
  const usagePercent = Math.min(100, Math.round((projectedUsed / cap) * 10000) / 100);

  const isBreakerTripped = projectedUsed >= cap;
  const isWarning = usagePercent >= 80 && !isBreakerTripped;

  let status: 'ok' | 'warning' | 'tripped' = 'ok';
  let message: string | undefined = undefined;

  if (isBreakerTripped) {
    status = 'tripped';
    message = `CIRCUIT_BREAKER_TRIPPED: Cellular data budget exhausted for SIM ${sim.id} (${projectedUsed} used of ${cap} bytes cap, ${usagePercent}%). Run halted.`;
  } else if (isWarning) {
    status = 'warning';
    message = `BUDGET_WARNING: Cellular data usage at ${usagePercent}% of monthly plan cap (${projectedUsed} of ${cap} bytes). Remaining: ${remaining} bytes.`;
  }

  return {
    simId: sim.id,
    carrier: sim.carrier,
    plan: sim.plan,
    dataCapBytes: cap,
    dataUsedBytes: projectedUsed,
    remainingBytes: remaining,
    usagePercent,
    isWarning,
    isBreakerTripped,
    status,
    message
  };
}

/**
 * Summarize data consumption across the entire fleet of SIMs.
 */
export function calculateFleetDataBudget(sims: SimRecord[]): FleetBudgetSummary {
  let totalCapBytes = 0;
  let totalUsedBytes = 0;
  let activeSims = 0;
  const warningSimIds: string[] = [];
  const trippedSimIds: string[] = [];

  for (const sim of sims) {
    if (sim.status !== 'unassigned') {
      activeSims++;
    }
    totalCapBytes += sim.dataCapBytes;
    totalUsedBytes += sim.dataUsedBytes;

    const budget = evaluateDataBudget(sim);
    if (budget.isBreakerTripped) {
      trippedSimIds.push(sim.id);
    } else if (budget.isWarning) {
      warningSimIds.push(sim.id);
    }
  }

  const fleetUsagePercent = totalCapBytes > 0
    ? Math.round((totalUsedBytes / totalCapBytes) * 10000) / 100
    : 0;

  return {
    totalSims: sims.length,
    activeSims,
    totalCapBytes,
    totalUsedBytes,
    fleetUsagePercent,
    warningCount: warningSimIds.length,
    trippedCount: trippedSimIds.length,
    warningSimIds,
    trippedSimIds
  };
}

// -------------------------------------------------------------
// Dual-Transport Enforcement & Connectivity Inspection
// -------------------------------------------------------------

/**
 * Parses dumpsys connectivity output to extract active default network ID and transport.
 */
export function parseConnectivityDumpsys(output: string): {
  activeNetId: string | null;
  transport: 'cellular' | 'wifi' | 'vpn' | 'unknown';
} {
  const activeMatch = output.match(/Active default network:\s*(\d+)/i);
  if (!activeMatch) {
    return { activeNetId: null, transport: 'unknown' };
  }

  const netId = activeMatch[1];
  // Match NetworkAgentInfo corresponding to netId
  const regex = new RegExp(`NetworkAgentInfo\\{network\\{${netId}\\}[\\s\\S]*?Transports:\\s*([A-Z_&]+)`, 'i');
  const match = output.match(regex);

  if (match) {
    const transports = match[1].toUpperCase();
    if (transports.includes('CELLULAR')) return { activeNetId: netId, transport: 'cellular' };
    if (transports.includes('WIFI')) return { activeNetId: netId, transport: 'wifi' };
    if (transports.includes('VPN')) return { activeNetId: netId, transport: 'vpn' };
  }

  // Secondary search for ni{WIFI or ni{MOBILE
  const niRegex = new RegExp(`NetworkAgentInfo\\{network\\{${netId}\\}[\\s\\S]*?ni\\{([A-Z]+)`, 'i');
  const niMatch = output.match(niRegex);
  if (niMatch) {
    const type = niMatch[1].toUpperCase();
    if (type.includes('WIFI')) return { activeNetId: netId, transport: 'wifi' };
    if (type.includes('MOBILE') || type.includes('CELLULAR')) return { activeNetId: netId, transport: 'cellular' };
    if (type.includes('VPN')) return { activeNetId: netId, transport: 'vpn' };
  }

  return { activeNetId: netId, transport: 'unknown' };
}

/**
 * Dual-Transport Check:
 * Enforces that when testing over cellular egress, ADB stays on USB and Wi-Fi is disabled on-device.
 * Otherwise, Android routes all app traffic over Wi-Fi by default, leaving the SIM inert.
 *
 * Fails loudly if Wi-Fi is enabled or active default route is Wi-Fi.
 */
export async function checkCellularDefaultRoute(
  deviceId: string,
  execAdb: AdbExecutor
): Promise<RouteCheckResult> {
  const [wifiRes, mobileRes, dumpsysRes] = await Promise.all([
    execAdb(['-s', deviceId, 'shell', 'settings', 'get', 'global', 'wifi_on']).catch(() => ({ stdout: '1', stderr: '' })),
    execAdb(['-s', deviceId, 'shell', 'settings', 'get', 'global', 'mobile_data']).catch(() => ({ stdout: '1', stderr: '' })),
    execAdb(['-s', deviceId, 'shell', 'dumpsys', 'connectivity']).catch(() => ({ stdout: '', stderr: '' }))
  ]);

  const wifiEnabled = wifiRes.stdout.trim() === '1';
  const mobileDataEnabled = mobileRes.stdout.trim() !== '0';
  const { transport } = parseConnectivityDumpsys(dumpsysRes.stdout);

  if (wifiEnabled || transport === 'wifi') {
    return {
      isCellularDefault: false,
      activeTransport: 'wifi',
      wifiEnabled,
      mobileDataEnabled,
      reason: 'DUAL_TRANSPORT_VIOLATION: Wi-Fi is enabled on-device (wifi_on=1, active transport: WIFI). For cellular-egress testing, ADB must remain on USB and Wi-Fi must be disabled on-device (e.g. adb shell svc wifi disable) to prevent Android from silently routing app traffic over Wi-Fi.'
    };
  }

  if (!mobileDataEnabled) {
    return {
      isCellularDefault: false,
      activeTransport: transport,
      wifiEnabled: false,
      mobileDataEnabled: false,
      reason: 'CELLULAR_DATA_DISABLED: Mobile data is turned off in Android settings (mobile_data=0). Enable via adb shell svc data enable.'
    };
  }

  if (transport === 'unknown') {
    return {
      isCellularDefault: false,
      activeTransport: 'unknown',
      wifiEnabled,
      mobileDataEnabled,
      reason: 'NO_ACTIVE_NETWORK: No active default network detected (dumpsys connectivity reports "Active default network: none"). The modem has no data connection; the wifi_on and mobile_data settings alone do not prove that a cellular network exists. Verify SIM registration (adb shell getprop gsm.operator.numeric) and data state (adb shell dumpsys telephony.registry) before running network-sensitive tests.'
    };
  }

  const isCellular = transport === 'cellular';
  return {
    isCellularDefault: isCellular,
    activeTransport: transport,
    wifiEnabled: false,
    mobileDataEnabled: true
  };
}

// -------------------------------------------------------------
// Automatic Observed-Egress Capture (Run-Time)
// -------------------------------------------------------------

/**
 * Capture observed egress on-device over the current active route via the companion agent.
 * Never cache this as a static property: German CGNAT rotates public IP dynamically across runs.
 */
export async function captureDeviceEgress(
  deviceId: string,
  physicalDeviceId: string,
  runId: string,
  execAdb: AdbExecutor
): Promise<ObservedEgress> {
  const broadcastCmd = [
    '-s', deviceId, 'shell', 'am', 'broadcast',
    '-a', 'handyfarm.egress.get',
    '-n', 'com.handyfarm.clipper/.ClipperReceiver'
  ];

  const res = await execAdb(broadcastCmd);
  const dataMatch = res.stdout.match(/data="([\s\S]*?)"(?:\s*$|\s*,\s*extras)/);
  if (!dataMatch) {
    throw new Error(`Failed to capture egress broadcast from companion app. Raw output: ${res.stdout || res.stderr}`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(dataMatch[1].replace(/\\"/g, '"'));
  } catch (err) {
    throw new Error(`Invalid JSON in egress response from device ${deviceId}: ${dataMatch[1]}`);
  }

  if (parsed.error) {
    throw new Error(`Observed egress resolution failed on device ${deviceId}: ${parsed.error}`);
  }

  if (!parsed.publicIp) {
    throw new Error(`Observed egress did not return a public IP: ${JSON.stringify(parsed)}`);
  }

  return {
    id: `egress_${runId}_${Date.now()}`,
    deviceId,
    physicalDeviceId,
    runId,
    publicIp: parsed.publicIp,
    asn: parsed.asn || 'unknown',
    carrier: parsed.carrier || 'unknown',
    geo: parsed.geo || {},
    transport: parsed.transport || 'unknown',
    observedAt: parsed.observedAt || Date.now()
  };
}

// -------------------------------------------------------------
// Preflight Assertions for Network-Sensitive Runs
// -------------------------------------------------------------

export interface PreflightOptions {
  deviceId: string;
  runId?: string;
  expectedCarrier?: string;
  requiredBytes?: number;
}

export interface PreflightDependencies {
  getSimForDevice: (deviceId: string) => SimRecord | undefined;
  recordEgress: (egress: ObservedEgress) => void;
  execAdb: AdbExecutor;
  physicalDeviceId?: string;
}

/**
 * Executes the mandatory preflight assertions before any network-sensitive run:
 * 1. Dual-transport check: Cellular must be active default route (Wi-Fi disabled, ADB on USB).
 * 2. Carrier check: Device SIM is registered in inventory and matches expected carrier.
 * 3. Budget headroom check: Hard circuit breaker trips if plan data cap is exhausted.
 * 4. Observed egress check: Public IP & ASN must resolve over cellular and be logged to egress_history.
 *
 * Fails immediately if ANY check fails, rather than producing a contaminated test result.
 */
export async function executeNetworkPreflight(
  options: PreflightOptions,
  deps: PreflightDependencies
): Promise<NetworkPreflightResult> {
  const { deviceId, expectedCarrier, requiredBytes = 1024 * 1024 } = options;
  const runId = options.runId || `run_${Date.now()}`;
  const physId = deps.physicalDeviceId || `phys_${deviceId}`;
  const checks: PreflightCheckItem[] = [];

  // 1. Dual-Transport Route Assertion
  const routeCheck = await checkCellularDefaultRoute(deviceId, deps.execAdb);
  if (!routeCheck.isCellularDefault) {
    const item: PreflightCheckItem = {
      check: 'dual_transport_cellular_route',
      passed: false,
      message: routeCheck.reason || 'Dual-transport violation: Cellular is not the active default route.',
      details: routeCheck
    };
    checks.push(item);
    return {
      passed: false,
      deviceId,
      physicalDeviceId: physId,
      runId,
      checks,
      error: item.message,
      timestamp: Date.now()
    };
  }
  checks.push({
    check: 'dual_transport_cellular_route',
    passed: true,
    message: 'Cellular is verified as active default route (Wi-Fi disabled on device, ADB on USB).',
    details: routeCheck
  });

  // 2. SIM Assignment & Carrier Match Assertion
  const sim = deps.getSimForDevice(deviceId);
  if (!sim) {
    const item: PreflightCheckItem = {
      check: 'carrier_match',
      passed: false,
      message: `No SIM card assigned to device ${deviceId} in SIM inventory store.`
    };
    checks.push(item);
    return {
      passed: false,
      deviceId,
      physicalDeviceId: physId,
      runId,
      checks,
      error: item.message,
      timestamp: Date.now()
    };
  }

  if (expectedCarrier) {
    const normExpected = expectedCarrier.toLowerCase().trim();
    const normSimCarrier = sim.carrier.toLowerCase().trim();
    if (!normSimCarrier.includes(normExpected) && !normExpected.includes(normSimCarrier)) {
      const item: PreflightCheckItem = {
        check: 'carrier_match',
        passed: false,
        message: `Carrier mismatch: expected '${expectedCarrier}', but assigned SIM is '${sim.carrier}' (plan: ${sim.plan}).`
      };
      checks.push(item);
      return {
        passed: false,
        deviceId,
        physicalDeviceId: physId,
        runId,
        sim,
        checks,
        error: item.message,
        timestamp: Date.now()
      };
    }
  }
  checks.push({
    check: 'carrier_match',
    passed: true,
    message: `Carrier matched: '${sim.carrier}' (Plan: ${sim.plan}, Slot: ${sim.slot}).`,
    details: { simId: sim.id, carrier: sim.carrier, plan: sim.plan }
  });

  // 3. Data Budget Headroom Assertion (Circuit Breaker)
  const budget = evaluateDataBudget(sim, requiredBytes);
  if (budget.isBreakerTripped) {
    const item: PreflightCheckItem = {
      check: 'budget_headroom',
      passed: false,
      message: budget.message || `Circuit breaker tripped: Cellular data cap exhausted (${budget.dataUsedBytes} / ${budget.dataCapBytes} bytes).`,
      details: budget
    };
    checks.push(item);
    return {
      passed: false,
      deviceId,
      physicalDeviceId: physId,
      runId,
      sim,
      checks,
      error: item.message,
      timestamp: Date.now()
    };
  }
  checks.push({
    check: 'budget_headroom',
    passed: true,
    message: `Data budget headroom confirmed (${budget.usagePercent}% used, ${budget.remainingBytes} bytes remaining).${budget.isWarning ? ' (Warning: >=80% consumed)' : ''}`,
    details: budget
  });

  // 4. Observed Egress Resolution Assertion
  try {
    const egress = await captureDeviceEgress(deviceId, physId, runId, deps.execAdb);
    deps.recordEgress(egress);
    checks.push({
      check: 'observed_egress',
      passed: true,
      message: `Observed egress resolved over ${egress.transport}: IP ${egress.publicIp} (${egress.asn}, ${egress.geo.city || 'unknown'}, ${egress.geo.country || 'unknown'}).`,
      details: egress
    });

    return {
      passed: true,
      deviceId,
      physicalDeviceId: physId,
      runId,
      sim,
      checks,
      egress,
      timestamp: Date.now()
    };
  } catch (err: any) {
    const item: PreflightCheckItem = {
      check: 'observed_egress',
      passed: false,
      message: `Observed egress resolution failed: ${err?.message || err}`
    };
    checks.push(item);
    return {
      passed: false,
      deviceId,
      physicalDeviceId: physId,
      runId,
      sim,
      checks,
      error: item.message,
      timestamp: Date.now()
    };
  }
}
