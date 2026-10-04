import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getDevices: () => ipcRenderer.invoke('get-devices'),
  rebootDevice: (deviceId: string, sessionId?: string) => ipcRenderer.invoke('reboot-device', deviceId, sessionId),
  openLink: (deviceId: string, url: string) => ipcRenderer.invoke('open-link', deviceId, url),
  installApk: (deviceId: string, apkPath: string, sessionId?: string) => ipcRenderer.invoke('install-apk', deviceId, apkPath, sessionId),
  updateDeviceData: (deviceId: string, data: any) => ipcRenderer.invoke('update-device-data', deviceId, data),
  onDevicesUpdated: (callback: (devices: any[]) => void) => {
    ipcRenderer.removeAllListeners('devices-updated');
    ipcRenderer.on('devices-updated', (_event, devices) => callback(devices));
  },
  switchToWireless: (deviceId: string, sessionId?: string) => ipcRenderer.invoke('switch-to-wireless', deviceId, sessionId),
  
  // Phase 7 Actions
  exportConfig: () => ipcRenderer.invoke('export-config'),
  importConfig: () => ipcRenderer.invoke('import-config'),
  checkAdbStatus: () => ipcRenderer.invoke('check-adb-status'),
  toggleScreen: (deviceId: string) => ipcRenderer.invoke('toggle-screen', deviceId),
  takeScreenshot: (deviceId: string) => ipcRenderer.invoke('take-screenshot', deviceId),
  syncClipboard: (deviceId: string, direction: string, text?: string, sessionId?: string) => ipcRenderer.invoke('sync-clipboard', deviceId, direction, text, sessionId),
  getCompanionIdentity: (deviceId: string) => ipcRenderer.invoke('get-companion-identity', deviceId),
  getForegroundApp: (deviceId: string) => ipcRenderer.invoke('get-foreground-app', deviceId),
  setMockLocation: (deviceId: string, lat: number, lng: number) => ipcRenderer.invoke('set-mock-location', deviceId, lat, lng),
  getMockLocation: (deviceId: string) => ipcRenderer.invoke('get-mock-location', deviceId),
  resetDeviceToBaseline: (deviceId: string) => ipcRenderer.invoke('reset-device-to-baseline', deviceId),
  connectVpn: (deviceId: string, config: any) => ipcRenderer.invoke('connect-vpn', deviceId, config),
  disconnectVpn: (deviceId: string) => ipcRenderer.invoke('disconnect-vpn', deviceId),
  getVpnStatus: (deviceId: string) => ipcRenderer.invoke('get-vpn-status', deviceId),
  sendText: (deviceId: string, text: string, sessionId?: string) => ipcRenderer.invoke('send-text', deviceId, text, sessionId),
  pushFile: (deviceId: string, localPath: string, remotePath: string, sessionId?: string) => ipcRenderer.invoke('push-file', deviceId, localPath, remotePath, sessionId),
  pullFile: (deviceId: string, remotePath: string, localPath: string) => ipcRenderer.invoke('pull-file', deviceId, remotePath, localPath),
  launchApp: (deviceId: string, packageName: string) => ipcRenderer.invoke('launch-app', deviceId, packageName),
  clearAppCache: (deviceId: string, packageName: string, sessionId?: string) => ipcRenderer.invoke('clear-app-cache', deviceId, packageName, sessionId),
  runAdbCommand: (deviceId: string, command: string, sessionId?: string) => ipcRenderer.invoke('run-adb-command', deviceId, command, sessionId),
  openSettings: (deviceId: string, intent: string) => ipcRenderer.invoke('open-settings', deviceId, intent),
  locateDevice: (deviceId: string) => ipcRenderer.invoke('locate-device', deviceId),
  saveTestAccountPassword: (accountId: string, password: string) => ipcRenderer.invoke('save-test-account-password', accountId, password),
  getTestAccountPassword: (accountId: string) => ipcRenderer.invoke('get-test-account-password', accountId),
  
  // Phase 2 POC
  startLiveViewPoc: (deviceId: string, maxSize?: number, videoBitRate?: number, sessionId?: string) => ipcRenderer.invoke('start-live-view-poc', deviceId, maxSize, videoBitRate, sessionId),
  stopLiveViewPoc: (deviceId: string) => ipcRenderer.invoke('stop-live-view-poc', deviceId),
  scanMdns: () => ipcRenderer.invoke('scan-mdns'),
  connectIp: (ip: string) => ipcRenderer.invoke('connect-ip', ip),
  startLogcat: (deviceId: string) => ipcRenderer.invoke('start-logcat', deviceId),
  stopLogcat: (deviceId: string) => ipcRenderer.invoke('stop-logcat', deviceId),
  onLogcatData: (deviceId: string, callback: (data: string) => void) => {
    ipcRenderer.removeAllListeners(`logcat-data-${deviceId}`);
    ipcRenderer.on(`logcat-data-${deviceId}`, (_event, data) => callback(data));
  },
  offLogcatData: (deviceId: string) => {
    ipcRenderer.removeAllListeners(`logcat-data-${deviceId}`);
  }
,
  browseApk: () => ipcRenderer.invoke('browse-apk'),
  parseApk: (filePath: string) => ipcRenderer.invoke('parse-apk', filePath),
  getInstalledPackages: (deviceId: string) => ipcRenderer.invoke('get-installed-packages', deviceId),
  retryDevice: (deviceId: string) => ipcRenderer.invoke('retry-device', deviceId),
  getPhysicalDeviceMappings: () => ipcRenderer.invoke('get-physical-device-mappings'),
  getPhysicalDeviceMapping: (physicalDeviceId: string) => ipcRenderer.invoke('get-physical-device-mapping', physicalDeviceId),
  acquireLease: (physicalDeviceId: string, sessionId: string, ttlMinutes?: number) => ipcRenderer.invoke('acquire-lease', physicalDeviceId, sessionId, ttlMinutes),
  releaseLease: (physicalDeviceId: string, sessionId: string) => ipcRenderer.invoke('release-lease', physicalDeviceId, sessionId),
  heartbeatLease: (physicalDeviceId: string, sessionId: string, extensionMinutes?: number) => ipcRenderer.invoke('heartbeat-lease', physicalDeviceId, sessionId, extensionMinutes),
  setDeviceLeaseState: (physicalDeviceId: string, state: string, sessionId?: string) => ipcRenderer.invoke('set-device-lease-state', physicalDeviceId, state, sessionId),
  getExpertMode: () => ipcRenderer.invoke('get-expert-mode'),
  setExpertMode: (enabled: boolean) => ipcRenderer.invoke('set-expert-mode', enabled),
});


