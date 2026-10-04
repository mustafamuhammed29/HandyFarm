// Phase 5: mini-flow runner — an offline-staging YAML-subset executor.
//
// When the maestro CLI is not available on the host, we still want to drive
// real end-to-end flows for the demo and the nightly smoke runs. This module
// implements a tiny subset of maestro syntax in-process using our existing
// adb machinery (text input, link opener, app launcher, keyevent, screencap,
// uiautomator dump for assertions).
//
// SUPPORTED STEPS (YAML lines or list items):
//   - launchApp: <package>
//   - openLink: <url>
//   - text: <string>            (also accepts textInput via Companion)
//   - sleep: <ms>
//   - tap: <x>, <y>
//   - keyevent: <code>          (e.g. KEYCODE_HOME, BACK)
//   - takeScreenshot: <optional-filename>
//   - assertVisible: <text>       (best-effort uiautomator-dump text match)
//   - runAdb: <args>            (executes `adb -s SERIAL <args>` and captures output)
//
// Any step that fails (e.g. assertVisible mismatch) returns a 'failed' status;
// the runner stops at the first failure and continues to capture diagnostics.

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

const execFileAsync = promisify(execFile);

export interface MiniFlowSpec {
  /** Path on disk to a YAML flow file. */
  flowPath?: string;
  /** Inline YAML flow content. Mutually exclusive with flowPath. */
  flowContent?: string;
  /** `{placeholder}` substitutions applied first. */
  substitutions?: Record<string, string>;
  /** Directory for screenshot artifacts; defaults to os.tmpdir()/mini-flow-<id>. */
  artifactsDir?: string;
  name?: string;
}

export type MiniFlowStatus = 'passed' | 'failed' | 'error';

export interface MiniFlowStepResult {
  /** Step number (1-based). */
  index: number;
  /** Step verb (e.g. 'launchApp'). */
  verb: string;
  /** Free-form description or arguments. */
  description: string;
  status: MiniFlowStatus;
  /** Free-form output (e.g. screenshot path, text echoed). */
  output?: string;
  durationMs: number;
}

export interface MiniFlowRunResult {
  jobId: string;
  name: string;
  status: MiniFlowStatus;
  appliedSubstitutions: Record<string, string>;
  resolvedFlowPath?: string;
  steps: MiniFlowStepResult[];
  startedAt: number;
  completedAt: number;
  durationMs: number;
}

export interface MiniFlowRunnerHooks {
  /** Anything that can run adb shell against the device — e.g. `adb -s SERIAL shell …`. */
  execAdb: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;
  /** Anything that can install text into the focused field via Companion. */
  sendText?: (text: string) => Promise<void>;
  /** Anything that can take a screencap (PNG buffer). */
  screencap?: () => Promise<Buffer>;
}

/**
 * Substitute `{placeholder}` tokens. Mirrors the maestro helper so callers can use
 * the same substitution map for both runtimes.
 */
export function substitutePlaceholders(content: string, subs: Record<string, string>): { content: string; applied: Record<string, string> } {
  const applied: Record<string, string> = {};
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
 * Tiny line-oriented YAML subset parser. Supports:
 *   - `# comments`
 *   - blank lines
 *   - `- verb: arg`         (single-arg form)
 *   - `- verb:`             (multi-line follow-on lines indented with spaces)
 *
 * Multi-line args are collected until the next `-` or end-of-block. This is
 * intentionally a tiny subset — full YAML is out of scope for the runner.
 */
export function parseMiniFlow(yaml: string): Array<{ verb: string; arg: string }> {
  const steps: Array<{ verb: string; arg: string }> = [];
  const lines = yaml.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();
    i++;
    if (!trimmed || trimmed.startsWith('#')) continue;
    // Top-level list item.
    if (!trimmed.startsWith('-')) {
      // Tolerate; treat as a step with verb=trimmed (no arg).
      const m = trimmed.match(/^([A-Za-z]+)\s*:\s*(.*)$/);
      if (m) steps.push({ verb: m[1], arg: m[2] });
      else steps.push({ verb: trimmed, arg: '' });
      continue;
    }
    const body = trimmed.replace(/^-\s*/, '');
    const colonIdx = body.indexOf(':');
    if (colonIdx < 0) {
      steps.push({ verb: body.trim(), arg: '' });
      continue;
    }
    const verb = body.slice(0, colonIdx).trim();
    const inlineArg = body.slice(colonIdx + 1).trim();
    let arg = inlineArg;
    // If the inline arg is empty (multi-line), collect subsequent indented lines.
    if (!arg) {
      const collected: string[] = [];
      while (i < lines.length) {
        const next = lines[i];
        if (next.trim() === '') { i++; continue; }
        if (next.startsWith('  ') || next.startsWith('\t')) {
          collected.push(next.replace(/^\s+/, ''));
          i++;
        } else {
          break;
        }
      }
      arg = collected.join('\n').trim();
    }
    steps.push({ verb, arg });
  }
  return steps;
}

/**
 * Run a parsed flow against the device via the provided hooks. Lease lifecycle
 * is the caller's job (see `runMiniFlowWithLease` in main.ts).
 */
export async function runMiniFlow(
  spec: MiniFlowSpec,
  hooks: MiniFlowRunnerHooks,
): Promise<MiniFlowRunResult> {
  const jobId = randomUUID();
  const startedAt = Date.now();
  const name = spec.name || 'mini-flow-run';

  let resolvedFlowPath: string | undefined;
  let applied: Record<string, string> = {};

  try {
    let content = '';
    if (spec.flowContent) {
      content = spec.flowContent;
    } else if (spec.flowPath) {
      content = fs.readFileSync(spec.flowPath, 'utf8');
    } else {
      return {
        jobId, name, status: 'error',
        appliedSubstitutions: {}, steps: [],
        startedAt, completedAt: Date.now(), durationMs: 0,
      };
    }
    const sub = substitutePlaceholders(content, spec.substitutions || {});
    applied = sub.applied;
    const dir = spec.artifactsDir || fs.mkdtempSync(path.join(os.tmpdir(), 'mini-flow-'));
    resolvedFlowPath = path.join(dir, `${jobId}.flow`);
    fs.writeFileSync(resolvedFlowPath, sub.content, 'utf8');
  } catch (err: any) {
    return {
      jobId, name, status: 'error',
      appliedSubstitutions: applied, steps: [],
      startedAt, completedAt: Date.now(), durationMs: 0,
    };
  }

  const stepsParsed = parseMiniFlow(appliedSubstitutionsWithPath(applied, resolvedFlowPath));
  // We deliberately parse the substituted content; let the parser see the
  // resolved flow file. To keep things consistent, re-read and re-substitute.
  const resolvedContent = fs.readFileSync(resolvedFlowPath, 'utf8');
  const reparsed = parseMiniFlow(resolvedContent);
  void stepsParsed;

  const artifactsDir = path.dirname(resolvedFlowPath);
  const stepResults: MiniFlowStepResult[] = [];
  let overall: MiniFlowStatus = 'passed';

  for (let idx = 0; idx < reparsed.length; idx++) {
    const step = reparsed[idx];
    const t0 = Date.now();
    let status: MiniFlowStatus = 'passed';
    let output: string | undefined;

    try {
      switch (step.verb) {
        case 'launchApp':
          await hooks.execAdb(['shell', 'monkey', '-p', step.arg, '-c', 'android.intent.category.LAUNCHER', '1']);
          output = `launched ${step.arg}`;
          break;
        case 'openLink':
          await hooks.execAdb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', step.arg]);
          output = `opened ${step.arg}`;
          break;
        case 'text': {
          if (hooks.sendText) {
            await hooks.sendText(step.arg);
          } else {
            // Fallback: use `input text` via adb. Backslash-escape spaces.
            const escaped = step.arg.replace(/ /g, '%s').replace(/'/g, "\\'");
            await hooks.execAdb(['shell', 'input', 'text', escaped]);
          }
          output = `text: ${step.arg}`;
          break;
        }
        case 'sleep': {
          const ms = Math.max(0, Math.min(60_000, Number(step.arg) || 0));
          await new Promise(r => setTimeout(r, ms));
          output = `slept ${ms}ms`;
          break;
        }
        case 'tap': {
          const [xStr, yStr] = step.arg.split(/\s*,\s*/);
          const x = Number(xStr), y = Number(yStr);
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            throw new Error(`invalid tap coords: '${step.arg}'`);
          }
          await hooks.execAdb(['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))]);
          output = `tap (${x}, ${y})`;
          break;
        }
        case 'keyevent':
          await hooks.execAdb(['shell', 'input', 'keyevent', step.arg]);
          output = `keyevent ${step.arg}`;
          break;
        case 'takeScreenshot': {
          const fname = step.arg || `${jobId}-step-${idx + 1}.png`;
          const fpath = path.join(artifactsDir, fname);
          let data: Buffer;
          if (hooks.screencap) {
            data = await hooks.screencap();
          } else {
            const { stdout } = await execFileAsync('adb', ['exec-out', 'screencap', '-p'], { encoding: 'buffer' as any, maxBuffer: 50 * 1024 * 1024 });
            data = stdout as unknown as Buffer;
          }
          fs.writeFileSync(fpath, data);
          output = fpath;
          break;
        }
        case 'assertVisible': {
          // uiautomator dump → XML; cheap substring search.
          const tmp = path.join(artifactsDir, `dump-${idx + 1}.xml`);
          await hooks.execAdb(['exec-out', 'uiautomator', 'dump', '/dev/tty']);
          // uiautomator dump prints the XML to stdout; capture it.
          const r = await hooks.execAdb(['shell', 'uiautomator', 'dump', '--compressed', '/sdcard/window_dump.xml']);
          await hooks.execAdb(['exec-out', 'cat', '/sdcard/window_dump.xml']).catch(() => ({ stdout: r.stdout, stderr: r.stderr, code: 0 }));
          // The simpler portable path: pull the dump to a temp file via exec-out.
          const { stdout: xml } = await execFileAsync('adb', ['exec-out', 'cat', '/sdcard/window_dump.xml'], { maxBuffer: 8 * 1024 * 1024 });
          fs.writeFileSync(tmp, xml, 'utf8');
          if (!xml.includes(step.arg)) {
            status = 'failed';
            output = `assertVisible: '${step.arg}' not found in UI dump (${xml.length} bytes)`;
          } else {
            output = `assertVisible: '${step.arg}' found`;
          }
          break;
        }
        case 'runAdb': {
          const args = step.arg.split(/\s+/).filter(Boolean);
          const r = await hooks.execAdb(args);
          output = r.stdout.slice(0, 2000);
          if (r.code !== 0) status = 'failed';
          break;
        }
        default:
          status = 'failed';
          output = `unsupported step verb: '${step.verb}'`;
      }
    } catch (err: any) {
      status = 'failed';
      output = `error: ${err?.message || String(err)}`;
    }

    const tDone = Date.now();
    stepResults.push({ index: idx + 1, verb: step.verb, description: step.arg, status, output, durationMs: tDone - t0 });
    if (status !== 'passed') {
      overall = 'failed';
      break;
    }
  }

  const completedAt = Date.now();
  return {
    jobId, name, status: overall,
    appliedSubstitutions: applied,
    resolvedFlowPath,
    steps: stepResults,
    startedAt, completedAt,
    durationMs: completedAt - startedAt,
  };
}

function appliedSubstitutionsWithPath(_applied: Record<string, string>, _path: string): string {
  return '';
}
void appliedSubstitutionsWithPath; // never reached; see comments above