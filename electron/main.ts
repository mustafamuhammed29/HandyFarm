import { app, BrowserWindow, ipcMain } from 'electron';
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
      spawnWorker(device.id, device.type);
    });

    tracker.on('remove', (device: any) => {
      console.log('Device removed:', device.id);
      const worker = workers.get(device.id);
      if (worker) {
        worker.kill();
        workers.delete(device.id);
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
        spawnWorker(device.id, device.type);
      }
    });
  } catch (err) {
    console.error('Failed to track devices:', err);
  }
}

function spawnWorker(deviceId: string, status: string) {
  if (workers.has(deviceId)) return;

  const workerPath = path.join(__dirname, 'deviceWorker.js');
  const worker = fork(workerPath, [deviceId, status]);

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
    
    // Auto-restart if we think it should still be connected (status is not offline in our DB)
    if (localDb[deviceId] && localDb[deviceId].status !== 'offline' && localDb[deviceId].status !== 'disconnect') {
        console.log(`Respawning worker for ${deviceId}`);
        setTimeout(() => spawnWorker(deviceId, localDb[deviceId].status), 2000);
    }
  });

  workers.set(deviceId, worker);
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

ipcMain.handle('launch-scrcpy', async (_event, deviceId, options) => {
  return new Promise((resolve, reject) => {
    let cmd = `scrcpy -s ${deviceId}`;
    if (options) {
      if (options.maxSize) cmd += ` -m ${options.maxSize}`;
      if (options.maxFps) cmd += ` --max-fps ${options.maxFps}`;
    }
    exec(cmd, (error) => {
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

ipcMain.handle('reboot-device', async (_event, deviceId) => {
  try {
    await client.reboot(deviceId);
    logAction(deviceId, 'Rebooted device');
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('open-link', async (_event, deviceId, url) => {
  try {
    await client.shell(deviceId, `am start -a android.intent.action.VIEW -d "${url}"`);
    logAction(deviceId, `Opened link: ${url}`);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('install-apk', async (_event, deviceId, apkPath) => {
  try {
    await client.install(deviceId, apkPath);
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

import { dialog } from 'electron';

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
    await client.shell(deviceId, 'input keyevent 26');
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
    const stream = await client.screencap(deviceId);
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
      // Need a way to set clipboard. Recent Android versions require ADB base64 broadcast or service call
      // For simplicity in this mock, we use a basic service call
      const b64 = Buffer.from(text || '').toString('base64');
      await client.shell(deviceId, `am broadcast -a clipper.set -e text "${text}"`);
      logAction(deviceId, 'Synced clipboard to device');
      return { success: true };
    } else {
      return { success: false, error: 'Not fully implemented without helper APK' };
    }
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('send-text', async (_event, deviceId, text) => {
  try {
    // Basic text input (doesn't handle spaces/special chars perfectly without escaping, but good for Phase 7 mock)
    await client.shell(deviceId, `input text "${text.replace(/"/g, '\\"')}"`);
    logAction(deviceId, `Sent text: ${text}`);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('push-file', async (_event, deviceId, localPath, remotePath) => {
  try {
    await client.push(deviceId, localPath, remotePath);
    logAction(deviceId, `Pushed file to ${remotePath}`);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('pull-file', async (_event, deviceId, remotePath, localPath) => {
  try {
    const transfer = await client.pull(deviceId, remotePath);
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
    await client.shell(deviceId, `monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`);
    logAction(deviceId, `Launched app: ${packageName}`);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('clear-app-cache', async (_event, deviceId, packageName) => {
  try {
    await client.shell(deviceId, `pm clear ${packageName}`);
    logAction(deviceId, `Cleared cache for: ${packageName}`);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('run-adb-command', async (_event, deviceId, command) => {
  try {
    const stream = await client.shell(deviceId, command);
    const output = await client.util.readAll(stream);
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
    await client.shell(deviceId, `am start -a ${action}`);
    logAction(deviceId, `Opened settings: ${intent}`);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});
