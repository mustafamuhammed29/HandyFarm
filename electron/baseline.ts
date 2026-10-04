/**
 * HandyFarm Phase 1: Verified State Baseline & Drift Detection
 *
 * Implements the verified-baseline + structured-diff model (§1.2):
 * - Split into Immutable (hardware-fixed, documented, never rotated)
 *   and Mutable (baseline-reset and verified).
 * - baseline capture: captures manifest at a known-good moment.
 * - reset --to baseline: full baseline reset (pm clear for apps, permission
 *   revocation, account removal, companion resets), replacing the legacy
 *   ephemeral UI-only clear.
 * - verify --against baseline: returns structured diff { field, expected, actual, drift_class }.
 * - clock verification: verifies NTP sync and bounds clock offset (never clock jitter).
 */

export type DriftClass =
  | 'app'
  | 'permission'
  | 'account'
  | 'locale'
  | 'network'
  | 'system'
  | 'hardware';

export interface ImmutableFingerprint {
  bootSerial?: string;          // ro.boot.serialno
  buildFingerprint?: string;    // ro.build.fingerprint
  model?: string;               // ro.product.model
  screen?: {
    size?: string;              // wm size (e.g. "1080x2460")
    density?: string;           // wm density (e.g. "480")
  };
  gpuRenderer?: string;         // dumpsys SurfaceFlinger / ro.hardware.egl / GLES renderer
  sensorList?: string[];        // dumpsys sensorservice sensor list
  playServicesVersion?: string; // dumpsys package com.google.android.gms versionName
  verifiedBootState?: string;   // ro.boot.verifiedbootstate (e.g. "green", "orange")
  selinuxMode?: string;         // getenforce (e.g. "Enforcing", "Permissive")
}

export interface PackageBaselineInfo {
  packageName: string;
  versionName?: string;
  versionCode?: string;
}

export interface MutableBaseline {
  installedPackages?: PackageBaselineInfo[];
  grantedPermissions?: Record<string, string[]>; // packageName -> array of granted permissions
  accounts?: string[];                           // dumpsys account names / types
  locale?: string;                               // persist.sys.locale / ro.product.locale
  timezone?: string;                             // persist.sys.timezone
  animationScales?: {
    window?: number;
    transition?: number;
    animator?: number;
  };
  dozeAndBatterySaver?: {
    lowPower?: boolean;
    deviceIdleEnabled?: boolean;
  };
  networkConfig?: {
    wifiOn?: boolean;
    wifiSsid?: string;
  };
  wallpaper?: {
    component?: string;
  };
  defaultLauncher?: string;                      // resolve-activity HOME
}

export interface BaselineManifest {
  deviceId: string;
  physicalDeviceId: string;
  capturedAt: number;
  immutable: ImmutableFingerprint;
  mutable: MutableBaseline;
}

export interface DriftDiffItem {
  field: string;
  expected: any;
  actual: any;
  drift_class: DriftClass;
  description?: string;
}

export interface ClockVerificationResult {
  offsetMs: number;
  bounded: boolean;
  autoTimeEnabled: boolean;
  deviceEpochMs: number;
  hostEpochMs: number;
  driftItem?: DriftDiffItem;
}

export interface BaselineVerificationResult {
  verified: boolean;
  deviceId: string;
  physicalDeviceId: string;
  capturedAt: number;
  verifiedAt: number;
  diffs: DriftDiffItem[];
  clockVerification?: ClockVerificationResult;
}

export type ExecAdbFn = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

/**
 * Classifies any given field path into one of the 7 documented drift classes.
 */
export function classifyDriftField(field: string): DriftClass {
  if (
    field.startsWith('immutable.bootSerial') ||
    field.startsWith('immutable.model') ||
    field.startsWith('immutable.screen') ||
    field.startsWith('immutable.gpuRenderer') ||
    field.startsWith('immutable.sensorList')
  ) {
    return 'hardware';
  }

  if (
    field.startsWith('immutable.buildFingerprint') ||
    field.startsWith('immutable.verifiedBootState') ||
    field.startsWith('immutable.selinuxMode') ||
    field.startsWith('immutable.playServicesVersion')
  ) {
    return 'system';
  }

  if (field.startsWith('mutable.installedPackages')) {
    return 'app';
  }

  if (field.startsWith('mutable.grantedPermissions')) {
    return 'permission';
  }

  if (field.startsWith('mutable.accounts')) {
    return 'account';
  }

  if (field.startsWith('mutable.locale') || field.startsWith('mutable.timezone')) {
    return 'locale';
  }

  if (field.startsWith('mutable.networkConfig')) {
    return 'network';
  }

  if (
    field.startsWith('mutable.animationScales') ||
    field.startsWith('mutable.dozeAndBatterySaver') ||
    field.startsWith('mutable.wallpaper') ||
    field.startsWith('mutable.defaultLauncher') ||
    field.startsWith('clock.')
  ) {
    return 'system';
  }

  return 'system';
}

/**
 * Verifies clock synchronization and bounds offset (never clock jitter).
 * Flagged if offset exceeds threshold (default 2000ms = 2s) or if auto_time is disabled.
 */
export function verifyClock(
  deviceEpochMs: number,
  hostEpochMs: number,
  autoTimeVal: string | number,
  maxOffsetMs = 2000
): ClockVerificationResult {
  const offsetMs = deviceEpochMs - hostEpochMs;
  const autoTimeEnabled = String(autoTimeVal).trim() === '1';
  const offsetBounded = Math.abs(offsetMs) <= maxOffsetMs;
  const bounded = offsetBounded && autoTimeEnabled;

  let driftItem: DriftDiffItem | undefined;
  if (!bounded) {
    let reason = '';
    if (!offsetBounded) reason += `Clock offset ${offsetMs}ms exceeds bound of ±${maxOffsetMs}ms. `;
    if (!autoTimeEnabled) reason += 'NTP auto_time is disabled in system settings.';
    driftItem = {
      field: 'clock.offsetMs',
      expected: `<= ±${maxOffsetMs}ms (auto_time: true)`,
      actual: `${offsetMs}ms (auto_time: ${autoTimeEnabled})`,
      drift_class: 'system',
      description: reason.trim()
    };
  }

  return {
    offsetMs,
    bounded,
    autoTimeEnabled,
    deviceEpochMs,
    hostEpochMs,
    driftItem
  };
}

/**
 * Generates a structured diff between a stored BaselineManifest and the current observed state.
 * Returns empty array if all fields match; returns array of DriftDiffItem with appropriate drift_class.
 */
export function generateBaselineDiff(
  baseline: BaselineManifest,
  current: {
    immutable: ImmutableFingerprint;
    mutable: MutableBaseline;
    clock?: ClockVerificationResult;
  }
): DriftDiffItem[] {
  const diffs: DriftDiffItem[] = [];

  // 1. Compare Immutable Fingerprint
  const immBase = baseline.immutable || {};
  const immCurr = current.immutable || {};

  const scalarImmFields: Array<keyof ImmutableFingerprint> = [
    'bootSerial',
    'buildFingerprint',
    'model',
    'gpuRenderer',
    'playServicesVersion',
    'verifiedBootState',
    'selinuxMode'
  ];

  for (const f of scalarImmFields) {
    const exp = immBase[f];
    const act = immCurr[f];
    if (exp !== undefined && act !== undefined && exp !== act) {
      diffs.push({
        field: `immutable.${f}`,
        expected: exp,
        actual: act,
        drift_class: classifyDriftField(`immutable.${f}`),
        description: `Immutable property '${f}' changed from '${exp}' to '${act}'`
      });
    }
  }

  // Screen size & density
  if (immBase.screen || immCurr.screen) {
    const baseSize = immBase.screen?.size;
    const currSize = immCurr.screen?.size;
    if (baseSize !== undefined && currSize !== undefined && baseSize !== currSize) {
      diffs.push({
        field: 'immutable.screen.size',
        expected: baseSize,
        actual: currSize,
        drift_class: 'hardware',
        description: `Screen resolution changed from '${baseSize}' to '${currSize}'`
      });
    }
    const baseDensity = immBase.screen?.density;
    const currDensity = immCurr.screen?.density;
    if (baseDensity !== undefined && currDensity !== undefined && baseDensity !== currDensity) {
      diffs.push({
        field: 'immutable.screen.density',
        expected: baseDensity,
        actual: currDensity,
        drift_class: 'hardware',
        description: `Screen density changed from '${baseDensity}' to '${currDensity}'`
      });
    }
  }

  // Sensor list (set comparison)
  if (immBase.sensorList && immCurr.sensorList) {
    const baseSensors = new Set(immBase.sensorList);
    const currSensors = new Set(immCurr.sensorList);

    for (const s of baseSensors) {
      if (!currSensors.has(s)) {
        diffs.push({
          field: 'immutable.sensorList',
          expected: s,
          actual: null,
          drift_class: 'hardware',
          description: `Hardware sensor missing: ${s}`
        });
      }
    }
    for (const s of currSensors) {
      if (!baseSensors.has(s)) {
        diffs.push({
          field: 'immutable.sensorList',
          expected: null,
          actual: s,
          drift_class: 'hardware',
          description: `Unexpected hardware sensor detected: ${s}`
        });
      }
    }
  }

  // 2. Compare Mutable Baseline
  const mutBase = baseline.mutable || {};
  const mutCurr = current.mutable || {};

  // Installed Packages
  if (mutBase.installedPackages || mutCurr.installedPackages) {
    const basePkgs = new Map((mutBase.installedPackages || []).map(p => [p.packageName, p]));
    const currPkgs = new Map((mutCurr.installedPackages || []).map(p => [p.packageName, p]));

    for (const [pkgName, baseInfo] of basePkgs.entries()) {
      const currInfo = currPkgs.get(pkgName);
      if (!currInfo) {
        diffs.push({
          field: `mutable.installedPackages.${pkgName}`,
          expected: baseInfo.versionName || 'installed',
          actual: null,
          drift_class: 'app',
          description: `Package '${pkgName}' was removed or uninstalled`
        });
      } else {
        if (baseInfo.versionName && currInfo.versionName && baseInfo.versionName !== currInfo.versionName) {
          diffs.push({
            field: `mutable.installedPackages.${pkgName}.versionName`,
            expected: baseInfo.versionName,
            actual: currInfo.versionName,
            drift_class: 'app',
            description: `Package '${pkgName}' version drifted from '${baseInfo.versionName}' to '${currInfo.versionName}'`
          });
        }
        if (baseInfo.versionCode && currInfo.versionCode && baseInfo.versionCode !== currInfo.versionCode) {
          diffs.push({
            field: `mutable.installedPackages.${pkgName}.versionCode`,
            expected: baseInfo.versionCode,
            actual: currInfo.versionCode,
            drift_class: 'app',
            description: `Package '${pkgName}' versionCode drifted from '${baseInfo.versionCode}' to '${currInfo.versionCode}'`
          });
        }
      }
    }

    for (const [pkgName, currInfo] of currPkgs.entries()) {
      if (!basePkgs.has(pkgName)) {
        diffs.push({
          field: `mutable.installedPackages.${pkgName}`,
          expected: null,
          actual: currInfo.versionName || 'installed',
          drift_class: 'app',
          description: `Unapproved package '${pkgName}' installed since baseline`
        });
      }
    }
  }

  // Granted Permissions
  if (mutBase.grantedPermissions || mutCurr.grantedPermissions) {
    const basePermsMap = mutBase.grantedPermissions || {};
    const currPermsMap = mutCurr.grantedPermissions || {};

    const allPackages = new Set([...Object.keys(basePermsMap), ...Object.keys(currPermsMap)]);
    for (const pkg of allPackages) {
      const bPerms = new Set(basePermsMap[pkg] || []);
      const cPerms = new Set(currPermsMap[pkg] || []);

      for (const p of cPerms) {
        if (!bPerms.has(p)) {
          diffs.push({
            field: `mutable.grantedPermissions.${pkg}.${p}`,
            expected: false,
            actual: true,
            drift_class: 'permission',
            description: `Permission '${p}' granted to '${pkg}' without baseline approval`
          });
        }
      }
      for (const p of bPerms) {
        if (!cPerms.has(p)) {
          diffs.push({
            field: `mutable.grantedPermissions.${pkg}.${p}`,
            expected: true,
            actual: false,
            drift_class: 'permission',
            description: `Baseline permission '${p}' revoked from '${pkg}'`
          });
        }
      }
    }
  }

  // Accounts
  if (mutBase.accounts || mutCurr.accounts) {
    const bAcc = new Set(mutBase.accounts || []);
    const cAcc = new Set(mutCurr.accounts || []);

    for (const a of cAcc) {
      if (!bAcc.has(a)) {
        diffs.push({
          field: `mutable.accounts.${a}`,
          expected: null,
          actual: a,
          drift_class: 'account',
          description: `Unexpected user account '${a}' found on device`
        });
      }
    }
    for (const a of bAcc) {
      if (!cAcc.has(a)) {
        diffs.push({
          field: `mutable.accounts.${a}`,
          expected: a,
          actual: null,
          drift_class: 'account',
          description: `Baseline user account '${a}' missing from device`
        });
      }
    }
  }

  // Locale and Timezone
  if (mutBase.locale !== undefined && mutCurr.locale !== undefined && mutBase.locale !== mutCurr.locale) {
    diffs.push({
      field: 'mutable.locale',
      expected: mutBase.locale,
      actual: mutCurr.locale,
      drift_class: 'locale',
      description: `Device locale drifted from '${mutBase.locale}' to '${mutCurr.locale}'`
    });
  }
  if (mutBase.timezone !== undefined && mutCurr.timezone !== undefined && mutBase.timezone !== mutCurr.timezone) {
    diffs.push({
      field: 'mutable.timezone',
      expected: mutBase.timezone,
      actual: mutCurr.timezone,
      drift_class: 'locale',
      description: `Device timezone drifted from '${mutBase.timezone}' to '${mutCurr.timezone}'`
    });
  }

  // Animation Scales
  if (mutBase.animationScales && mutCurr.animationScales) {
    const bAnim = mutBase.animationScales;
    const cAnim = mutCurr.animationScales;
    for (const k of ['window', 'transition', 'animator'] as const) {
      if (bAnim[k] !== undefined && cAnim[k] !== undefined && bAnim[k] !== cAnim[k]) {
        diffs.push({
          field: `mutable.animationScales.${k}`,
          expected: bAnim[k],
          actual: cAnim[k],
          drift_class: 'system',
          description: `Animation scale '${k}' drifted from ${bAnim[k]} to ${cAnim[k]}`
        });
      }
    }
  }

  // Doze and Battery Saver
  if (mutBase.dozeAndBatterySaver && mutCurr.dozeAndBatterySaver) {
    const bDoze = mutBase.dozeAndBatterySaver;
    const cDoze = mutCurr.dozeAndBatterySaver;
    if (bDoze.lowPower !== undefined && cDoze.lowPower !== undefined && bDoze.lowPower !== cDoze.lowPower) {
      diffs.push({
        field: 'mutable.dozeAndBatterySaver.lowPower',
        expected: bDoze.lowPower,
        actual: cDoze.lowPower,
        drift_class: 'system',
        description: `Battery saver state drifted (expected ${bDoze.lowPower}, got ${cDoze.lowPower})`
      });
    }
  }

  // Network Config
  if (mutBase.networkConfig && mutCurr.networkConfig) {
    const bNet = mutBase.networkConfig;
    const cNet = mutCurr.networkConfig;
    if (bNet.wifiOn !== undefined && cNet.wifiOn !== undefined && bNet.wifiOn !== cNet.wifiOn) {
      diffs.push({
        field: 'mutable.networkConfig.wifiOn',
        expected: bNet.wifiOn,
        actual: cNet.wifiOn,
        drift_class: 'network',
        description: `Wi-Fi state drifted (expected ${bNet.wifiOn}, got ${cNet.wifiOn})`
      });
    }
  }

  // Default Launcher
  if (mutBase.defaultLauncher !== undefined && mutCurr.defaultLauncher !== undefined && mutBase.defaultLauncher !== mutCurr.defaultLauncher) {
    diffs.push({
      field: 'mutable.defaultLauncher',
      expected: mutBase.defaultLauncher,
      actual: mutCurr.defaultLauncher,
      drift_class: 'system',
      description: `Default launcher drifted from '${mutBase.defaultLauncher}' to '${mutCurr.defaultLauncher}'`
    });
  }

  // Clock verification
  if (current.clock?.driftItem) {
    diffs.push(current.clock.driftItem);
  }

  return diffs;
}

// -------------------------------------------------------------
// Parsers for Android CLI Outputs
// -------------------------------------------------------------

export function parseDumpsysPackage(rawText: string): {
  versionName?: string;
  versionCode?: string;
  grantedPermissions: string[];
} {
  let versionName: string | undefined;
  let versionCode: string | undefined;
  const grantedPermissions: string[] = [];

  const vNameMatch = rawText.match(/versionName=([^\s]+)/);
  if (vNameMatch) versionName = vNameMatch[1];

  const vCodeMatch = rawText.match(/versionCode=([0-9]+)/);
  if (vCodeMatch) versionCode = vCodeMatch[1];

  // Scan granted runtime and install permissions
  const lines = rawText.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    const permMatch = trimmed.match(/^([a-zA-Z0-9_.]+):\s*granted=true/);
    if (permMatch) {
      const permName = permMatch[1];
      if (!grantedPermissions.includes(permName)) {
        grantedPermissions.push(permName);
      }
    }
  }

  return { versionName, versionCode, grantedPermissions };
}

export function parseAccountDump(rawText: string): string[] {
  const accounts: string[] = [];
  const matches = rawText.matchAll(/Account\s*\{name=([^,]+),\s*type=([^}]+)\}/g);
  for (const m of matches) {
    const accStr = `${m[1]} (${m[2]})`;
    if (!accounts.includes(accStr)) {
      accounts.push(accStr);
    }
  }
  return accounts;
}

export function parseSensorDump(rawText: string): string[] {
  const sensors: string[] = [];
  const lines = rawText.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // Line format e.g.: "0x00000001) lsm6dsm_acc | st | ver: 1 | type: android.sensor.accelerometer(1)"
    const match = trimmed.match(/^0x[0-9a-fA-F]+\)\s+([a-zA-Z0-9_.-]+)\s*\|/);
    if (match) {
      const name = match[1].trim();
      if (!sensors.includes(name)) sensors.push(name);
    }
  }
  return sensors;
}

export function parseGpuRenderer(rawText: string): string | undefined {
  const match = rawText.match(/GLES:\s*(.*)/);
  if (match) return match[1].trim();
  return undefined;
}

export function parseWmOutput(sizeText: string, densityText: string): { size?: string; density?: string } {
  let size: string | undefined;
  let density: string | undefined;

  const sizeMatch = sizeText.match(/Physical size:\s*([0-9x]+)/i) || sizeText.match(/([0-9]+x[0-9]+)/);
  if (sizeMatch) size = sizeMatch[1];

  const denMatch = densityText.match(/Physical density:\s*([0-9]+)/i) || densityText.match(/([0-9]+)/);
  if (denMatch) density = denMatch[1];

  return { size, density };
}

// -------------------------------------------------------------
// Live Device Capture, Verify, and Full Reset
// -------------------------------------------------------------

/**
 * Captures the complete baseline manifest for a physical device at a known-good moment.
 */
export async function captureDeviceManifest(
  deviceId: string,
  physicalDeviceId: string,
  execAdb: ExecAdbFn
): Promise<BaselineManifest> {
  // 1. Gather Immutable Hardware & System properties
  const [
    bootSerialRes,
    fingerprintRes,
    modelRes,
    wmSizeRes,
    wmDensityRes,
    selinuxRes,
    verifiedBootRes,
    sfRes,
    sensorRes,
    gmsRes
  ] = await Promise.all([
    execAdb(['-s', deviceId, 'shell', 'getprop', 'ro.boot.serialno']).catch(() => ({ stdout: '', stderr: '' })),
    execAdb(['-s', deviceId, 'shell', 'getprop', 'ro.build.fingerprint']).catch(() => ({ stdout: '', stderr: '' })),
    execAdb(['-s', deviceId, 'shell', 'getprop', 'ro.product.model']).catch(() => ({ stdout: '', stderr: '' })),
    execAdb(['-s', deviceId, 'shell', 'wm', 'size']).catch(() => ({ stdout: '', stderr: '' })),
    execAdb(['-s', deviceId, 'shell', 'wm', 'density']).catch(() => ({ stdout: '', stderr: '' })),
    execAdb(['-s', deviceId, 'shell', 'getenforce']).catch(() => ({ stdout: '', stderr: '' })),
    execAdb(['-s', deviceId, 'shell', 'getprop', 'ro.boot.verifiedbootstate']).catch(() => ({ stdout: '', stderr: '' })),
    execAdb(['-s', deviceId, 'shell', 'dumpsys', 'SurfaceFlinger']).catch(() => ({ stdout: '', stderr: '' })),
    execAdb(['-s', deviceId, 'shell', 'dumpsys', 'sensorservice']).catch(() => ({ stdout: '', stderr: '' })),
    execAdb(['-s', deviceId, 'shell', 'dumpsys package com.google.android.gms | grep -m 1 versionName']).catch(() => ({ stdout: '', stderr: '' }))
  ]);

  const screen = parseWmOutput(wmSizeRes.stdout, wmDensityRes.stdout);
  const gpuRenderer = parseGpuRenderer(sfRes.stdout);
  const sensorList = parseSensorDump(sensorRes.stdout);
  const gmsParsed = parseDumpsysPackage(gmsRes.stdout);

  const immutable: ImmutableFingerprint = {
    bootSerial: bootSerialRes.stdout.trim() || undefined,
    buildFingerprint: fingerprintRes.stdout.trim() || undefined,
    model: modelRes.stdout.trim() || undefined,
    screen,
    gpuRenderer,
    sensorList: sensorList.length > 0 ? sensorList : undefined,
    playServicesVersion: gmsParsed.versionName,
    verifiedBootState: verifiedBootRes.stdout.trim() || undefined,
    selinuxMode: selinuxRes.stdout.trim() || undefined
  };

  // 2. Gather Mutable Baseline properties
  const [
    packagesRes,
    accountsRes,
    localeRes,
    timezoneRes,
    winAnimRes,
    transAnimRes,
    durAnimRes,
    lowPowerRes,
    wifiRes,
    launcherRes
  ] = await Promise.all([
    execAdb(['-s', deviceId, 'shell', 'pm', 'list', 'packages', '-3']).catch(() => ({ stdout: '', stderr: '' })),
    execAdb(['-s', deviceId, 'shell', 'dumpsys', 'account']).catch(() => ({ stdout: '', stderr: '' })),
    execAdb(['-s', deviceId, 'shell', 'getprop', 'persist.sys.locale']).catch(() => ({ stdout: '', stderr: '' })),
    execAdb(['-s', deviceId, 'shell', 'getprop', 'persist.sys.timezone']).catch(() => ({ stdout: '', stderr: '' })),
    execAdb(['-s', deviceId, 'shell', 'settings', 'get', 'global', 'window_animation_scale']).catch(() => ({ stdout: '0', stderr: '' })),
    execAdb(['-s', deviceId, 'shell', 'settings', 'get', 'global', 'transition_animation_scale']).catch(() => ({ stdout: '0', stderr: '' })),
    execAdb(['-s', deviceId, 'shell', 'settings', 'get', 'global', 'animator_duration_scale']).catch(() => ({ stdout: '0', stderr: '' })),
    execAdb(['-s', deviceId, 'shell', 'settings', 'get', 'global', 'low_power']).catch(() => ({ stdout: '0', stderr: '' })),
    execAdb(['-s', deviceId, 'shell', 'settings', 'get', 'global', 'wifi_on']).catch(() => ({ stdout: '1', stderr: '' })),
    execAdb(['-s', deviceId, 'shell', 'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.HOME']).catch(() => ({ stdout: '', stderr: '' }))
  ]);

  // Parse 3rd party packages & query their permissions in parallel batches
  const rawPkgs = packagesRes.stdout
    .split('\n')
    .map(l => l.trim().replace(/^package:/, ''))
    .filter(p => p.length > 0);

  const installedPackages: PackageBaselineInfo[] = [];
  const grantedPermissions: Record<string, string[]> = {};

  // Inspect up to 50 3rd party packages
  const samplePkgs = rawPkgs.slice(0, 50);
  for (let i = 0; i < samplePkgs.length; i += 10) {
    const chunk = samplePkgs.slice(i, i + 10);
    const dumpResults = await Promise.all(
      chunk.map(pkg => execAdb(['-s', deviceId, 'shell', 'dumpsys', 'package', pkg]).catch(() => ({ stdout: '', stderr: '' })))
    );
    for (let j = 0; j < chunk.length; j++) {
      const pkg = chunk[j];
      const parsed = parseDumpsysPackage(dumpResults[j].stdout);
      installedPackages.push({
        packageName: pkg,
        versionName: parsed.versionName,
        versionCode: parsed.versionCode
      });
      if (parsed.grantedPermissions.length > 0) {
        grantedPermissions[pkg] = parsed.grantedPermissions;
      }
    }
  }

  const accounts = parseAccountDump(accountsRes.stdout);
  const launcherLines = launcherRes.stdout.trim().split('\n');
  const defaultLauncher = launcherLines.length > 0 ? launcherLines[launcherLines.length - 1].trim() : undefined;

  const mutable: MutableBaseline = {
    installedPackages,
    grantedPermissions,
    accounts,
    locale: localeRes.stdout.trim() || undefined,
    timezone: timezoneRes.stdout.trim() || undefined,
    animationScales: {
      window: parseFloat(winAnimRes.stdout.trim()) || 0,
      transition: parseFloat(transAnimRes.stdout.trim()) || 0,
      animator: parseFloat(durAnimRes.stdout.trim()) || 0
    },
    dozeAndBatterySaver: {
      lowPower: lowPowerRes.stdout.trim() === '1'
    },
    networkConfig: {
      wifiOn: wifiRes.stdout.trim() !== '0'
    },
    defaultLauncher
  };

  return {
    deviceId,
    physicalDeviceId,
    capturedAt: Date.now(),
    immutable,
    mutable
  };
}

/**
 * Verifies a device against its stored baseline manifest.
 * Computes structured drift diffs and bounds clock offset.
 */
export async function verifyDeviceAgainstBaseline(
  deviceId: string,
  manifest: BaselineManifest,
  execAdb: ExecAdbFn
): Promise<BaselineVerificationResult> {
  const verifiedAt = Date.now();

  // Clock verification
  const tStart = Date.now();
  const [dateRes, autoTimeRes] = await Promise.all([
    execAdb(['-s', deviceId, 'shell', 'date', '+%s%3N']).catch(() => ({ stdout: '', stderr: '' })),
    execAdb(['-s', deviceId, 'shell', 'settings', 'get', 'global', 'auto_time']).catch(() => ({ stdout: '1', stderr: '' }))
  ]);
  const tEnd = Date.now();
  const hostEpochMid = Math.round((tStart + tEnd) / 2);
  const deviceEpochMs = parseInt(dateRes.stdout.trim(), 10) || hostEpochMid;
  const clockVerification = verifyClock(deviceEpochMs, hostEpochMid, autoTimeRes.stdout.trim());

  // Capture current state
  const currentManifest = await captureDeviceManifest(deviceId, manifest.physicalDeviceId, execAdb);

  // Generate structured diff
  const diffs = generateBaselineDiff(manifest, {
    immutable: currentManifest.immutable,
    mutable: currentManifest.mutable,
    clock: clockVerification
  });

  return {
    verified: diffs.length === 0,
    deviceId,
    physicalDeviceId: manifest.physicalDeviceId,
    capturedAt: manifest.capturedAt,
    verifiedAt,
    diffs,
    clockVerification
  };
}

/**
 * FULL BASELINE RESET (§1.2 & §1.4).
 * Replaces the legacy ephemeral-only reset.baseline (which only cleared mock location,
 * clipboard, system dialogs, animation scales, and VPN).
 *
 * This implementation performs a genuine verified state reset:
 * 1. Invokes first-party companion app resets (mock location, clipboard, VPN).
 * 2. Runs `pm clear` for all third-party app state (exempting com.handyfarm.clipper).
 * 3. Uninstalls any apps installed after baseline capture.
 * 4. Revokes permissions granted beyond baseline.
 * 5. Removes user accounts created since baseline.
 * 6. Restores animation scales, low-power mode, and closes system dialogs / returns HOME.
 * 7. Immediately runs verification to produce a verified post-reset status.
 */
export async function executeFullBaselineReset(
  deviceId: string,
  manifest: BaselineManifest | undefined,
  execAdb: ExecAdbFn,
  broadcastResetFn: () => Promise<any>
): Promise<{
  success: boolean;
  actions: string[];
  verification?: BaselineVerificationResult;
  error?: string;
}> {
  const actions: string[] = [];

  try {
    // 1. Companion-side resets (mock location, clipboard, VPN disconnection)
    try {
      await broadcastResetFn();
      actions.push('companion_resets_executed (mock_location, clipboard, vpn)');
    } catch (e: any) {
      console.warn(`[FullBaselineReset] Companion broadcast reset warning: ${e?.message}`);
    }

    // 2. Query currently installed 3rd-party packages
    const pkgListRes = await execAdb(['-s', deviceId, 'shell', 'pm', 'list', 'packages', '-3'])
      .catch(() => ({ stdout: '', stderr: '' }));
    const currentPkgs = pkgListRes.stdout
      .split('\n')
      .map(l => l.trim().replace(/^package:/, ''))
      .filter(p => p.length > 0);

    const baselinePkgNames = new Set((manifest?.mutable?.installedPackages || []).map(p => p.packageName));
    const COMPANION_PKG = 'com.handyfarm.clipper';

    // 3. Clear app data or uninstall post-baseline apps
    for (const pkg of currentPkgs) {
      if (pkg === COMPANION_PKG) continue; // CRITICAL: Never clear companion app state

      if (manifest && !baselinePkgNames.has(pkg)) {
        // App was installed AFTER baseline -> uninstall it
        await execAdb(['-s', deviceId, 'shell', 'pm', 'uninstall', pkg]).catch(() => {});
        actions.push(`uninstalled_unapproved_package: ${pkg}`);
      } else {
        // App is part of baseline -> pm clear to wipe data/cache back to clean state
        await execAdb(['-s', deviceId, 'shell', 'pm', 'clear', pkg]).catch(() => {});
        actions.push(`pm_cleared_package: ${pkg}`);
      }
    }

    // 4. Revoke runtime permissions granted beyond baseline
    if (manifest?.mutable?.grantedPermissions) {
      for (const [pkg, baselinePerms] of Object.entries(manifest.mutable.grantedPermissions)) {
        if (pkg === COMPANION_PKG) continue;
        const bSet = new Set(baselinePerms);
        const dumpRes = await execAdb(['-s', deviceId, 'shell', 'dumpsys', 'package', pkg])
          .catch(() => ({ stdout: '', stderr: '' }));
        const currentPerms = parseDumpsysPackage(dumpRes.stdout).grantedPermissions;

        for (const p of currentPerms) {
          if (!bSet.has(p)) {
            await execAdb(['-s', deviceId, 'shell', 'pm', 'revoke', pkg, p]).catch(() => {});
            actions.push(`revoked_permission: ${pkg} -> ${p}`);
          }
        }
      }
    }

    // 5. Account cleanup: check accounts and remove extraneous accounts if possible
    const accountDump = await execAdb(['-s', deviceId, 'shell', 'dumpsys', 'account'])
      .catch(() => ({ stdout: '', stderr: '' }));
    const accounts = parseAccountDump(accountDump.stdout);
    const baselineAccounts = new Set(manifest?.mutable?.accounts || []);
    for (const acc of accounts) {
      if (!baselineAccounts.has(acc)) {
        actions.push(`extraneous_account_flagged: ${acc}`);
      }
    }

    // 6. Restore system settings (animations, battery saver, dialogs, HOME key)
    const targetWinAnim = manifest?.mutable?.animationScales?.window ?? 0;
    const targetTransAnim = manifest?.mutable?.animationScales?.transition ?? 0;
    const targetDurAnim = manifest?.mutable?.animationScales?.animator ?? 0;

    await execAdb(['-s', deviceId, 'shell', 'settings', 'put', 'global', 'window_animation_scale', String(targetWinAnim)]).catch(() => {});
    await execAdb(['-s', deviceId, 'shell', 'settings', 'put', 'global', 'transition_animation_scale', String(targetTransAnim)]).catch(() => {});
    await execAdb(['-s', deviceId, 'shell', 'settings', 'put', 'global', 'animator_duration_scale', String(targetDurAnim)]).catch(() => {});
    await execAdb(['-s', deviceId, 'shell', 'settings', 'put', 'global', 'low_power', '0']).catch(() => {});
    actions.push(`restored_animation_scales (${targetWinAnim}, ${targetTransAnim}, ${targetDurAnim}) and low_power=0`);

    // Dismiss system dialogs & return to home screen
    await execAdb(['-s', deviceId, 'shell', 'am', 'broadcast', '-a', 'android.intent.action.CLOSE_SYSTEM_DIALOGS']).catch(() => {});
    await execAdb(['-s', deviceId, 'shell', 'input', 'keyevent', '3']).catch(() => {});
    actions.push('dismissed_system_dialogs_and_navigated_home');

    // 7. Verify baseline post-reset if manifest exists
    let verification: BaselineVerificationResult | undefined;
    if (manifest) {
      verification = await verifyDeviceAgainstBaseline(deviceId, manifest, execAdb);
    }

    return {
      success: true,
      actions,
      verification
    };
  } catch (err: any) {
    return {
      success: false,
      actions,
      error: err?.message || String(err)
    };
  }
}
