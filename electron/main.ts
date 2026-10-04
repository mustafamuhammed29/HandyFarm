console.log('BUILD CANARY:', Date.now(), 'ALPHA-BRAVO-123');
import { app, BrowserWindow, ipcMain, safeStorage, dialog, clipboard } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork, ChildProcess, spawn, execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
import adbkit from '@devicefarmer/adbkit';
const Adb = (adbkit as any).Adb || (adbkit as any).default?.Adb || (adbkit as any).default || adbkit;
import fs from 'fs';
import os from 'node:os';
import { WebSocketServer } from 'ws';
import { Adb as YumeAdb, AdbServerClient } from '@yume-chan/adb';
import { AdbServerNodeTcpConnector } from '@yume-chan/adb-server-node-tcp';
import { AdbScrcpyClient, AdbScrcpyOptions2_4 } from '@yume-chan/adb-scrcpy';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
console.log('__dirname is:', __dirname);
console.log('preload path is:', path.join(__dirname, 'preload.js'));

export function getResourcePath(fileName: string): string {
  const baseDir = app.isPackaged ? app.getAppPath() : __dirname;
  const p1 = path.join(baseDir, 'resources', fileName);
  if (fs.existsSync(p1)) return p1;
  const p2 = path.join(__dirname, '..', 'resources', fileName);
  if (fs.existsSync(p2)) return p2;
  const p3 = path.join(app.getAppPath(), 'resources', fileName);
  if (fs.existsSync(p3)) return p3;
  return p1;
}

const client = Adb.createClient();

let mainWindow: BrowserWindow | null = null;
const workers: Map<string, ChildProcess> = new Map();
const workerGenerations: Map<string, number> = new Map();

import { DeviceStore, thumbnailCache, downscaleThumbnail, type DeviceData } from './db.js';
import { startApiServer, type ApiServerHandle } from './apiServer.js';
export { DeviceStore, thumbnailCache, downscaleThumbnail };

let apiServerHandle: ApiServerHandle | null = null;
const sqliteDbPath = path.join(app.getPath('userData'), 'handyfarm.db');
const legacyJsonPath = path.join(app.getPath('userData'), 'devices.json');
const deviceStore = new DeviceStore(sqliteDbPath, legacyJsonPath);

// Phase 4: fleet health monitor. Created lazily on app.ready so we have access
// to the fully-initialized DeviceStore. See app.whenReady().then(...) below.
let healthMonitor: HealthMonitor | null = null;
const RECONNECT_SCHEDULER_BASE_CAP = 3;
const ADAPTIVE_CAP_BUDGET_KBPS = 480_000; // USB 2.0 hi-speed nominal
let reconnectScheduler: Scheduler | null = null;

function broadcastDelta(deviceId: string, patch: Partial<DeviceData>, removed = false) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('devices-updated', {
      id: deviceId,
      patch,
      removed
    });
  }
}

import { evaluateDeviceLeaseGuard } from './leaseGuard.js';
import { validateDeviceConfigImport as validateConfigImport } from './configValidation.js';
import {
  captureDeviceManifest,
  verifyDeviceAgainstBaseline,
  executeFullBaselineReset,
  type BaselineManifest,
  type BaselineVerificationResult
} from './baseline.js';
import { executeNetworkPreflight } from './network.js';
import { sendTextToDevice } from './textInput.js';

/**
 * Guard function to enforce exclusive device lease access on destructive actions.
 * Allows action if device is available or caller sessionId holds the active lease.
 * Blocks if device is leased by another session, cooling down, quarantined, or in maintenance.
 */
export function checkDeviceLeaseGuard(deviceId: string, sessionId?: string): { allowed: boolean; error?: string } {
  return evaluateDeviceLeaseGuard(deviceStore, deviceId, sessionId, (id, patch) => broadcastDelta(id, patch));
}

// Periodic sweep for expired leases & cooldown periods (every 2 seconds)
setInterval(() => {
  try {
    const { changedLeases, affectedDeviceIds } = deviceStore.sweepExpiredLeases();
    if (changedLeases.length > 0) {
      console.log(`[Lease Sweep] State changed for ${changedLeases.length} lease(s). Emitting delta broadcast for: ${affectedDeviceIds.join(', ')}`);
      for (const id of affectedDeviceIds) {
        const dev = deviceStore.getDevice(id);
        if (dev) {
          broadcastDelta(id, {
            leaseState: dev.leaseState,
            leasedBy: dev.leasedBy ?? (null as any),
            leaseExpiresAt: dev.leaseExpiresAt ?? (null as any),
            lastHeartbeatAt: dev.lastHeartbeatAt ?? (null as any)
          });
        }
      }
    }
  } catch (err) {
    console.warn('[Lease Sweep] Error sweeping expired leases:', err);
  }
}, 2000);

// Background periodic drift detection sweep (§1.2 - every 60 seconds)
async function sweepDeviceDrift() {
  const activeDevices = deviceStore.getAllDevices(false).filter(d => d.status === 'device');
  for (const dev of activeDevices) {
    const physId = dev.physicalDeviceId || `phys_${dev.serial || dev.id}`;
    const manifest = deviceStore.getBaseline(physId);
    if (!manifest) continue;

    // Skip intrusive sweep if device is currently leased by an active session
    const lease = deviceStore.getLease(physId);
    if (lease.state === 'leased') continue;

    try {
      const result = await verifyDeviceAgainstBaseline(dev.id, manifest, (args) => execFileAsync('adb', args));
      deviceStore.recordDriftVerification(dev.id, result);
      broadcastDelta(dev.id, {
        baselineStatus: result.verified ? 'verified' : 'drifted',
        driftCount: result.diffs.length,
        driftWarnings: result.diffs.map(d => d.description || `${d.field}: expected ${JSON.stringify(d.expected)}, got ${JSON.stringify(d.actual)}`),
        lastVerifiedAt: result.verifiedAt
      });
      if (!result.verified) {
        console.warn(`[Drift Detection] Device ${dev.id} (${physId}) drifted: ${result.diffs.length} field(s) out of baseline.`);
      }
    } catch (err: any) {
      console.warn(`[Drift Detection] Background verify failed for ${dev.id}:`, err?.message);
    }
  }
}

setInterval(() => {
  sweepDeviceDrift().catch(() => {});
}, 60000);

// Run dedupe once on startup to clean up and merge any duplicates in the database
const allInitialDevices = deviceStore.getAllDevices(false);
for (let i = 0; i < allInitialDevices.length; i++) {
  const d1 = allInitialDevices[i];
  if (!d1) continue;
  for (let j = i + 1; j < allInitialDevices.length; j++) {
    const d2 = allInitialDevices[j];
    if (!d2) continue;

    const isMatch = (
      (d1.physicalDeviceId && d2.physicalDeviceId && d1.physicalDeviceId === d2.physicalDeviceId) ||
      (d1.serial && d2.serial && d1.serial === d2.serial) ||
      (d1.serial && d1.serial === d2.id) ||
      (d2.serial && d2.serial === d1.id)
    );

    if (isMatch) {
      console.log(`[Startup Dedupe] Found duplicate for ${d1.id} (serial: ${d1.serial}, phys: ${d1.physicalDeviceId}) and ${d2.id} (serial: ${d2.serial}, phys: ${d2.physicalDeviceId})`);
      const d1IsWifi = d1.id.includes(':');
      const d2IsWifi = d2.id.includes(':');

      const d1IsActive = d1.status === 'device';
      const d2IsActive = d2.status === 'device';

      let survivingId: string;
      let losingId: string;

      if (d1IsActive && !d2IsActive) {
        survivingId = d1.id;
        losingId = d2.id;
      } else if (!d1IsActive && d2IsActive) {
        survivingId = d2.id;
        losingId = d1.id;
      } else {
        // Prefer USB (hardware serial) if both active or both inactive
        if (d1IsWifi && !d2IsWifi) {
          survivingId = d2.id;
          losingId = d1.id;
        } else if (!d1IsWifi && d2IsWifi) {
          survivingId = d1.id;
          losingId = d2.id;
        } else {
          survivingId = d1.id;
          losingId = d2.id;
        }
      }

      console.log(`[Startup Dedupe] Merging duplicate entry ${losingId} into surviving entry ${survivingId}`);
      deviceStore.mergeDevices(survivingId, losingId);
    }
  }
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const nowMs = Date.now();
for (const dev of deviceStore.getAllDevices(false)) {
  const lastConnected = dev.connectedAt || 0;
  if (nowMs - lastConnected > SEVEN_DAYS_MS) {
    console.log(`[Startup Cleanup] Purging stale device ${dev.id} (last seen ${new Date(lastConnected).toLocaleString()})`);
    deviceStore.deleteDevice(dev.id);
    continue;
  }

  const patch: Partial<DeviceData> = {};
  if (dev.status !== 'offline') {
    patch.status = 'offline';
  }
  if (!dev.serial) {
    patch.serial = dev.id;
  }
  if (Object.keys(patch).length > 0) {
    deviceStore.updateDevice(dev.id, patch);
  }
}
deviceStore.flushWrites();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.webContents.on('console-message', (_event, _level, message, line, sourceId) => {
    console.log(`[Renderer Console] ${message} (${sourceId}:${line})`);
  });
}

app.whenReady().then(() => {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('WARNING: safeStorage encryption is not available on this system.');
  }
  createWindow();

  // Phase 4: start the health monitor before any tracker events arrive so the
  // first batch of presence events is captured. The monitor is idempotent: safe
  // to call start() once per process lifetime.
  healthMonitor = new HealthMonitor(deviceStore, {
    tickMs: 30_000,
    windowMs: 5 * 60_000,
    staleLeaseMs: 5 * 60_000,
  });
  healthMonitor.start();
  console.log('[Phase 4] HealthMonitor started (tick=30s, window=5m, staleLease=5m).');

  // Phase 4: periodic adaptive-cap recompute. Reads the current fleet bandwidth
  // estimate from power.ts and re-caps the auto-reconnect scheduler. Without this
  // hook the scheduler would stay at the static cap=3 even when the USB budget
  // saturates.
  setInterval(() => {
    if (!reconnectScheduler) return;
    try {
      const bandwidth = estimateFleetBandwidthKbps([]);
      const cap = getAdaptiveConcurrencyCap({
        baseCap: RECONNECT_SCHEDULER_BASE_CAP,
        totalBandwidthKbps: bandwidth,
        bandwidthBudgetKbps: ADAPTIVE_CAP_BUDGET_KBPS,
        floorCap: 1,
      });
      if (cap.cap !== reconnectScheduler.getConcurrencyCap()) {
        reconnectScheduler.setConcurrencyCap(cap.cap);
        console.log(`[Phase 4] Adaptive cap → ${cap.cap} (utilization=${(cap.bandwidthUtilization * 100).toFixed(0)}%)`);
      }
    } catch (err) {
      console.warn('[Phase 4] adaptive-cap tick failed:', err);
    }
  }, 60_000); // re-evaluate once a minute

  startAdbTracker();

  // Start Phase 7 loopback REST API server
  startApiServer({
    deviceStore,
    client,
    checkDeviceLeaseGuard,
    isSafeAdbCommand,
    isExpertMode: () => expertModeEnabled,
    redactLogcatText,
    broadcastDelta,
    userDataDir: app.getPath('userData'),
    captureBaseline,
    verifyBaseline,
    resetToBaseline: resetDeviceToBaseline,
    tickHealthMonitor: async () => {
      if (!healthMonitor) return { evaluated: 0, transitions: 0 };
      return healthMonitor.tick();
    },
    runNetworkPreflight: async (deviceId, opts = {}) => {
      const dev = deviceStore.getDevice(deviceId);
      const physId = dev?.physicalDeviceId || `phys_${dev?.serial || deviceId}`;
      return executeNetworkPreflight(
        { deviceId, ...opts },
        {
          getSimForDevice: (id) => deviceStore.getSimForDevice(id),
          recordEgress: (egress) => deviceStore.recordObservedEgress(egress),
          execAdb: (args) => execFileAsync('adb', args),
          physicalDeviceId: physId
        }
      );
    }
  }).then((handle) => {
    apiServerHandle = handle;
  }).catch((err) => {
    console.error('[API Server] Failed to start loopback REST API server:', err);
  });
  
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  deviceStore.flushWrites();
});

app.on('will-quit', () => {
  if (apiServerHandle) {
    apiServerHandle.close().catch(() => {});
  }
  deviceStore.close();
});

async function startAdbTracker() {
  try {
    const tracker = await client.trackDevices();

    // --- STARTUP SCAN: pick up devices already connected before the app launched ---
    console.log('[Startup] Scanning for already-connected devices...');
    try {
      const existingDevices = await client.listDevices();
      console.log(`[Startup] Found ${existingDevices.length} already-connected device(s):`, existingDevices.map((d: any) => `${d.id}(${d.type})`).join(', '));
      for (const device of existingDevices) {
        console.log(`[Startup] Processing pre-connected device: ${device.id} (${device.type})`);
        const dev = deviceStore.getDevice(device.id);
        const patch: Partial<DeviceData> = {
          status: device.type,
          serial: dev?.serial || device.id,
          connectedAt: Date.now()
        };
        deviceStore.updateDevice(device.id, patch);
        broadcastDelta(device.id, patch);

        if (device.type === 'device' || device.type === 'unauthorized') {
          queueWorker(device.id, device.type);
        }
      }
    } catch (scanErr: any) {
      console.error('[Startup] listDevices() scan failed:', scanErr?.message || scanErr);
    }
    // --- END STARTUP SCAN ---

    tracker.on('add', (device: any) => {
      console.log('Device added:', device.id, device.type);
      const dev = deviceStore.getDevice(device.id);

      // Pre-match against known devices to prevent transient duplicate tiles
      let matchedDev = dev;
      if (!matchedDev) {
        const allDevs = deviceStore.getAllDevices(false);
        if (device.id.includes(':')) {
          const ip = device.id.split(':')[0];
          matchedDev = allDevs.find(d => d.lastKnownIp === ip);
        } else {
          matchedDev = allDevs.find(d => d.serial === device.id || d.id === device.id);
        }
      }

      const patch: Partial<DeviceData> = {
        status: device.type,
        connectedAt: Date.now(),
        serial: dev?.serial || matchedDev?.serial || (device.id.includes(':') ? undefined : device.id),
        physicalDeviceId: dev?.physicalDeviceId || matchedDev?.physicalDeviceId
      };
      deviceStore.updateDevice(device.id, patch);

      // If matchedDev exists and is a different ID, merge immediately so the UI transitions seamlessly
      if (matchedDev && matchedDev.id !== device.id) {
        console.log(`[Tracker Add Dedupe] Immediate merge of ${matchedDev.id} into newly connected ${device.id}`);
        const oldWorker = workers.get(matchedDev.id);
        if (oldWorker) {
          workerGenerations.set(matchedDev.id, (workerGenerations.get(matchedDev.id) || 0) + 1);
          oldWorker.kill();
          workers.delete(matchedDev.id);
        }
        closeLiveView(matchedDev.id, 'Connection transferred to new transport');

        const merged = deviceStore.mergeDevices(device.id, matchedDev.id);
        broadcastDelta(matchedDev.id, {}, true);
        broadcastDelta(device.id, merged);
      } else {
        broadcastDelta(device.id, patch);
      }

      if (device.type === 'device' || device.type === 'unauthorized') {
        queueWorker(device.id, device.type);
      }
    });

    tracker.on('remove', async (device: any) => {
      console.log('Device removed:', device.id);
      const dev = deviceStore.getDevice(device.id);
      const physId = dev?.physicalDeviceId;
      if (physId && healthMonitor) healthMonitor.recordPresence(physId, 'absent');

      const worker = workers.get(device.id);
      if (worker) {
        worker.kill();
        workers.delete(device.id);
        checkQueue();
      } else {
        const qIdx = workerQueue.findIndex(w => w.deviceId === device.id);
        if (qIdx >= 0) workerQueue.splice(qIdx, 1);
      }
      closeLiveView(device.id, 'Connection lost — device disconnected');

      // Check if another transport is still active for this physical device
      // (e.g. Wi-Fi was disconnected, but USB cable is still plugged into computer)
      try {
        const activeAdbDevices = await client.listDevices();
        let fallbackTransport: any = null;

        if (dev) {
          const physMapping = dev.physicalDeviceId ? deviceStore.getPhysicalMapping(dev.physicalDeviceId) : undefined;
          for (const d of activeAdbDevices) {
            if (d.id === device.id) continue;
            const matchesSerial = dev.serial && (d.id === dev.serial || physMapping?.serials?.includes(d.id));
            const matchesLastSeen = physMapping && physMapping.lastSeenTransportId === d.id;
            if (matchesSerial || matchesLastSeen) {
              fallbackTransport = d;
              break;
            }
          }
        }

        if (fallbackTransport) {
          console.log(`[Tracker Remove Dedupe] Active fallback transport ${fallbackTransport.id} detected for removed ${device.id}. Re-activating fallback transport.`);
          const merged = deviceStore.mergeDevices(fallbackTransport.id, device.id);
          broadcastDelta(device.id, {}, true);
          broadcastDelta(fallbackTransport.id, merged);
          if (fallbackTransport.type === 'device' || fallbackTransport.type === 'unauthorized') {
            queueWorker(fallbackTransport.id, fallbackTransport.type);
          }
          return;
        }
      } catch (err) {
        console.warn('[Tracker Remove] Fallback transport detection failed:', err);
      }

      if (deviceStore.hasDevice(device.id)) {
        deviceStore.updateDevice(device.id, { status: 'offline' });
        broadcastDelta(device.id, { status: 'offline' });
      }
    });

    tracker.on('change', (device: any) => {
      console.log('Device changed:', device.id, device.type);
      const dev = deviceStore.getDevice(device.id);
      const patch: Partial<DeviceData> = {
        status: device.type,
        serial: dev?.serial || device.id
      };
      deviceStore.updateDevice(device.id, patch);
      broadcastDelta(device.id, patch);

      // Phase 4: feed presence events to the health monitor. A device that comes
      // back online after being offline is also a "reconnect" signal that should
      // bump the per-device reconnect counter.
      const physId = dev?.physicalDeviceId;
      if (physId && healthMonitor) {
        healthMonitor.recordPresence(physId, device.type === 'device' ? 'present' : 'present');
        if (device.type === 'device') {
          deviceStore.recordReconnect(physId);
        }
      }

      const worker = workers.get(device.id);
      if (worker && !worker.killed && worker.connected) {
        try { worker.send({ type: 'STATUS_CHANGE', status: device.type }); } catch(e){}
      } else if (device.type === 'device' || device.type === 'unauthorized') {
        queueWorker(device.id, device.type);
      }
    });

    // Background Auto-Reconnect Loop for WiFi devices.
    // Routed through the fan-out scheduler so a 20-device farm doesn't slam adb with
    // 20 parallel connect() calls every 15 seconds. Concurrency cap + per-device
    // randomized delay smooths the burst.
    reconnectScheduler = new Scheduler({
      globalConcurrencyCap: RECONNECT_SCHEDULER_BASE_CAP,
      rateLimit: { maxJobs: 8, windowMs: 15000 }, // ≤8 connect attempts per 15s sweep window
      defaultDelay: { minMs: 200, maxMs: 800 },
    });
    reconnectScheduler.onAudit((e) => {
      if (e.status === 'completed' || e.status === 'failed') {
        console.log(`[Auto-Reconnect audit] ${e.jobId} ${e.label || ''} status=${e.status} delayMs=${e.appliedDelayMs} ${e.error ? 'err=' + e.error : ''}`);
      }
      // Phase 4: persist to scheduler_audit so the health monitor can score
      // flakiness from real runs across restarts. Only terminal statuses
      // (completed/failed/cancelled) are persisted — otherwise the health
      // counter would double-count every queued/running transition. Best-effort
      // — failures are logged but never break the scheduler.
      if (e.status === 'completed' || e.status === 'failed' || e.status === 'cancelled') {
        try {
          const auditEntry = e as any;
          deviceStore.insertAuditEntry({
            jobId: e.jobId,
            groupId: e.groupId,
            deviceId: auditEntry.deviceId,
            physicalDeviceId: auditEntry.physicalDeviceId,
            label: e.label,
            priority: e.priority,
            status: e.status,
            scheduledAt: e.scheduledAt,
            startedAt: e.startedAt,
            completedAt: e.completedAt,
            appliedDelayMs: e.appliedDelayMs,
            orderIndex: e.orderIndex,
            error: e.error,
            result: e.result,
          });
        } catch (err) {
          console.warn('[Phase 4] Failed to persist scheduler audit entry:', err);
        }
      }
    });
    setInterval(() => {
      const allDevs = deviceStore.getAllDevices(false);
      for (const dev of allDevs) {
        const deviceId = dev.id;
        if (!deviceId.includes(':') && (dev.status === 'offline' || dev.status === 'disconnect') && dev.lastKnownIp) {
          const hasActiveWifi = allDevs.some(d => d.id.includes(':') && d.serial === dev.serial && d.status === 'device');
          if (!hasActiveWifi && /^(\d{1,3}\.){3}\d{1,3}$/.test(dev.lastKnownIp) && reconnectScheduler) {
            reconnectScheduler.submit({
              label: `reconnect-${deviceId}-${dev.lastKnownIp}`,
              groupId: 'auto-reconnect',
              action: async () => {
                console.log(`[Auto-Reconnect] Attempting to reconnect offline device ${deviceId} via last known IP ${dev.lastKnownIp}:5555`);
                try {
                  const { stdout } = await execFileAsync('adb', ['connect', `${dev.lastKnownIp}:5555`]);
                  console.log(`[Auto-Reconnect] Output for ${dev.lastKnownIp}: ${stdout}`);
                } catch (e) {
                  console.error(`[Auto-Reconnect] Failed for ${dev.lastKnownIp}`);
                  throw e;
                }
              },
            });
          }
        }
      }
    }, 15000); // Check every 15 seconds

  } catch (err) {
    console.error('Failed to track devices:', err);
  }
}

const MAX_CONCURRENT_WORKERS = 8;
const workerQueue: { deviceId: string, status: string }[] = [];

const BASE_SCREENCAP_INTERVAL = 10000;
const SCREENCAP_INCREMENT = 2000;
const MAX_SCREENCAP_INTERVAL = 60000;

function getComputedInterval(workerCount: number) {
  return Math.min(
    MAX_SCREENCAP_INTERVAL,
    BASE_SCREENCAP_INTERVAL + (Math.max(0, workerCount - 1) * SCREENCAP_INCREMENT)
  );
}

function broadcastScreencapInterval() {
  const currentInterval = getComputedInterval(workers.size);
  workers.forEach(worker => {
    if (worker && !worker.killed && worker.connected) {
      try { worker.send({ type: 'UPDATE_SCREENCAP_INTERVAL', interval: currentInterval }); } catch(e){}
    }
  });
}

function checkQueue() {
  if (workers.size >= MAX_CONCURRENT_WORKERS) return;
  if (workerQueue.length > 0) {
    const next = workerQueue.shift();
    if (next) {
      spawnWorker(next.deviceId, next.status);
    }
  }
}

function queueWorker(deviceId: string, status: string) {
  if (workers.has(deviceId)) return;
  
  const existingIdx = workerQueue.findIndex(w => w.deviceId === deviceId);
  if (existingIdx >= 0) {
    workerQueue[existingIdx].status = status;
    return;
  }
  
  if (workers.size < MAX_CONCURRENT_WORKERS) {
    spawnWorker(deviceId, status);
  } else {
    workerQueue.push({ deviceId, status });
  }
}

function spawnWorker(deviceId: string, status: string) {
  if (workers.has(deviceId)) return;

  const currentGen = (workerGenerations.get(deviceId) || 0) + 1;
  workerGenerations.set(deviceId, currentGen);

  // Compute the interval it will have once added
  const initialInterval = getComputedInterval(workers.size + 1);
  
  const workerPath = path.join(__dirname, 'deviceWorker.js');
  // Pass the interval as the 3rd argument to avoid any IPC race condition
  const worker = fork(workerPath, [deviceId, status, initialInterval.toString()]);

  worker.on('message', (msg: any) => {
    if (workerGenerations.get(deviceId) !== currentGen || workers.get(deviceId) !== worker) {
      return;
    }

    if (msg.type === 'SCREENSHOT_FRAME' && msg.buffer) {
      const rawBuf = Buffer.isBuffer(msg.buffer) ? msg.buffer : Buffer.from(msg.buffer.data || msg.buffer);
      const downscaled = downscaleThumbnail(rawBuf);
      if (downscaled) {
        thumbnailCache.set(deviceId, downscaled);
        broadcastDelta(deviceId, { thumbnail: downscaled });
      }
      return;
    }

    if (msg.type === 'DEVICE_DATA') {
      const patch = { ...msg.data };
      if (patch.thumbnail) {
        const thumb = patch.thumbnail;
        delete patch.thumbnail;
        if (typeof thumb === 'string' && thumb.startsWith('data:image/')) {
          const b64 = thumb.split(',')[1];
          if (b64) {
            const downscaled = downscaleThumbnail(Buffer.from(b64, 'base64'));
            if (downscaled) {
              thumbnailCache.set(deviceId, downscaled);
              broadcastDelta(deviceId, { thumbnail: downscaled });
            }
          }
        }
      }

      deviceStore.updateDevice(deviceId, patch);

      let hasMerged = false;
      const allDevs = deviceStore.getAllDevices(false);
      for (const other of allDevs) {
        if (other.id === deviceId) continue;

        const isMatch = (
          (patch.physicalDeviceId && other.physicalDeviceId && patch.physicalDeviceId === other.physicalDeviceId) ||
          (patch.serial && other.serial && patch.serial === other.serial) ||
          (patch.serial && patch.serial === other.id) ||
          (other.serial && other.serial === deviceId)
        );

        if (isMatch) {
          console.log(`[Dedupe check] Physical device conflict found between ${deviceId} and ${other.id} (serial: ${patch.serial || other.serial}, physId: ${patch.physicalDeviceId || other.physicalDeviceId})`);

          const isCurrentWifi = deviceId.includes(':');
          const isOtherWifi = other.id.includes(':');

          const isCurrentActive = patch.status === 'device';
          const isOtherActive = other.status === 'device';

          let idToKill: string;
          let survivingId: string;

          if (isCurrentActive && !isOtherActive) {
            // Current connection is active, other is inactive -> current survives
            survivingId = deviceId;
            idToKill = other.id;
          } else if (!isCurrentActive && isOtherActive) {
            // Other connection is active, current is inactive -> other survives
            survivingId = other.id;
            idToKill = deviceId;
          } else if (isCurrentActive && isOtherActive) {
            // Both are active: newly reporting connection takes over as the active transport
            survivingId = deviceId;
            idToKill = other.id;
          } else {
            // Both are inactive: keep hardware serial (non-WiFi) if possible
            if (isCurrentWifi && !isOtherWifi) {
              survivingId = other.id;
              idToKill = deviceId;
            } else {
              survivingId = deviceId;
              idToKill = other.id;
            }
          }

          console.log(`[Dedupe] MERGING! Consolidating duplicate ${idToKill} into surviving ${survivingId}`);
          const oldWorker = workers.get(idToKill);
          if (oldWorker) {
            workerGenerations.set(idToKill, (workerGenerations.get(idToKill) || 0) + 1);
            oldWorker.kill();
            workers.delete(idToKill);
          }
          closeLiveView(idToKill, 'Connection transferred to surviving transport');

          const merged = deviceStore.mergeDevices(survivingId, idToKill);
          broadcastDelta(idToKill, {}, true);
          broadcastDelta(survivingId, merged);
          hasMerged = true;

          if (idToKill === deviceId) {
            return; // Stop processing this worker's message since it was merged into other
          }
        }
      }

      if (!hasMerged) {
        broadcastDelta(deviceId, patch);
      }
    }
  });

  worker.on('exit', (code) => {
    console.log(`Worker for ${deviceId} (gen ${currentGen}) exited with code ${code}`);

    // Ignore stale exit handlers if generation moved on or worker replaced
    if (workerGenerations.get(deviceId) !== currentGen || workers.get(deviceId) !== worker) {
      console.log(`[Worker Exit] Ignoring stale exit event for ${deviceId} (gen ${currentGen} vs current ${workerGenerations.get(deviceId)})`);
      return;
    }

    workers.delete(deviceId);
    checkQueue();
    broadcastScreencapInterval();

    // Auto-restart if we think it should still be connected (status is not offline in our DB)
    const dev = deviceStore.getDevice(deviceId);
    if (dev && dev.status !== 'offline' && dev.status !== 'disconnect') {
      console.log(`Re-queuing worker for ${deviceId}`);
      setTimeout(() => queueWorker(deviceId, dev.status), 2000);
    }
  });

  workers.set(deviceId, worker);
  broadcastScreencapInterval();
}

ipcMain.handle('get-devices', () => {
  return deviceStore.getAllDevices(true);
});

ipcMain.handle('retry-device', (_event, deviceId: string) => {
  console.log(`[Retry] Requested for device ${deviceId}`);

  // Invalidate any in-flight exit handlers from the existing worker
  workerGenerations.set(deviceId, (workerGenerations.get(deviceId) || 0) + 1);

  // Kill any existing zombie worker
  const existingWorker = workers.get(deviceId);
  if (existingWorker) {
    console.log(`[Retry] Killing existing worker for ${deviceId}`);
    existingWorker.kill();
    workers.delete(deviceId);
  }
  // Remove from queue if queued
  const qIdx = workerQueue.findIndex(w => w.deviceId === deviceId);
  if (qIdx >= 0) workerQueue.splice(qIdx, 1);

  // Re-query adb for current device status
  client.listDevices().then((devices: any[]) => {
    const found = devices.find((d: any) => d.id === deviceId);
    const liveStatus = found ? found.type : 'offline';
    console.log(`[Retry] ADB reports ${deviceId} as: ${liveStatus}`);

    const dev = deviceStore.getDevice(deviceId);
    if (dev) {
      deviceStore.updateDevice(deviceId, { status: liveStatus, serial: dev.serial || deviceId });
      broadcastDelta(deviceId, { status: liveStatus });
    }

    if (liveStatus === 'device') {
      console.log(`[Retry] Spawning fresh worker for ${deviceId}`);
      queueWorker(deviceId, liveStatus);
    }
  }).catch((err: any) => {
    console.error(`[Retry] listDevices failed: ${err?.message || err}`);
  });

  return { ok: true };
});


const activeLiveViews = new Map<string, { ws: WebSocketServer, client: AdbScrcpyClient<any>, adb: YumeAdb }>();


function closeLiveView(deviceId: string, reason: string) {
  const active = activeLiveViews.get(deviceId);
  if (active) {
    console.log(`[POC] Closing live view for ${deviceId} (Reason: ${reason})`);
    try {
      if (active.ws.clients) {
        for (const client of active.ws.clients) {
          try {
            if (client.readyState === 1 /* OPEN */) {
              client.send(JSON.stringify({ type: 'control-error', error: reason }));
            }
            client.close();
          } catch(e) {}
        }
      }
      active.ws.close(); 
      active.client.close();
    } catch(e) {}
    activeLiveViews.delete(deviceId);
  }
}

ipcMain.handle('start-live-view-poc', async (_event, deviceId, maxSize = 800, videoBitRate = 2000000, sessionId?: string) => {
  console.log(`[POC] Starting Live View for ${deviceId}`);
  
  // Phase 5: Lease Guard Check
  const leaseGuard = checkDeviceLeaseGuard(deviceId, sessionId);
  if (!leaseGuard.allowed) {
    return { success: false, error: leaseGuard.error };
  }

  // Phase 4: DeviceId validation
  const connected = deviceStore.getDevice(deviceId);
  if (!connected || connected.status !== 'device') {
    return { success: false, error: 'Device is not connected or unauthorized' };
  }

  if (activeLiveViews.has(deviceId)) {
    // Already running, return existing port
    return { success: true, port: (activeLiveViews.get(deviceId)!.ws.address() as any).port };
  }

  const worker = workers.get(deviceId);
  if (worker && !worker.killed && worker.connected) {
    try { worker.send({ type: 'PAUSE_SCREENCAP' }); } catch(e){}
  }

  // 1) Read initial stay_on_while_plugged_in value
  let originalStayOnValue = '0';
  try {
    const { stdout } = await execFileAsync('adb', ['-s', deviceId, 'shell', 'settings', 'get', 'global', 'stay_on_while_plugged_in']);
    originalStayOnValue = stdout.trim();
  } catch (e) {
    console.error('[POC] Failed to read stay_on_while_plugged_in', e);
  }
  
  // 2) Set to 3 (stay awake) and wake device up
  try {
    await execFileAsync('adb', ['-s', deviceId, 'shell', 'settings', 'put', 'global', 'stay_on_while_plugged_in', '3']);
    await execFileAsync('adb', ['-s', deviceId, 'shell', 'input', 'keyevent', '224']);
  } catch (e) {
    console.error('[POC] Failed to set stay_on/wake up', e);
  }

  const connector = new AdbServerNodeTcpConnector({ host: '127.0.0.1', port: 5037 });
  const client = new AdbServerClient(connector);
  const transport = await client.createTransport({ serial: deviceId });
  const yumeAdb = new YumeAdb(transport);

  const serverBuffer = fs.readFileSync(getResourcePath('scrcpy-server-v2.4.jar'));
  
  await AdbScrcpyClient.pushServer(
    yumeAdb,
    new ReadableStream<any>({
      start(controller) {
        controller.enqueue(new Uint8Array(serverBuffer));
        controller.close();
      }
    }) as any,
    '/data/local/tmp/scrcpy-server.jar'
  );

  const initOptions: any = {
    maxSize: maxSize,
    maxFps: 30,
    videoBitRate: videoBitRate,
    tunnelForward: true,
    control: true,
    sendDeviceMeta: false,
    sendDummyByte: false,
    scid: (Math.floor(Math.random() * 0x7FFFFFFF)).toString(16).padStart(8, '0') // 31-bit masked scid
  };

  // Force software encoder for Samsung Galaxy Note 5 due to hardware encoder (OMX.Exynos.AVC) incompatibilities with WebCodecs
  if (connected.model?.includes('N920C') || deviceId === '11160b2a51ec0a02') {
    initOptions.videoEncoder = 'OMX.google.h264.encoder';
  }

  const scrcpyOptions = new AdbScrcpyOptions2_4(initOptions, { version: '2.4' });

  let activeScrcpyClient: AdbScrcpyClient<any> | undefined;
  try {
    activeScrcpyClient = await AdbScrcpyClient.start(
      yumeAdb,
      '/data/local/tmp/scrcpy-server.jar',
      scrcpyOptions
    );
    console.log('[POC] activeScrcpyClient.controller is truthy:', !!activeScrcpyClient.controller);
  } catch (e: any) {
    let retrySucceeded = false;
    const outputString = (e.output && e.output.join ? e.output.join('\n') : String(e.output || ''));
    if (String(e.message).includes('NumberFormatException') || outputString.includes('NumberFormatException')) {
      console.warn("[POC] Caught NumberFormatException due to scid bug. Retrying with new scid...");
      initOptions.scid = (Math.floor(Math.random() * 0x7FFFFFFF)).toString(16).padStart(8, '0');
      const scrcpyOptionsRetry = new AdbScrcpyOptions2_4(initOptions, { version: '2.4' });
      try {
        activeScrcpyClient = await AdbScrcpyClient.start(
          yumeAdb,
          '/data/local/tmp/scrcpy-server.jar',
          scrcpyOptionsRetry
        );
        console.log('[POC] Retry successful. activeScrcpyClient.controller is truthy:', !!activeScrcpyClient.controller);
        retrySucceeded = true;
      } catch (retryErr: any) {
        e = retryErr;
      }
    }
    
    if (!retrySucceeded) {
      console.error("[POC] Scrcpy server failed to start:", e);
      if (e.output) {
        console.error("[POC] Server output:", e.output);
      }
      return { success: false, error: e.message || String(e) };
    }
  }

  const activeLiveViewWs = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  
  activeLiveViews.set(deviceId, { ws: activeLiveViewWs, client: activeScrcpyClient!, adb: yumeAdb });

  await new Promise<void>((resolve) => activeLiveViewWs.on('listening', resolve));
  const port = (activeLiveViewWs.address() as any).port;
  console.log(`[POC] WebSocket bridge listening on port ${port} for ${deviceId}`);

  activeLiveViewWs.on('connection', async (ws) => {
    console.log(`[POC] Renderer connected to WebSocket`);

    const videoStreamInstance = await activeScrcpyClient!.videoStream;
    const videoReader = videoStreamInstance!.stream.getReader();
    let packetCount = 0;
    const pumpVideo = async () => {
      try {
        while (true) {
          const { value, done } = await videoReader.read();
          if (done || !value) break;
            // Serialize ScrcpyMediaStreamPacket over WebSocket
            if (ws.readyState === ws.OPEN) {
              const header = new Uint8Array(1);
              if (value.type === 'configuration') {
                header[0] |= 1;
              }
              if ((value as any).keyframe) {
                header[0] |= 2;
              }
              
              if (packetCount < 10) {
                console.log(`[POC-SND] Pkt ${packetCount} | type: ${value.type} | keyframe: ${(value as any).keyframe} | header byte: ${header[0]} | size: ${value.data.byteLength}`);
                packetCount++;
              }
              
              const buffer = new Uint8Array(1 + value.data.byteLength);
              buffer.set(header, 0);
              buffer.set(value.data, 1);
              ws.send(buffer);
            }
        }
      } catch (e) {
        console.error("Video stream error", e);
      }
    };
    pumpVideo();

    const messageHandler = async (data: any, _isBinary: boolean) => {
      console.log('RAW WS MESSAGE:', typeof data, data);
      if (!activeScrcpyClient!.controller) {
        console.log('[POC-TOUCH] activeScrcpyClient.controller is falsy! Bailing out.');
        return;
      }
      try {
        let str = '';
        if (typeof data === 'string') {
          str = data;
        } else if (data instanceof Buffer) {
          str = data.toString('utf-8');
        } else if (Array.isArray(data)) {
          str = Buffer.concat(data).toString('utf-8');
        } else {
          str = Buffer.from(data as any).toString('utf-8');
        }

        console.log(`[POC-TOUCH] Decoded string length: ${str.length}, startsWith('{') = ${str.startsWith('{')}`);

        if (str && str.startsWith('{')) {
          const msg = JSON.parse(str);
          console.log(`[POC-TOUCH] Parsed JSON:`, msg);
          
          if (msg.type === 'touch') {
            console.log(`[POC-TOUCH] Forwarding touch: action=${msg.action}, x=${msg.x}, y=${msg.y}, videoWidth=${msg.videoWidth}, videoHeight=${msg.videoHeight}, pointerId=${msg.pointerId}`);
            await activeScrcpyClient!.controller.injectTouch({
              action: msg.action, // 0: down, 1: up, 2: move
              pointerId: BigInt(msg.pointerId || 1),
              pointerX: msg.x,
              pointerY: msg.y,
              videoWidth: msg.videoWidth,
              videoHeight: msg.videoHeight,
              pressure: msg.action === 1 ? 0 : 1, // 0 for up, 1 for down/move
              actionButton: 1, // AMOTION_EVENT_BUTTON_PRIMARY
              buttons: 1, // AMOTION_EVENT_BUTTON_PRIMARY
            });
            console.log(`[POC-TOUCH] Bytes flushed for touch action=${msg.action}`);
          } else if (msg.type === 'text') {
            console.log(`[POC-TOUCH] Forwarding text: ${msg.text}`);
            if (msg.text === '\b') {
              // Backspace is keycode 67
              await activeScrcpyClient!.controller.injectKeyCode({
                action: 0, keyCode: 67, metaState: 0, repeat: 0
              });
              await activeScrcpyClient!.controller.injectKeyCode({
                action: 1, keyCode: 67, metaState: 0, repeat: 0
              });
            } else {
              await activeScrcpyClient!.controller.injectText(msg.text);
            }
          } else if (msg.type === 'keycode') {
            console.log(`[POC-TOUCH] Forwarding keycode: ${msg.keycode}`);
            if (!activeScrcpyClient) {
              console.error(`[POC-TOUCH] ERROR: activeScrcpyClient is null or undefined when trying to send keycode ${msg.keycode}`);
              return;
            }
            if (!activeScrcpyClient.controller) {
              console.error(`[POC-TOUCH] ERROR: activeScrcpyClient.controller is null when trying to send keycode ${msg.keycode}`);
              return;
            }
            await activeScrcpyClient!.controller.injectKeyCode({
              action: 0, keyCode: msg.keycode, metaState: 0, repeat: 0
            });
            await activeScrcpyClient!.controller.injectKeyCode({
              action: 1, keyCode: msg.keycode, metaState: 0, repeat: 0
            });
          }
        }
      } catch (e: any) {
        console.error('Control parse error', e);
        if (e.code === 'EPIPE' || (e.message && e.message.includes('ended by the other party'))) {
          console.error(`[POC] Socket died for ${deviceId}: ${e.message}`);
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'control-error', error: 'Connection lost — reconnecting...' }));
          }
        }
        if (e.stack) {
          console.error('Stack trace:', e.stack);
        }
      }
    };
    console.log('[POC] Live handler function source:', messageHandler.toString());
    ws.on('message', messageHandler);

    ws.on('close', async () => {
      try {
        console.log(`[POC] Renderer disconnected for ${deviceId}`);
        if (worker && !worker.killed && worker.connected) {
          try {
            worker.send({ type: 'RESUME_SCREENCAP' });
          } catch (err) {
            console.error('[POC] Failed to send RESUME_SCREENCAP to worker:', err);
          }
        }
        activeScrcpyClient?.close();
        yumeAdb.close();
        activeLiveViews.delete(deviceId);

        // Restore stay_on_while_plugged_in
        try {
          await execFileAsync('adb', ['-s', deviceId, 'shell', 'settings', 'put', 'global', 'stay_on_while_plugged_in', String(originalStayOnValue)]);
        } catch (e) {
          console.error('[POC] Failed to restore stay_on_while_plugged_in', e);
        }
      } catch (err) {
        console.error('[POC] Uncaught error in ws close handler:', err);
      }
    });
  });

  return { success: true, port };
});

ipcMain.handle('stop-live-view-poc', async (_event, deviceId) => {
  console.log(`[POC] Stopping Live View for ${deviceId}`);
  closeLiveView(deviceId, 'Live view stopped by user');
  return { success: true };
});

function logAction(deviceId: string, action: string) {
  deviceStore.logDeviceAction(deviceId, action);
  const dev = deviceStore.getDevice(deviceId);
  if (dev) {
    broadcastDelta(deviceId, { history: dev.history });
  }
}

function isValidPackageName(pkg: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(pkg);
}

ipcMain.handle('reboot-device', async (_event, deviceId, sessionId?: string) => {
  const leaseGuard = checkDeviceLeaseGuard(deviceId, sessionId);
  if (!leaseGuard.allowed) {
    return { success: false, error: leaseGuard.error };
  }
  try {
    await client.getDevice(deviceId).reboot();
    logAction(deviceId, 'Rebooted device');
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

async function openUrlRobust(deviceId: string, url: string) {
  if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('data:text/html')) {
    throw new Error('Disallowed URL scheme. Only http, https, and data:text/html are supported.');
  }

  let target = '';
  try {
    const resolveArgs = ['-s', deviceId, 'shell', 'pm', 'resolve-activity', '-a', 'android.intent.action.VIEW', '-d', url];
    console.log(`[openUrlRobust] Resolving activity for ${deviceId}`);
    const { stdout } = await execFileAsync('adb', resolveArgs);
    
    // Look for something like "com.android.chrome/com.google.android.apps.chrome.Main"
    // that indicates a resolved component
    const match = stdout.match(/([a-zA-Z0-9_.]+\/[a-zA-Z0-9_.]+)/);
    if (match && !stdout.includes('No activity found')) {
      target = match[1];
    }
  } catch (e: any) {
    console.warn(`[openUrlRobust] Failed to resolve activity for ${deviceId}: ${e.message}`);
  }

  const startArgs = target 
    ? ['-s', deviceId, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url, target]
    : ['-s', deviceId, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url];
    
  console.log(`[openUrlRobust] Executing am start for ${deviceId}`);
  try {
    const { stdout, stderr } = await execFileAsync('adb', startArgs);
    console.log(`[openUrlRobust] Success: ${stdout} ${stderr}`);
  } catch (e: any) {
    console.error(`[openUrlRobust] Start failed. Exit code: ${e.code}, Stderr: ${e.stderr}, Error: ${e.message}`);
    throw new Error(`Command failed: ${e.stderr || e.message}`);
  }
}

ipcMain.handle('open-link', async (_event, deviceId, url) => {
  try {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { success: false, error: 'Invalid URL format' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { success: false, error: 'Only http: and https: protocols are allowed' };
    }
    await openUrlRobust(deviceId, parsed.toString());
    logAction(deviceId, `Opened link: ${parsed.toString()}`);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('install-apk', async (_event, deviceId, apkPath, sessionId?: string) => {
  const leaseGuard = checkDeviceLeaseGuard(deviceId, sessionId);
  if (!leaseGuard.allowed) {
    return { success: false, error: leaseGuard.error };
  }
  if (!apkPath || typeof apkPath !== 'string' || !apkPath.toLowerCase().endsWith('.apk') || !fs.existsSync(apkPath)) {
    return { success: false, error: 'Invalid or non-existent APK file path' };
  }
  try {
    await client.getDevice(deviceId).install(apkPath);
    logAction(deviceId, `Installed APK: ${apkPath}`);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('update-device-data', (_event, deviceId, data) => {
  deviceStore.updateDevice(deviceId, data);
  broadcastDelta(deviceId, data);
  return true;
});

ipcMain.handle('export-config', async () => {
  if (!mainWindow) return { success: false, error: 'No main window' };
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Device Configuration',
    defaultPath: 'handyfarm-config.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (canceled || !filePath) return { success: false };
  try {
    const devicesList = deviceStore.getAllDevices(false);
    const exportMap: Record<string, Partial<DeviceData>> = {};
    for (const d of devicesList) {
      exportMap[d.id] = {
        customName: d.customName,
        notes: d.notes,
        tags: d.tags,
        isBareBoard: d.isBareBoard
      };
    }
    fs.writeFileSync(filePath, JSON.stringify(exportMap, null, 2));
    return { success: true, path: filePath };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

export function validateDeviceConfigImport(rawJson: unknown): {
  valid: boolean;
  error?: string;
  sanitized?: Record<string, Partial<DeviceData>>;
} {
  const existingDevices = new Set(deviceStore.getAllDevices(false).map(d => d.id));
  return validateConfigImport(rawJson, existingDevices);
}

ipcMain.handle('import-config', async () => {
  if (!mainWindow) return { success: false, error: 'No main window' };
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Device Configuration',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (canceled || filePaths.length === 0) return { success: false };
  try {
    const rawContent = fs.readFileSync(filePaths[0], 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      return { success: false, error: 'Invalid JSON file: parsing failed.' };
    }

    const validation = validateDeviceConfigImport(parsed);
    if (!validation.valid || !validation.sanitized) {
      return { success: false, error: validation.error };
    }

    for (const [id, patch] of Object.entries(validation.sanitized)) {
      deviceStore.updateDevice(id, patch);
      broadcastDelta(id, patch);
    }
    deviceStore.flushWrites();
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('toggle-screen', async (_event, deviceId) => {
  try {
    await client.getDevice(deviceId).shell('input keyevent 26');
    logAction(deviceId, 'Toggled screen power');
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('take-screenshot', async (_event, deviceId) => {
  if (!mainWindow) return { success: false, error: 'No main window' };
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Screenshot',
    defaultPath: `screenshot-${deviceId}-${Date.now()}.png`,
    filters: [{ name: 'Images', extensions: ['png'] }]
  });
  if (canceled || !filePath) return { success: false };
  try {
    const stream = await client.getDevice(deviceId).screencap();
    const writeStream = fs.createWriteStream(filePath);
    stream.pipe(writeStream);
    return new Promise((resolve) => {
      writeStream.on('finish', () => {
        logAction(deviceId, `Saved screenshot to ${filePath}`);
        resolve({ success: true, path: filePath });
      });
      writeStream.on('error', (err) => resolve({ success: false, error: err.message }));
    });
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

const CLIPPER_PACKAGE = 'com.handyfarm.clipper';
const CLIPPER_RECEIVER = `${CLIPPER_PACKAGE}/.ClipperReceiver`;
const CLIPPER_MAIN = `${CLIPPER_PACKAGE}/.Main`;

// NOTE(clipper-foreground): Android 10+ (API 29+) requires window focus to read clipboard data.
// com.handyfarm.clipper/.Main uses a 100% invisible/translucent theme (no animation/UI) to briefly
// acquire focus for reading without visible screen disruption, then dismisses via KEYCODE_BACK.
async function bringClipperToFocus(deviceId: string) {
  await execFileAsync('adb', ['-s', deviceId, 'shell', 'am', 'start', '-W', '-n', CLIPPER_MAIN]).catch(() => {});
}

async function grantCompanionAppOps(deviceId: string) {
  try {
    await execFileAsync('adb', ['-s', deviceId, 'shell', 'appops', 'set', CLIPPER_PACKAGE, 'GET_USAGE_STATS', 'allow']).catch(() => {});
    await execFileAsync('adb', ['-s', deviceId, 'shell', 'appops', 'set', CLIPPER_PACKAGE, 'android:mock_location', 'allow']).catch(() => {});
    await execFileAsync('adb', ['-s', deviceId, 'shell', 'appops', 'set', CLIPPER_PACKAGE, 'ACTIVATE_VPN', 'allow']).catch(() => {});
    // L3 fix: the mock_location appop alone isn't enough — Android also requires the
    // global "mock_location" secure setting to be 1, otherwise the appop is revoked on
    // every process restart. See LIVE-TEST-REPORT.md L3.
    await execFileAsync('adb', ['-s', deviceId, 'shell', 'settings', 'put', 'secure', 'mock_location', '1']).catch(() => {});
  } catch (err: any) {
    console.warn(`[Companion] Auto-granting appops failed for ${deviceId}:`, err?.message || err);
  }
}

async function ensureClipperInstalled(deviceId: string) {
  const clipperPath = getResourcePath('clipper.apk');
  if (!fs.existsSync(clipperPath)) return;
  try {
    const stream = await client.getDevice(deviceId).shell(`pm path ${CLIPPER_PACKAGE}`);
    const out = (await Adb.util.readAll(stream)).toString();
    if (!out.includes('package:')) {
      console.log(`[Clipper] Installing first-party clipper.apk on ${deviceId} from ${clipperPath}...`);
      // First-party com.handyfarm.clipper targets modern SDK 34 and is signed with v2/v3 schemes.
      // Play Protect verification bypass is no longer required.
      try {
        await execFileAsync('adb', ['-s', deviceId, 'install', '-r', '-d', '-g', clipperPath]);
      } catch {
        await client.getDevice(deviceId).install(clipperPath);
      }
      // Automate appops grants on fresh install so no manual per-device intervention is required
      await grantCompanionAppOps(deviceId);
      // Launch once to move package out of stopped state, then dismiss
      await bringClipperToFocus(deviceId);
      await execFileAsync('adb', ['-s', deviceId, 'shell', 'input', 'keyevent', '4']).catch(() => {});
    }
  } catch (err: any) {
    console.warn(`[Clipper] Auto-install check failed for ${deviceId}:`, err?.message || err);
  }
}

async function getCompanionIdentity(deviceId: string): Promise<string | null> {
  try {
    await ensureClipperInstalled(deviceId);
    const stream = await client.getDevice(deviceId).shell(`am broadcast -a handyfarm.identity.get -n ${CLIPPER_RECEIVER}`);
    const buffer = await Adb.util.readAll(stream);
    const output = buffer.toString();
    const match = output.match(/data="([a-f0-9\-]+)"/i);
    return match ? match[1] : null;
  } catch (err: any) {
    console.warn(`[Clipper] getCompanionIdentity failed for ${deviceId}:`, err?.message || err);
    return null;
  }
}

ipcMain.handle('get-companion-identity', async (_event, deviceId: string) => {
  return await getCompanionIdentity(deviceId);
});

interface ClipperInfo {
  installed: boolean;
  version?: string;
  firstInstallTime?: string;
  lastUpdateTime?: string;
  error?: string;
}

ipcMain.handle('get-clipper-info', async (_event, deviceId: string): Promise<ClipperInfo> => {
  try {
    const pmStream = await client.getDevice(deviceId).shell(`pm path ${CLIPPER_PACKAGE}`);
    const pmOut = (await Adb.util.readAll(pmStream)).toString();
    if (!pmOut.includes('package:')) {
      return { installed: false };
    }
    const dStream = await client.getDevice(deviceId).shell(`dumpsys package ${CLIPPER_PACKAGE} | grep -E "versionName=|firstInstallTime=|lastUpdateTime="`);
    const dOut = (await Adb.util.readAll(dStream)).toString();
    const info: ClipperInfo = { installed: true };
    for (const line of dOut.split('\n')) {
      const v = line.match(/versionName=([^\s]+)/);
      if (v) info.version = v[1];
      const f = line.match(/firstInstallTime=([^\s]+)/);
      if (f) info.firstInstallTime = f[1];
      const u = line.match(/lastUpdateTime=([^\s]+)/);
      if (u) info.lastUpdateTime = u[1];
    }
    return info;
  } catch (err: any) {
    return { installed: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('install-clipper', async (_event, deviceId: string): Promise<ClipperInfo> => {
  const apkPath = getResourcePath('clipper.apk');
  if (!fs.existsSync(apkPath)) {
    return { installed: false, error: `clipper.apk not found at ${apkPath}` };
  }
  try {
    // Uninstall first so we get a fresh baseline, then install.
    // -k preserves user data but companion has none, so full uninstall is fine.
    await execFileAsync('adb', ['-s', deviceId, 'uninstall', CLIPPER_PACKAGE]).catch(() => {});
    await execFileAsync('adb', ['-s', deviceId, 'install', '-r', '-d', '-g', apkPath]);
    await grantCompanionAppOps(deviceId);
    await bringClipperToFocus(deviceId);
    await execFileAsync('adb', ['-s', deviceId, 'shell', 'input', 'keyevent', '4']).catch(() => {});
    // Re-query info for the caller
    const dStream = await client.getDevice(deviceId).shell(`dumpsys package ${CLIPPER_PACKAGE} | grep -E "versionName="`);
    const dOut = (await Adb.util.readAll(dStream)).toString();
    const version = dOut.match(/versionName=([^\s]+)/)?.[1];
    return { installed: true, version };
  } catch (err: any) {
    return { installed: false, error: err?.message || String(err) };
  }
});

async function getForegroundApp(deviceId: string): Promise<{ success: boolean; packageName?: string; error?: string; permissionRequired?: boolean }> {
  try {
    await ensureClipperInstalled(deviceId);
    const stream = await client.getDevice(deviceId).shell(`am broadcast -a handyfarm.foreground.get -n ${CLIPPER_RECEIVER}`);
    const buffer = await Adb.util.readAll(stream);
    const output = buffer.toString();
    const match = output.match(/data="(.*)"/s);
    if (!match || !match[1]) {
      return { success: false, error: 'Failed to read broadcast output from companion app' };
    }
    const data = match[1].trim();
    if (data.startsWith('STATUS_PERMISSION_REQUIRED')) {
      // Auto-remediation: attempt granting via ADB and retry once automatically
      console.log(`[Companion] Auto-granting GET_USAGE_STATS via ADB for ${deviceId}...`);
      await execFileAsync('adb', ['-s', deviceId, 'shell', 'appops', 'set', CLIPPER_PACKAGE, 'GET_USAGE_STATS', 'allow']).catch(() => {});
      const retryStream = await client.getDevice(deviceId).shell(`am broadcast -a handyfarm.foreground.get -n ${CLIPPER_RECEIVER}`);
      const retryBuffer = await Adb.util.readAll(retryStream);
      const retryMatch = retryBuffer.toString().match(/data="(.*)"/s);
      const retryData = retryMatch ? retryMatch[1].trim() : '';
      if (!retryData.startsWith('STATUS_PERMISSION_REQUIRED') && retryData.length > 0) {
        return { success: true, packageName: retryData };
      }
      return {
        success: false,
        permissionRequired: true,
        error: 'PACKAGE_USAGE_STATS permission is required. Enable via Settings -> Apps -> Special app access -> Usage access, or run: adb shell appops set com.handyfarm.clipper GET_USAGE_STATS allow'
      };
    }
    return { success: true, packageName: data };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

ipcMain.handle('get-foreground-app', async (_event, deviceId: string) => {
  return await getForegroundApp(deviceId);
});

async function setMockLocation(deviceId: string, lat: number, lng: number): Promise<{ success: boolean; error?: string; permissionRequired?: boolean }> {
  try {
    await ensureClipperInstalled(deviceId);
    const stream = await client.getDevice(deviceId).shell(`am broadcast -a handyfarm.location.set -n ${CLIPPER_RECEIVER} --ef lat ${lat} --ef lng ${lng}`);
    const buffer = await Adb.util.readAll(stream);
    const output = buffer.toString();
    const match = output.match(/data="(.*)"/s);
    if (!match || !match[1]) {
      return { success: false, error: 'Failed to read broadcast output from companion app' };
    }
    const data = match[1].trim();
    if (data.startsWith('STATUS_PERMISSION_REQUIRED')) {
      // Auto-remediation: attempt granting via ADB and retry once automatically
      console.log(`[Companion] Auto-granting android:mock_location via ADB for ${deviceId}...`);
      await execFileAsync('adb', ['-s', deviceId, 'shell', 'appops', 'set', CLIPPER_PACKAGE, 'android:mock_location', 'allow']).catch(() => {});
      const retryStream = await client.getDevice(deviceId).shell(`am broadcast -a handyfarm.location.set -n ${CLIPPER_RECEIVER} --ef lat ${lat} --ef lng ${lng}`);
      const retryBuffer = await Adb.util.readAll(retryStream);
      const retryMatch = retryBuffer.toString().match(/data="(.*)"/s);
      const retryData = retryMatch ? retryMatch[1].trim() : '';
      if (retryData.startsWith('OK:')) {
        return { success: true };
      }
      return {
        success: false,
        permissionRequired: true,
        error: retryData || data
      };
    }
    if (data.startsWith('ERROR:')) {
      return { success: false, error: data };
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

ipcMain.handle('set-mock-location', async (_event, deviceId: string, lat: number, lng: number) => {
  return await setMockLocation(deviceId, lat, lng);
});

async function getMockLocation(deviceId: string): Promise<{ success: boolean; lat?: number; lng?: number; mockAllowed?: boolean; error?: string }> {
  try {
    await ensureClipperInstalled(deviceId);
    const stream = await client.getDevice(deviceId).shell(`am broadcast -a handyfarm.location.get -n ${CLIPPER_RECEIVER}`);
    const buffer = await Adb.util.readAll(stream);
    const output = buffer.toString();
    const match = output.match(/data="(.*)"/s);
    if (!match || !match[1]) {
      return { success: false, error: 'Failed to read broadcast output from companion app' };
    }
    const data = match[1].trim();
    const mockAllowed = data.includes('mock_allowed=true');
    const latMatch = data.match(/lat=([\-0-9\.]+)/);
    const lngMatch = data.match(/lng=([\-0-9\.]+)/);
    return {
      success: true,
      lat: latMatch ? parseFloat(latMatch[1]) : undefined,
      lng: lngMatch ? parseFloat(lngMatch[1]) : undefined,
      mockAllowed
    };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

ipcMain.handle('get-mock-location', async (_event, deviceId: string) => {
  return await getMockLocation(deviceId);
});

export async function captureBaseline(deviceId: string): Promise<{ success: boolean; manifest?: BaselineManifest; error?: string }> {
  try {
    const dev = deviceStore.getDevice(deviceId);
    const physId = dev?.physicalDeviceId || `phys_${dev?.serial || deviceId}`;
    const manifest = await captureDeviceManifest(deviceId, physId, (args) => execFileAsync('adb', args));
    deviceStore.saveBaseline(manifest);
    deviceStore.logDeviceAction(deviceId, `Baseline manifest captured at ${new Date(manifest.capturedAt).toISOString()}`);
    broadcastDelta(deviceId, {
      baselineStatus: 'verified',
      driftCount: 0,
      driftWarnings: [],
      lastBaselineAt: manifest.capturedAt,
      lastVerifiedAt: manifest.capturedAt
    });
    return { success: true, manifest };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

export async function verifyBaseline(deviceId: string): Promise<{ success: boolean; result?: BaselineVerificationResult; error?: string }> {
  try {
    const dev = deviceStore.getDevice(deviceId);
    const physId = dev?.physicalDeviceId || `phys_${dev?.serial || deviceId}`;
    const manifest = deviceStore.getBaseline(physId) || deviceStore.getBaseline(deviceId);
    if (!manifest) {
      return { success: false, error: `No baseline captured for device '${deviceId}'. Run baseline capture first.` };
    }

    const result = await verifyDeviceAgainstBaseline(deviceId, manifest, (args) => execFileAsync('adb', args));
    deviceStore.recordDriftVerification(deviceId, result);
    deviceStore.logDeviceAction(deviceId, `Baseline verified: ${result.verified ? 'OK (0 drift)' : `${result.diffs.length} drift items`}`);
    broadcastDelta(deviceId, {
      baselineStatus: result.verified ? 'verified' : 'drifted',
      driftCount: result.diffs.length,
      driftWarnings: result.diffs.map(d => d.description || `${d.field}: expected ${JSON.stringify(d.expected)}, got ${JSON.stringify(d.actual)}`),
      lastVerifiedAt: result.verifiedAt
    });
    return { success: true, result };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * FULL BASELINE RESET (§1.2 & §1.4).
 * Replaces the legacy ephemeral-only reset.baseline (which only cleared mock location,
 * clipboard, system dialogs, animation scales, and VPN).
 *
 * This is now a full verified baseline reset, NOT an ephemeral UI-state clear:
 * 1. Enforces lease-guard to prevent execution conflicts during testing.
 * 2. Clears app data via `pm clear` for all third-party apps (exempting first-party companion com.handyfarm.clipper).
 * 3. Uninstalls any apps installed after baseline capture.
 * 4. Revokes permissions granted beyond baseline.
 * 5. Removes user accounts created since baseline.
 * 6. Restores animation scales and system settings.
 * 7. Executes companion app cleanup (mock location, clipboard, VPN).
 * 8. Immediately runs verification to produce and broadcast a verified post-reset status.
 */
export async function resetDeviceToBaseline(deviceId: string, sessionId?: string): Promise<{
  success: boolean;
  actions?: string[];
  verification?: BaselineVerificationResult;
  error?: string;
}> {
  // 1. Enforce lease guard
  const leaseGuard = checkDeviceLeaseGuard(deviceId, sessionId);
  if (!leaseGuard.allowed) {
    return { success: false, error: leaseGuard.error };
  }

  try {
    await ensureClipperInstalled(deviceId);

    const dev = deviceStore.getDevice(deviceId);
    const physId = dev?.physicalDeviceId || `phys_${dev?.serial || deviceId}`;
    const manifest = deviceStore.getBaseline(physId) || deviceStore.getBaseline(deviceId);

    const broadcastReset = async () => {
      const stream = await client.getDevice(deviceId).shell(`am broadcast -a handyfarm.reset.baseline -n ${CLIPPER_RECEIVER}`);
      await Adb.util.readAll(stream);
    };

    const resetResult = await executeFullBaselineReset(
      deviceId,
      manifest,
      (args) => execFileAsync('adb', args),
      broadcastReset
    );

    if (resetResult.verification) {
      deviceStore.recordDriftVerification(deviceId, resetResult.verification);
      broadcastDelta(deviceId, {
        baselineStatus: resetResult.verification.verified ? 'verified' : 'drifted',
        driftCount: resetResult.verification.diffs.length,
        driftWarnings: resetResult.verification.diffs.map(d => d.description || `${d.field}: expected ${JSON.stringify(d.expected)}, got ${JSON.stringify(d.actual)}`),
        lastVerifiedAt: resetResult.verification.verifiedAt
      });
    }

    deviceStore.logDeviceAction(deviceId, `Full baseline reset executed (${resetResult.actions.length} actions)`);

    return resetResult;
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

ipcMain.handle('capture-device-baseline', async (_event, deviceId: string) => {
  return await captureBaseline(deviceId);
});

ipcMain.handle('verify-device-baseline', async (_event, deviceId: string) => {
  return await verifyBaseline(deviceId);
});

ipcMain.handle('reset-device-to-baseline', async (_event, deviceId: string, sessionId?: string) => {
  return await resetDeviceToBaseline(deviceId, sessionId);
});

ipcMain.handle('get-device-baseline', async (_event, deviceId: string) => {
  return deviceStore.getBaseline(deviceId);
});

async function getVpnStatus(deviceId: string): Promise<{ success: boolean; status?: any; error?: string }> {
  try {
    await ensureClipperInstalled(deviceId);
    const stream = await client.getDevice(deviceId).shell(`am broadcast -a handyfarm.vpn.status -n ${CLIPPER_RECEIVER}`);
    const buffer = await Adb.util.readAll(stream);
    const output = buffer.toString();
    const match = output.match(/data="(.*)"/s);
    if (!match || !match[1]) {
      return { success: false, error: 'Failed to read VPN status from companion app' };
    }
    try {
      const parsed = JSON.parse(match[1]);
      return { success: true, status: parsed };
    } catch {
      return { success: true, status: { raw: match[1] } };
    }
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

async function connectVpn(deviceId: string, config: {
  targetPackage: string;
  serverEndpoint: string;
  clientPrivateKey: string;
  serverPublicKey: string;
  clientIp?: string;
  allowedIp?: string;
  dns?: string;
  mtu?: number;
}): Promise<{ success: boolean; status?: any; error?: string }> {
  try {
    await ensureClipperInstalled(deviceId);
    if (!config || !config.targetPackage) {
      return { success: false, error: 'Missing targetPackage in VPN configuration' };
    }
    if (!config.serverEndpoint) {
      return { success: false, error: 'Missing serverEndpoint in VPN configuration' };
    }
    if (!config.clientPrivateKey || !config.serverPublicKey) {
      return { success: false, error: 'Missing clientPrivateKey or serverPublicKey in VPN configuration' };
    }

    // Hard requirement: prevent self-lockout of adb shell and companion agent
    if (config.targetPackage === 'com.android.shell' || config.targetPackage === CLIPPER_PACKAGE) {
      return { success: false, error: 'Self-lockout prevented: cannot route ADB shell or companion agent through VPN' };
    }

    // Build broadcast command
    const args = [
      '-s', deviceId, 'shell', 'am', 'broadcast',
      '-a', 'handyfarm.vpn.connect',
      '-n', CLIPPER_RECEIVER,
      '--es', 'target_package', config.targetPackage,
      '--es', 'server_endpoint', config.serverEndpoint,
      '--es', 'client_private_key', config.clientPrivateKey,
      '--es', 'server_public_key', config.serverPublicKey
    ];
    if (config.clientIp) {
      args.push('--es', 'client_ip', config.clientIp);
    }
    if (config.allowedIp) {
      args.push('--es', 'allowed_ip', config.allowedIp);
    }
    if (config.dns) {
      args.push('--es', 'dns', config.dns);
    }
    if (config.mtu) {
      args.push('--ei', 'mtu', String(config.mtu));
    }

    const { stdout } = await execFileAsync('adb', args);
    if (stdout.includes('STATUS_PERMISSION_REQUIRED')) {
      console.log(`[Companion] Auto-granting ACTIVATE_VPN via ADB for ${deviceId}...`);
      await execFileAsync('adb', ['-s', deviceId, 'shell', 'appops', 'set', CLIPPER_PACKAGE, 'ACTIVATE_VPN', 'allow']).catch(() => {});
      // Retry broadcast
      await execFileAsync('adb', args);
    }

    // Wait briefly for tunnel activation and query status
    await new Promise(r => setTimeout(r, 1000));
    const statusRes = await getVpnStatus(deviceId);
    if (statusRes.success && statusRes.status?.status === 'CONNECTED') {
      logAction(deviceId, `Connected VPN tunnel for ${config.targetPackage} -> ${config.serverEndpoint}`);
      return { success: true, status: statusRes.status };
    } else if (statusRes.status?.status === 'ERROR') {
      return { success: false, status: statusRes.status, error: statusRes.status?.error || 'VPN connection failed' };
    }
    return { success: true, status: statusRes.status };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

async function disconnectVpn(deviceId: string): Promise<{ success: boolean; status?: any; error?: string }> {
  try {
    await ensureClipperInstalled(deviceId);
    await execFileAsync('adb', ['-s', deviceId, 'shell', 'am', 'broadcast', '-a', 'handyfarm.vpn.disconnect', '-n', CLIPPER_RECEIVER]);
    await new Promise(r => setTimeout(r, 500));
    const statusRes = await getVpnStatus(deviceId);
    logAction(deviceId, 'Disconnected VPN tunnel');
    return { success: true, status: statusRes.status };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

ipcMain.handle('connect-vpn', async (_event, deviceId: string, config: any) => {
  return await connectVpn(deviceId, config);
});

ipcMain.handle('disconnect-vpn', async (_event, deviceId: string) => {
  return await disconnectVpn(deviceId);
});

ipcMain.handle('get-vpn-status', async (_event, deviceId: string) => {
  return await getVpnStatus(deviceId);
});

ipcMain.handle('sync-clipboard', async (_event, deviceId, direction, text, sessionId?: string) => {
  const leaseGuard = checkDeviceLeaseGuard(deviceId, sessionId);
  if (!leaseGuard.allowed) {
    return { success: false, error: leaseGuard.error };
  }
  try {
    await ensureClipperInstalled(deviceId);
    if (direction === 'toDevice') {
      // L5 fix: file-based transport. The previous implementation base64-encoded the text
      // and shell-decoded it inside `adb shell` to avoid quote-escape issues — but the
      // surrounding `"$RAW"` is still vulnerable to special chars that base64 doesn't
      // transform, and a base64 string itself can include shell-meaningful chars.
      //
      // The new path: write text to a host-side temp file, `adb push` it to the device
      // (no shell on either side — adb push is a binary file transfer), then broadcast
      // a fixed-shape path to a new companion action `handyfarm.clipboard.set.path`.
      // The companion reads the file and deletes it. End-to-end, the text never
      // touches a shell.
      const rand = Math.random().toString(36).slice(2, 8);
      const filename = `handyfarm_clip_${Date.now()}_${rand}.txt`;
      const devicePath = `/data/local/tmp/${filename}`;
      const hostTmp = path.join(os.tmpdir(), `handyfarm_clip_${Date.now()}_${rand}.txt`);
      await fs.promises.writeFile(hostTmp, text || '', 'utf-8');
      try {
        await execFileAsync('adb', ['-s', deviceId, 'push', hostTmp, devicePath]);
        await execFileAsync('adb', [
          '-s', deviceId, 'shell', 'am', 'broadcast',
          '-a', 'handyfarm.clipboard.set.path',
          '-n', CLIPPER_RECEIVER,
          '--es', 'path', devicePath
        ]);
        // Clean up the device-side temp file. The companion app's UID is not the shell UID,
            // and on Android 14 the /data/local/tmp/ directory is shell:shell 0770, so the
            // companion's own f.delete() returns false silently. Use adb to clean up since
            // adb shell runs as the shell UID.
        await execFileAsync('adb', ['-s', deviceId, 'shell', 'rm', '-f', devicePath]).catch(() => {});
      } finally {
        await fs.promises.unlink(hostTmp).catch(() => {});
      }
      logAction(deviceId, 'Synced clipboard to device (file-based, safe transport)');
      return { success: true };
    } else if (direction === 'fromDevice') {
      console.log(`[IPC] sync-clipboard called fromDevice for ${deviceId}`);
      // On Android 10+ (API 29+), reading clipboard requires the helper app to have foreground focus
      await bringClipperToFocus(deviceId);

      const stream = await client.getDevice(deviceId).shell(`am broadcast -a clipper.get -n ${CLIPPER_RECEIVER}`);
      const buffer = await Adb.util.readAll(stream);
      const output = buffer.toString();

      // Send KEYCODE_BACK to return to the previous screen
      await execFileAsync('adb', ['-s', deviceId, 'shell', 'input', 'keyevent', '4']).catch(() => {});

      console.log(`[IPC] Broadcast output:`, output);
      const match = output.match(/data="(.*)"/s);
      if (match && match[1] !== undefined) {
        console.log(`[IPC] Regex match found, clipText:`, match[1]);
        clipboard.writeText(match[1]);
        logAction(deviceId, 'Synced clipboard from device');
        return { success: true, text: match[1] };
      } else {
        console.log(`[IPC] Regex match FAILED.`);
        return { success: false, error: 'Could not read clipboard. Helper APK might be missing or clipboard is empty.' };
      }
    } else {
      return { success: false, error: 'Invalid direction' };
    }
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('switch-to-wireless', async (_event, deviceId, sessionId?: string) => {
  const leaseGuard = checkDeviceLeaseGuard(deviceId, sessionId);
  if (!leaseGuard.allowed) {
    return { success: false, error: leaseGuard.error };
  }
  try {
    // 1. Restart ADB in TCP/IP mode on port 5555
    await execFileAsync('adb', ['-s', deviceId, 'tcpip', '5555']);
    
    // Wait a brief moment for the adbd daemon on device to restart in tcpip mode
    await new Promise(res => setTimeout(res, 2000));
    
    // 2. Fetch the device's IP address (wlan0)
    const { stdout } = await execFileAsync('adb', ['-s', deviceId, 'shell', 'ip', 'route']);
    // Output looks like: "192.168.1.0/24 dev wlan0 proto kernel scope link src 192.168.1.10"
    const match = stdout.match(/src (\d+\.\d+\.\d+\.\d+)/);
    
    if (!match || !match[1]) {
      return { success: false, error: 'Could not detect device IP address. Is Wi-Fi connected?' };
    }
    
    const ip = match[1];
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
      return { success: false, error: 'Invalid IP address detected from device route' };
    }
    
    // 3. Connect to the device via its IP
    const { stdout: connectOutput } = await execFileAsync('adb', ['connect', `${ip}:5555`]);
    
    if (connectOutput.includes('failed') || connectOutput.includes('cannot connect')) {
      return { success: false, error: `Failed to connect to ${ip}:5555` };
    }
    
    // Proactively dedupe and merge the USB device into the new WiFi transport NOW
    const oldId = deviceId;
    const newId = `${ip}:5555`;
    const oldWorker = workers.get(oldId);
    if (oldWorker) {
      workerGenerations.set(oldId, (workerGenerations.get(oldId) || 0) + 1);
      oldWorker.kill();
      workers.delete(oldId);
    }
    const active = activeLiveViews.get(oldId);
    if (active) {
      try { active.ws.close(); active.client.close(); } catch(e) {}
      activeLiveViews.delete(oldId);
    }
    if (deviceStore.hasDevice(oldId)) {
      deviceStore.updateDevice(oldId, { lastKnownIp: ip });
      const merged = deviceStore.mergeDevices(newId, oldId);
      broadcastDelta(oldId, {}, true);
      broadcastDelta(newId, merged);
    }

    logAction(newId, `Switched to Wireless ADB (${ip}:5555)`);
    return { success: true, ip };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('send-text', async (_event, deviceId, text, sessionId?: string) => {
  const leaseGuard = checkDeviceLeaseGuard(deviceId, sessionId);
  if (!leaseGuard.allowed) {
    return { success: false, error: leaseGuard.error };
  }
  return await sendTextToDevice({
    deviceId,
    text,
    ensureClipperInstalled,
    execShell: async (_devId, cmd) => {
      await execFileAsync('adb', ['-s', deviceId, 'shell', cmd]);
    },
    logAction,
    clipperReceiver: CLIPPER_RECEIVER
  });
});

ipcMain.handle('push-file', async (_event, deviceId, localPath, remotePath, sessionId?: string) => {
  const leaseGuard = checkDeviceLeaseGuard(deviceId, sessionId);
  if (!leaseGuard.allowed) {
    return { success: false, error: leaseGuard.error };
  }
  if (!localPath || typeof localPath !== 'string' || !fs.existsSync(localPath)) {
    return { success: false, error: 'Local file does not exist' };
  }
  if (!remotePath || typeof remotePath !== 'string' || !remotePath.startsWith('/')) {
    return { success: false, error: 'Remote path must be an absolute Android path starting with /' };
  }
  try {
    await client.getDevice(deviceId).push(localPath, remotePath);
    logAction(deviceId, `Pushed file to ${remotePath}`);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('pull-file', async (_event, deviceId, remotePath, localPath) => {
  if (!remotePath || typeof remotePath !== 'string' || !remotePath.startsWith('/')) {
    return { success: false, error: 'Remote path must be an absolute Android path starting with /' };
  }
  if (!localPath || typeof localPath !== 'string') {
    return { success: false, error: 'Invalid destination file path' };
  }
  try {
    const transfer = await client.getDevice(deviceId).pull(remotePath);
    return new Promise((resolve) => {
      const writeStream = fs.createWriteStream(localPath);
      transfer.on('end', () => {
        logAction(deviceId, `Pulled file to ${localPath}`);
        resolve({ success: true });
      });
      transfer.on('error', (err: any) => resolve({ success: false, error: err.message }));
      transfer.pipe(writeStream);
    });
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('launch-app', async (_event, deviceId, packageName) => {
  try {
    if (!isValidPackageName(packageName)) {
      return { success: false, error: 'Invalid package name format' };
    }
    await execFileAsync('adb', ['-s', deviceId, 'shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1']);
    logAction(deviceId, `Launched app: ${packageName}`);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('clear-app-cache', async (_event, deviceId, packageName, sessionId?: string) => {
  const leaseGuard = checkDeviceLeaseGuard(deviceId, sessionId);
  if (!leaseGuard.allowed) {
    return { success: false, error: leaseGuard.error };
  }
  try {
    if (!isValidPackageName(packageName)) {
      return { success: false, error: 'Invalid package name format' };
    }
    await execFileAsync('adb', ['-s', deviceId, 'shell', 'pm', 'clear', packageName]);
    logAction(deviceId, `Cleared cache for: ${packageName}`);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('check-adb-status', async () => {
  try {
    const version = await client.version();
    return { success: true, connected: true, version };
  } catch (err) {
    return { success: true, connected: false };
  }
});

let expertModeEnabled = false;

// L7 fix: typed allowlist for diagnostic adb commands. The module is pure — no
// side effects on import — so tests can require it directly. See electron/safeAdb.ts.
import { parseAllowedCommand, isSafeAdbCommand, ALLOWED_OPS } from './safeAdb.js';
export { parseAllowedCommand, isSafeAdbCommand, ALLOWED_OPS };
import { Scheduler } from './scheduler.js';

// Phase 4: fleet health + safety + adaptive cap.
import { HealthMonitor } from './healthMonitor.js';
import { getAdaptiveConcurrencyCap, estimateFleetBandwidthKbps } from './power.js';

ipcMain.handle('get-expert-mode', () => expertModeEnabled);
ipcMain.handle('set-expert-mode', (_event, enabled: boolean) => {
  expertModeEnabled = Boolean(enabled);
  return { success: true, expertMode: expertModeEnabled };
});

ipcMain.handle('run-adb-command', async (_event, deviceId, command, sessionId?: string) => {
  const leaseGuard = checkDeviceLeaseGuard(deviceId, sessionId);
  if (!leaseGuard.allowed) {
    return { success: false, error: leaseGuard.error };
  }

  // L7 fix: always parse into a typed operation; only allowlist-derived args reach
  // the device shell, never the raw input string. With expert mode ON, the same
  // allowlist still applies — the difference is that expert mode skips the
  // "must be a recognized diagnostic command" requirement but cannot bypass the
  // shell-metachar / ARG_RE validation.
  const parsed = parseAllowedCommand(command);
  if (!parsed.ok) {
    if (expertModeEnabled) {
      // Expert mode allows the user to run any command, but the typed-args path is
      // still required to prevent shell injection from the device-id shell.
      return {
        success: false,
        error: `Expert mode is enabled, but every command — even expert ones — must pass the typed allowlist. Reason: ${parsed.error}. ` +
               `To extend the allowlist, edit ALLOWED_OPS in electron/main.ts and add a test in tests/safe-adb-allowlist.test.ts.`
      };
    }
    return {
      success: false,
      error: `Command blocked: ${parsed.error}. Only allowlisted diagnostic commands (getprop, dumpsys, pm list, ip, etc.) are accepted. ` +
             `Enable Expert Mode to allow additional commands (still typed-allowlisted).`
    };
  }

  // Construct the device-side command from validated args. No interpolation.
  const deviceCmd = parsed.args.join(' ');
  try {
    const stream = await client.getDevice(deviceId).shell(deviceCmd);
    const output = await Adb.util.readAll(stream);
    const rawOutput = output.toString();
    const finalOutput = deviceCmd.startsWith('logcat') || deviceCmd.includes(' logcat')
      ? redactLogcatText(rawOutput)
      : rawOutput;
    logAction(deviceId, `Ran command: ${deviceCmd}`);
    return { success: true, output: finalOutput };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('open-settings', async (_event, deviceId, intent) => {
  try {
    let action = '';
    if (intent === 'wifi') action = 'android.settings.WIFI_SETTINGS';
    if (intent === 'ime') action = 'android.settings.INPUT_METHOD_SETTINGS';
    if (intent === 'accessibility') action = 'android.settings.ACCESSIBILITY_SETTINGS';
    if (!action) return { success: false, error: 'Invalid settings intent' };
    await execFileAsync('adb', ['-s', deviceId, 'shell', 'am', 'start', '-a', action]);
    logAction(deviceId, `Opened settings: ${intent}`);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('locate-device', async (_event, deviceId) => {
  try {
    // Wake screen
    await execFileAsync('adb', ['-s', deviceId, 'shell', 'input', 'keyevent', '224']).catch(() => {});
    // Vibrate for 1 second
    await execFileAsync('adb', ['-s', deviceId, 'shell', 'cmd', 'vibrator', 'vibrate', '1000']).catch(() => {});
    // Flash bright red color using browser VIEW intent
    const dataUri = 'data:text/html,%3Chtml%3E%3Cbody%20style=%22background:red;%22%3E%3C/body%3E%3C/html%3E';
    await openUrlRobust(deviceId, dataUri).catch((e) => {
      console.warn(`[Locate Device] Failed to open red screen for ${deviceId}: ${e.message}`);
    });
    logAction(deviceId, 'Located device');
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

export function redactLogcatText(text: string): string {
  if (!text) return text;
  let redacted = text;
  // 1. JWT tokens
  redacted = redacted.replace(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]');
  // 2. Authorization headers (Bearer / Basic / Token)
  redacted = redacted.replace(/(authorization\s*:\s*(?:bearer|basic|token)\s+)[^\s\r\n]+/gi, '$1[REDACTED]');
  // 3. Key-value secrets (password, secret, apiKey, token, etc.)
  redacted = redacted.replace(
    /(["']?(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?id|private[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;&}]+/gi,
    '$1[REDACTED]'
  );
  // 4. Basic Auth credentials in URLs
  redacted = redacted.replace(/(https?:\/\/)([^:\/\s]+):([^@\/\s]+)@/g, '$1[USER]:[REDACTED]@');
  // 5. PEM private keys
  redacted = redacted.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
  return redacted;
}

const activeLogcats = new Map<string, ChildProcess>();
ipcMain.handle('start-logcat', async (event, deviceId) => {
  try {
    if (activeLogcats.has(deviceId)) {
      activeLogcats.get(deviceId)?.kill();
    }
    const proc = spawn('adb', ['-s', deviceId, 'logcat', '-v', 'time']);
    proc.stdout?.on('data', (data: any) => {
       const cleaned = redactLogcatText(data.toString());
       event.sender.send(`logcat-data-${deviceId}`, cleaned);
    });
    proc.stderr?.on('data', (data: any) => {
       const cleaned = redactLogcatText(data.toString());
       event.sender.send(`logcat-data-${deviceId}`, cleaned);
    });
    activeLogcats.set(deviceId, proc);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('stop-logcat', async (_event, deviceId) => {
  if (activeLogcats.has(deviceId)) {
    activeLogcats.get(deviceId)?.kill();
    activeLogcats.delete(deviceId);
  }
  return { success: true };
});

const secureAccountsPath = path.join(app.getPath('userData'), 'secure-accounts.json');

function readSecureAccounts() {
  if (fs.existsSync(secureAccountsPath)) {
    try {
      return JSON.parse(fs.readFileSync(secureAccountsPath, 'utf8'));
    } catch {
      return {};
    }
  }
  return {};
}

function writeSecureAccounts(data: any) {
  fs.writeFileSync(secureAccountsPath, JSON.stringify(data));
}

ipcMain.handle('save-test-account-password', async (_event, accountId, password) => {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      return { success: false, error: 'Secure storage unavailable on this system; password not saved' };
    }
    const data = readSecureAccounts();
    data[accountId] = safeStorage.encryptString(password).toString('base64');
    writeSecureAccounts(data);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-test-account-password', async (_event, accountId) => {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      return { success: false, error: 'Secure storage unavailable on this system' };
    }
    const data = readSecureAccounts();
    const encryptedBase64 = data[accountId];
    if (!encryptedBase64) return { success: true, password: '' };

    const buf = Buffer.from(encryptedBase64, 'base64');
    return { success: true, password: safeStorage.decryptString(buf) };
  } catch (e: any) {
    return { success: false, error: 'Failed to decrypt password' };
  }
});

ipcMain.handle('scan-mdns', async () => {
  try {
    const { stdout } = await execFileAsync('adb', ['mdns', 'services']);
    const lines = stdout.split('\n').map(l => l.trim()).filter(l => l);
    const discovered: { name: string; ip: string; serial?: string }[] = [];
    
    for (const line of lines) {
      if (line.includes('List of')) continue;
      const tokens = line.split(/\s+/);
      const ipToken = tokens.find(t => t.match(/\d+\.\d+\.\d+\.\d+:\d+/));
      if (ipToken) {
        let serial = undefined; const nameMatch = tokens[0].match(/adb-(.*?)-/); if (nameMatch) { serial = nameMatch[1]; } discovered.push({ name: tokens[0], ip: ipToken, serial });
      }
    }
    return discovered;
  } catch (e) {
    return [];
  }
});

ipcMain.handle('connect-ip', async (_event, ip) => {
  try {
    const trimmed = (ip || '').trim();
    if (!/^([0-9]{1,3}\.){3}[0-9]{1,3}(:[0-9]{1,5})?$/.test(trimmed)) {
      return { success: false, error: 'Invalid IP address format. Expected IPv4 or IPv4:port.' };
    }
    const { stdout } = await execFileAsync('adb', ['connect', trimmed]);
    if (stdout.includes('failed') || stdout.includes('cannot connect')) {
      return { success: false, error: stdout };
    }
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});




import AppInfoParser from 'app-info-parser';

ipcMain.handle('browse-apk', async () => {
  try {
    const res = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'APK Files', extensions: ['apk'] }]
    });
    if (res.canceled || res.filePaths.length === 0) return { success: false };
    const filePath = res.filePaths[0];
    const stat = fs.statSync(filePath);
    let packageName = null;
    try {
      const parser = new AppInfoParser(filePath);
      const result = await parser.parse();
      packageName = result.package;
    } catch (e) {
      console.error('Failed to parse APK:', e);
    }
    return { success: true, path: filePath, name: path.basename(filePath), size: stat.size, packageName };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('parse-apk', async (_event, filePath: string) => {
  try {
    const stat = fs.statSync(filePath);
    const parser = new AppInfoParser(filePath);
    const result = await parser.parse();
    return { success: true, path: filePath, name: path.basename(filePath), size: stat.size, packageName: result.package };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-installed-packages', async (_event, deviceId: string) => {
  try {
    const stream = await client.getDevice(deviceId).shell('pm list packages -3');
    const output = await Adb.util.readAll(stream);
    const text = output.toString();
    const packages = text.split('\n')
      .map((l: string) => l.trim())
      .filter((l: string) => l.startsWith('package:'))
      .map((l: string) => l.replace('package:', ''));
    return { success: true, packages };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-physical-device-mappings', async () => {
  return deviceStore.getAllPhysicalMappings();
});

ipcMain.handle('get-physical-device-mapping', async (_event, physicalDeviceId: string) => {
  return deviceStore.getPhysicalMapping(physicalDeviceId);
});

// --- Phase 5 Lease Management IPC Handlers ---

ipcMain.handle('acquire-lease', async (_event, physicalDeviceId: string, sessionId: string, ttlMinutes?: number) => {
  const res = deviceStore.acquireLease(physicalDeviceId, sessionId, ttlMinutes);
  if (res.success && res.lease) {
    for (const devId of res.affectedDeviceIds) {
      const dev = deviceStore.getDevice(devId);
      if (dev) {
        broadcastDelta(devId, {
          leaseState: res.lease.state,
          leasedBy: res.lease.leasedBy,
          leaseExpiresAt: res.lease.leaseExpiresAt,
          lastHeartbeatAt: res.lease.lastHeartbeatAt
        });
      }
    }
  }
  return res;
});

ipcMain.handle('release-lease', async (_event, physicalDeviceId: string, sessionId: string) => {
  const res = deviceStore.releaseLease(physicalDeviceId, sessionId);
  if (res.success) {
    const lease = deviceStore.getLease(physicalDeviceId);
    for (const devId of res.affectedDeviceIds) {
      broadcastDelta(devId, {
        leaseState: lease.state,
        leasedBy: lease.leasedBy ?? (null as any),
        leaseExpiresAt: lease.leaseExpiresAt ?? (null as any),
        lastHeartbeatAt: lease.lastHeartbeatAt ?? (null as any)
      });
    }
  }
  return res;
});

ipcMain.handle('heartbeat-lease', async (_event, physicalDeviceId: string, sessionId: string, extensionMinutes?: number) => {
  const res = deviceStore.heartbeatLease(physicalDeviceId, sessionId, extensionMinutes);
  if (res.success) {
    const lease = deviceStore.getLease(physicalDeviceId);
    for (const devId of res.affectedDeviceIds) {
      broadcastDelta(devId, {
        leaseState: lease.state,
        leasedBy: lease.leasedBy ?? (null as any),
        leaseExpiresAt: lease.leaseExpiresAt ?? (null as any),
        lastHeartbeatAt: lease.lastHeartbeatAt ?? (null as any)
      });
    }
  }
  return res;
});

ipcMain.handle('set-device-lease-state', async (_event, physicalDeviceId: string, state: any, sessionId?: string) => {
  const res = deviceStore.setDeviceLeaseState(physicalDeviceId, state, sessionId);
  if (res.success) {
    const lease = deviceStore.getLease(physicalDeviceId);
    for (const devId of res.affectedDeviceIds) {
      broadcastDelta(devId, {
        leaseState: lease.state,
        leasedBy: lease.leasedBy ?? (null as any),
        leaseExpiresAt: lease.leaseExpiresAt ?? (null as any),
        lastHeartbeatAt: lease.lastHeartbeatAt ?? (null as any)
      });
    }
  }
  return res;
});

// ----- Phase 4: fleet health IPC -----

ipcMain.handle('get-fleet-health', async () => {
  const fleet = deviceStore.getAllPhysicalDeviceHealth();
  return {
    total: fleet.length,
    devices: fleet.map(pd => ({
      physicalDeviceId: pd.physicalDeviceId,
      healthScore: pd.healthScore,
      reasons: JSON.parse(pd.healthReasonsJson || '[]'),
      lastEvaluatedAt: pd.healthLastEvaluatedAt,
      leaseState: deviceStore.getLease(pd.physicalDeviceId).state,
      propsAttempts: pd.propsAttempts,
      propsFailures: pd.propsFailures,
      reconnectCount: pd.reconnectCount,
    })),
  };
});

ipcMain.handle('get-device-health', async (_event, deviceId: string) => {
  let physId = deviceId;
  const dev = deviceStore.getDevice(deviceId);
  if (dev?.physicalDeviceId) physId = dev.physicalDeviceId;
  const mapping = deviceStore.getPhysicalMapping(deviceId);
  if (!dev && mapping?.physicalDeviceId) physId = mapping.physicalDeviceId;

  const health = deviceStore.getPhysicalDeviceHealth(physId);
  const lease = deviceStore.getLease(physId);
  return {
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
  };
});

ipcMain.handle('evaluate-health-now', async () => {
  if (!healthMonitor) return { evaluated: 0, transitions: 0 };
  return healthMonitor.tick();
});

ipcMain.handle('manual-quarantine', async (_event, deviceId: string, reason?: string) => {
  let physId = deviceId;
  const dev = deviceStore.getDevice(deviceId);
  if (dev?.physicalDeviceId) physId = dev.physicalDeviceId;
  const mapping = deviceStore.getPhysicalMapping(deviceId);
  if (!dev && mapping?.physicalDeviceId) physId = mapping.physicalDeviceId;

  const cleanReason = typeof reason === 'string' && reason.trim()
    ? reason.trim().slice(0, 500)
    : 'manual quarantine';
  const res = deviceStore.setDeviceLeaseState(physId, 'quarantined', 'operator');
  console.log(`[IPC] Manual quarantine: ${physId} — ${cleanReason}`);
  return { ...res, reason: cleanReason };
});

ipcMain.handle('clear-quarantine', async (_event, deviceId: string) => {
  let physId = deviceId;
  const dev = deviceStore.getDevice(deviceId);
  if (dev?.physicalDeviceId) physId = dev.physicalDeviceId;
  const mapping = deviceStore.getPhysicalMapping(deviceId);
  if (!dev && mapping?.physicalDeviceId) physId = mapping.physicalDeviceId;

  const res = deviceStore.setDeviceLeaseState(physId, 'available');
  console.log(`[IPC] Manual quarantine clear: ${physId}`);
  return res;
});


