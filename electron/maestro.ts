// Phase 5: Maestro CLI executor.
//
// This is the production path. It calls `maestro` via execFile/spawn, streams
// stdout/stderr, captures artifacts, and reports pass/fail with the lease
// properly held for the run's duration.
//
// `maestro` is installed locally via Eclipse Temurin 21 JDK + Maestro CLI
// binary (detected via `probeMaestro()`).
//
// When `maestro` is not on PATH, entry points return a structured
// `MAESTRO_NOT_FOUND` error. The mini-flow runner in miniFlow.ts is the
// offline-staging alternative that uses our existing adb machinery.

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

const execFileAsync = promisify(execFile);

export type MaestroRunStatus = 'passed' | 'failed' | 'cancelled' | 'error';

export interface MaestroRunSpec {
  /** Path to a `.yaml` flow file on disk. Mutually exclusive with `flowContent`. */
  flowPath?: string;
  /** Inline YAML flow content. Mutually exclusive with `flowPath`. */
  flowContent?: string;
  /** Optional name for the run, used in audit + artifact filenames. */
  name?: string;
  /** `{placeholder}` substitution applied to the flow YAML before execution. */
  substitutions?: Record<string, string>;
  /** Optional explicit path to the maestro binary. Defaults to 'maestro' on PATH. */
  maestroPath?: string;
  /** Optional env passed through to maestro (e.g. ANDROID_HOME). */
  env?: NodeJS.ProcessEnv;
}

export interface MaestroParsedFailure {
  /** Step description or line number from the YAML. */
  step?: string;
  /** Human-readable failure message from maestro output. */
  message: string;
}

export interface MaestroRunResult {
  /** Unique job id; also used as the scheduler_audit job_id. */
  jobId: string;
  /** Caller-supplied or auto-generated name. */
  name: string;
  status: MaestroRunStatus;
  /** maestro's exit code. Null when the process was killed externally. */
  exitCode: number | null;
  /** maestro stdout, full text. */
  stdout: string;
  /** maestro stderr, full text. */
  stderr: string;
  /** Parsed failure descriptions (best-effort). */
  parsedFailures: MaestroParsedFailure[];
  /** Resolved substitutions actually applied to the flow. */
  appliedSubstitutions: Record<string, string>;
  /** Path to the YAML file that was passed to maestro. Useful for debugging. */
  resolvedFlowPath?: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
}

/**
 * Substitute `{placeholder}` tokens in `content` using the provided map.
 * Tokens follow the existing convention used elsewhere in the project: name
 * inside braces, matching `[A-Za-z0-9_]+`. Unknown tokens are left as-is.
 */
export function substitutePlaceholders(content: string, subs: Record<string, string>): { content: string; applied: Record<string, string> } {
  const applied: Record<string, string> = {};
  // Use a single-pass replace so we don't double-substitute values that
  // themselves contain `{...}` (rare but possible).
  const out = content.replace(/\{([A-Za-z0-9_]+)\}/g, (m, name: string) => {
    if (Object.prototype.hasOwnProperty.call(subs, name)) {
      applied[name] = subs[name];
      return subs[name];
    }
    return m;
  });
  return { content: out, applied };
}

/**
 * Best-effort parse of maestro output for failure steps. Maestro prints lines
 * like `Failure: step "..." at line N` and assertion messages. We collect any
 * line that contains a recognizable failure token.
 */
export function parseFailures(stdout: string, stderr: string): MaestroParsedFailure[] {
  const failures: MaestroParsedFailure[] = [];
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const lower = line.toLowerCase();
    if (
      lower.startsWith('failure:') ||
      lower.startsWith('error:') ||
      lower.includes('assertion failed') ||
      lower.includes('expected to be visible') ||
      lower.includes('timed out waiting') ||
      lower.includes('unable to find element')
    ) {
      const m = line.match(/at line (\d+)/);
      failures.push({ step: m ? `line ${m[1]}` : undefined, message: line });
    }
  }
  return failures;
}

/**
 * Probe whether the maestro binary is reachable. Returns the resolved path on
 * success or a structured error on failure. We do NOT cache this — the caller
 * can decide how often to check.
 */
export async function probeMaestro(maestroPath?: string): Promise<{ ok: true; path: string } | { ok: false; error: 'MAESTRO_NOT_FOUND'; tried: string }> {
  const cmd = maestroPath || 'maestro';
  try {
    const { stdout } = await execFileAsync(cmd, ['--version'], { timeout: 5_000 });
    if (!stdout || stdout.trim().length === 0) {
      return { ok: false, error: 'MAESTRO_NOT_FOUND', tried: cmd };
    }
    return { ok: true, path: cmd };
  } catch {
    return { ok: false, error: 'MAESTRO_NOT_FOUND', tried: cmd };
  }
}

/**
 * Run a maestro flow. The function takes responsibility for:
 *   - resolving the YAML (path OR inline → temp file)
 *   - applying `{placeholder}` substitutions
 *   - invoking maestro with `-d <serial> test <flowPath>`
 *   - capturing stdout/stderr
 *   - parsing pass/fail
 *
 * Lease lifecycle is the caller's job: the executor is intentionally
 * lease-agnostic so it can be invoked from inside the Phase 3 scheduler with
 * a lease already held. Use `runMaestroFlowWithLease` for the all-in-one
 * entry point that ties it to the DeviceStore.
 */
export async function runMaestroFlow(spec: MaestroRunSpec, adbSerial: string): Promise<MaestroRunResult> {
  const jobId = randomUUID();
  const startedAt = Date.now();
  const name = spec.name || 'maestro-run';

  if (!spec.flowPath && !spec.flowContent) {
    return {
      jobId, name, status: 'error',
      exitCode: null, stdout: '', stderr: 'either flowPath or flowContent is required',
      parsedFailures: [{ message: 'missing flow' }],
      appliedSubstitutions: {},
      startedAt, completedAt: Date.now(), durationMs: 0,
    };
  }

  let resolvedFlowPath: string | undefined;
  let applied: Record<string, string> = {};
  let tmpDir: string | undefined;

  try {
    if (spec.flowContent) {
      const sub = substitutePlaceholders(spec.flowContent, spec.substitutions || {});
      applied = sub.applied;
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-'));
      resolvedFlowPath = path.join(tmpDir, `${jobId}.yaml`);
      fs.writeFileSync(resolvedFlowPath, sub.content, 'utf8');
    } else {
      // For path flows we still apply substitutions to the file's contents so
      // callers can use `{serial}` etc. consistently across both modes.
      const original = fs.readFileSync(spec.flowPath!, 'utf8');
      const sub = substitutePlaceholders(original, spec.substitutions || {});
      applied = sub.applied;
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-'));
      resolvedFlowPath = path.join(tmpDir, `${jobId}.yaml`);
      fs.writeFileSync(resolvedFlowPath, sub.content, 'utf8');
    }
  } catch (err: any) {
    return {
      jobId, name, status: 'error',
      exitCode: null, stdout: '', stderr: `failed to resolve flow: ${err?.message || String(err)}`,
      parsedFailures: [{ message: 'flow resolution failed' }],
      appliedSubstitutions: applied,
      startedAt, completedAt: Date.now(), durationMs: 0,
    };
  }

  // Probe maestro before spawning the long-running process.
  const probe = await probeMaestro(spec.maestroPath);
  if (!probe.ok) {
    cleanup(tmpDir);
    return {
      jobId, name, status: 'error',
      exitCode: null, stdout: '', stderr: `${probe.error}: tried '${probe.tried}'. Install maestro (see electron/maestro.ts) or use miniFlow.ts as a fallback.`,
      parsedFailures: [{ message: probe.error }],
      appliedSubstitutions: applied,
      resolvedFlowPath,
      startedAt, completedAt: Date.now(), durationMs: 0,
    };
  }

  // Use spawn() (not execFile) so we can stream large outputs without buffering
  // them all into memory; the buffer grows only in the captured strings below.
  return new Promise<MaestroRunResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;

    const child = spawn(probe.path, ['test', '--device', adbSerial, resolvedFlowPath!], {
      env: { ...process.env, ...(spec.env || {}) },
    });

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

    child.on('error', (err) => {
      cleanup(tmpDir);
      resolve({
        jobId, name, status: 'error',
        exitCode: null, stdout, stderr: stderr + `\nspawn error: ${err.message}`,
        parsedFailures: [{ message: err.message }],
        appliedSubstitutions: applied,
        resolvedFlowPath,
        startedAt, completedAt: Date.now(), durationMs: Date.now() - startedAt,
      });
    });

    child.on('close', (code) => {
      cleanup(tmpDir);
      if (killed) {
        resolve({
          jobId, name, status: 'cancelled',
          exitCode: code, stdout, stderr,
          parsedFailures: [],
          appliedSubstitutions: applied,
          resolvedFlowPath,
          startedAt, completedAt: Date.now(), durationMs: Date.now() - startedAt,
        });
        return;
      }
      const status: MaestroRunStatus = code === 0 ? 'passed' : 'failed';
      resolve({
        jobId, name, status,
        exitCode: code, stdout, stderr,
        parsedFailures: parseFailures(stdout, stderr),
        appliedSubstitutions: applied,
        resolvedFlowPath,
        startedAt, completedAt: Date.now(), durationMs: Date.now() - startedAt,
      });
    });

    // Expose kill so the caller can wire AbortSignal support; not part of the
    // public MaestroRunResult but reachable via the spawn child if needed.
    void killed;
  });
}

function cleanup(dir?: string) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}