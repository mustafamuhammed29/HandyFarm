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

const dbPath = path.join(app.getPath('userData'), 'devices.json');
let localDb: Record<string, any> = {};
if (fs.existsSync(dbPath)) {
  try {
    localDb = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
  } catch(e) {
    console.error('Failed to read local DB', e);
  }
}
    
// Run dedupe once on startup to clean up any duplicates in the saved DB
let didCleanup = false;
const deviceIds = Object.keys(localDb);
for (let i = 0; i < deviceIds.length; i++) {
  const d1 = deviceIds[i];
  if (!localDb[d1] || !localDb[d1].serial) continue;
  for (let j = i + 1; j < deviceIds.length; j++) {
    const d2 = deviceIds[j];
    if (!localDb[d2] || !localDb[d2].serial) continue;
    
    if (localDb[d1].serial === localDb[d2].serial) {
      // Conflict found in saved DB!
      console.log(`[Startup Dedupe] Found duplicate serial ${localDb[d1].serial} for ${d1} and ${d2}`);
      const d1IsWifi = d1.includes(':');
      const d2IsWifi = d2.includes(':');
      
      const d1IsActive = localDb[d1].status === 'device';
      const d2IsActive = localDb[d2].status === 'device';

      let toRemove = null;
      if (d1IsActive && !d2IsActive) toRemove = d2;
      else if (!d1IsActive && d2IsActive) toRemove = d1;
      else {
        // Prefer USB: if one is WiFi and the other is USB, remove the WiFi one.
        if (d1IsWifi && !d2IsWifi) toRemove = d1;
        else if (!d1IsWifi && d2IsWifi) toRemove = d2;
        else toRemove = d2; // remove the latter one if both same type
      }
      
      console.log(`[Startup Dedupe] Evicting stale entry ${toRemove}`);
      delete localDb[toRemove];
      didCleanup = true;
    }
  }
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const nowMs = Date.now();
for (const id of Object.keys(localDb)) {
  const lastConnected = localDb[id].connectedAt || 0;
  if (nowMs - lastConnected > SEVEN_DAYS_MS) {
    console.log(`[Startup Cleanup] Purging stale device ${id} (last seen ${new Date(lastConnected).toLocaleString()})`);
    delete localDb[id];
    didCleanup = true;
    continue;
  }
  
  if (localDb[id].status !== 'offline') {
    localDb[id].status = 'offline';
    didCleanup = true;
  }
  if (!localDb[id].serial) {
    localDb[id].serial = id;
    didCleanup = true;
  }
}

if (didCleanup) saveDb();

function saveDb() {
  fs.writeFileSync(dbPath, JSON.stringify(localDb, null, 2));
}

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
        if (!localDb[device.id]) {
          localDb[device.id] = { id: device.id, serial: device.id, status: device.type, connectedAt: Date.now() };
        } else {
          localDb[device.id].status = device.type;
          if (!localDb[device.id].serial) localDb[device.id].serial = device.id;
        }
        if (device.type === 'device' || device.type === 'unauthorized') {
          queueWorker(device.id, device.type);
        }
      }
      saveDb();
      notifyUpdate();
    } catch (scanErr: any) {
      console.error('[Startup] listDevices() scan failed:', scanErr?.message || scanErr);
    }
    // --- END STARTUP SCAN ---

    tracker.on('add', (device: any) => {
      console.log('Device added:', device.id, device.type);
      if (!localDb[device.id]) {
        localDb[device.id] = { id: device.id, serial: device.id, status: device.type, connectedAt: Date.now() };
      } else {
        localDb[device.id].status = device.type;
        localDb[device.id].connectedAt = Date.now();
        if (!localDb[device.id].serial) localDb[device.id].serial = device.id;
      }
      saveDb();
      notifyUpdate();

      if (device.type === 'device' || device.type === 'unauthorized') {
        queueWorker(device.id, device.type);
      }
    });

    tracker.on('remove', (device: any) => {
      console.log('Device removed:', device.id);
      if (localDb[device.id]) {
        localDb[device.id].status = 'offline';
        saveDb();
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
      notifyUpdate();
    });

    tracker.on('change', (device: any) => {
      console.log('Device changed:', device.id, device.type);
      if (!localDb[device.id]) {
        localDb[device.id] = { id: device.id, serial: device.id, status: device.type, connectedAt: Date.now() };
      } else {
        localDb[device.id].status = device.type;
        if (!localDb[device.id].serial) localDb[device.id].serial = device.id;
      }
      saveDb();
      notifyUpdate();

      const worker = workers.get(device.id);
      if (worker && !worker.killed && worker.connected) {
        try { worker.send({ type: 'STATUS_CHANGE', status: device.type }); } catch(e){}
      } else if (device.type === 'device' || device.type === 'unauthorized') {
        queueWorker(device.id, device.type);
      }
    });

    // Background Auto-Reconnect Loop for WiFi devices
    setInterval(async () => {
      for (const deviceId in localDb) {
        const dev = localDb[deviceId];
        // If it's a USB device and it's offline and has a known IP
        if (!deviceId.includes(':') && (dev.status === 'offline' || dev.status === 'disconnect') && dev.lastKnownIp) {
          // Check if it's already actively connected via WiFi
          const hasActiveWifi = Object.values(localDb).some(d => d.id.includes(':') && d.serial === dev.serial && d.status === 'device');
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

    if (msg.type === 'DEVICE_DATA') {
      localDb[deviceId] = { ...localDb[deviceId], ...msg.data, id: deviceId };
      if (!localDb[deviceId].serial) {
        localDb[deviceId].serial = deviceId;
      }
      
      if (msg.data.serial) {
        for (const otherId in localDb) {
          const otherSerial = localDb[otherId].serial;
          if (otherId !== deviceId && otherSerial === msg.data.serial) {
            console.log(`[Dedupe check] Conflict found between ${deviceId} and ${otherId} (serial: ${msg.data.serial})`);
            
            // Only conflict if they are both trying to be active, or prefer the active one
            const isCurrentWifi = deviceId.includes(':');
            const isOtherWifi = otherId.includes(':');
            
            const isCurrentActive = msg.data.status === 'device';
            const isOtherActive = localDb[otherId].status === 'device';

            let idToKill = null;
            if (isCurrentActive && !isOtherActive) {
              idToKill = otherId;
            } else if (!isCurrentActive && isOtherActive) {
              idToKill = deviceId;
            } else {
              // Prefer USB connection if both are active or both inactive
              if (isCurrentWifi && !isOtherWifi) {
                idToKill = deviceId; // kill the current WiFi if other is USB
              } else if (!isCurrentWifi && isOtherWifi) {
                idToKill = otherId; // kill the other WiFi if current is USB
              } else {
                idToKill = otherId;
              }
            }
            
            if (idToKill) {
              console.log(`[Dedupe] MATCH! Evicting stale/duplicate device ${idToKill} to enforce one tile per physical device`);
              const oldWorker = workers.get(idToKill);
              if (oldWorker) {
                workerGenerations.set(idToKill, (workerGenerations.get(idToKill) || 0) + 1);
                oldWorker.kill();
                workers.delete(idToKill);
              }
              closeLiveView(idToKill, 'Connection lost — evicted by dedupe logic');
              delete localDb[idToKill];

              if (idToKill === deviceId) {
                // The current worker was killed (it was the USB one, and WiFi already exists)
                saveDb();
                notifyUpdate();
                return; // Stop processing this worker's message
              }
            }
          }
        }
      }

      saveDb();
      notifyUpdate();
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
    if (localDb[deviceId] && localDb[deviceId].status !== 'offline' && localDb[deviceId].status !== 'disconnect') {
        console.log(`Re-queuing worker for ${deviceId}`);
        setTimeout(() => queueWorker(deviceId, localDb[deviceId].status), 2000);
    }
  });

  workers.set(deviceId, worker);
  broadcastScreencapInterval();
}

function notifyUpdate() {
  if (mainWindow) {
    const devices = Object.values(localDb);
    mainWindow.webContents.send('devices-updated', devices);
  }
}

ipcMain.handle('get-devices', () => {
  return Object.values(localDb);
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

    if (localDb[deviceId]) {
      localDb[deviceId].status = liveStatus;
      if (!localDb[deviceId].serial) localDb[deviceId].serial = deviceId;
      saveDb();
      notifyUpdate();
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
  const connected = localDb[deviceId];
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
  if (!localDb[deviceId]) localDb[deviceId] = { id: deviceId };
  if (!localDb[deviceId].history) localDb[deviceId].history = [];
  localDb[deviceId].history.unshift({ action, timestamp: new Date().toISOString() });
  localDb[deviceId].history = localDb[deviceId].history.slice(0, 50); // keep last 50
  saveDb();
  notifyUpdate();
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
  if (!localDb[deviceId]) {
    localDb[deviceId] = { id: deviceId };
  }
  localDb[deviceId] = { ...localDb[deviceId], ...data };
  saveDb();
  notifyUpdate();
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
    fs.writeFileSync(filePath, JSON.stringify(localDb, null, 2));
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
    const data = JSON.parse(fs.readFileSync(filePaths[0], 'utf-8'));
    localDb = { ...localDb, ...data };
    saveDb();
    notifyUpdate();
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

async function ensureClipperInstalled(deviceId: string) {
  const clipperPath = getResourcePath('clipper.apk');
  if (!fs.existsSync(clipperPath)) return;
  try {
    const stream = await client.getDevice(deviceId).shell('pm path ca.zgrs.clipper');
    const out = (await Adb.util.readAll(stream)).toString();
    if (!out.includes('package:')) {
      console.log(`[Clipper] Installing clipper.apk on ${deviceId} from ${clipperPath}...`);
      await client.getDevice(deviceId).install(clipperPath);
      await client.getDevice(deviceId).shell('am startservice ca.zgrs.clipper/.ClipboardService');
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
      await client.getDevice(deviceId).shell(`am broadcast -a clipper.set -e text "${sanitized}"`);
      logAction(deviceId, 'Synced clipboard to device');
      return { success: true };
    } else if (direction === 'fromDevice') {
      console.log(`[IPC] sync-clipboard called fromDevice for ${deviceId}`);
      const stream = await client.getDevice(deviceId).shell('am broadcast -a clipper.get');
      const buffer = await Adb.util.readAll(stream);
      const output = buffer.toString();
      console.log(`[IPC] Broadcast output:`, output);
      const match = output.match(/data="(.*)"/s);
      if (match) {
        console.log(`[IPC] Regex match found, clipText:`, match[1]);
        clipboard.writeText(match[1]);
        logAction(deviceId, 'Synced clipboard from device');
        return { success: true };
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
    if (localDb[oldId]) {
      localDb[oldId].lastKnownIp = ip; // Save last known IP for auto-reconnect
      localDb[oldId].status = 'offline'; // Temporarily mark offline so WiFi takes over
      saveDb();
      notifyUpdate();
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
