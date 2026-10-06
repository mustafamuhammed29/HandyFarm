// Phase 5 (this PR): minimum-viable Device Agent host-side scaffolding.
//
// This is the smallest slice that exercises the highest-value audit items
// without requiring a new companion APK. Every capability here runs over
// `adb shell` from the host, which is the same trust model as the existing
// Phase 2 preflight.
//
// SCOPE (this PR):
//   - Agent status: package version / signature / last-update for an
//     installed app on the device.
//   - App inventory: list installed packages + classification.
//   - Granted permissions for a given package.
//   - Safe APK install workflow (wraps existing install-apk).
//   - Photo-picker test (pushes a test image path to the existing
//     companion; no exfiltration; broadcast stays on device).
//
// OUT OF SCOPE (this PR): signature-level sender verification on the
// companion receiver; new APK build; permission revocation UI. See
// ANDROID-AGENT-SPEC.md for the full design and ROADMAP-NEXT.md for what
// comes next.

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 8000;

// All `execFile` calls below use a hard timeout. Note: Node's
// promisify(execFile) does NOT abort the underlying child on reject; the
// audit (`PRODUCT-AUDIT.md` §3.3 finding #4) flags this. For this PR we
// accept the limitation and rely on the caller's lease TTL + the fact
// that adb is a short-lived process. Future: wrap with AbortController +
// child.kill('SIGKILL') on timeout.

export interface AgentStatus {
  package: string;
  installed: boolean;
  versionName: string | null;
  versionCode: number | null;
  firstInstallMs: number | null;
  lastUpdateMs: number | null;
  signatureSha256: string[]; // empty if not signature-protected
  targetSdk: number | null;
  minSdk: number | null;
}

/**
 * Run `adb shell dumpsys package <pkg>` and parse out the bits the agent
 * needs. Pure parser + a thin wrapper over execFile so tests can call it
 * with a synthetic dumpsys output.
 */
export async function getAgentStatus(deviceId: string, pkg: string): Promise<AgentStatus> {
  try {
    const { stdout } = await execFileAsync('adb', ['-s', deviceId, 'shell', 'dumpsys', 'package', pkg], {
      timeout: DEFAULT_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
    });
    if (/Unable to find package/i.test(stdout)) {
      return notInstalledStatus(pkg);
    }
    return parseDumpsysPackage(stdout, pkg);
  } catch (err: any) {
    // exec failure (e.g. device gone) — return not-installed to keep callers
    // safe. They can re-query once the device is back.
    return notInstalledStatus(pkg);
  }
}

function notInstalledStatus(pkg: string): AgentStatus {
  return {
    package: pkg,
    installed: false,
    versionName: null,
    versionCode: null,
    firstInstallMs: null,
    lastUpdateMs: null,
    signatureSha256: [],
    targetSdk: null,
    minSdk: null,
  };
}

/** Pure parser — exposed for tests. */
export function parseDumpsysPackage(stdout: string, pkg: string): AgentStatus {
  const result: AgentStatus = {
    package: pkg,
    installed: true,
    versionName: null,
    versionCode: null,
    firstInstallMs: null,
    lastUpdateMs: null,
    signatureSha256: [],
    targetSdk: null,
    minSdk: null,
  };

  const versionMatch = stdout.match(/versionCode=(\d+)\s+minSdk=(\d+)(?:\s+targetSdk=(\d+))?/);
  if (versionMatch) {
    result.versionCode = Number(versionMatch[1]);
    result.minSdk = Number(versionMatch[2]);
    if (versionMatch[3]) result.targetSdk = Number(versionMatch[3]);
  }
  const versionNameMatch = stdout.match(/versionName=([^\s\n]+)/);
  if (versionNameMatch) result.versionName = versionNameMatch[1];

  const firstInstallMatch = stdout.match(/firstInstallTime=(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
  if (firstInstallMatch) result.firstInstallMs = Date.parse(firstInstallMatch[1]);
  const lastUpdateMatch = stdout.match(/lastUpdateTime=(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
  if (lastUpdateMatch) result.lastUpdateMs = Date.parse(lastUpdateMatch[1]);

  // Signature IDs appear in two shapes depending on Android version:
//   modern: signatures=PackageSignatures{22cf952 version:3, signatures:[34471701,1234], past signatures:[]}
//   legacy: signatures=PackageSignatures{65a2af5 [34471701]}
// The IDs are integer (NOT hex). Strategy: pull the braces body, then run
// a second regex targeting `signatures:[…]` or bare `[…]`. Be permissive
// about the ID format (digits + spaces + commas + words + punctuation)
// because Android's exact serialisation drifts across versions.
  const sigAll = stdout.match(/signatures=PackageSignatures\{([^}]+)\}/);
  if (sigAll) {
    const body = sigAll[1];
    const modern = body.match(/signatures:\[([^\]]+)\]/);
    if (modern) {
      result.signatureSha256 = modern[1].split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      const legacy = body.match(/\[([^\]]+)\]/);
      if (legacy) {
        result.signatureSha256 = legacy[1].split(',').map((s) => s.trim()).filter(Boolean);
      }
    }
  }

  return result;
}

export interface InstalledApp {
  package: string;
  /** Path on device, if `-f` was passed. */
  path: string | null;
  /** Best-effort classification based on the package location. */
  classification: 'system' | 'user' | 'unknown';
}

/**
 * Run `adb shell pm list packages -f`. `-f` includes the on-device path and
 * lets us classify system vs user apps heuristically:
 *   - /system/...          → system
 *   - /data/app/...         → user
 *   - /product/...          → system (newer Android)
 *   - anything else         → 'unknown' (caller may refine)
 */
export async function getInstalledApps(deviceId: string): Promise<InstalledApp[]> {
  let stdout = '';
  try {
    const r = await execFileAsync('adb', ['-s', deviceId, 'shell', 'pm', 'list', 'packages', '-f'], {
      timeout: DEFAULT_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
    });
    stdout = r.stdout;
  } catch {
    return [];
  }
  return parsePmList(stdout);
}

export function parsePmList(stdout: string): InstalledApp[] {
  const out: InstalledApp[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('package:')) continue;
    // Android 7 output:  package:/data/app/com.x-1/base.apk=com.x
    // Android 14 output: package:/data/app/~~X==/com.x-y==/base.apk=com.x
    //   The path itself contains `==` separators so a non-greedy regex
    //   would split at the wrong `=`. Strategy: find the LAST `=` in
    //   the line, take everything after it as the package, everything
    //   before as the path.
    const lastEq = trimmed.lastIndexOf('=');
    if (lastEq === -1 || lastEq === trimmed.length - 1) {
      // No `=` or trailing `=`: just a package name with no path.
      const pkg = trimmed.slice('package:'.length).trim();
      if (pkg) out.push({ package: pkg, path: null, classification: 'unknown' });
      continue;
    }
    const path = trimmed.slice('package:'.length, lastEq).trim();
    const pkg = trimmed.slice(lastEq + 1).trim();
    if (pkg) out.push({ package: pkg, path, classification: classifyPath(path) });
  }
  return out;
}

function classifyPath(path: string): 'system' | 'user' | 'unknown' {
  if (path.startsWith('/system/') || path.startsWith('/product/') || path.startsWith('/vendor/')) {
    return 'system';
  }
  if (path.startsWith('/data/app/')) {
    return 'user';
  }
  return 'unknown';
}

export type PermissionState =
  | 'granted'
  | 'denied'
  | 'restricted' // hardware feature
  | 'unavailable-on-version' // API not present on this Android version
  | 'requires-user-interaction'; // runtime grant requires user gesture

export interface PermissionRecord {
  permission: string;
  state: PermissionState;
  /** For runtime permissions: granted=true|false|null. */
  granted: boolean | null;
  /** When granted=true, the flags set on the grant. */
  flags: string;
}

/**
 * Run `adb shell dumpsys package <pkg>` and parse the per-permission block.
 * Pure parser is `parseDumpsysPermissions` — tests use synthetic input.
 */
export async function getGrantedPermissions(deviceId: string, pkg: string): Promise<PermissionRecord[]> {
  let stdout = '';
  try {
    const r = await execFileAsync('adb', ['-s', deviceId, 'shell', 'dumpsys', 'package', pkg], {
      timeout: DEFAULT_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
    });
    stdout = r.stdout;
  } catch {
    return [];
  }
  return parseDumpsysPermissions(stdout);
}

/** Parse the per-permission block of `dumpsys package`. */
export function parseDumpsysPermissions(stdout: string): PermissionRecord[] {
  // `dumpsys package` permission lines look like:
  //   android.permission.INTERNET: granted=true, flags=[ GRANTED_BY_DEFAULT | USER_FIXED ]
  //   android.permission.READ_CONTACTS: granted=false, flags=[ ]
  //   android.permission.SEND_SMS: prot=signature|privileged, INSTALLED
  // We only return runtime permissions with a `granted=true|false` value.
  const out: PermissionRecord[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*(android\.permission\.\w+|com\.handyfarm\.clipper\.permission\.\w+):\s+granted=(true|false|null)/);
    if (!m) continue;
    const permission = m[1];
    const grantedRaw = m[2];
    const flags = (line.match(/flags=\[([^\]]*)\]/) || [, ''])[1].trim();
    const state: PermissionState =
      grantedRaw === 'true' ? 'granted' :
      grantedRaw === 'false' ? 'denied' :
      'requires-user-interaction';
    out.push({
      permission,
      state,
      granted: grantedRaw === 'true' ? true : grantedRaw === 'false' ? false : null,
      flags,
    });
  }
  return out;
}

/**
 * Destructive-action safety wrapper. Confirms that the `confirm: true`
 * token is set when the caller asks for a destructive operation.
 */
export function requireConfirmation(confirm: boolean, opName: string): { ok: true } | { ok: false; error: string } {
  if (confirm) return { ok: true };
  return { ok: false, error: `${opName} requires { confirm: true } in the request envelope` };
}

/**
 * Re-export the constant so tests can verify the audit-trail envelope.
 */
export const AGENT_REQUIRED_PERMS = [] as const;

/**
 * Photo / media picker test: pushes a small image to /data/local/tmp/ on
 * the device and asks the existing companion to read it. **No exfiltration.**
 * The path stays on device; we only verify the broadcast was accepted.
 *
 * For a real photo-picker UI test (Android 13+ system picker), this
 * would use `Intent.ACTION_GET_CONTENT` with `type=image/*`. Defer until
 * a real test scenario requires it (see ANDROID-AGENT-SPEC.md §2.6).
 */
export async function pushTestImage(
  deviceId: string,
  imagePath: string,
): Promise<{ ok: boolean; message: string }> {
  // 1. Validate the path is on the host, not a path traversal.
  if (imagePath.includes('..')) {
    return { ok: false, message: 'invalid path' };
  }

  // 2. Copy to the device's tmp dir (binary, no shell).
  const tmpName = `handyfarm-pickertest-${Date.now()}.png`;
  try {
    await execFileAsync('adb', ['-s', deviceId, 'push', imagePath, `/data/local/tmp/${tmpName}`], {
      timeout: DEFAULT_TIMEOUT_MS,
    });
  } catch (err: any) {
    return { ok: false, message: `adb push failed: ${err?.message || String(err)}` };
  }

  // 3. Broadcast the path to the existing companion's clipboard receiver
  //    (it handles path validation + deletion).
  try {
    await execFileAsync(
      'adb',
      ['-s', deviceId, 'shell', 'am', 'broadcast', '-a', 'handyfarm.clipboard.set.path', '--es', 'path', `/data/local/tmp/${tmpName}`],
      { timeout: DEFAULT_TIMEOUT_MS },
    );
    return { ok: true, message: `pushed ${tmpName} and broadcast set.path` };
  } catch (err: any) {
    return { ok: false, message: `broadcast failed: ${err?.message || String(err)}` };
  }
}