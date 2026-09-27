import { app, BrowserWindow, ipcMain, safeStorage, dialog, clipboard } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork, ChildProcess } from 'child_process';
import { Adb } from '@devicefarmer/adbkit';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
console.log('__dirname is:', __dirname);
console.log('preload path is:', path.join(__dirname, 'preload.js'));

const client = Adb.createClient();

let mainWindow: BrowserWindow | null = null;
const workers: Map<string, ChildProcess> = new Map();

const dbPath = path.join(app.getPath('userData'), 'devices.json');
let localDb: Record<string, any> = {};
if (fs.existsSync(dbPath)) {
  try {
    localDb = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
  } catch(e) {
    console.error('Failed to read local DB', e);
  }
}

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
    tracker.on('add', (device: any) => {
      console.log('Device added:', device.id);
      queueWorker(device.id, device.type);
    });

    tracker.on('remove', (device: any) => {
      console.log('Device removed:', device.id);
      const worker = workers.get(device.id);
      if (worker) {
        worker.kill();
        workers.delete(device.id);
        checkQueue();
      } else {
        const qIdx = workerQueue.findIndex(w => w.deviceId === device.id);
        if (qIdx >= 0) workerQueue.splice(qIdx, 1);
      }
      
      if (localDb[device.id]) {
          localDb[device.id].status = 'offline';
          saveDb();
      }
      notifyUpdate();
    });

    tracker.on('change', (device: any) => {
      console.log('Device changed:', device.id, device.type);
      const worker = workers.get(device.id);
      if (worker) {
        worker.send({ type: 'STATUS_CHANGE', status: device.type });
      } else {
        queueWorker(device.id, device.type);
      }
    });

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
    worker.send({ type: 'UPDATE_SCREENCAP_INTERVAL', interval: currentInterval });
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

  // Compute the interval it will have once added
  const initialInterval = getComputedInterval(workers.size + 1);
  
  const workerPath = path.join(__dirname, 'deviceWorker.js');
  // Pass the interval as the 3rd argument to avoid any IPC race condition
  const worker = fork(workerPath, [deviceId, status, initialInterval.toString()]);

  worker.on('message', (msg: any) => {
    if (msg.type === 'DEVICE_DATA') {
      localDb[deviceId] = { ...localDb[deviceId], ...msg.data, id: deviceId };
      saveDb();
      notifyUpdate();
    }
  });

  worker.on('exit', (code) => {
    console.log(`Worker for ${deviceId} exited with code ${code}`);
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

import { exec } from 'child_process';

import { execFile } from 'child_process';

ipcMain.handle('launch-scrcpy', async (_event, deviceId, options) => {
  return new Promise((resolve, reject) => {
    const args = ['-s', deviceId];
    
    if (options) {
      if (options.maxSize) {
        args.push('-m', options.maxSize.toString());
      }
      if (options.maxFps) {
        args.push('--max-fps', options.maxFps.toString());
      }
    }
    
    // Add default stability flags
    args.push('--stay-awake');
    
    const worker = workers.get(deviceId);
    if (worker) worker.send({ type: 'PAUSE_SCREENCAP' });
    
    execFile('scrcpy', args, (error) => {
      if (worker) worker.send({ type: 'RESUME_SCREENCAP' });
      
      if (error) {
        console.error(`scrcpy failed for ${deviceId}:`, error);
        resolve({ success: false, error: error.message });
      } else {
        resolve({ success: true });
      }
    });
  });
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
    await client.getDevice(deviceId).shell(`am start -a android.intent.action.VIEW -d "${parsed.toString()}"`);
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

ipcMain.handle('sync-clipboard', async (_event, deviceId, direction, text) => {
  try {
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
      transfer.on('error', (err) => resolve({ success: false, error: err.message }));
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
