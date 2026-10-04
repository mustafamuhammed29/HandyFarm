import { useEffect, useState, useCallback } from 'react';
import {
  Clipboard, MapPin, Eye, Lock, ShieldCheck, ShieldAlert,
  Power, RotateCw, Package, Hash, AlertCircle, CheckCircle2, Clock, RefreshCw
} from 'lucide-react';
import type { DeviceData, VpnConfig, VpnStatus } from '../types';

interface ClipperInfo {
  installed: boolean;
  version?: string;
  firstInstallTime?: string;
  lastUpdateTime?: string;
  error?: string;
}

interface ClipperIdentity {
  uuid?: string;
  error?: string;
}

interface ClipboardState {
  text: string;
  lastResult?: string;
  error?: string;
}

interface MockLocationState {
  lat: string;
  lng: string;
  current?: { lat: number; lng: number; mockAllowed: boolean };
  error?: string;
}

interface ForegroundState {
  package?: string;
  permissionRequired?: boolean;
  error?: string;
}

interface VpnState {
  status?: VpnStatus;
  error?: string;
}

interface BaselineState {
  manifest?: any;
  status?: 'verified' | 'drifted' | 'unbaselined';
  driftCount?: number;
  driftWarnings?: string[];
  lastVerifiedAt?: number;
  lastBaselineAt?: number;
  error?: string;
  lastVerifyResult?: any;
  lastResetResult?: any;
}

interface Props {
  devices: DeviceData[];
  selectedDeviceId: string;
  onSelectDevice: (id: string) => void;
}

const statusBadge = (label: string, kind: 'ok' | 'warn' | 'error' | 'neutral' = 'neutral') => {
  const colors = {
    ok: 'var(--status-online)',
    warn: '#f59e0b',
    error: 'var(--status-error)',
    neutral: 'var(--text-muted)'
  };
  return { color: colors[kind], label };
};

const fmtTime = (ms?: number): string => {
  if (!ms) return 'never';
  const d = new Date(ms);
  const secs = Math.floor((Date.now() - ms) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return d.toLocaleString();
};

const fmtUptime = (ms?: number): string => {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

export function ClipperPanel({ devices, selectedDeviceId, onSelectDevice }: Props) {
  const [busy, setBusy] = useState(false);
  const [clipper, setClipper] = useState<ClipperInfo>({ installed: false });
  const [identity, setIdentity] = useState<ClipperIdentity>({});
  const [clipboard, setClipboard] = useState<ClipboardState>({ text: '' });
  const [mock, setMock] = useState<MockLocationState>({ lat: '', lng: '' });
  const [foreground, setForeground] = useState<ForegroundState>({});
  const [vpn, setVpn] = useState<VpnState>({});
  const [vpnForm, setVpnForm] = useState<VpnConfig>({
    targetPackage: '',
    serverEndpoint: '',
    clientPrivateKey: '',
    serverPublicKey: '',
    clientIp: '10.0.0.2/32',
    allowedIp: '10.0.0.0/24',
    dns: '1.1.1.1',
    mtu: 1280
  });
  const [baseline, setBaseline] = useState<BaselineState>({});

  const refreshClipperInfo = useCallback(async () => {
    if (!selectedDeviceId) return;
    setBusy(true);
    try {
      const res = await window.electronAPI.getClipperInfo?.(selectedDeviceId);
      if (res) setClipper(res);
    } finally {
      setBusy(false);
    }
  }, [selectedDeviceId]);

  const refreshIdentity = useCallback(async () => {
    if (!selectedDeviceId) return;
    const uuid = await window.electronAPI.getCompanionIdentity(selectedDeviceId);
    setIdentity({ uuid: uuid ?? undefined, error: uuid ? undefined : 'No identity returned' });
  }, [selectedDeviceId]);

  const refreshMock = useCallback(async () => {
    if (!selectedDeviceId) return;
    const res = await window.electronAPI.getMockLocation(selectedDeviceId);
    if (res.success && (res.lat !== undefined && res.lng !== undefined)) {
      setMock(s => ({ ...s, current: { lat: res.lat!, lng: res.lng!, mockAllowed: !!res.mockAllowed }, error: undefined }));
    } else {
      setMock(s => ({ ...s, error: res.error, current: undefined }));
    }
  }, [selectedDeviceId]);

  const refreshForeground = useCallback(async () => {
    if (!selectedDeviceId) return;
    const res = await window.electronAPI.getForegroundApp(selectedDeviceId);
    setForeground({
      package: res.packageName,
      permissionRequired: res.permissionRequired,
      error: res.error
    });
  }, [selectedDeviceId]);

  const refreshVpn = useCallback(async () => {
    if (!selectedDeviceId) return;
    const res = await window.electronAPI.getVpnStatus(selectedDeviceId);
    if (res.success) {
      setVpn({ status: res.status, error: undefined });
    } else {
      setVpn({ error: res.error });
    }
  }, [selectedDeviceId]);

  const refreshBaseline = useCallback(async () => {
    if (!selectedDeviceId) return;
    const manifest = await window.electronAPI.getDeviceBaseline?.(selectedDeviceId);
    const dev = devices.find(d => d.id === selectedDeviceId);
    setBaseline(s => ({
      ...s,
      manifest: manifest ?? undefined,
      status: dev?.baselineStatus,
      driftCount: dev?.driftCount,
      driftWarnings: dev?.driftWarnings,
      lastVerifiedAt: dev?.lastVerifiedAt,
      lastBaselineAt: dev?.lastBaselineAt
    }));
  }, [selectedDeviceId, devices]);

  // Refresh all when device changes
  useEffect(() => {
    if (!selectedDeviceId) {
      setClipper({ installed: false });
      setIdentity({});
      setClipboard({ text: '' });
      setMock({ lat: '', lng: '' });
      setForeground({});
      setVpn({});
      setBaseline({});
      return;
    }
    const dev = devices.find(d => d.id === selectedDeviceId);
    setBaseline(s => ({
      ...s,
      status: dev?.baselineStatus,
      driftCount: dev?.driftCount,
      driftWarnings: dev?.driftWarnings,
      lastVerifiedAt: dev?.lastVerifiedAt,
      lastBaselineAt: dev?.lastBaselineAt
    }));
    void refreshClipperInfo();
    void refreshIdentity();
    void refreshMock();
    void refreshForeground();
    void refreshVpn();
    void refreshBaseline();
  }, [selectedDeviceId, devices, refreshClipperInfo, refreshIdentity, refreshMock, refreshForeground, refreshVpn, refreshBaseline]);

  const reinstallClipper = async () => {
    setBusy(true);
    try {
      const res = await window.electronAPI.installClipper?.(selectedDeviceId);
      if (res) setClipper({ installed: res.installed ?? false, version: res.version, error: res.error });
      await refreshClipperInfo();
      await refreshIdentity();
    } finally {
      setBusy(false);
    }
  };

  const pushClipboard = async () => {
    if (!clipboard.text) return;
    setBusy(true);
    try {
      const res = await window.electronAPI.syncClipboard(selectedDeviceId, 'toDevice', clipboard.text);
      setClipboard(s => ({ ...s, lastResult: res.success ? `pushed ${clipboard.text.length} chars` : `failed: ${res.error}`, error: res.error }));
    } finally {
      setBusy(false);
    }
  };

  const pullClipboard = async () => {
    setBusy(true);
    try {
      const res = await window.electronAPI.syncClipboard(selectedDeviceId, 'fromDevice');
      if (res.success && res.text !== undefined) {
        setClipboard(s => ({ ...s, text: res.text!, lastResult: `pulled ${res.text!.length} chars`, error: undefined }));
      } else {
        setClipboard(s => ({ ...s, error: res.error, lastResult: 'pull failed' }));
      }
    } finally {
      setBusy(false);
    }
  };

  const setMockAction = async () => {
    const lat = parseFloat(mock.lat);
    const lng = parseFloat(mock.lng);
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      setMock(s => ({ ...s, error: 'lat/lng must be numbers' }));
      return;
    }
    setBusy(true);
    try {
      const res = await window.electronAPI.setMockLocation(selectedDeviceId, lat, lng);
      if (res.success) {
        await refreshMock();
      } else {
        setMock(s => ({ ...s, error: res.error }));
      }
    } finally {
      setBusy(false);
    }
  };

  const clearMock = async () => {
    setMock(s => ({ ...s, lat: '', lng: '', error: undefined, current: undefined }));
  };

  const connectVpnAction = async () => {
    if (!vpnForm.targetPackage || !vpnForm.serverEndpoint || !vpnForm.clientPrivateKey || !vpnForm.serverPublicKey) {
      setVpn({ error: 'all fields required: targetPackage, serverEndpoint, clientPrivateKey, serverPublicKey' });
      return;
    }
    setBusy(true);
    try {
      const res = await window.electronAPI.connectVpn(selectedDeviceId, vpnForm);
      if (res.success) {
        setVpn({ status: res.status, error: undefined });
        await refreshVpn();
      } else {
        setVpn({ error: res.error, status: res.status });
      }
    } finally {
      setBusy(false);
    }
  };

  const disconnectVpnAction = async () => {
    setBusy(true);
    try {
      const res = await window.electronAPI.disconnectVpn(selectedDeviceId);
      if (res.success) {
        setVpn({ status: res.status, error: undefined });
        await refreshVpn();
      } else {
        setVpn({ error: res.error, status: res.status });
      }
    } finally {
      setBusy(false);
    }
  };

  const captureBaseline = async () => {
    setBusy(true);
    try {
      const res = await window.electronAPI.captureDeviceBaseline?.(selectedDeviceId);
      if (res) {
        setBaseline(s => ({ ...s, lastResetResult: undefined, manifest: res.manifest, error: res.error, lastBaselineAt: Date.now() }));
        await refreshBaseline();
      }
    } finally {
      setBusy(false);
    }
  };

  const verifyBaseline = async () => {
    setBusy(true);
    try {
      const res = await window.electronAPI.verifyDeviceBaseline?.(selectedDeviceId);
      if (res) {
        setBaseline(s => ({ ...s, lastVerifyResult: res.result, error: res.error, lastVerifiedAt: Date.now() }));
        await refreshBaseline();
      }
    } finally {
      setBusy(false);
    }
  };

  const resetBaseline = async () => {
    setBusy(true);
    try {
      const res = await window.electronAPI.resetDeviceToBaseline(selectedDeviceId);
      if (res) {
        setBaseline(s => ({ ...s, lastResetResult: res, error: res.error }));
        await refreshBaseline();
      }
    } finally {
      setBusy(false);
    }
  };

  const vpnBadge = vpn.status?.status === 'CONNECTED'
    ? statusBadge('connected', 'ok')
    : vpn.status?.status === 'CONNECTING'
      ? statusBadge('connecting', 'warn')
      : vpn.status?.status === 'ERROR'
        ? statusBadge('error', 'error')
        : statusBadge('disconnected', 'neutral');

  const baselineBadge = baseline.status === 'verified'
    ? statusBadge('verified', 'ok')
    : baseline.status === 'drifted'
      ? statusBadge(`drifted (${baseline.driftCount ?? '?'})`, 'error')
      : statusBadge('unbaselined', 'neutral');

  const mockBadge = mock.current?.mockAllowed
    ? statusBadge('allowed', 'ok')
    : mock.current
      ? statusBadge('not allowed', 'warn')
      : null;

  const fgBadge = foreground.permissionRequired
    ? statusBadge('permission required', 'warn')
    : foreground.package
      ? statusBadge('ok', 'ok')
      : statusBadge('—', 'neutral');

  const onlineDevices = devices.filter(d => d.status === 'device');
  const selectedOnline = devices.find(d => d.id === selectedDeviceId)?.status === 'device';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        <select
          value={selectedDeviceId}
          onChange={e => onSelectDevice(e.target.value)}
          style={{ flex: 1, padding: '6px', borderRadius: '4px', background: 'var(--card-bg)', color: 'var(--text-main)', border: '1px solid var(--border)', fontSize: '12px' }}
        >
          <option value="">— Select device —</option>
          {onlineDevices.map(d => (
            <option key={d.id} value={d.id}>
              {d.customName || d.name || d.model} ({d.id})
            </option>
          ))}
        </select>
        <button className="icon-btn" onClick={() => {
          void refreshClipperInfo();
          void refreshIdentity();
          void refreshMock();
          void refreshForeground();
          void refreshVpn();
          void refreshBaseline();
        }} disabled={!selectedDeviceId || busy} title="Refresh all">
          <RefreshCw size={14} />
        </button>
      </div>

      {!selectedDeviceId && (
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
          Select an online device to view and control the Clipper companion.
        </div>
      )}

      {selectedDeviceId && !selectedOnline && (
        <div style={{ fontSize: '11px', color: 'var(--status-error)' }}>
          Device is not online; most actions will fail.
        </div>
      )}

      {selectedDeviceId && (
        <>
          {/* Companion status */}
          <div style={{ background: 'var(--bg-color)', padding: '8px', borderRadius: '6px', fontSize: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
              <Package size={14} />
              <strong>Companion</strong>
              <span style={{ marginLeft: 'auto', color: clipper.installed ? 'var(--status-online)' : 'var(--status-error)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                {clipper.installed ? <><CheckCircle2 size={12} /> installed</> : <><AlertCircle size={12} /> not installed</>}
              </span>
            </div>
            {clipper.version && (
              <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
                version <code style={{ background: 'var(--card-bg)', padding: '1px 4px', borderRadius: '3px' }}>{clipper.version}</code>
                {clipper.lastUpdateTime && <> · updated {fmtTime(Date.parse(clipper.lastUpdateTime))}</>}
              </div>
            )}
            {clipper.error && <div style={{ color: 'var(--status-error)', fontSize: '11px' }}>{clipper.error}</div>}
            <button className="secondary-btn" disabled={busy} onClick={reinstallClipper} style={{ marginTop: '6px', padding: '4px 8px', fontSize: '11px', width: '100%' }}>
              <RotateCw size={12} /> Reinstall / Update Clipper APK
            </button>
          </div>

          {/* Identity */}
          <div style={{ background: 'var(--bg-color)', padding: '8px', borderRadius: '6px', fontSize: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
              <Hash size={14} />
              <strong>Stable Identity</strong>
            </div>
            <code style={{ display: 'block', background: 'var(--card-bg)', padding: '4px 6px', borderRadius: '3px', fontSize: '11px', wordBreak: 'break-all', minHeight: '1.6em' }}>
              {identity.uuid ?? (identity.error ?? '—')}
            </code>
          </div>

          {/* Clipboard */}
          <div style={{ background: 'var(--bg-color)', padding: '8px', borderRadius: '6px', fontSize: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
              <Clipboard size={14} />
              <strong>Clipboard</strong>
            </div>
            <textarea
              placeholder="Text to push..."
              value={clipboard.text}
              onChange={e => setClipboard(s => ({ ...s, text: e.target.value }))}
              style={{ width: '100%', minHeight: '50px', padding: '6px', border: '1px solid var(--border)', borderRadius: '4px', background: 'var(--card-bg)', color: 'var(--text-main)', fontSize: '12px', fontFamily: 'inherit', resize: 'vertical' }}
            />
            <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
              <button className="secondary-btn" disabled={busy || !clipboard.text} onClick={pushClipboard} style={{ flex: 1, padding: '4px 8px', fontSize: '11px' }}>Push → device</button>
              <button className="secondary-btn" disabled={busy} onClick={pullClipboard} style={{ flex: 1, padding: '4px 8px', fontSize: '11px' }}>← Pull from device</button>
            </div>
            {clipboard.lastResult && <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>{clipboard.lastResult}</div>}
            {clipboard.error && <div style={{ fontSize: '10px', color: 'var(--status-error)', marginTop: '4px' }}>{clipboard.error}</div>}
          </div>

          {/* Mock Location */}
          <div style={{ background: 'var(--bg-color)', padding: '8px', borderRadius: '6px', fontSize: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
              <MapPin size={14} />
              <strong>Mock Location</strong>
              {mockBadge && <span style={{ marginLeft: 'auto', color: mockBadge.color, fontSize: '11px' }}>{mockBadge.label}</span>}
            </div>
            {mock.current && (
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>
                current: {mock.current.lat.toFixed(4)}, {mock.current.lng.toFixed(4)}
              </div>
            )}
            <div style={{ display: 'flex', gap: '4px' }}>
              <input type="text" placeholder="lat" value={mock.lat} onChange={e => setMock(s => ({ ...s, lat: e.target.value }))} style={{ flex: 1, padding: '4px', border: '1px solid var(--border)', borderRadius: '4px', background: 'var(--card-bg)', color: 'var(--text-main)', fontSize: '11px' }} />
              <input type="text" placeholder="lng" value={mock.lng} onChange={e => setMock(s => ({ ...s, lng: e.target.value }))} style={{ flex: 1, padding: '4px', border: '1px solid var(--border)', borderRadius: '4px', background: 'var(--card-bg)', color: 'var(--text-main)', fontSize: '11px' }} />
            </div>
            <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
              <button className="secondary-btn" disabled={busy || !mock.lat || !mock.lng} onClick={setMockAction} style={{ flex: 1, padding: '4px 8px', fontSize: '11px' }}>Set</button>
              <button className="secondary-btn" disabled={busy} onClick={clearMock} style={{ flex: 1, padding: '4px 8px', fontSize: '11px' }}>Clear</button>
            </div>
            {mock.error && <div style={{ fontSize: '10px', color: 'var(--status-error)', marginTop: '4px' }}>{mock.error}</div>}
          </div>

          {/* Foreground App */}
          <div style={{ background: 'var(--bg-color)', padding: '8px', borderRadius: '6px', fontSize: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
              <Eye size={14} />
              <strong>Foreground App</strong>
              <span style={{ marginLeft: 'auto', color: fgBadge.color, fontSize: '11px' }}>{fgBadge.label}</span>
            </div>
            <code style={{ display: 'block', background: 'var(--card-bg)', padding: '4px 6px', borderRadius: '3px', fontSize: '11px', wordBreak: 'break-all', minHeight: '1.6em' }}>
              {foreground.package ?? '—'}
            </code>
            <button className="secondary-btn" disabled={busy} onClick={refreshForeground} style={{ marginTop: '6px', padding: '4px 8px', fontSize: '11px', width: '100%' }}>Refresh</button>
          </div>

          {/* VPN */}
          <div style={{ background: 'var(--bg-color)', padding: '8px', borderRadius: '6px', fontSize: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
              <Lock size={14} />
              <strong>WireGuard VPN</strong>
              <span style={{ marginLeft: 'auto', color: vpnBadge.color, fontSize: '11px' }}>{vpnBadge.label}</span>
            </div>
            {vpn.status?.status === 'CONNECTED' && (
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px' }}>
                target: <code style={{ background: 'var(--card-bg)', padding: '1px 4px', borderRadius: '3px' }}>{vpn.status.targetPackage ?? '—'}</code><br />
                endpoint: <code style={{ background: 'var(--card-bg)', padding: '1px 4px', borderRadius: '3px' }}>{vpn.status.serverEndpoint ?? '—'}</code><br />
                tunnel IP: <code style={{ background: 'var(--card-bg)', padding: '1px 4px', borderRadius: '3px' }}>{vpn.status.tunnelIp ?? '—'}</code><br />
                uptime: {fmtUptime(vpn.status.uptimeMs)}
              </div>
            )}
            {vpn.error && <div style={{ color: 'var(--status-error)', fontSize: '11px', marginBottom: '4px' }}>{vpn.error}</div>}
            <details>
              <summary style={{ cursor: 'pointer', fontSize: '11px', color: 'var(--text-muted)' }}>configure &amp; connect</summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '6px' }}>
                <input type="text" placeholder="target package (e.g. com.example.app)" value={vpnForm.targetPackage} onChange={e => setVpnForm(f => ({ ...f, targetPackage: e.target.value }))} style={{ padding: '4px', border: '1px solid var(--border)', borderRadius: '4px', background: 'var(--card-bg)', color: 'var(--text-main)', fontSize: '11px', fontFamily: 'monospace' }} />
                <input type="text" placeholder="server endpoint (host:port)" value={vpnForm.serverEndpoint} onChange={e => setVpnForm(f => ({ ...f, serverEndpoint: e.target.value }))} style={{ padding: '4px', border: '1px solid var(--border)', borderRadius: '4px', background: 'var(--card-bg)', color: 'var(--text-main)', fontSize: '11px', fontFamily: 'monospace' }} />
                <textarea placeholder="client private key (base64)" value={vpnForm.clientPrivateKey} onChange={e => setVpnForm(f => ({ ...f, clientPrivateKey: e.target.value }))} style={{ padding: '4px', border: '1px solid var(--border)', borderRadius: '4px', background: 'var(--card-bg)', color: 'var(--text-main)', fontSize: '11px', fontFamily: 'monospace', minHeight: '40px' }} />
                <textarea placeholder="server public key (base64)" value={vpnForm.serverPublicKey} onChange={e => setVpnForm(f => ({ ...f, serverPublicKey: e.target.value }))} style={{ padding: '4px', border: '1px solid var(--border)', borderRadius: '4px', background: 'var(--card-bg)', color: 'var(--text-main)', fontSize: '11px', fontFamily: 'monospace', minHeight: '40px' }} />
                <div style={{ display: 'flex', gap: '4px' }}>
                  <input type="text" placeholder="client IP" value={vpnForm.clientIp ?? ''} onChange={e => setVpnForm(f => ({ ...f, clientIp: e.target.value }))} style={{ flex: 1, padding: '4px', border: '1px solid var(--border)', borderRadius: '4px', background: 'var(--card-bg)', color: 'var(--text-main)', fontSize: '11px', fontFamily: 'monospace' }} />
                  <input type="text" placeholder="allowed IPs" value={vpnForm.allowedIp ?? ''} onChange={e => setVpnForm(f => ({ ...f, allowedIp: e.target.value }))} style={{ flex: 1, padding: '4px', border: '1px solid var(--border)', borderRadius: '4px', background: 'var(--card-bg)', color: 'var(--text-main)', fontSize: '11px', fontFamily: 'monospace' }} />
                  <input type="text" placeholder="MTU" value={String(vpnForm.mtu ?? 1280)} onChange={e => setVpnForm(f => ({ ...f, mtu: parseInt(e.target.value) || 1280 }))} style={{ width: '70px', padding: '4px', border: '1px solid var(--border)', borderRadius: '4px', background: 'var(--card-bg)', color: 'var(--text-main)', fontSize: '11px', fontFamily: 'monospace' }} />
                </div>
                <button className="secondary-btn" disabled={busy} onClick={connectVpnAction} style={{ padding: '4px 8px', fontSize: '11px' }}>Connect</button>
              </div>
            </details>
            <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
              <button className="secondary-btn" disabled={busy} onClick={refreshVpn} style={{ flex: 1, padding: '4px 8px', fontSize: '11px' }}>Refresh status</button>
              <button className="secondary-btn" disabled={busy || vpn.status?.status !== 'CONNECTED'} onClick={disconnectVpnAction} style={{ flex: 1, padding: '4px 8px', fontSize: '11px', color: 'var(--status-error)' }}>Disconnect</button>
            </div>
          </div>

          {/* Baseline */}
          <div style={{ background: 'var(--bg-color)', padding: '8px', borderRadius: '6px', fontSize: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
              {baseline.status === 'verified' ? <ShieldCheck size={14} /> : baseline.status === 'drifted' ? <ShieldAlert size={14} /> : <Power size={14} />}
              <strong>Baseline</strong>
              <span style={{ marginLeft: 'auto', color: baselineBadge.color, fontSize: '11px' }}>{baselineBadge.label}</span>
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}><Clock size={11} /> last baseline: {fmtTime(baseline.lastBaselineAt)}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}><Clock size={11} /> last verified: {fmtTime(baseline.lastVerifiedAt)}</span>
            </div>
            <div style={{ display: 'flex', gap: '4px' }}>
              <button className="secondary-btn" disabled={busy} onClick={captureBaseline} style={{ flex: 1, padding: '4px 8px', fontSize: '11px' }}>Capture</button>
              <button className="secondary-btn" disabled={busy} onClick={verifyBaseline} style={{ flex: 1, padding: '4px 8px', fontSize: '11px' }}>Verify</button>
              <button className="secondary-btn" disabled={busy} onClick={resetBaseline} style={{ flex: 1, padding: '4px 8px', fontSize: '11px', color: 'var(--status-error)' }}>Reset</button>
            </div>
            {baseline.lastVerifyResult && (
              <details style={{ marginTop: '6px' }}>
                <summary style={{ cursor: 'pointer', fontSize: '11px', color: 'var(--text-muted)' }}>last verify diff</summary>
                <pre style={{ background: 'var(--card-bg)', padding: '6px', borderRadius: '4px', fontSize: '10px', maxHeight: '120px', overflow: 'auto', marginTop: '4px' }}>
                  {JSON.stringify(baseline.lastVerifyResult, null, 2)}
                </pre>
              </details>
            )}
            {baseline.lastResetResult && (
              <details style={{ marginTop: '6px' }}>
                <summary style={{ cursor: 'pointer', fontSize: '11px', color: 'var(--text-muted)' }}>last reset result</summary>
                <pre style={{ background: 'var(--card-bg)', padding: '6px', borderRadius: '4px', fontSize: '10px', maxHeight: '120px', overflow: 'auto', marginTop: '4px' }}>
                  {JSON.stringify(baseline.lastResetResult, null, 2)}
                </pre>
              </details>
            )}
            {baseline.error && <div style={{ fontSize: '10px', color: 'var(--status-error)', marginTop: '4px' }}>{baseline.error}</div>}
          </div>
        </>
      )}
    </div>
  );
}