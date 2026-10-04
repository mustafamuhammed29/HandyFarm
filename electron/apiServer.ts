import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import adbkit from '@devicefarmer/adbkit';
import type { DeviceStore, DeviceData } from './db.js';

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
  const defaultPort = options.port || Number(process.env.HANDYFARM_API_PORT) || 5055;

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
        if (parsed.port && Number.isInteger(parsed.port)) {
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

      // 8. GET /devices/:id/artifacts (Placeholder for future screenshot/log retrieval)
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
