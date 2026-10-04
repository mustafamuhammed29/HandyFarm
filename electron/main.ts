console.log('BUILD CANARY:', Date.now(), 'ALPHA-BRAVO-123');
import { app, BrowserWindow, ipcMain, safeStorage, dialog, clipboard } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork, ChildProcess, exec, spawn } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
import adbkit from '@devicefarmer/adbkit';
const Adb = (adbkit as any).Adb || (adbkit as any).default?.Adb || (adbkit as any).default || adbkit;
import fs from 'fs';
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
export { DeviceStore, thumbnailCache, downscaleThumbnail };

const sqliteDbPath = path.join(app.getPath('userData'), 'handyfarm.db');
const legacyJsonPath = path.join(app.getPath('userData'), 'devices.json');
const deviceStore = new DeviceStore(sqliteDbPath, legacyJsonPath);

function broadcastDelta(deviceId: string, patch: Partial<DeviceData>, removed = false) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('devices-updated', {
      id: deviceId,
      patch,
      removed
    });
  }
}

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
      sandbox: false,
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
  startAdbTracker();
  
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
      const patch: Partial<DeviceData> = {
        status: device.type,
        connectedAt: Date.now(),
        serial: dev?.serial || device.id
      };
      deviceStore.updateDevice(device.id, patch);
      broadcastDelta(device.id, patch);

      if (device.type === 'device' || device.type === 'unauthorized') {
        queueWorker(device.id, device.type);
      }
    });

    tracker.on('remove', (device: any) => {
      console.log('Device removed:', device.id);
      if (deviceStore.hasDevice(device.id)) {
        deviceStore.updateDevice(device.id, { status: 'offline' });
        broadcastDelta(device.id, { status: 'offline' });
      }

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

      const worker = workers.get(device.id);
      if (worker && !worker.killed && worker.connected) {
        try { worker.send({ type: 'STATUS_CHANGE', status: device.type }); } catch(e){}
      } else if (device.type === 'device' || device.type === 'unauthorized') {
        queueWorker(device.id, device.type);
      }
    });

    // Background Auto-Reconnect Loop for WiFi devices
    setInterval(async () => {
      const allDevs = deviceStore.getAllDevices(false);
      for (const dev of allDevs) {
        const deviceId = dev.id;
        // If it's a USB device and it's offline and has a known IP
        if (!deviceId.includes(':') && (dev.status === 'offline' || dev.status === 'disconnect') && dev.lastKnownIp) {
          // Check if it's already actively connected via WiFi
          const hasActiveWifi = allDevs.some(d => d.id.includes(':') && d.serial === dev.serial && d.status === 'device');
          if (!hasActiveWifi) {
            console.log(`[Auto-Reconnect] Attempting to reconnect offline device ${deviceId} via last known IP ${dev.lastKnownIp}:5555`);
            try {
              const { stdout } = await execAsync(`adb connect ${dev.lastKnownIp}:5555`);
              console.log(`[Auto-Reconnect] Output for ${dev.lastKnownIp}: ${stdout}`);
            } catch (e) {
              console.error(`[Auto-Reconnect] Failed for ${dev.lastKnownIp}`);
            }
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

ipcMain.handle('start-live-view-poc', async (_event, deviceId, maxSize = 800, videoBitRate = 2000000) => {
  console.log(`[POC] Starting Live View for ${deviceId}`);
  
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
    const { stdout } = await execAsync(`adb -s ${deviceId} shell settings get global stay_on_while_plugged_in`);
    originalStayOnValue = stdout.trim();
  } catch (e) {
    console.error('[POC] Failed to read stay_on_while_plugged_in', e);
  }
  
  // 2) Set to 3 (stay awake) and wake device up
  try {
    await execAsync(`adb -s ${deviceId} shell settings put global stay_on_while_plugged_in 3`);
    await execAsync(`adb -s ${deviceId} shell input keyevent 224`);
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
          await execAsync(`adb -s ${deviceId} shell settings put global stay_on_while_plugged_in ${originalStayOnValue}`);
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

function sanitizeFreeText(text: string): string {
  let sanitized = text.replace(/[`;&|]/g, '');
  sanitized = sanitized.replace(/([$()"\\])/g, '\\$1');
  return sanitized;
}

ipcMain.handle('reboot-device', async (_event, deviceId) => {
  try {
    await client.getDevice(deviceId).reboot();
    logAction(deviceId, 'Rebooted device');
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

async function openUrlRobust(deviceId: string, url: string) {
  let target = '';
  try {
    const resolveCmd = `adb -s ${deviceId} shell pm resolve-activity -a android.intent.action.VIEW -d "${url}"`;
    console.log(`[openUrlRobust] Resolving: ${resolveCmd}`);
    const { stdout } = await execAsync(resolveCmd);
    
    // Look for something like "com.android.chrome/com.google.android.apps.chrome.Main"
    // that indicates a resolved component
    const match = stdout.match(/([a-zA-Z0-9_.]+\/[a-zA-Z0-9_.]+)/);
    if (match && !stdout.includes('No activity found')) {
      target = match[1];
    }
  } catch (e: any) {
    console.warn(`[openUrlRobust] Failed to resolve activity for ${deviceId}: ${e.message}`);
  }

  const startCmd = target 
    ? `adb -s ${deviceId} shell am start -a android.intent.action.VIEW -d "${url}" ${target}`
    : `adb -s ${deviceId} shell am start -a android.intent.action.VIEW -d "${url}"`;
    
  console.log(`[openUrlRobust] Executing: ${startCmd}`);
  try {
    const { stdout, stderr } = await execAsync(startCmd);
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

ipcMain.handle('install-apk', async (_event, deviceId, apkPath) => {
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
    const exportMap: Record<string, DeviceData> = {};
    for (const d of devicesList) {
      exportMap[d.id] = d;
    }
    fs.writeFileSync(filePath, JSON.stringify(exportMap, null, 2));
    return { success: true, path: filePath };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('import-config', async () => {
  if (!mainWindow) return { success: false, error: 'No main window' };
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Device Configuration',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (canceled || filePaths.length === 0) return { success: false };
  try {
    const data: Record<string, Partial<DeviceData>> = JSON.parse(fs.readFileSync(filePaths[0], 'utf-8'));
    for (const [id, patch] of Object.entries(data)) {
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

// TODO(clipper-security-debt): bringClipperToFocus() visibly steals screen focus during every clipboard read on Android 10+ (API 29+). This is accepted as a temporary tradeoff.
async function bringClipperToFocus(deviceId: string) {
  await execAsync(`adb -s ${deviceId} shell am start -W -n ca.zgrs.clipper/.Main`).catch(() => {});
  await new Promise(r => setTimeout(r, 350));
  const { stdout } = await execAsync(`adb -s ${deviceId} shell dumpsys window`).catch(() => ({ stdout: '' }));
  if (stdout.includes('DeprecatedTargetSdkVersionDialog')) {
    await execAsync(`adb -s ${deviceId} shell input keyevent 4`).catch(() => {});
    await new Promise(r => setTimeout(r, 250));
  }
}

async function ensureClipperInstalled(deviceId: string) {
  const clipperPath = getResourcePath('clipper.apk');
  if (!fs.existsSync(clipperPath)) return;
  try {
    const stream = await client.getDevice(deviceId).shell('pm path ca.zgrs.clipper');
    const out = (await Adb.util.readAll(stream)).toString();
    if (!out.includes('package:')) {
      console.log(`[Clipper] Installing clipper.apk on ${deviceId} from ${clipperPath}...`);
      // TODO(clipper-security-debt): clipper.apk (majido/clipper, ca.zgrs.clipper) requires package_verifier_enable=0 and verifier_verify_adb_installs=0 to install (disabling Play Protect verification system-wide on the device, not just for this app). This is accepted as a temporary tradeoff.
      await execAsync(`adb -s ${deviceId} shell settings put global verifier_verify_adb_installs 0`).catch(() => {});
      await execAsync(`adb -s ${deviceId} shell settings put global package_verifier_enable 0`).catch(() => {});
      try {
        await execAsync(`adb -s ${deviceId} install -r -d -g --bypass-low-target-sdk-block "${clipperPath}"`);
      } catch {
        await client.getDevice(deviceId).install(clipperPath);
      }
      // Launch once to move package out of stopped state, then dismiss
      await bringClipperToFocus(deviceId);
      await execAsync(`adb -s ${deviceId} shell input keyevent 4`).catch(() => {});
    }
  } catch (err: any) {
    console.warn(`[Clipper] Auto-install check failed for ${deviceId}:`, err?.message || err);
  }
}

ipcMain.handle('sync-clipboard', async (_event, deviceId, direction, text) => {
  try {
    await ensureClipperInstalled(deviceId);
    if (direction === 'toDevice') {
      const sanitized = sanitizeFreeText(text || '');
      await client.getDevice(deviceId).shell(`am broadcast -a clipper.set -n ca.zgrs.clipper/.ClipperReceiver -e text "${sanitized}"`);
      logAction(deviceId, 'Synced clipboard to device');
      return { success: true };
    } else if (direction === 'fromDevice') {
      console.log(`[IPC] sync-clipboard called fromDevice for ${deviceId}`);
      // On Android 10+ (API 29+), reading clipboard requires the helper app to have foreground focus
      await bringClipperToFocus(deviceId);

      const stream = await client.getDevice(deviceId).shell('am broadcast -a clipper.get -n ca.zgrs.clipper/.ClipperReceiver');
      const buffer = await Adb.util.readAll(stream);
      const output = buffer.toString();

      // Send KEYCODE_BACK to return to the previous screen
      await client.getDevice(deviceId).shell('input keyevent 4').catch(() => {});

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

ipcMain.handle('switch-to-wireless', async (_event, deviceId) => {
  try {
    // 1. Restart ADB in TCP/IP mode on port 5555
    await execAsync(`adb -s ${deviceId} tcpip 5555`);
    
    // Wait a brief moment for the adbd daemon on device to restart in tcpip mode
    await new Promise(res => setTimeout(res, 2000));
    
    // 2. Fetch the device's IP address (wlan0)
    const { stdout } = await execAsync(`adb -s ${deviceId} shell ip route`);
    // Output looks like: "192.168.1.0/24 dev wlan0 proto kernel scope link src 192.168.1.10"
    const match = stdout.match(/src (\d+\.\d+\.\d+\.\d+)/);
    
    if (!match || !match[1]) {
      return { success: false, error: 'Could not detect device IP address. Is Wi-Fi connected?' };
    }
    
    const ip = match[1];
    
    // 3. Connect to the device via its IP
    const { stdout: connectOutput } = await execAsync(`adb connect ${ip}:5555`);
    
    if (connectOutput.includes('failed') || connectOutput.includes('cannot connect')) {
      return { success: false, error: `Failed to connect to ${ip}:5555` };
    }
    
    // Proactively dedupe the USB device's active processes NOW to prevent race conditions
    const oldId = deviceId;
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
      deviceStore.updateDevice(oldId, { lastKnownIp: ip, status: 'offline' });
      broadcastDelta(oldId, { lastKnownIp: ip, status: 'offline' });
    }

    logAction(deviceId, `Switched to Wireless ADB (${ip}:5555)`);
    return { success: true, ip };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('send-text', async (_event, deviceId, text) => {
  try {
    const sanitized = sanitizeFreeText(text);
    await client.getDevice(deviceId).shell(`input text "${sanitized}"`);
    logAction(deviceId, `Sent text: ${text}`);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('push-file', async (_event, deviceId, localPath, remotePath) => {
  try {
    await client.getDevice(deviceId).push(localPath, remotePath);
    logAction(deviceId, `Pushed file to ${remotePath}`);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('pull-file', async (_event, deviceId, remotePath, localPath) => {
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
    await client.getDevice(deviceId).shell(`monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`);
    logAction(deviceId, `Launched app: ${packageName}`);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('clear-app-cache', async (_event, deviceId, packageName) => {
  try {
    if (!isValidPackageName(packageName)) {
      return { success: false, error: 'Invalid package name format' };
    }
    await client.getDevice(deviceId).shell(`pm clear ${packageName}`);
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

ipcMain.handle('run-adb-command', async (_event, deviceId, command) => {
  try {
    const stream = await client.getDevice(deviceId).shell(command);
    const output = await Adb.util.readAll(stream);
    logAction(deviceId, `Ran command: ${command}`);
    return { success: true, output: output.toString() };
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
    await client.getDevice(deviceId).shell(`am start -a ${action}`);
    logAction(deviceId, `Opened settings: ${intent}`);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('locate-device', async (_event, deviceId) => {
  try {
    // Wake screen
    await execAsync(`adb -s ${deviceId} shell input keyevent 224`).catch(() => {});
    // Vibrate for 1 second
    await execAsync(`adb -s ${deviceId} shell cmd vibrator vibrate 1000`).catch(() => {});
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

const activeLogcats = new Map<string, ChildProcess>();
ipcMain.handle('start-logcat', async (event, deviceId) => {
  try {
    if (activeLogcats.has(deviceId)) {
      activeLogcats.get(deviceId)?.kill();
    }
    const proc = spawn('adb', ['-s', deviceId, 'logcat', '-v', 'time']);
    proc.stdout?.on('data', (data: any) => {
       event.sender.send(`logcat-data-${deviceId}`, data.toString());
    });
    proc.stderr?.on('data', (data: any) => {
       event.sender.send(`logcat-data-${deviceId}`, data.toString());
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
    const { stdout } = await execAsync('adb mdns services');
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
    const { stdout } = await execAsync(`adb connect ${ip}`);
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

