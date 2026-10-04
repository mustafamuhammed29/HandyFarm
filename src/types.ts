export interface DeviceData {
  id: string;
  physicalDeviceId?: string;
  status: string; // 'device', 'offline', 'unauthorized', 'disconnect', etc.
  model?: string;
  manufacturer?: string;
  serial?: string;
  name?: string;
  customName?: string;
  thumbnail?: string;
  notes?: string;
  isBareBoard?: boolean;
  history?: { action: string, timestamp: string }[];
  tags?: string[];
  connectedAt?: number;
  lastKnownIp?: string;
  battery?: { level: number; charging: boolean };
}

export interface QuickPhrase {
  id: string;
  label: string;
  text: string;
}

export interface TestAccount {
  id: string;
  label: string;
  username: string;
  password?: string;
}

export interface DeviceDelta {
  id: string;
  patch?: Partial<DeviceData>;
  removed?: boolean;
}

declare global {
  interface Window {
    electronAPI: {
      getDevices: () => Promise<DeviceData[]>;
      launchScrcpy: (deviceId: string, options?: { maxFps?: number, maxSize?: number }) => Promise<{success: boolean, error?: string}>;
      rebootDevice: (deviceId: string) => Promise<{success: boolean, error?: string}>;
      openLink: (deviceId: string, url: string) => Promise<{success: boolean, error?: string}>;
      installApk: (deviceId: string, apkPath: string) => Promise<{success: boolean, error?: string}>;
      updateDeviceData: (deviceId: string, data: Partial<DeviceData>) => Promise<boolean>;
      onDevicesUpdated: (callback: (update: DeviceData[] | DeviceDelta) => void) => void;
      switchToWireless: (deviceId: string) => Promise<{success: boolean, ip?: string, error?: string}>;
      // Phase 7 Actions
      exportConfig: () => Promise<{success: boolean, path?: string, error?: string}>;
      importConfig: () => Promise<{success: boolean, error?: string}>;
      checkAdbStatus: () => Promise<{success: boolean, connected: boolean, version?: number}>;
      
      toggleScreen: (deviceId: string) => Promise<{success: boolean, error?: string}>;
      takeScreenshot: (deviceId: string) => Promise<{success: boolean, path?: string, error?: string}>;
      
      syncClipboard: (deviceId: string, direction: 'toDevice' | 'fromDevice', text?: string) => Promise<{success: boolean, text?: string, error?: string}>;
      sendText: (deviceId: string, text: string) => Promise<{success: boolean, error?: string}>;
      pushFile: (deviceId: string, localPath: string, remotePath: string) => Promise<{success: boolean, error?: string}>;
      pullFile: (deviceId: string, remotePath: string, localPath: string) => Promise<{success: boolean, error?: string}>;
      
      launchApp: (deviceId: string, packageName: string) => Promise<{success: boolean, error?: string}>;
      clearAppCache: (deviceId: string, packageName: string) => Promise<{success: boolean, error?: string}>;
      
      runAdbCommand: (deviceId: string, command: string) => Promise<{success: boolean, output?: string, error?: string}>;
      openSettings: (deviceId: string, intent: 'wifi' | 'ime' | 'accessibility') => Promise<{success: boolean, error?: string}>;
      locateDevice: (deviceId: string) => Promise<{success: boolean, error?: string}>;
      saveTestAccountPassword: (accountId: string, password: string) => Promise<{success: boolean, error?: string}>;
      getTestAccountPassword: (accountId: string) => Promise<{success: boolean, password?: string, error?: string}>;
      scanMdns: () => Promise<{name: string, ip: string, serial?: string}[]>;
      connectIp: (ip: string) => Promise<{success: boolean, error?: string}>;
      startLogcat: (deviceId: string) => Promise<{success: boolean, error?: string}>;
      stopLogcat: (deviceId: string) => Promise<{success: boolean, error?: string}>;
      onLogcatData: (deviceId: string, callback: (data: string) => void) => void;
      offLogcatData: (deviceId: string) => void;
      
      browseApk: () => Promise<{success: boolean, path?: string, name?: string, size?: number, packageName?: string, error?: string}>;
      parseApk: (filePath: string) => Promise<{success: boolean, path?: string, name?: string, size?: number, packageName?: string, error?: string}>;
      getInstalledPackages: (deviceId: string) => Promise<{success: boolean, packages?: string[], error?: string}>;
      retryDevice: (deviceId: string) => Promise<{ok: boolean}>;
      getPhysicalDeviceMappings?: () => Promise<any[]>;
      getPhysicalDeviceMapping?: (physicalDeviceId: string) => Promise<any>;
    };
  }
}
