// Typed allowlist for diagnostic adb commands. Used by main.ts and the api server
// to validate every command before it reaches the device shell. Pure module — no
// side effects on import, safe to require from tests.

export const ARG_RE = /^[a-zA-Z0-9._:\/-]+$/;

export interface AllowedOp {
  pattern: RegExp;
  build: (m: RegExpMatchArray) => string[];
}

export const ALLOWED_OPS: AllowedOp[] = [
  { pattern: /^getprop(?:\s+([a-zA-Z0-9._-]+))?$/,           build: (m) => m[1] ? ['getprop', m[1]] : ['getprop'] },
  { pattern: /^dumpsys\s+(battery|batteryinfo|package|window|display|power|diskstats|meminfo)(?:\s+([a-zA-Z0-9._-]+))?$/,
    build: (m) => ['dumpsys', m[1], ...(m[2] ? [m[2]] : [])] },
  { pattern: /^pm\s+list\s+(packages|features|permission-groups)(?:\s+-([a-zA-Z0-9]+))?$/, build: (m) => ['pm', 'list', m[1], ...(m[2] ? [`-${m[2]}`] : [])] },
  { pattern: /^pm\s+path\s+([a-zA-Z0-9._-]+)$/,              build: (m) => ['pm', 'path', m[1]] },
  { pattern: /^ip\s+(addr|route|neigh)(?:\s+(show))?$/,      build: (m) => ['ip', m[1], ...(m[2] ? [m[2]] : [])] },
  { pattern: /^cat\s+\/proc\/(cpuinfo|meminfo|version|uptime|loadavg)$/, build: (m) => ['cat', `/proc/${m[1]}`] },
  { pattern: /^uptime$/,                                      build: () => ['uptime'] },
  { pattern: /^date$/,                                        build: () => ['date'] },
  { pattern: /^df(?:\s+-([a-zA-Z]))?(?:\s+(\/[a-zA-Z0-9._-]+))*$/, build: (m) => ['df', ...(m[1] ? [`-${m[1]}`] : []), ...(m[2] ? [m[2]] : [])] },
  { pattern: /^free(?:\s+-([a-zA-Z]))?$/,                     build: (m) => ['free', ...(m[1] ? [`-${m[1]}`] : [])] },
  { pattern: /^wm\s+(size|density)$/,                          build: (m) => ['wm', m[1]] },
  { pattern: /^settings\s+get\s+(system|secure|global)\s+([a-zA-Z0-9_]+)$/, build: (m) => ['settings', 'get', m[1], m[2]] },
  { pattern: /^logcat\s+-d(?:\s+-([a-zA-Z0-9]+))*(?:\s+([a-zA-Z0-9_:]+))*$/,
    build: (m) => ['logcat', '-d', ...(m[1] ? [`-${m[1]}`] : []), ...(m[2] ? [m[2]] : [])] },
  { pattern: /^ifconfig(?:\s+([a-zA-Z0-9]+))?$/,              build: (m) => m[1] ? ['ifconfig', m[1]] : ['ifconfig'] }
];

export type ParseResult =
  | { ok: true; args: string[] }
  | { ok: false; error: string };

// Belt-and-braces: rejects shell metacharacters from the input wholesale. Every
// allowlist pattern below already rejects them, but this is cheap insurance.
const FORBIDDEN_CHARS_RE = /[;&|`$<>(){}!*?\\\n\r\t'"]/;

export function parseAllowedCommand(input: string): ParseResult {
  if (typeof input !== 'string') return { ok: false, error: 'Command must be a string' };
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: 'Command cannot be empty' };
  if (FORBIDDEN_CHARS_RE.test(trimmed)) {
    return { ok: false, error: 'Command contains forbidden shell metacharacter' };
  }
  for (const { pattern, build } of ALLOWED_OPS) {
    const m = trimmed.match(pattern);
    if (!m) continue;
    const args = build(m);
    // Defense in depth: re-validate every emitted arg
    for (const a of args) {
      if (!ARG_RE.test(a)) {
        return { ok: false, error: `Argument failed allowlist regex: ${a}` };
      }
    }
    return { ok: true, args };
  }
  return { ok: false, error: 'Command is not in the diagnostic allowlist' };
}

export function isSafeAdbCommand(cmd: string): boolean {
  return parseAllowedCommand(cmd).ok;
}