export interface DeviceData {
  id: string;
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

declare global {
  interface Window {
    electronAPI: {
      getDevices: () => Promise<DeviceData[]>;
      launchScrcpy: (deviceId: string, options?: { maxFps?: number, maxSize?: number }) => Promise<{success: boolean, error?: string}>;
      rebootDevice: (deviceId: string) => Promise<{success: boolean, error?: string}>;
      openLink: (deviceId: string, url: string) => Promise<{success: boolean, error?: string}>;
      installApk: (deviceId: string, apkPath: string) => Promise<{success: boolean, error?: string}>;
      updateDeviceData: (deviceId: string, data: Partial<DeviceData>) => Promise<boolean>;
      onDevicesUpdated: (callback: (devices: DeviceData[]) => void) => void;
      
      // Phase 7 Actions
      exportConfig: () => Promise<{success: boolean, path?: string, error?: string}>;
      importConfig: () => Promise<{success: boolean, error?: string}>;
      
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
    };
  }
}
