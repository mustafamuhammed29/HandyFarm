import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getDevices: () => ipcRenderer.invoke('get-devices'),
  launchScrcpy: (deviceId: string, options?: any) => ipcRenderer.invoke('launch-scrcpy', deviceId, options),
  rebootDevice: (deviceId: string) => ipcRenderer.invoke('reboot-device', deviceId),
  openLink: (deviceId: string, url: string) => ipcRenderer.invoke('open-link', deviceId, url),
  installApk: (deviceId: string, apkPath: string) => ipcRenderer.invoke('install-apk', deviceId, apkPath),
  updateDeviceData: (deviceId: string, data: any) => ipcRenderer.invoke('update-device-data', deviceId, data),
  onDevicesUpdated: (callback: (devices: any[]) => void) => {
    ipcRenderer.removeAllListeners('devices-updated');
    ipcRenderer.on('devices-updated', (_event, devices) => callback(devices));
  },
  
  // Phase 7 Actions
  exportConfig: () => ipcRenderer.invoke('export-config'),
  importConfig: () => ipcRenderer.invoke('import-config'),
  toggleScreen: (deviceId: string) => ipcRenderer.invoke('toggle-screen', deviceId),
  takeScreenshot: (deviceId: string) => ipcRenderer.invoke('take-screenshot', deviceId),
  syncClipboard: (deviceId: string, direction: string, text?: string) => ipcRenderer.invoke('sync-clipboard', deviceId, direction, text),
  sendText: (deviceId: string, text: string) => ipcRenderer.invoke('send-text', deviceId, text),
  pushFile: (deviceId: string, localPath: string, remotePath: string) => ipcRenderer.invoke('push-file', deviceId, localPath, remotePath),
  pullFile: (deviceId: string, remotePath: string, localPath: string) => ipcRenderer.invoke('pull-file', deviceId, remotePath, localPath),
  launchApp: (deviceId: string, packageName: string) => ipcRenderer.invoke('launch-app', deviceId, packageName),
  clearAppCache: (deviceId: string, packageName: string) => ipcRenderer.invoke('clear-app-cache', deviceId, packageName),
  runAdbCommand: (deviceId: string, command: string) => ipcRenderer.invoke('run-adb-command', deviceId, command),
  openSettings: (deviceId: string, intent: string) => ipcRenderer.invoke('open-settings', deviceId, intent),
  saveTestAccountPassword: (accountId: string, password: string) => ipcRenderer.invoke('save-test-account-password', accountId, password),
  getTestAccountPassword: (accountId: string) => ipcRenderer.invoke('get-test-account-password', accountId)
});
