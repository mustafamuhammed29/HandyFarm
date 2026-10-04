export type LeaseState = 'available' | 'leased' | 'cooling_down' | 'quarantined' | 'maintenance';

export interface DeviceLeaseInfo {
  state: LeaseState;
  leasedBy?: string;
  leaseExpiresAt?: number;
  lastHeartbeatAt?: number;
}

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
  leaseState?: LeaseState;
  leasedBy?: string;
  leaseExpiresAt?: number;
  lastHeartbeatAt?: number;
  baselineStatus?: 'verified' | 'drifted' | 'unbaselined';
  driftCount?: number;
  driftWarnings?: string[];
  lastVerifiedAt?: number;
  lastBaselineAt?: number;
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

export interface VpnConfig {
  targetPackage: string;
  serverEndpoint: string;
  clientPrivateKey: string;
  serverPublicKey: string;
  clientIp?: string;
  allowedIp?: string;
  dns?: string;
  mtu?: number;
}

export interface VpnStatus {
  status: 'CONNECTED' | 'DISCONNECTED' | 'CONNECTING' | 'ERROR';
  targetPackage?: string;
  serverEndpoint?: string;
  tunnelIp?: string;
  handle?: number;
  uptimeMs?: number;
  splitTunnel?: boolean;
  backendLoaded?: boolean;
  backendVersion?: string;
  error?: string;
}

declare global {
  interface Window {
    electronAPI: {
      getDevices: () => Promise<DeviceData[]>;
      launchScrcpy: (deviceId: string, options?: { maxFps?: number, maxSize?: number }) => Promise<{success: boolean, error?: string}>;
      rebootDevice: (deviceId: string, sessionId?: string) => Promise<{success: boolean, error?: string}>;
      openLink: (deviceId: string, url: string) => Promise<{success: boolean, error?: string}>;
      installApk: (deviceId: string, apkPath: string, sessionId?: string) => Promise<{success: boolean, error?: string}>;
      updateDeviceData: (deviceId: string, data: Partial<DeviceData>) => Promise<boolean>;
      onDevicesUpdated: (callback: (update: DeviceData[] | DeviceDelta) => void) => void;
      switchToWireless: (deviceId: string, sessionId?: string) => Promise<{success: boolean, ip?: string, error?: string}>;
      // Phase 7 Actions
      exportConfig: () => Promise<{success: boolean, path?: string, error?: string}>;
      importConfig: () => Promise<{success: boolean, error?: string}>;
      checkAdbStatus: () => Promise<{success: boolean, connected: boolean, version?: number}>;
      
      toggleScreen: (deviceId: string) => Promise<{success: boolean, error?: string}>;
      takeScreenshot: (deviceId: string) => Promise<{success: boolean, path?: string, error?: string}>;
      
      syncClipboard: (deviceId: string, direction: 'toDevice' | 'fromDevice', text?: string, sessionId?: string) => Promise<{success: boolean, text?: string, error?: string}>;
      getCompanionIdentity: (deviceId: string) => Promise<string | null>;
      getForegroundApp: (deviceId: string) => Promise<{success: boolean, packageName?: string, error?: string, permissionRequired?: boolean}>;
      setMockLocation: (deviceId: string, lat: number, lng: number) => Promise<{success: boolean, error?: string, permissionRequired?: boolean}>;
      getMockLocation: (deviceId: string) => Promise<{success: boolean, lat?: number, lng?: number, mockAllowed?: boolean, error?: string}>;
      resetDeviceToBaseline: (deviceId: string, sessionId?: string) => Promise<{success: boolean, actions?: string[], verification?: any, error?: string}>;
      captureDeviceBaseline?: (deviceId: string) => Promise<{success: boolean, manifest?: any, error?: string}>;
      verifyDeviceBaseline?: (deviceId: string) => Promise<{success: boolean, result?: any, error?: string}>;
      getDeviceBaseline?: (deviceId: string) => Promise<any>;
      connectVpn: (deviceId: string, config: VpnConfig) => Promise<{success: boolean, status?: VpnStatus, error?: string}>;
      disconnectVpn: (deviceId: string) => Promise<{success: boolean, status?: VpnStatus, error?: string}>;
      getVpnStatus: (deviceId: string) => Promise<{success: boolean, status?: VpnStatus, error?: string}>;
      sendText: (deviceId: string, text: string, sessionId?: string) => Promise<{success: boolean, error?: string}>;
      pushFile: (deviceId: string, localPath: string, remotePath: string, sessionId?: string) => Promise<{success: boolean, error?: string}>;
      pullFile: (deviceId: string, remotePath: string, localPath: string) => Promise<{success: boolean, error?: string}>;
      
      launchApp: (deviceId: string, packageName: string) => Promise<{success: boolean, error?: string}>;
      clearAppCache: (deviceId: string, packageName: string, sessionId?: string) => Promise<{success: boolean, error?: string}>;
      
      runAdbCommand: (deviceId: string, command: string, sessionId?: string) => Promise<{success: boolean, output?: string, error?: string}>;
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
      acquireLease?: (physicalDeviceId: string, sessionId: string, ttlMinutes?: number) => Promise<{ success: boolean; error?: string; lease?: DeviceLeaseInfo }>;
      releaseLease?: (physicalDeviceId: string, sessionId: string) => Promise<{ success: boolean; error?: string }>;
      heartbeatLease?: (physicalDeviceId: string, sessionId: string, extensionMinutes?: number) => Promise<{ success: boolean; error?: string; leaseExpiresAt?: number }>;
      setDeviceLeaseState?: (physicalDeviceId: string, state: LeaseState, sessionId?: string) => Promise<{ success: boolean; error?: string }>;
      getExpertMode?: () => Promise<boolean>;
      setExpertMode?: (enabled: boolean) => Promise<{ success: boolean; expertMode: boolean }>;

      // Clipper Companion Control Panel
      getClipperInfo?: (deviceId: string) => Promise<{ installed: boolean; version?: string; firstInstallTime?: string; lastUpdateTime?: string; error?: string }>;
      installClipper?: (deviceId: string) => Promise<{ installed: boolean; version?: string; error?: string }>;

      // Phase 4: fleet health
      getFleetHealth?: () => Promise<{
        total: number;
        devices: Array<{
          physicalDeviceId: string;
          healthScore: number;
          reasons: string[];
          lastEvaluatedAt: number;
          leaseState: string;
          propsAttempts: number;
          propsFailures: number;
          reconnectCount: number;
        }>;
      }>;
      getDeviceHealth?: (deviceId: string) => Promise<{
        physicalDeviceId: string;
        healthScore: number;
        reasons: string[];
        lastEvaluatedAt: number;
        counters: { propsAttempts: number; propsFailures: number; reconnectCount: number; rebootCount: number };
        lease: { state: string; leasedBy?: string; leaseExpiresAt?: number; lastHeartbeatAt?: number };
      }>;
      evaluateHealthNow?: () => Promise<{ evaluated: number; transitions: number }>;
      manualQuarantine?: (deviceId: string, reason?: string) => Promise<{ success: boolean; error?: string; reason?: string }>;
      clearQuarantine?: (deviceId: string) => Promise<{ success: boolean; error?: string }>;

      // Phase 5: regression + screenshot diff + crash aggregation
      runRegression?: (spec: any) => Promise<any>;
      setGoldenBaseline?: (payload: { package: string; scenario: string; deviceFingerprint: string; imageBase64: string }) =>
        Promise<{ success: boolean; key?: string; error?: string }>;
      diffAgainstBaseline?: (payload: { package: string; scenario: string; deviceFingerprint: string; deviceSerial: string; imageBase64: string; capturePath?: string }) =>
        Promise<{ success?: boolean; error?: string; result?: any; clusterKey?: string }>;
      getCrashClusters?: () => Promise<{ totalRecords: number; clusters: any[] }>;
      getDiffs?: () => Promise<{ clusters: any[] }>;
    };
  }
}
