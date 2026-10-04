import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import adbkit from '@devicefarmer/adbkit';
import type { DeviceStore, DeviceData } from './db.js';
import { evaluateDataBudget } from './network.js';

const Adb = (adbkit as any).Adb || (adbkit as any).default?.Adb || (adbkit as any).default || adbkit;

export interface ApiServerOptions {
  deviceStore: DeviceStore;
  client: any;
  checkDeviceLeaseGuard: (deviceId: string, sessionId?: string) => { allowed: boolean; error?: string };
  isSafeAdbCommand: (cmd: string) => boolean;
  isExpertMode: () => boolean;
  redactLogcatText: (text: string) => string;
  broadcastDelta: (deviceId: string, patch: Partial<DeviceData>, removed?: boolean) => void;
  userDataDir: string;
  port?: number;
  host?: string; // Strictly 127.0.0.1
  captureBaseline?: (deviceId: string) => Promise<{ success: boolean; manifest?: any; error?: string }>;
  verifyBaseline?: (deviceId: string) => Promise<{ success: boolean; result?: any; error?: string }>;
  resetToBaseline?: (deviceId: string, sessionId?: string) => Promise<{ success: boolean; actions?: string[]; verification?: any; error?: string }>;
  runNetworkPreflight?: (deviceId: string, options?: { expectedCarrier?: string; runId?: string; requiredBytes?: number }) => Promise<any>;
  /** Force an immediate HealthMonitor tick (Phase 4). Returns {evaluated, transitions}. */
  tickHealthMonitor?: () => Promise<{ evaluated: number; transitions: number }>;
}

export interface ApiServerHandle {
  server: http.Server;
  port: number;
  host: string;
  token: string;
  authFilePath: string;
  close: () => Promise<void>;
}

export interface AuthFileData {
  token: string;
  port: number;
  host: string;
  createdAt: number;
}

/**
 * Timing-safe comparison to prevent timing side-channel attacks on tokens.
 */
function verifyAuthToken(expected: string, received?: string): boolean {
  if (!received) return false;
  const expectedBuf = Buffer.from(expected, 'utf8');
  const receivedBuf = Buffer.from(received, 'utf8');
  if (expectedBuf.length !== receivedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

/**
 * Helper to parse JSON request bodies up to 10MB.
 */
function parseJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err: any) {
        reject(new Error(`Invalid JSON body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Helper to send JSON response.
 */
function sendJson(res: http.ServerResponse, statusCode: number, data: any) {
  const payload = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

/**
 * Start loopback REST API server bound strictly to 127.0.0.1 with local token authentication.
 */
export async function startApiServer(options: ApiServerOptions): Promise<ApiServerHandle> {
  const {
    deviceStore,
    client,
    checkDeviceLeaseGuard,
    isSafeAdbCommand,
    isExpertMode,
    redactLogcatText,
    broadcastDelta,
    userDataDir
  } = options;

  const targetHost = '127.0.0.1'; // Strictly loopback, never 0.0.0.0
  const defaultPort = options.port !== undefined ? options.port : (Number(process.env.HANDYFARM_API_PORT) || 5055);

  // 1. Resolve auth file path
  const authFilePath = process.env.HANDYFARM_AUTH_FILE || path.join(userDataDir, 'api-auth.json');
  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  // 2. Load or generate authentication token
  let token: string;
  let savedPort = defaultPort;

  if (fs.existsSync(authFilePath)) {
    try {
      const raw = fs.readFileSync(authFilePath, 'utf8');
      const parsed: AuthFileData = JSON.parse(raw);
      if (parsed.token && typeof parsed.token === 'string' && parsed.token.length >= 32) {
        token = parsed.token;
        if (options.port === undefined && parsed.port && Number.isInteger(parsed.port)) {
          savedPort = parsed.port;
        }
      } else {
        token = crypto.randomBytes(32).toString('hex');
      }
    } catch {
      token = crypto.randomBytes(32).toString('hex');
    }
  } else {
    token = crypto.randomBytes(32).toString('hex');
  }

  // Write/persist auth file with 0o600 permissions
  const writeAuthFile = (actualPort: number) => {
    const authData: AuthFileData = {
      token,
      port: actualPort,
      host: targetHost,
      createdAt: Date.now()
    };
    try {
      fs.writeFileSync(authFilePath, JSON.stringify(authData, null, 2), { mode: 0o600 });
      console.log(`[API Server] Auth token and config saved to: ${authFilePath} (port ${actualPort})`);
    } catch (err) {
      console.warn(`[API Server] Could not set 0o600 mode on ${authFilePath}:`, err);
    }
  };

  // Helper to resolve physical ID from param
  const resolvePhysicalId = (idOrPhys: string): string => {
    const dev = deviceStore.getDevice(idOrPhys);
    if (dev?.physicalDeviceId) return dev.physicalDeviceId;
    const mapping = deviceStore.getPhysicalMapping(idOrPhys);
    if (mapping?.physicalDeviceId) return mapping.physicalDeviceId;
    return idOrPhys;
  };

  // Helper to resolve transport ID from param
  const resolveTransportId = (idOrPhys: string): string => {
    const dev = deviceStore.getDevice(idOrPhys);
    if (dev) return dev.id;
    const mapping = deviceStore.getPhysicalMapping(idOrPhys);
    if (mapping?.currentTransportId) return mapping.currentTransportId;
    return idOrPhys;
  };

  // 3. Create HTTP Server
  const server = http.createServer(async (req, res) => {
    // Defense-in-depth: Reject non-loopback sockets
    const remote = req.socket.remoteAddress;
    if (remote !== '127.0.0.1' && remote !== '::ffff:127.0.0.1' && remote !== '::1') {
      console.warn(`[API Server] Blocked non-loopback connection attempt from: ${remote}`);
      sendJson(res, 403, { success: false, error: 'Forbidden: loopback connections only' });
      req.socket.destroy();
      return;
    }

    // CORS for local web tooling if needed
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, X-API-Token, Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || '/', `http://${targetHost}`);
    const pathname = parsedUrl.pathname;
    const method = (req.method || 'GET').toUpperCase();

    // Loopback authentication check
    const authHeader = req.headers['authorization'];
    const tokenHeader = req.headers['x-api-token'];
    let receivedToken: string | undefined;

    if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      receivedToken = authHeader.slice(7).trim();
    } else if (typeof tokenHeader === 'string') {
      receivedToken = tokenHeader.trim();
    }

    if (!verifyAuthToken(token, receivedToken)) {
      return sendJson(res, 401, {
        success: false,
        error: 'Unauthorized: invalid or missing auth token. Please provide Authorization: Bearer <token> or X-API-Token header.'
      });
    }

    try {
      // --- ENDPOINTS ---

      // 1. GET /status (Health check)
      if ((pathname === '/' || pathname === '/status') && method === 'GET') {
        return sendJson(res, 200, {
          success: true,
          app: 'HandyFarm Loopback REST API',
          version: 'Phase 7',
          loopbackOnly: true
        });
      }

      // 2. GET /devices (List all devices with status, lease state, physical ID)
      if ((pathname === '/devices' || pathname === '/devices/') && method === 'GET') {
        const rawDevices = deviceStore.getAllDevices(false);
        const devices = rawDevices.map(dev => {
          const physId = dev.physicalDeviceId || `phys_${dev.serial || dev.id}`;
          const lease = deviceStore.getLease(physId);
          return {
            id: dev.id,
            physicalDeviceId: physId,
            serial: dev.serial,
            status: dev.status,
            model: dev.model,
            manufacturer: dev.manufacturer,
            name: dev.name,
            customName: dev.customName,
            isBareBoard: dev.isBareBoard,
            leaseState: lease.state || dev.leaseState || 'available',
            leasedBy: lease.leasedBy || dev.leasedBy,
            leaseExpiresAt: lease.leaseExpiresAt || dev.leaseExpiresAt,
            lastHeartbeatAt: lease.lastHeartbeatAt || dev.lastHeartbeatAt,
            tags: dev.tags || [],
            battery: dev.battery,
            connectedAt: dev.connectedAt,
            lastKnownIp: dev.lastKnownIp
          };
        });

        return sendJson(res, 200, {
          success: true,
          count: devices.length,
          devices
        });
      }

      // 3. POST /devices/:physicalDeviceId/lease (Acquire lease)
      const leaseMatch = pathname.match(/^\/devices\/([^/]+)\/lease\/?$/);
      if (leaseMatch && method === 'POST') {
        const rawId = decodeURIComponent(leaseMatch[1]);
        const physId = resolvePhysicalId(rawId);
        const body = await parseJsonBody(req);

        if (!body.sessionId || typeof body.sessionId !== 'string' || !body.sessionId.trim()) {
          return sendJson(res, 400, { success: false, error: 'sessionId is required in request body' });
        }

        const ttlMinutes = typeof body.ttlMinutes === 'number' && body.ttlMinutes > 0 ? body.ttlMinutes : 15;
        const result = deviceStore.acquireLease(physId, body.sessionId.trim(), ttlMinutes);

        if (!result.success) {
          return sendJson(res, 409, { success: false, error: result.error });
        }

        // Live GUI update: broadcast delta
        if (result.lease) {
          for (const devId of result.affectedDeviceIds) {
            const dev = deviceStore.getDevice(devId);
            if (dev) {
              broadcastDelta(devId, {
                leaseState: result.lease.state,
                leasedBy: result.lease.leasedBy,
                leaseExpiresAt: result.lease.leaseExpiresAt,
                lastHeartbeatAt: result.lease.lastHeartbeatAt
              });
            }
          }
        }

        return sendJson(res, 200, {
          success: true,
          lease: result.lease,
          affectedDeviceIds: result.affectedDeviceIds
        });
      }

      // 4. DELETE /devices/:physicalDeviceId/lease (Release lease)
      if (leaseMatch && method === 'DELETE') {
        const rawId = decodeURIComponent(leaseMatch[1]);
        const physId = resolvePhysicalId(rawId);
        const body = await parseJsonBody(req).catch(() => ({}));
        const querySession = parsedUrl.searchParams.get('sessionId');
        const queryForce = parsedUrl.searchParams.get('force') === 'true';

        const sessionId = body.sessionId || querySession || undefined;
        const force = body.force === true || queryForce;

        const result = deviceStore.releaseLease(physId, sessionId, force);
        if (!result.success) {
          return sendJson(res, 409, { success: false, error: result.error });
        }

        const lease = deviceStore.getLease(physId);
        for (const devId of result.affectedDeviceIds) {
          broadcastDelta(devId, {
            leaseState: lease.state,
            leasedBy: lease.leasedBy ?? (null as any),
            leaseExpiresAt: lease.leaseExpiresAt ?? (null as any),
            lastHeartbeatAt: lease.lastHeartbeatAt ?? (null as any)
          });
        }

        return sendJson(res, 200, {
          success: true,
          message: 'Lease released; device entered cooling down period',
          leaseState: lease.state,
          leaseExpiresAt: lease.leaseExpiresAt
        });
      }

      // 5. POST /devices/:physicalDeviceId/heartbeat (Renew lease)
      const heartbeatMatch = pathname.match(/^\/devices\/([^/]+)\/heartbeat\/?$/);
      if (heartbeatMatch && method === 'POST') {
        const rawId = decodeURIComponent(heartbeatMatch[1]);
        const physId = resolvePhysicalId(rawId);
        const body = await parseJsonBody(req);

        if (!body.sessionId || typeof body.sessionId !== 'string') {
          return sendJson(res, 400, { success: false, error: 'sessionId is required in request body' });
        }

        const extensionMinutes = typeof body.extensionMinutes === 'number' && body.extensionMinutes > 0
          ? body.extensionMinutes
          : undefined;

        const result = deviceStore.heartbeatLease(physId, body.sessionId, extensionMinutes);
        if (!result.success) {
          return sendJson(res, 409, { success: false, error: result.error });
        }

        const lease = deviceStore.getLease(physId);
        for (const devId of result.affectedDeviceIds) {
          broadcastDelta(devId, {
            leaseState: lease.state,
            leasedBy: lease.leasedBy ?? (null as any),
            leaseExpiresAt: lease.leaseExpiresAt ?? (null as any),
            lastHeartbeatAt: lease.lastHeartbeatAt ?? (null as any)
          });
        }

        return sendJson(res, 200, {
          success: true,
          leaseExpiresAt: result.leaseExpiresAt
        });
      }

      // 6. POST /devices/:id/install (Install APK respecting lease guard)
      const installMatch = pathname.match(/^\/devices\/([^/]+)\/install\/?$/);
      if (installMatch && method === 'POST') {
        const rawId = decodeURIComponent(installMatch[1]);
        const body = await parseJsonBody(req);

        // Enforce lease guard
        const leaseGuard = checkDeviceLeaseGuard(rawId, body.sessionId);
        if (!leaseGuard.allowed) {
          return sendJson(res, 403, { success: false, error: leaseGuard.error });
        }

        // Validate APK path
        const apkPath = body.apkPath;
        if (!apkPath || typeof apkPath !== 'string' || !apkPath.toLowerCase().endsWith('.apk') || !fs.existsSync(apkPath)) {
          return sendJson(res, 400, { success: false, error: 'Invalid or non-existent APK file path' });
        }

        const transportId = resolveTransportId(rawId);
        const currentDev = deviceStore.getDevice(transportId);
        if (!currentDev || currentDev.status !== 'device') {
          return sendJson(res, 404, { success: false, error: `Device '${rawId}' is not connected or offline` });
        }

        try {
          await client.getDevice(transportId).install(apkPath);
          deviceStore.logDeviceAction(transportId, `Installed APK via REST API: ${apkPath}`);
          return sendJson(res, 200, {
            success: true,
            message: `Successfully installed ${apkPath} on device ${transportId}`
          });
        } catch (err: any) {
          return sendJson(res, 500, { success: false, error: err.message || String(err) });
        }
      }

      // 7. POST /devices/:id/shell (Run allowlisted command respecting lease guard and expert mode)
      const shellMatch = pathname.match(/^\/devices\/([^/]+)\/shell\/?$/);
      if (shellMatch && method === 'POST') {
        const rawId = decodeURIComponent(shellMatch[1]);
        const body = await parseJsonBody(req);

        // Enforce lease guard
        const leaseGuard = checkDeviceLeaseGuard(rawId, body.sessionId);
        if (!leaseGuard.allowed) {
          return sendJson(res, 403, { success: false, error: leaseGuard.error });
        }

        const trimmed = (body.command || '').trim();
        if (!trimmed) {
          return sendJson(res, 400, { success: false, error: 'Command cannot be empty' });
        }

        // Enforce Phase 6 expert mode & safe diagnostic allowlist
        if (!isExpertMode() && !isSafeAdbCommand(trimmed)) {
          return sendJson(res, 403, {
            success: false,
            error: 'Command blocked: Expert Mode is disabled. Only allowlisted diagnostic commands (getprop, dumpsys, pm list, ip, etc.) are allowed.'
          });
        }

        const transportId = resolveTransportId(rawId);
        const currentDev = deviceStore.getDevice(transportId);
        if (!currentDev || currentDev.status !== 'device') {
          return sendJson(res, 404, { success: false, error: `Device '${rawId}' is not connected or offline` });
        }

        try {
          const stream = await client.getDevice(transportId).shell(trimmed);
          const output = await Adb.util.readAll(stream);
          const rawOutput = output.toString();
          const finalOutput = (trimmed.startsWith('logcat') || trimmed.includes('logcat'))
            ? redactLogcatText(rawOutput)
            : rawOutput;

          deviceStore.logDeviceAction(transportId, `Ran shell command via REST API: ${trimmed}`);
          return sendJson(res, 200, { success: true, output: finalOutput });
        } catch (err: any) {
          return sendJson(res, 500, { success: false, error: err.message || String(err) });
        }
      }

      // --- Phase 1 Baseline Endpoints ---

      // 8. POST /devices/:id/baseline/capture (Capture baseline manifest at known-good moment)
      const baselineCaptureMatch = pathname.match(/^\/devices\/([^/]+)\/baseline\/capture\/?$/);
      if (baselineCaptureMatch && method === 'POST') {
        const rawId = decodeURIComponent(baselineCaptureMatch[1]);
        if (!options.captureBaseline) {
          return sendJson(res, 501, { success: false, error: 'Baseline capture is not configured on this server' });
        }
        const result = await options.captureBaseline(rawId);
        return sendJson(res, result.success ? 200 : 500, result);
      }

      // 9. GET /devices/:id/baseline/verify (Verify current state against stored baseline)
      const baselineVerifyMatch = pathname.match(/^\/devices\/([^/]+)\/baseline\/verify\/?$/);
      if (baselineVerifyMatch && method === 'GET') {
        const rawId = decodeURIComponent(baselineVerifyMatch[1]);
        if (!options.verifyBaseline) {
          return sendJson(res, 501, { success: false, error: 'Baseline verification is not configured on this server' });
        }
        const result = await options.verifyBaseline(rawId);
        return sendJson(res, result.success ? 200 : 404, result);
      }

      // 10. POST /devices/:id/baseline/reset (Execute full baseline reset respecting lease guard)
      const baselineResetMatch = pathname.match(/^\/devices\/([^/]+)\/baseline\/reset\/?$/);
      if (baselineResetMatch && method === 'POST') {
        const rawId = decodeURIComponent(baselineResetMatch[1]);
        const body = await parseJsonBody(req);

        // Enforce lease guard
        const leaseGuard = checkDeviceLeaseGuard(rawId, body.sessionId);
        if (!leaseGuard.allowed) {
          return sendJson(res, 403, { success: false, error: leaseGuard.error });
        }

        if (!options.resetToBaseline) {
          return sendJson(res, 501, { success: false, error: 'Baseline reset is not configured on this server' });
        }

        const result = await options.resetToBaseline(rawId, body.sessionId);
        return sendJson(res, result.success ? 200 : 500, result);
      }

      // 11. GET /devices/:id/baseline (Fetch stored baseline manifest)
      const baselineGetMatch = pathname.match(/^\/devices\/([^/]+)\/baseline\/?$/);
      if (baselineGetMatch && method === 'GET') {
        const rawId = decodeURIComponent(baselineGetMatch[1]);
        const manifest = deviceStore.getBaseline(rawId);
        if (!manifest) {
          return sendJson(res, 404, { success: false, error: `No baseline found for device '${rawId}'` });
        }
        return sendJson(res, 200, { success: true, manifest });
      }

      // 12. GET /devices/:id/artifacts (Placeholder for future screenshot/log retrieval)
      const artifactsMatch = pathname.match(/^\/devices\/([^/]+)\/artifacts\/?$/);
      if (artifactsMatch && method === 'GET') {
        const rawId = decodeURIComponent(artifactsMatch[1]);
        const transportId = resolveTransportId(rawId);
        const physId = resolvePhysicalId(rawId);
        const dev = deviceStore.getDevice(transportId);

        return sendJson(res, 200, {
          success: true,
          deviceId: transportId,
          physicalDeviceId: physId,
          artifacts: {
            screenshots: [],
            logs: [],
            historyCount: dev?.history?.length || 0,
            message: 'Artifacts retrieval endpoint placeholder (Phase 7)'
          }
        });
      }

      // --- Phase 2: Network & SIM Inventory Endpoints ---

      // 13. GET /devices/:id/sim (Get assigned SIM for device)
      const deviceSimMatch = pathname.match(/^\/devices\/([^/]+)\/sim\/?$/);
      if (deviceSimMatch && method === 'GET') {
        const rawId = decodeURIComponent(deviceSimMatch[1]);
        const sim = deviceStore.getSimForDevice(rawId);
        if (!sim) {
          return sendJson(res, 404, { success: false, error: `No SIM card assigned to device '${rawId}'` });
        }
        return sendJson(res, 200, { success: true, sim, budget: evaluateDataBudget(sim) });
      }

      // 14. POST /devices/:id/sim/assign (Assign a SIM to device)
      const deviceSimAssignMatch = pathname.match(/^\/devices\/([^/]+)\/sim\/assign\/?$/);
      if (deviceSimAssignMatch && method === 'POST') {
        const rawId = decodeURIComponent(deviceSimAssignMatch[1]);
        const body = await parseJsonBody(req);
        if (!body.simId) {
          return sendJson(res, 400, { success: false, error: 'Missing required field: simId' });
        }

        try {
          const sim = deviceStore.assignSim(body.simId, rawId, body.slot);
          return sendJson(res, 200, { success: true, deviceId: rawId, sim });
        } catch (err: any) {
          return sendJson(res, 400, { success: false, error: err?.message || 'Failed to assign SIM' });
        }
      }

      // 15. POST /devices/:id/sim/unassign (Unassign SIM from device)
      const deviceSimUnassignMatch = pathname.match(/^\/devices\/([^/]+)\/sim\/unassign\/?$/);
      if (deviceSimUnassignMatch && method === 'POST') {
        const rawId = decodeURIComponent(deviceSimUnassignMatch[1]);
        deviceStore.unassignSim(rawId);
        return sendJson(res, 200, { success: true, deviceId: rawId, message: 'SIM unassigned' });
      }

      // 16. GET /devices/:id/egress/history (Get observed egress history records)
      const egressHistoryMatch = pathname.match(/^\/devices\/([^/]+)\/egress\/history\/?$/);
      if (egressHistoryMatch && method === 'GET') {
        const rawId = decodeURIComponent(egressHistoryMatch[1]);
        const limitParam = parsedUrl.searchParams.get('limit');
        const limit = limitParam ? Number(limitParam) : 50;
        const egressHistory = deviceStore.getEgressHistory(rawId, limit);
        return sendJson(res, 200, { success: true, deviceId: rawId, egressHistory, count: egressHistory.length });
      }

      // 17. POST /devices/:id/preflight/network (Run network preflight assertions)
      const preflightMatch = pathname.match(/^\/devices\/([^/]+)\/preflight\/network\/?$/);
      if (preflightMatch && method === 'POST') {
        const rawId = decodeURIComponent(preflightMatch[1]);
        const body = await parseJsonBody(req);

        if (!options.runNetworkPreflight) {
          return sendJson(res, 501, { success: false, error: 'Network preflight is not configured on this server' });
        }

        const result = await options.runNetworkPreflight(rawId, body);
        return sendJson(res, result.passed ? 200 : 412, result);
      }

      // 18. GET /sims (List all SIM cards + fleet data budget)
      if (pathname === '/sims' && method === 'GET') {
        const sims = deviceStore.getAllSims();
        const fleetBudget = deviceStore.getFleetDataBudget();
        return sendJson(res, 200, { success: true, sims, fleetBudget });
      }

      // 19. POST /sims (Create or update SIM record in inventory)
      if (pathname === '/sims' && method === 'POST') {
        const body = await parseJsonBody(req);
        if (!body.iccid || !body.carrier || !body.apn || !body.plan || !body.dataCapBytes || !body.renewalDate) {
          return sendJson(res, 400, {
            success: false,
            error: 'Missing required SIM fields: iccid, carrier, apn, plan, dataCapBytes, renewalDate'
          });
        }

        try {
          const sim = deviceStore.saveSim(body);
          return sendJson(res, 200, { success: true, sim });
        } catch (err: any) {
          return sendJson(res, 400, { success: false, error: err?.message || 'Failed to save SIM' });
        }
      }

      // 20. GET /sims/:id (Get single SIM record by ID)
      const simGetMatch = pathname.match(/^\/sims\/([^/]+)\/?$/);
      if (simGetMatch && method === 'GET') {
        const simId = decodeURIComponent(simGetMatch[1]);
        const sim = deviceStore.getSim(simId);
        if (!sim) {
          return sendJson(res, 404, { success: false, error: `SIM '${simId}' not found in inventory` });
        }
        return sendJson(res, 200, { success: true, sim, budget: evaluateDataBudget(sim) });
      }

      // 21. POST /sims/:id/consume (Record data usage with 80% warning and 100% hard circuit breaker)
      const simConsumeMatch = pathname.match(/^\/sims\/([^/]+)\/consume\/?$/);
      if (simConsumeMatch && method === 'POST') {
        const simId = decodeURIComponent(simConsumeMatch[1]);
        const body = await parseJsonBody(req);
        const bytesUsed = Number(body.bytesUsed);
        if (!bytesUsed || isNaN(bytesUsed) || bytesUsed <= 0) {
          return sendJson(res, 400, { success: false, error: 'bytesUsed must be a positive number' });
        }

        try {
          const sim = deviceStore.recordSimDataConsumption(simId, bytesUsed);
          const budget = evaluateDataBudget(sim);
          return sendJson(res, 200, { success: true, sim, budget });
        } catch (err: any) {
          return sendJson(res, 400, { success: false, error: err?.message || 'Failed to record consumption' });
        }
      }

      // ----- Phase 4: fleet health + safety endpoints -----

      // 22. GET /fleet/health — fleet-level health summary.
      if (pathname === '/fleet/health' && method === 'GET') {
        const fleet = deviceStore.getAllPhysicalDeviceHealth();
        const summary = {
          total: fleet.length,
          quarantined: 0,
          degraded: 0,
          healthy: 0,
          unknown: 0,
          avgScore: 0,
          minScore: 100,
        };
        let scoreSum = 0;
        for (const pd of fleet) {
          const lease = deviceStore.getLease(pd.physicalDeviceId);
          if (lease.state === 'quarantined') summary.quarantined++;
          else if (pd.healthScore <= 40) summary.degraded++;
          else if (pd.healthScore >= 60) summary.healthy++;
          else summary.degraded++;
          if (pd.healthScore === 100 && pd.propsAttempts === 0 && pd.reconnectCount === 0) summary.unknown++;
          scoreSum += pd.healthScore;
          if (pd.healthScore < summary.minScore) summary.minScore = pd.healthScore;
        }
        summary.avgScore = fleet.length > 0 ? Math.round(scoreSum / fleet.length) : 0;
        if (fleet.length === 0) summary.minScore = 0;
        return sendJson(res, 200, { success: true, summary, devices: fleet.map(pd => ({
          physicalDeviceId: pd.physicalDeviceId,
          healthScore: pd.healthScore,
          reasons: JSON.parse(pd.healthReasonsJson || '[]'),
          lastEvaluatedAt: pd.healthLastEvaluatedAt,
          leaseState: deviceStore.getLease(pd.physicalDeviceId).state,
        })) });
      }

      // 23. GET /devices/:id/health — health snapshot for one device.
      const deviceHealthMatch = pathname.match(/^\/devices\/([^/]+)\/health\/?$/);
      if (deviceHealthMatch && method === 'GET') {
        const rawId = decodeURIComponent(deviceHealthMatch[1]);
        let physId = rawId;
        const dev = deviceStore.getDevice(rawId);
        if (dev?.physicalDeviceId) physId = dev.physicalDeviceId;
        const mapping = deviceStore.getPhysicalMapping(rawId);
        if (!dev && mapping?.physicalDeviceId) physId = mapping.physicalDeviceId;

        const health = deviceStore.getPhysicalDeviceHealth(physId);
        const lease = deviceStore.getLease(physId);
        const audit = deviceStore.getAuditForDevice(physId, Date.now() - 5 * 60_000);

        return sendJson(res, 200, {
          success: true,
          physicalDeviceId: physId,
          healthScore: health.healthScore,
          reasons: JSON.parse(health.healthReasonsJson || '[]'),
          lastEvaluatedAt: health.healthLastEvaluatedAt,
          counters: {
            propsAttempts: health.propsAttempts,
            propsFailures: health.propsFailures,
            reconnectCount: health.reconnectCount,
            rebootCount: health.rebootCount,
          },
          lease,
          recentAuditCount: audit.length,
          recentFailedAuditCount: audit.filter(a => a.status === 'failed').length,
        });
      }

      // 24. POST /devices/:id/health/evaluate — force an immediate tick for one device.
      const evaluateMatch = pathname.match(/^\/devices\/([^/]+)\/health\/evaluate\/?$/);
      if (evaluateMatch && method === 'POST') {
        if (!options.tickHealthMonitor) {
          return sendJson(res, 501, { success: false, error: 'Health monitor is not configured on this server' });
        }
        const result = await options.tickHealthMonitor();
        return sendJson(res, 200, { success: true, ...result });
      }

      // 25. POST /devices/:id/quarantine — manual quarantine (operator override).
      const quarantineMatch = pathname.match(/^\/devices\/([^/]+)\/quarantine\/?$/);
      if (quarantineMatch && method === 'POST') {
        const rawId = decodeURIComponent(quarantineMatch[1]);
        let physId = rawId;
        const dev = deviceStore.getDevice(rawId);
        if (dev?.physicalDeviceId) physId = dev.physicalDeviceId;
        const mapping = deviceStore.getPhysicalMapping(rawId);
        if (!dev && mapping?.physicalDeviceId) physId = mapping.physicalDeviceId;

        const body = await parseJsonBody(req);
        const reason = typeof body.reason === 'string' && body.reason.trim()
          ? body.reason.trim().slice(0, 500)
          : 'manual quarantine';
        const result = deviceStore.setDeviceLeaseState(physId, 'quarantined', 'operator');
        console.log(`[API] Manual quarantine: ${physId} — ${reason}`);
        return sendJson(res, 200, { success: result.success, physicalDeviceId: physId, lease: deviceStore.getLease(physId), reason });
      }

      // 26. POST /devices/:id/quarantine/clear — clear a manual or auto quarantine.
      const quarantineClearMatch = pathname.match(/^\/devices\/([^/]+)\/quarantine\/clear\/?$/);
      if (quarantineClearMatch && method === 'POST') {
        const rawId = decodeURIComponent(quarantineClearMatch[1]);
        let physId = rawId;
        const dev = deviceStore.getDevice(rawId);
        if (dev?.physicalDeviceId) physId = dev.physicalDeviceId;
        const mapping = deviceStore.getPhysicalMapping(rawId);
        if (!dev && mapping?.physicalDeviceId) physId = mapping.physicalDeviceId;

        const result = deviceStore.setDeviceLeaseState(physId, 'available');
        console.log(`[API] Manual quarantine clear: ${physId}`);
        return sendJson(res, 200, { success: result.success, physicalDeviceId: physId, lease: deviceStore.getLease(physId) });
      }

      // Fallback 404 Not Found
      return sendJson(res, 404, {
        success: false,
        error: `Endpoint not found: ${method} ${pathname}`
      });

    } catch (err: any) {
      console.error('[API Server] Unhandled error handling request:', err);
      return sendJson(res, 500, {
        success: false,
        error: err?.message || 'Internal server error'
      });
    }
  });

  // 4. Start listening on loopback (127.0.0.1) with port conflict resilience
  return new Promise((resolve, reject) => {
    let chosenPort = savedPort;

    const tryListen = (portToTry: number) => {
      server.listen(portToTry, targetHost, () => {
        const addr = server.address() as any;
        const actualPort = addr.port;
        console.log(`[API Server] Loopback REST API listening strictly on http://${targetHost}:${actualPort}`);

        writeAuthFile(actualPort);

        resolve({
          server,
          port: actualPort,
          host: targetHost,
          token,
          authFilePath,
          close: () => new Promise<void>((resClose) => server.close(() => resClose()))
        });
      });
    };

    server.once('error', (err: any) => {
      if (err.code === 'EADDRINUSE' && chosenPort !== 0) {
        console.warn(`[API Server] Port ${chosenPort} in use on ${targetHost}. Falling back to OS-assigned port...`);
        chosenPort = 0;
        tryListen(0);
      } else {
        console.error('[API Server] Failed to bind server:', err);
        reject(err);
      }
    });

    tryListen(chosenPort);
  });
}
