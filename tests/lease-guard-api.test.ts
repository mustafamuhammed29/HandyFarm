import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fc from 'fast-check';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { Readable } from 'stream';
import { DeviceStore, DeviceData } from '../electron/db.ts';
import { evaluateDeviceLeaseGuard } from '../electron/leaseGuard.ts';
import { startApiServer, ApiServerHandle } from '../electron/apiServer.ts';

describe('Area 5: API Lease Guard Enforcement & Endpoint Protection', () => {
  let tmpDir: string;
  let dbPath: string;
  let jsonPath: string;
  let store: DeviceStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handyfarm-guard-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    jsonPath = path.join(tmpDir, 'devices.json');
    store = new DeviceStore(dbPath, jsonPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  describe('Pure Guard Logic (evaluateDeviceLeaseGuard)', () => {
    const devId = '106293738O006649';
    const physId = 'phys_106293738O006649';

    beforeEach(() => {
      store.updateDevice(devId, {
        physicalDeviceId: physId,
        serial: '106293738O006649',
        status: 'device'
      });
    });

    it('Allows action when device is in available state', () => {
      store.setDeviceLeaseState(physId, 'available');
      const res = evaluateDeviceLeaseGuard(store, devId);
      expect(res.allowed).toBe(true);
      expect(res.error).toBeUndefined();

      const resWithSession = evaluateDeviceLeaseGuard(store, devId, 'random_caller');
      expect(resWithSession.allowed).toBe(true);
    });

    it('Allows action when caller holds the active lease', () => {
      store.acquireLease(physId, 'session_holder_1', 15);
      const res = evaluateDeviceLeaseGuard(store, devId, 'session_holder_1');
      expect(res.allowed).toBe(true);
      expect(res.error).toBeUndefined();
    });

    it('Blocks action when device is leased by a different session', () => {
      store.acquireLease(physId, 'session_holder_1', 15);

      const resWrong = evaluateDeviceLeaseGuard(store, devId, 'session_attacker');
      expect(resWrong.allowed).toBe(false);
      expect(resWrong.error).toContain("leased by session 'session_holder_1'");

      const resNoSession = evaluateDeviceLeaseGuard(store, devId);
      expect(resNoSession.allowed).toBe(false);
      expect(resNoSession.error).toContain("leased by session 'session_holder_1'");
    });

    it('Auto-releases and allows action when lease TTL has expired', () => {
      const t0 = 1000000;
      vi.setSystemTime(t0);
      store.acquireLease(physId, 'session_holder_1', 5); // 5 mins

      // Advance time past expiry
      vi.setSystemTime(t0 + 6 * 60 * 1000);

      let deltaBroadcasted = false;
      const res = evaluateDeviceLeaseGuard(store, devId, 'new_caller_session', (id, patch) => {
        if (id === devId && patch.leaseState === 'available') {
          deltaBroadcasted = true;
        }
      });

      expect(res.allowed).toBe(true);
      expect(deltaBroadcasted).toBe(true);
      expect(store.getLease(physId).state).toBe('available');
    });

    it('Blocks action unconditionally when device is in cooling_down state', () => {
      store.acquireLease(physId, 'session_holder_1', 10);
      store.releaseLease(physId, 'session_holder_1');

      // Even the original session cannot execute during cooldown
      const resSame = evaluateDeviceLeaseGuard(store, devId, 'session_holder_1');
      expect(resSame.allowed).toBe(false);
      expect(resSame.error).toContain('cooling down');

      const resOther = evaluateDeviceLeaseGuard(store, devId, 'other_session');
      expect(resOther.allowed).toBe(false);
      expect(resOther.error).toContain('cooling down');
    });

    it('Blocks action unconditionally when device is quarantined', () => {
      store.setDeviceLeaseState(physId, 'quarantined');
      const res = evaluateDeviceLeaseGuard(store, devId, 'any_session');
      expect(res.allowed).toBe(false);
      expect(res.error).toContain('quarantined');
    });

    it('Blocks action unconditionally when device is under maintenance', () => {
      store.setDeviceLeaseState(physId, 'maintenance');
      const res = evaluateDeviceLeaseGuard(store, devId, 'any_session');
      expect(res.allowed).toBe(false);
      expect(res.error).toContain('under maintenance');
    });

    it('Resolves physical device mapping from transport ID accurately', () => {
      const wifiTransportId = '172.20.10.2:5555';
      store.recordPhysicalMapping(physId, wifiTransportId, ['106293738O006649']);

      store.acquireLease(physId, 'session_alpha', 10);

      // Checking the Wi-Fi transport ID correctly looks up physId lease
      const resWrong = evaluateDeviceLeaseGuard(store, wifiTransportId, 'session_beta');
      expect(resWrong.allowed).toBe(false);
      expect(resWrong.error).toContain("leased by session 'session_alpha'");

      const resRight = evaluateDeviceLeaseGuard(store, wifiTransportId, 'session_alpha');
      expect(resRight.allowed).toBe(true);
    });
  });

  describe('REST API Server Lease Guard Enforcement', () => {
    let apiHandle: ApiServerHandle;
    const testDeviceId = 'dev_api_1';
    const testPhysId = 'phys_api_1';

    beforeEach(async () => {
      store.updateDevice(testDeviceId, {
        physicalDeviceId: testPhysId,
        serial: 'SER123',
        status: 'device'
      });

      apiHandle = await startApiServer({
        deviceStore: store,
        client: {
          getDevice: () => ({
            install: async () => {},
            shell: async () => Readable.from([Buffer.from('Linux test-host 5.10\n')])
          })
        },
        checkDeviceLeaseGuard: (deviceId, sessionId) => evaluateDeviceLeaseGuard(store, deviceId, sessionId),
        isSafeAdbCommand: (cmd) => cmd.startsWith('getprop') || cmd.startsWith('uname'),
        isExpertMode: () => true,
        redactLogcatText: (t) => t,
        broadcastDelta: () => {},
        userDataDir: tmpDir,
        port: 0 // Random ephemeral port
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

    it('Allows read endpoints (GET /devices) regardless of lease state', async () => {
      store.acquireLease(testPhysId, 'session_exclusive', 10);

      const res = await makeRequest('GET', '/devices');
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(Array.isArray(res.data.devices)).toBe(true);
    });

    it('Blocks POST /devices/:id/shell with HTTP 403 when held by another session', async () => {
      store.acquireLease(testPhysId, 'session_owner', 10);

      const resBlocked = await makeRequest('POST', `/devices/${testDeviceId}/shell`, {
        command: 'uname -a',
        sessionId: 'session_intruder'
      });

      expect(resBlocked.status).toBe(403);
      expect(resBlocked.data.success).toBe(false);
      expect(resBlocked.data.error).toContain("leased by session 'session_owner'");
    });

    it('Allows POST /devices/:id/shell when caller sessionId matches lease holder', async () => {
      store.acquireLease(testPhysId, 'session_owner', 10);

      const resAllowed = await makeRequest('POST', `/devices/${testDeviceId}/shell`, {
        command: 'uname -a',
        sessionId: 'session_owner'
      });

      expect(resAllowed.status).toBe(200);
      expect(resAllowed.data.success).toBe(true);
      expect(resAllowed.data.output).toContain('Linux');
    });

    it('Blocks POST /devices/:id/install with HTTP 403 when held by another session', async () => {
      store.acquireLease(testPhysId, 'session_owner', 10);

      // Create a dummy .apk file
      const fakeApk = path.join(tmpDir, 'sample.apk');
      fs.writeFileSync(fakeApk, 'fake-apk-content');

      const resBlocked = await makeRequest('POST', `/devices/${testDeviceId}/install`, {
        apkPath: fakeApk,
        sessionId: 'session_intruder'
      });

      expect(resBlocked.status).toBe(403);
      expect(resBlocked.data.success).toBe(false);
      expect(resBlocked.data.error).toContain("leased by session 'session_owner'");
    });
  });

  describe('Property-Based Lease Guard Invariants (fast-check)', () => {
    it('Property: Guard invariant strictly guarantees exclusive session access', () => {
      fc.assert(
        fc.property(
          fc.constantFrom<'available' | 'leased' | 'cooling_down' | 'quarantined' | 'maintenance'>(
            'available', 'leased', 'cooling_down', 'quarantined', 'maintenance'
          ),
          fc.constantFrom('session_A', 'session_B'),
          fc.constantFrom('session_A', 'session_B', undefined),
          (state, leaseHolder, callerSession) => {
            const devId = 'prop_dev_guard';
            const physId = 'phys_prop_dev_guard';
            store.updateDevice(devId, { physicalDeviceId: physId });

            const now = 1700000000000;
            vi.setSystemTime(now);

            // Reset state to available first
            store.setDeviceLeaseState(physId, 'available');

            // Configure state
            if (state === 'leased') {
              store.acquireLease(physId, leaseHolder, 15);
            } else if (state === 'cooling_down') {
              store.acquireLease(physId, leaseHolder, 15);
              store.releaseLease(physId, leaseHolder);
            } else {
              store.setDeviceLeaseState(physId, state);
            }

            const guardResult = evaluateDeviceLeaseGuard(store, devId, callerSession);

            if (state === 'cooling_down' || state === 'quarantined' || state === 'maintenance') {
              expect(guardResult.allowed).toBe(false);
              expect(guardResult.error).toBeDefined();
            } else if (state === 'available') {
              expect(guardResult.allowed).toBe(true);
            } else if (state === 'leased') {
              if (callerSession === leaseHolder) {
                expect(guardResult.allowed).toBe(true);
              } else {
                expect(guardResult.allowed).toBe(false);
                expect(guardResult.error).toBeDefined();
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
