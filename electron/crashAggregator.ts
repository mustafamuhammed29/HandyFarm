// Phase 5: crash + ANR aggregation.
//
// Two ingest paths:
//   1. Live: `adb logcat -b crash -b events -v threadtime` — catches
//      am_crash / am_anr events as they happen.
//   2. On-demand: `adb shell dumpsys dropbox --print` — survives reboot,
//      gives us historical records the device has been holding.
//
// We parse into a structured record keyed by
//   (package, exception, appVersion, deviceFingerprint)
// so cross-device clustering works (e.g. "3/20 devices, all same build,
// same exception"). The clustering key is `clusterKey(record)` and is the
// highest-value property-test target.
//
// On an actual crash we kick off a full `adb bugreport` snapshot for the
// device (Phase 5 brief: "trigger a full adb bugreport only on an actual
// crash, never polled").

import { execFile, spawn } from 'child_process';

export interface CrashRecord {
  /** Owning app package, e.g. "com.handyfarm.clipper". */
  package: string;
  /** Exception class name, e.g. "java.lang.NullPointerException". */
  exception: string;
  /** App versionName as reported by dumpsys (or "unknown" if absent). */
  appVersion: string;
  /** Device fingerprint (Phase 1 immutable fingerprint or phys_id). */
  deviceFingerprint: string;
  /** adb-reported serial (transport id), for grouping across the same physical device. */
  deviceSerial: string;
  /** When the event was observed (wall clock at parse time). */
  observedAt: number;
  /** Which ingest path produced this record. */
  source: 'logcat-am_crash' | 'logcat-am_anr' | 'dropbox';
  /** Best-effort message line; can include the stack head. */
  message: string;
}

export interface CrashCluster {
  package: string;
  exception: string;
  appVersion: string;
  deviceFingerprint: string;
  /** Affected device serials within this cluster. */
  affectedSerials: string[];
  affectedCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
  sample: CrashRecord;
}

/** Cluster key for cross-device grouping. Property: any two records with the
 * same clusterKey should be merged into one entry regardless of which ingest
 * path produced them. */
export function clusterKey(r: CrashRecord): string {
  return `${r.package}|${r.exception}|${r.appVersion}|${r.deviceFingerprint}`;
}

// ----------------- Logcat parser -----------------

/**
 * Best-effort parse of one logcat line. Returns null if the line does not
 * describe a crash or ANR. We match:
 *   - "am_crash: <message> in <pkg>... exception <ClassName>"
 *   - "am_anr: <message> in <pkg>"
 *   - tombstones in crash buffer ("Process: <pkg>...")
 */
export function parseLogcatCrashLine(
  line: string,
  deviceSerial: string,
  deviceFingerprint: string,
  now: number = Date.now(),
): CrashRecord | null {
  if (!line) return null;

  // am_crash / am_anr events are tagged by ActivityManager. The actual line
  // shape varies slightly across Android versions, so we accept a few patterns.
  const amMatch = line.match(/(am_crash|am_anr):\s+(.+)/);
  if (amMatch) {
    const kind = amMatch[1];
    const rest = amMatch[2];
    // ActivityManager logs the event body in two shapes:
    //   - "[10023,0,com.android.settings,684310085,ExceptionClass,...]"  (events buffer)
    //   - "Process com.example crashed: java.lang.X at..."              (logcat I/E)
    // Handle both.
    let pkg = 'unknown';
    const arrayMatch = rest.match(/^\[\d+,\d+,([a-zA-Z0-9_.$]+),/);
    if (arrayMatch) {
      pkg = arrayMatch[1];
    } else {
      const pkgMatch = rest.match(/(?:Process|in|process) ([a-zA-Z0-9_.]+)/)
                    || rest.match(/^([a-zA-Z0-9_.]+)/);
      if (pkgMatch) pkg = pkgMatch[1];
    }
    // Match the exception class — typically a fully-qualified Java/Kotlin name
    // ending in "Exception", "Error", or "Throwable". We look for the longest
    // dotted prefix that ends in one of those suffixes.
    const excMatch = rest.match(/([A-Za-z_][A-Za-z0-9_.$]*(?:\.[A-Za-z0-9_.$]+)*(?:Exception|Error|Throwable))\b/);
    const exception = excMatch ? excMatch[1] : (kind === 'am_anr' ? 'ANR' : 'unknown');
    return {
      package: pkg,
      exception,
      appVersion: 'unknown',
      deviceFingerprint,
      deviceSerial,
      observedAt: now,
      source: kind === 'am_anr' ? 'logcat-am_anr' : 'logcat-am_crash',
      message: rest,
    };
  }

  // Tombstone lines look like "Process <name>, PID <n>, crash buffer..."
  const tombMatch = line.match(/^Process\s+([a-zA-Z0-9_.]+).*crash buffer/i);
  if (tombMatch) {
    return {
      package: tombMatch[1],
      exception: 'native-crash',
      appVersion: 'unknown',
      deviceFingerprint,
      deviceSerial,
      observedAt: now,
      source: 'logcat-am_crash',
      message: line,
    };
  }

  return null;
}

// ----------------- Dropbox parser -----------------

/**
 * Parse a single dropbox entry (one entry == one text blob). Returns null if
 * the entry is not a crash/anr/tombstone. Each dropbox entry starts with a
 * line like "Process: com.example" or "package: com.example".
 */
export function parseDropboxEntry(
  body: string,
  deviceSerial: string,
  deviceFingerprint: string,
  appVersion: string = 'unknown',
  now: number = Date.now(),
): CrashRecord | null {
  if (!body) return null;
  const head = body.slice(0, 4000); // most crash heads are <1k chars
  const lower = body.toLowerCase();
  if (!lower.includes('exception') && !lower.includes('anr in') && !lower.includes('tombstone')) {
    return null;
  }

  const pkgMatch = head.match(/(?:Process|process|package)[:=]\s*([a-zA-Z0-9_.]+)/);
  const pkg = pkgMatch ? pkgMatch[1] : 'unknown';

  const excMatch = head.match(/([A-Za-z0-9_.$]+(?:Exception|Error))/);
  const exception = excMatch ? excMatch[1] : (lower.includes('anr in') ? 'ANR' : 'unknown');

  return {
    package: pkg,
    exception,
    appVersion,
    deviceFingerprint,
    deviceSerial,
    observedAt: now,
    source: 'dropbox',
    message: head.split('\n')[0] || head.slice(0, 200),
  };
}

// ----------------- Clustering -----------------

/**
 * Group a flat list of records by clusterKey. Returns one row per cluster
 * with the affected serials aggregated.
 */
export function clusterCrashes(records: CrashRecord[]): CrashCluster[] {
  const groups = new Map<string, CrashCluster>();
  for (const r of records) {
    const key = clusterKey(r);
    const existing = groups.get(key);
    if (existing) {
      if (!existing.affectedSerials.includes(r.deviceSerial)) {
        existing.affectedSerials.push(r.deviceSerial);
        existing.affectedCount = existing.affectedSerials.length;
      }
      if (r.observedAt < existing.firstSeenAt) existing.firstSeenAt = r.observedAt;
      if (r.observedAt > existing.lastSeenAt) existing.lastSeenAt = r.observedAt;
    } else {
      groups.set(key, {
        package: r.package,
        exception: r.exception,
        appVersion: r.appVersion,
        deviceFingerprint: r.deviceFingerprint,
        affectedSerials: [r.deviceSerial],
        affectedCount: 1,
        firstSeenAt: r.observedAt,
        lastSeenAt: r.observedAt,
        sample: r,
      });
    }
  }
  return Array.from(groups.values()).sort((a, b) => b.affectedCount - a.affectedCount);
}

// ----------------- Live process management -----------------

/**
 * Spawn the long-running `adb logcat -b crash -b events` and call `onLine`
 * for every parsed CrashRecord. Returns the child process so the caller can
 * kill it on shutdown.
 */
export function startCrashLogcat(
  adbSerial: string,
  deviceFingerprint: string,
  onLine: (record: CrashRecord) => void,
): { child: ReturnType<typeof spawn>; stop: () => void } {
  const child = spawn('adb', ['-s', adbSerial, 'logcat', '-b', 'crash', '-b', 'events', '-v', 'threadtime'], { stdio: ['ignore', 'pipe', 'pipe'] });

  let buf = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const rec = parseLogcatCrashLine(line, adbSerial, deviceFingerprint);
      if (rec) onLine(rec);
      nl = buf.indexOf('\n');
    }
  });
  child.stderr.on('data', () => { /* ignore logcat stderr noise */ });
  child.on('error', () => { /* adb killed; surface to caller via stop() */ });

  return {
    child,
    stop: () => {
      try { child.kill('SIGTERM'); } catch { /* */ }
      try { execFile('adb', ['-s', adbSerial, 'kill-server']); } catch { /* best effort */ }
    },
  };
}

/**
 * Fetch historical crash/anr records via `dumpsys dropbox --print`.
 * Resolves to an array of parsed records (the raw blob is split on the
 * entry-separator lines that dropbox emits).
 */
export async function fetchDropboxRecords(
  adbSerial: string,
  deviceFingerprint: string,
  appVersionLookup: (pkg: string) => Promise<string>,
): Promise<CrashRecord[]> {
  return new Promise((resolve) => {
    const child = spawn('adb', ['-s', adbSerial, 'shell', 'dumpsys', 'dropbox', '--print'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let blob = '';
    child.stdout.on('data', (chunk: Buffer) => { blob += chunk.toString('utf8'); });
    child.stderr.on('data', () => { /* ignore */ });
    child.on('close', async () => {
      // dropbox entries are separated by 80-char horizontal-rule lines ("=========================================================").
      const entries = blob.split(/={40,}/).map(s => s.trim()).filter(Boolean);
      const records: CrashRecord[] = [];
      for (const e of entries) {
        const rec = parseDropboxEntry(e, adbSerial, deviceFingerprint);
        if (rec) {
          const ver = await appVersionLookup(rec.package).catch(() => 'unknown');
          rec.appVersion = ver;
          records.push(rec);
        }
      }
      resolve(records);
    });
    child.on('error', () => resolve([]));
  });
}

/**
 * Trigger a full `adb bugreport` for the given device. Returns the path to
 * the generated zip. Only call this on an actual crash — never on a poll.
 */
export function captureBugreport(adbSerial: string, outDir: string): Promise<string> {
  const fs = require('fs');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${outDir}/bugreport-${adbSerial}-${stamp}.zip`;
  return new Promise((resolve, reject) => {
    const child = spawn('adb', ['-s', adbSerial, 'bugreport', dest], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.on('data', () => { /* bugreport is verbose; ignore */ });
    child.on('close', (code) => {
      if (code === 0) resolve(dest);
      else reject(new Error(`bugreport exited with code ${code}`));
    });
    child.on('error', reject);
  });
}