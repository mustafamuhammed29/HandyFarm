import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  getAgentStatus,
  getInstalledApps,
  getGrantedPermissions,
  requireConfirmation,
} from '../electron/agent';

const execFileAsync = promisify(execFile);

const DEVICES = [
  '106293738O006649', // TECNO LH7n (API 34, USB)
  '0915f94a25610d04', // Samsung Galaxy S6 Edge (API 24, USB)
  '11160b2a51ec0a02', // Samsung Galaxy Note 5 (API 24, USB)
] as const;

const ENABLED = process.env.HANDYFARM_LIVE_TESTS === '1';

const adb = (deviceId: string) => (cmd: string[]) => execFileAsync('adb', ['-s', deviceId, ...cmd], { timeout: 8000 });

describe.skipIf(!ENABLED)('Phase 5 live — agent scaffolding on 3 devices', () => {
  beforeAll(() => {
    // No-op: rely on the per-test calls. We do not modify the device.
  }, 30_000);

  afterAll(() => {
    // No cleanup needed; all calls are read-only except pushTestImage which we
    // do not invoke here.
  });

  it('Step 1: getAgentStatus returns consistent data for the companion across all 3 devices', async () => {
    const results = await Promise.all(
      DEVICES.map(async (d) => ({ device: d, status: await getAgentStatus(d, 'com.handyfarm.clipper') })),
    );
    console.log('[Step 1] agent status per device:');
    for (const r of results) {
      console.log(`         ${r.device}: installed=${r.status.installed}, version=${r.status.versionName}, sig=[${r.status.signatureSha256.join(',')}]`);
    }
    for (const r of results) {
      expect(r.status.installed).toBe(true);
      expect(r.status.package).toBe('com.handyfarm.clipper');
      // Same signed APK across all three devices — the signature is the key
      // integrity check for "did the same build land everywhere".
      expect(r.status.signatureSha256).toContain('34471701');
      expect(r.status.versionCode).toBe(1);
    }
  }, 60_000);

  it('Step 2: getInstalledApps returns a non-empty list on every device and includes the companion', async () => {
    const results = await Promise.all(
      DEVICES.map(async (d) => ({ device: d, apps: await getInstalledApps(d) })),
    );
    for (const r of results) {
      console.log(`[Step 2] ${r.device}: ${r.apps.length} packages`);
      const has = r.apps.find((a) => a.package === 'com.handyfarm.clipper');
      expect(has).toBeDefined();
      // On Android 7, the package path is /data/app/<pkg>-<random>/base.apk (user)
      // On Android 14, similar layout but with longer random suffixes.
      if (has) {
        expect(['user', 'unknown']).toContain(has.classification);
      }
    }
  }, 60_000);

  it('Step 3: getGrantedPermissions parses consistently for the companion on each device', async () => {
    const results = await Promise.all(
      DEVICES.map(async (d) => ({ device: d, perms: await getGrantedPermissions(d, 'com.handyfarm.clipper') })),
    );
    for (const r of results) {
      console.log(`[Step 3] ${r.device}: ${r.perms.length} runtime permissions`);
      // INTERNET is granted by default on every Android version we target.
      const internet = r.perms.find((p) => p.permission === 'android.permission.INTERNET');
      expect(internet).toBeDefined();
      if (internet) {
        expect(internet.state).toBe('granted');
      }
    }
  }, 60_000);

  it('Step 4 (negative): getAgentStatus for a non-existent package returns installed=false', async () => {
    const statuses = await Promise.all(
      DEVICES.map((d) => getAgentStatus(d, 'com.nonexistent.package.deadbeef')),
    );
    for (const s of statuses) {
      expect(s.installed).toBe(false);
      expect(s.versionName).toBeNull();
      expect(s.versionCode).toBeNull();
    }
  }, 30_000);

  it('Step 5: every destructive op requires { confirm: true }', () => {
    expect(requireConfirmation(false, 'uninstall')).toEqual({
      ok: false,
      error: expect.stringContaining('uninstall') as any,
    });
    expect(requireConfirmation(true, 'uninstall')).toEqual({ ok: true });
  });
});