import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { DeviceStore } from '../electron/db.ts';
import {
  executeFullBaselineReset,
  type BaselineManifest,
  type BaselineVerificationResult
} from '../electron/baseline.ts';
import { startApiServer, type ApiServerHandle } from '../electron/apiServer.ts';
import { evaluateDeviceLeaseGuard } from '../electron/leaseGuard.ts';

describe('Phase 1: Baseline Persistence, Full Reset & REST API', () => {
  let tmpDir: string;
  let dbPath: string;
  let jsonPath: string;
  let store: DeviceStore;

  const sampleManifest: BaselineManifest = {
    deviceId: 'test_dev_01',
    physicalDeviceId: 'phys_test_dev_01',
    capturedAt: 1700000000000,
    immutable: {
      bootSerial: 'test_dev_01',
      model: 'TECNO LH7n',
      buildFingerprint: 'TECNO/LH7n/14:user/release-keys'
    },
    mutable: {
      installedPackages: [
        { packageName: 'com.handyfarm.clipper', versionName: '1.0' },
        { packageName: 'com.internal.qa.app', versionName: '1.0.0' }
      ],
      grantedPermissions: {
        'com.internal.qa.app': ['android.permission.INTERNET']
      },
      accounts: ['qa@internal.org (com.google)'],
      locale: 'en-US',
      timezone: 'Europe/Berlin',
      animationScales: { window: 0, transition: 0, animator: 0 }
    }
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handyfarm-baseline-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    jsonPath = path.join(tmpDir, 'devices.json');
    store = new DeviceStore(dbPath, jsonPath);
    store.updateDevice('test_dev_01', {
      physicalDeviceId: 'phys_test_dev_01',
      serial: 'test_dev_01',
      status: 'device'
    });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('DeviceStore Baseline Manifest Persistence', () => {
    it('Saves baseline manifest and marks device as verified', () => {
      store.saveBaseline(sampleManifest);

      const loaded = store.getBaseline('test_dev_01');
      expect(loaded).toBeDefined();
      expect(loaded?.physicalDeviceId).toBe('phys_test_dev_01');
      expect(loaded?.immutable.model).toBe('TECNO LH7n');
      expect(loaded?.mutable.installedPackages?.length).toBe(2);

      const dev = store.getDevice('test_dev_01');
      expect(dev?.baselineStatus).toBe('verified');
      expect(dev?.driftCount).toBe(0);
      expect(dev?.lastBaselineAt).toBe(1700000000000);
    });

    it('Persists baseline manifest in SQLite across store restarts', () => {
      store.saveBaseline(sampleManifest);
      store.flushWrites();
      store.close();

      const newStore = new DeviceStore(dbPath, jsonPath);
      const loaded = newStore.getBaseline('phys_test_dev_01');
      expect(loaded).toBeDefined();
      expect(loaded?.physicalDeviceId).toBe('phys_test_dev_01');
      expect(loaded?.capturedAt).toBe(1700000000000);

      const dev = newStore.getDevice('test_dev_01');
      expect(dev?.baselineStatus).toBe('verified');
      newStore.close();
    });

    it('Records drift verification and updates device status', () => {
      store.saveBaseline(sampleManifest);

      const verificationResult: BaselineVerificationResult = {
        verified: false,
        deviceId: 'test_dev_01',
        physicalDeviceId: 'phys_test_dev_01',
        capturedAt: 1700000000000,
        verifiedAt: 1700000500000,
        diffs: [
          {
            field: 'mutable.installedPackages.com.bad.app',
            expected: null,
            actual: '1.0',
            drift_class: 'app',
            description: 'Unapproved package com.bad.app installed'
          }
        ]
      };

      store.recordDriftVerification('test_dev_01', verificationResult);
      const dev = store.getDevice('test_dev_01');
      expect(dev?.baselineStatus).toBe('drifted');
      expect(dev?.driftCount).toBe(1);
      expect(dev?.driftWarnings?.[0]).toContain('Unapproved package com.bad.app installed');
      expect(dev?.lastVerifiedAt).toBe(1700000500000);
    });

    it('Deletes baseline manifest', () => {
      store.saveBaseline(sampleManifest);
      expect(store.getBaseline('phys_test_dev_01')).toBeDefined();

      const ok = store.deleteBaseline('phys_test_dev_01');
      expect(ok).toBe(true);
      expect(store.getBaseline('phys_test_dev_01')).toBeUndefined();
    });
  });

  describe('Full Baseline Reset Execution (§1.2 & §1.4)', () => {
    it('Executes full baseline reset: pm clear on apps, uninstall unapproved, exempts companion app', async () => {
      const executedCommands: string[][] = [];
      const mockExecAdb = async (args: string[]) => {
        executedCommands.push(args);

        // When listing 3rd party packages, simulate 3 apps: companion, baseline app, and an unauthorized app
        if (args.includes('pm') && args.includes('packages')) {
          return {
            stdout: 'package:com.handyfarm.clipper\npackage:com.internal.qa.app\npackage:com.unauthorized.tool\n',
            stderr: ''
          };
        }

        // When dumping dumpsys package for permission check
        if (args.includes('dumpsys') && args.includes('package')) {
          return {
            stdout: 'runtime permissions:\n  android.permission.CAMERA: granted=true\n  android.permission.INTERNET: granted=true\n',
            stderr: ''
          };
        }

        return { stdout: 'OK\n', stderr: '' };
      };

      let companionResetCalled = false;
      const mockBroadcastReset = async () => {
        companionResetCalled = true;
      };

      const resetRes = await executeFullBaselineReset(
        'test_dev_01',
        sampleManifest,
        mockExecAdb,
        mockBroadcastReset
      );

      expect(resetRes.success).toBe(true);
      expect(companionResetCalled).toBe(true);

      // Verify actions
      expect(resetRes.actions.some(a => a.includes('companion_resets_executed'))).toBe(true);
      expect(resetRes.actions.some(a => a.includes('pm_cleared_package: com.internal.qa.app'))).toBe(true);
      expect(resetRes.actions.some(a => a.includes('uninstalled_unapproved_package: com.unauthorized.tool'))).toBe(true);
      expect(resetRes.actions.some(a => a.includes('revoked_permission: com.internal.qa.app -> android.permission.CAMERA'))).toBe(true);

      // CRITICAL SECURITY ASSERTION: Companion app com.handyfarm.clipper must NEVER be cleared or uninstalled
      const companionCleared = executedCommands.some(cmd =>
        cmd.includes('pm') && (cmd.includes('clear') || cmd.includes('uninstall')) && cmd.includes('com.handyfarm.clipper')
      );
      expect(companionCleared).toBe(false);

      // Check system settings restored
      expect(executedCommands.some(cmd => cmd.some(arg => arg.includes('window_animation_scale')))).toBe(true);
      expect(executedCommands.some(cmd => cmd.some(arg => arg.includes('low_power')))).toBe(true);
      expect(executedCommands.some(cmd => cmd.some(arg => arg.includes('CLOSE_SYSTEM_DIALOGS')))).toBe(true);
    });
  });

  describe('REST API Baseline Endpoints', () => {
    let apiHandle: ApiServerHandle;

    beforeEach(async () => {
      apiHandle = await startApiServer({
        deviceStore: store,
        client: {
          getDevice: () => ({
            install: async () => {},
            shell: async () => ({})
          })
        },
        checkDeviceLeaseGuard: (deviceId, sessionId) => evaluateDeviceLeaseGuard(store, deviceId, sessionId),
        isSafeAdbCommand: () => true,
        isExpertMode: () => true,
        redactLogcatText: (t) => t,
        broadcastDelta: () => {},
        userDataDir: tmpDir,
        port: 0,
        captureBaseline: async (devId) => {
          store.saveBaseline(sampleManifest);
          return { success: true, manifest: sampleManifest };
        },
        verifyBaseline: async (devId) => {
          return {
            success: true,
            verified: true,
            deviceId: devId,
            physicalDeviceId: 'phys_test_dev_01',
            capturedAt: 1700000000000,
            verifiedAt: Date.now(),
            diffs: []
          };
        },
        resetToBaseline: async (devId, sessionId) => {
          return {
            success: true,
            actions: ['companion_resets_executed', 'pm_cleared_package: com.internal.qa.app']
          };
        }
      });
    });

    afterEach(async () => {
      await apiHandle.close();
    });

    function makeRequest(
      method: string,
      pathname: string,
      body?: any,
      token = apiHandle.token
    ): Promise<{ status: number; data: any }> {
      return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : undefined;
        const req = http.request({
          hostname: apiHandle.host,
          port: apiHandle.port,
          path: pathname,
          method,
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
          }
        }, (res) => {
          let resData = '';
          res.on('data', chunk => resData += chunk);
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode || 500, data: JSON.parse(resData) });
            } catch {
              resolve({ status: res.statusCode || 500, data: resData });
            }
          });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
      });
    }

    it('POST /devices/:id/baseline/capture saves and returns manifest', async () => {
      const res = await makeRequest('POST', '/devices/test_dev_01/baseline/capture');
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.manifest?.physicalDeviceId).toBe('phys_test_dev_01');
    });

    it('GET /devices/:id/baseline/verify returns structured verification status', async () => {
      const res = await makeRequest('GET', '/devices/test_dev_01/baseline/verify');
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.verified).toBe(true);
      expect(Array.isArray(res.data.diffs)).toBe(true);
    });

    it('POST /devices/:id/baseline/reset is blocked with HTTP 403 when leased by another session', async () => {
      // Lease the physical device to session_owner
      store.acquireLease('phys_test_dev_01', 'session_owner', 15);

      const resBlocked = await makeRequest('POST', '/devices/test_dev_01/baseline/reset', {
        sessionId: 'session_intruder'
      });

      expect(resBlocked.status).toBe(403);
      expect(resBlocked.data.success).toBe(false);
      expect(resBlocked.data.error).toContain("leased by session 'session_owner'");
    });

    it('POST /devices/:id/baseline/reset succeeds when caller matches lease holder', async () => {
      store.acquireLease('phys_test_dev_01', 'session_owner', 15);

      const resAllowed = await makeRequest('POST', '/devices/test_dev_01/baseline/reset', {
        sessionId: 'session_owner'
      });

      expect(resAllowed.status).toBe(200);
      expect(resAllowed.data.success).toBe(true);
      expect(resAllowed.data.actions).toContain('companion_resets_executed');
    });

    it('GET /devices/:id/baseline returns stored manifest', async () => {
      store.saveBaseline(sampleManifest);
      const res = await makeRequest('GET', '/devices/test_dev_01/baseline');

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.manifest?.physicalDeviceId).toBe('phys_test_dev_01');
    });
  });
});
