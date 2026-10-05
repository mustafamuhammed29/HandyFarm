import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DeviceStore } from '../electron/db';
import { Scheduler } from '../electron/scheduler';
import { runRegressionWithLease } from '../electron/regression';
import {
  diffAgainstGolden,
  groupDiffs,
  imageToPHashBuffer,
  clusterKey as diffClusterKey,
  computePHash,
  DEFAULT_DIFF_CONFIG,
} from '../electron/screencapDiff';
import {
  parseLogcatCrashLine,
  clusterCrashes,
  CrashRecord,
} from '../electron/crashAggregator';

const execFileAsync = promisify(execFile);
const DEVICE = '106293738O006649';
const adb = (args: string[]) => execFileAsync('adb', ['-s', DEVICE, ...args], { timeout: 8000 });

// Live-only: requires a real connected device. Skipped unless HANDYFARM_LIVE_TESTS=1.
const ENABLED = process.env.HANDYFARM_LIVE_TESTS === '1';

interface DemoContext {
  tmpDir: string;
  store: DeviceStore;
  scheduler: Scheduler;
  physId: string;
}

async function setupDemo(): Promise<DemoContext> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-phase5-live-'));
  const store = new DeviceStore(path.join(tmpDir, 'phase5-live.db'));
  const { stdout: serial } = await adb(['shell', 'getprop', 'ro.serialno']);
  const physId = `phys_${serial.trim()}`;
  console.log(`[Phase 5 Live Demo] device=${physId}`);
  const scheduler = new Scheduler({ globalConcurrencyCap: 4 });
  return { tmpDir, store, scheduler, physId };
}

function cleanup(ctx: DemoContext) {
  ctx.scheduler.stop();
  try { ctx.store.close(); } catch {}
  try { fs.rmSync(ctx.tmpDir, { recursive: true, force: true }); } catch {}
}

describe.skipIf(!ENABLED)('Phase 5 live demo — regression + diff + crash on real device', () => {
  let ctx: DemoContext;

  beforeAll(async () => {
    ctx = await setupDemo();
  }, 15_000);

  afterAll(() => {
    if (ctx) cleanup(ctx);
  });

  it('Step 1: regression run via maestro — launch Settings, screenshot, back', async () => {
    ctx.store.savePhysicalDeviceHealth({
      physicalDeviceId: ctx.physId, healthScore: 100, healthReasons: [], healthLastEvaluatedAt: 0,
    });

    const result = await runRegressionWithLease(ctx.store, ctx.scheduler, {
      runner: 'maestro',
      flow: {
        flowContent: `appId: com.android.settings
---
- launchApp
- takeScreenshot: settings-1
- back
`,
        substitutions: {},
      },
      runId: 'live-demo-1',
      sessionId: 'demo-runner',
      deviceId: ctx.physId,
      ttlMinutes: 5,
    });

    console.log(`[Demo 1] status=${result.status}`);
    console.log(`[Demo 1] summary=${result.summary}`);
    if (result.maestro) {
      console.log(`[Demo 1] stdout:\n${result.maestro.stdout}`);
      console.log(`[Demo 1] duration=${result.maestro.durationMs}ms`);
    }
    expect(result.status).toBe('passed');
    expect(result.runner).toBe('maestro');
    expect(result.maestro).toBeDefined();
    expect(result.maestro?.exitCode).toBe(0);
    // Lease released.
    expect(ctx.store.getLease(ctx.physId).state).not.toBe('leased');
  }, 60_000);

  it('Step 2: screenshot diff — capture a golden, capture again, expect match', async () => {
    // Force the device to a stable screen (already at HOME after step 1).
    await adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME']);
    await new Promise(r => setTimeout(r, 800));

    // Capture candidate.
    const { stdout: pngA } = await execFileAsync('adb', ['-s', DEVICE, 'exec-out', 'screencap', '-p'], { encoding: 'buffer' as any, maxBuffer: 50 * 1024 * 1024 });
    const bufA = pngA as unknown as Buffer;
    expect(bufA.length).toBeGreaterThan(1024);

    // Compute pHash + grayscale via the Electron-aware path. For tests we
    // monkey-patch by exposing a minimal nativeImage-free normalization: use
    // the PNG buffer's first 64 bytes for pHash (deterministic but not
    // perceptually meaningful — this is a sanity test of the diff pipeline).
    const phashA = computePHashFromBuffer(bufA);
    const grayscaleA = mockGrayscale(bufA);

    // Golden: same image → distance must be 0.
    const golden = {
      package: 'com.android.settings', scenario: 'home-screen',
      deviceFingerprint: ctx.physId,
      pHash: phashA, grayscale: grayscaleA, width: 64, height: 64, capturedAt: Date.now(),
    };

    const r1 = diffAgainstGolden(grayscaleA, phashA, 64, 64, golden, DEVICE, '/tmp/a.png');
    console.log(`[Demo 2] same-image diff: matchesGolden=${r1.matchesGolden}, pHashDistance=${r1.pHashDistance}, ssim=${r1.ssim.toFixed(4)}`);
    expect(r1.matchesGolden).toBe(true);
    expect(r1.pHashDistance).toBe(0);

    // Now create a candidate that differs. Flip enough bytes in the first 64 to
    // push pHash distance > 6 (the default threshold). A single bit flip
    // would still be classified as a fast-path match.
    const bufB = Buffer.from(bufA);
    for (let i = 0; i < 64; i += 4) bufB[i] ^= 0xff;
    const phashB = computePHashFromBuffer(bufB);
    const grayscaleB = mockGrayscale(bufB);

    // The mock grayscale uses the buffer cyclically, so SSIM stays high
    // even after the pHash crosses threshold. Tighten the SSIM match
    // threshold to 0.999 so a >0.001 deviation (which we just produced) is
    // classified as a non-match — mirroring the real pipeline's behavior
    // when pHash distance > threshold AND SSIM < match threshold.
    const tightCfg = { ...DEFAULT_DIFF_CONFIG, ssimMatchThreshold: 0.999 };

    const r2 = diffAgainstGolden(grayscaleB, phashB, 64, 64, golden, DEVICE, '/tmp/b.png', tightCfg);
    console.log(`[Demo 2] perturbed-image diff: matchesGolden=${r2.matchesGolden}, pHashDistance=${r2.pHashDistance}, ssim=${r2.ssim.toFixed(4)}`);
    expect(r2.pHashDistance).toBeGreaterThan(0);

    // groupDiffs must drop the matches and keep the mismatch.
    const grouped = groupDiffs([r1, r2]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].affectedSerials).toEqual([DEVICE]);
    console.log(`[Demo 2] grouped cluster: key=${diffClusterKey(r2)}, worstSSIM=${grouped[0].worstSSIM.toFixed(4)}`);
  }, 30_000);

  it('Step 3: crash aggregation — am_crash → structured record → cluster', async () => {
    // Read the recent crash events buffer, parse, cluster.
    const { stdout } = await adb(['logcat', '-d', '-b', 'events', '-t', '50']);
    const records: CrashRecord[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const r = parseLogcatCrashLine(line, DEVICE, ctx.physId);
      if (r) records.push(r);
    }
    console.log(`[Demo 3] parsed ${records.length} crash records from the events buffer`);
    if (records.length > 0) {
      console.log(`[Demo 3] sample: ${JSON.stringify(records[0])}`);
    }

    // Now trigger a fresh synthetic crash to prove the parser produces a
    // well-formed record. am crash on com.android.settings is harmless.
    await adb(['shell', 'am', 'crash', 'com.android.settings']).catch(() => { /* best-effort */ });
    await new Promise(r => setTimeout(r, 1500));

    const { stdout: freshStdout } = await adb(['logcat', '-d', '-b', 'events', '-t', '20']);
    let freshRecord: CrashRecord | null = null;
    for (const line of freshStdout.split(/\r?\n/)) {
      const r = parseLogcatCrashLine(line, DEVICE, ctx.physId);
      if (r && r.package === 'com.android.settings') { freshRecord = r; break; }
    }
    expect(freshRecord).not.toBeNull();
    expect(freshRecord!.package).toBe('com.android.settings');
    expect(freshRecord!.exception).toMatch(/Exception|Error/);
    expect(freshRecord!.source).toBe('logcat-am_crash');
    console.log(`[Demo 3] fresh synthetic crash record: ${JSON.stringify(freshRecord)}`);

    // Cluster the records: should contain the new entry.
    const all = [...records, freshRecord!];
    const clusters = clusterCrashes(all);
    console.log(`[Demo 3] ${clusters.length} clusters, top: package=${clusters[0]?.package}, exception=${clusters[0]?.exception}, affected=${clusters[0]?.affectedCount}`);
    expect(clusters.length).toBeGreaterThan(0);
    expect(clusters.some(c => c.package === 'com.android.settings')).toBe(true);
  }, 30_000);
});

// --- helpers for the diff demo (PNG buffer → 8x8 grayscale without nativeImage) ---

function computePHashFromBuffer(buf: Buffer): bigint {
  const gray = new Uint8Array(64);
  for (let i = 0; i < 64; i++) gray[i] = buf[i] || 0;
  return computePHash(gray);
}

function mockGrayscale(buf: Buffer): Uint8Array {
  const out = new Uint8Array(64 * 64);
  for (let i = 0; i < out.length; i++) out[i] = buf[i % buf.length] || 0;
  return out;
}