import React, { useEffect, useMemo, useState } from 'react';
import {
  X, MonitorSmartphone, FileText, ClipboardCheck, RefreshCw, Heart, PackageSearch,
} from 'lucide-react';
import type { DeviceData } from '../types';
import {
  connectionColorVar,
  connectionLabel,
  healthTier,
  healthTierColorVar,
  healthTierLabel,
  leaseLabel,
} from '../stateColor';
import type { DeviceConnectionStatus, LeaseState } from '../stateColor';

type Tab = 'screen' | 'apps' | 'health' | 'audit' | 'regression' | 'agent';

export interface DeviceDetailHealth {
  healthScore: number;
  reasons: string[];
  leaseState: string;
  lastEvaluatedAt?: number;
  propsAttempts?: number;
  propsFailures?: number;
  reconnectCount?: number;
  rebootCount?: number;
}

export interface DeviceDetailModalProps {
  device: DeviceData | null;
  health?: DeviceDetailHealth;
  recentAudit?: Array<{
    jobId: string;
    label?: string;
    status: string;
    completedAt: number;
    appliedDelayMs: number;
    error?: string;
  }>;
  recentRegression?: Array<{
    runId: string;
    status: string;
    summary?: string;
    completedAt: number;
  }>;
  onClose: () => void;
  onRunRegression?: (deviceId: string) => void;
  onQuarantine?: (deviceId: string, reason?: string) => void;
  onClearQuarantine?: (deviceId: string) => void;
  now: number;
}

export const DeviceDetailModal: React.FC<DeviceDetailModalProps> = ({
  device, health, recentAudit, recentRegression,
  onClose, onRunRegression, onQuarantine, onClearQuarantine, now,
}) => {
  const [tab, setTab] = useState<Tab>('screen');

  // Reset to screen tab when device changes.
  useEffect(() => { setTab('screen'); }, [device?.id]);

  if (!device) return null;

  const connection = (device.status || 'unknown') as DeviceConnectionStatus;
  const leaseState = (health?.leaseState || device.leaseState || 'available') as LeaseState;
  const connColor = connectionColorVar(connection);
  const tier = healthTier(health?.healthScore ?? 0, leaseState);
  const healthColor = healthTierColorVar(tier);
  const liveLease = leaseLabel(leaseState, device.leasedBy, device.leaseExpiresAt, now);

  return (
    <div
      className="modal-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ zIndex: 100 }}
      data-testid="device-detail-modal"
    >
      <div
        className="modal-content"
        style={{ maxWidth: '720px', width: '90%', maxHeight: '80vh', overflow: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            borderBottom: '1px solid var(--border)',
            padding: '12px 16px',
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{
                width: '10px', height: '10px', borderRadius: '50%',
                background: connColor, display: 'inline-block',
              }} />
              <h3 style={{ margin: 0 }}>
                {device.customName || device.name || device.model || 'Unknown device'}
              </h3>
              <span
                style={{
                  fontSize: '11px',
                  padding: '2px 8px',
                  background: 'var(--bg-color)',
                  color: connColor,
                  border: `1px solid ${connColor}`,
                  borderRadius: '4px',
                }}
              >
                {connectionLabel(connection)}
              </span>
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px', display: 'flex', gap: '12px' }}>
              {device.model && <span>Model: {device.model}</span>}
              {device.serial && <span>Serial: {device.serial}</span>}
              {device.id.includes(':') && <span>WiFi: {device.id}</span>}
              <span>Lease: {liveLease.label}</span>
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close" data-testid="close-detail">
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div
          style={{
            display: 'flex',
            gap: '4px',
            padding: '4px 16px 0',
            borderBottom: '1px solid var(--border)',
          }}
        >
          {([
            ['screen', MonitorSmartphone, 'Screen'],
            ['apps', ClipboardCheck, 'Apps'],
            ['health', Heart, 'Health'],
            ['audit', FileText, 'Audit'],
            ['regression', RefreshCw, 'Regression'],
            ['agent', PackageSearch, 'Agent'],
          ] as const).map(([k, Icon, label]) => (
            <button
              key={k}
              onClick={() => setTab(k as Tab)}
              data-testid={`detail-tab-${k}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                background: tab === k ? 'var(--card-bg)' : 'transparent',
                color: tab === k ? 'var(--text-main)' : 'var(--text-muted)',
                border: 'none',
                padding: '8px 12px',
                cursor: 'pointer',
                borderRadius: '4px 4px 0 0',
                borderBottom: tab === k ? '2px solid var(--accent)' : '2px solid transparent',
                fontSize: '13px',
              }}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div style={{ padding: '16px' }}>
          {tab === 'screen' && (
            <ScreenTab
              device={device}
              onRunRegression={onRunRegression}
              onQuarantine={onQuarantine}
              onClearQuarantine={onClearQuarantine}
            />
          )}
          {tab === 'apps' && <AppsTab device={device} />}
          {tab === 'health' && <HealthTab health={health} tier={tier} color={healthColor} />}
          {tab === 'audit' && <AuditTab rows={recentAudit || []} />}
          {tab === 'agent' && <AgentTab device={device} />}
          {tab === 'regression' && <RegressionTab rows={recentRegression || []} />}
        </div>
      </div>
    </div>
  );
};

// --- Tabs ---

const ScreenTab: React.FC<{
  device: DeviceData;
  onRunRegression?: (deviceId: string) => void;
  onQuarantine?: (deviceId: string, reason?: string) => void;
  onClearQuarantine?: (deviceId: string) => void;
}> = ({ device, onRunRegression, onQuarantine, onClearQuarantine }) => {
  const ls = (device.leaseState || 'available') as LeaseState;
  const isQuarantined = ls === 'quarantined';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
        The full live-view surface is rendered in the device tile to the left. This tab gives you
        the per-device summary + a place to run a regression or override the lease.
      </div>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <button
          className="primary-btn"
          disabled={isQuarantined || ls === 'leased'}
          onClick={() => onRunRegression?.(device.id)}
          data-testid="run-regression-btn"
          style={{ padding: '6px 12px', fontSize: '13px' }}
        >
          <RefreshCw size={14} style={{ marginRight: '6px' }} />
          Run regression on this device
        </button>
        {!isQuarantined ? (
          <button
            className="secondary-btn"
            onClick={() => onQuarantine?.(device.id, 'operator override')}
            style={{ padding: '6px 12px', fontSize: '13px' }}
          >
            Quarantine
          </button>
        ) : (
          <button
            className="secondary-btn"
            onClick={() => onClearQuarantine?.(device.id)}
            style={{ padding: '6px 12px', fontSize: '13px' }}
          >
            Clear quarantine
          </button>
        )}
      </div>
      {device.battery && (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          Battery: {device.battery.level}%{device.battery.charging && ' (charging)'}
        </div>
      )}
    </div>
  );
};

const AppsTab: React.FC<{ device: DeviceData }> = ({ device }) => (
  <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
    Use the Clipper Companion panel in the sidebar for companion-app actions (install, version,
    foreground-app detection). Future work: launch profiles bound to each device here.
    <div style={{ marginTop: '8px' }}>
      <div>Device id: <code>{device.id}</code></div>
      <div>Baseline status: <code>{device.baselineStatus || 'unbaselined'}</code></div>
    </div>
  </div>
);

const HealthTab: React.FC<{
  health?: DeviceDetailHealth;
  tier: ReturnType<typeof healthTier>;
  color: string;
}> = ({ health, tier, color }) => {
  if (!health) {
    return (
      <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
        No health data yet. The fleet monitor ticks every 30s; force a tick via Fleet Health panel.
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <span style={{ fontSize: '32px', fontWeight: 700, color }}>{health.healthScore}</span>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ color, fontWeight: 600 }}>{healthTierLabel(tier)}</span>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            Last evaluated {health.lastEvaluatedAt ? new Date(health.lastEvaluatedAt).toLocaleString() : 'never'}
          </span>
        </div>
      </div>

      {health.reasons.length > 0 ? (
        <div>
          <h4 style={{ margin: '8px 0 4px', fontSize: '13px' }}>Reasons</h4>
          <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '12px' }}>
            {health.reasons.map((r, i) => (
              <li key={i} style={{ color: 'var(--text-main)' }}>{r}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No reasons recorded — looks healthy.</div>
      )}

      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', fontSize: '12px' }}>
        <Stat label="Props attempts" value={health.propsAttempts ?? 0} />
        <Stat label="Props failures" value={health.propsFailures ?? 0} />
        <Stat label="Reconnects" value={health.reconnectCount ?? 0} />
        <Stat label="Reboots" value={health.rebootCount ?? 0} />
      </div>
    </div>
  );
};

const AuditTab: React.FC<{
  rows: Array<{
    jobId: string;
    label?: string;
    status: string;
    completedAt: number;
    appliedDelayMs: number;
    error?: string;
  }>;
}> = ({ rows }) => {
  if (rows.length === 0) {
    return (
      <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
        No recent audit entries. The scheduler's audit log is persisted to
        <code> scheduler_audit</code> and exposed via /fleet/health.
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {rows.map((r) => (
        <div
          key={r.jobId}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            background: 'var(--bg-color)',
            padding: '6px 10px',
            borderRadius: '4px',
            borderLeft: `3px solid ${r.status === 'completed' ? 'var(--state-healthy)' : 'var(--state-degraded)'}`,
            fontSize: '12px',
          }}
        >
          <span style={{
            color: r.status === 'completed' ? 'var(--state-healthy)' : 'var(--state-degraded)',
            fontWeight: 600,
            minWidth: '78px',
          }}>
            {r.status}
          </span>
          <span style={{ flex: 1, color: 'var(--text-main)' }}>{r.label || r.jobId}</span>
          <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
            {new Date(r.completedAt).toLocaleString()} · {r.appliedDelayMs}ms
          </span>
          {r.error && <span style={{ color: 'var(--state-quarantined)' }}>{r.error.slice(0, 60)}</span>}
        </div>
      ))}
    </div>
  );
};

const RegressionTab: React.FC<{
  rows: Array<{ runId: string; status: string; summary?: string; completedAt: number }>;
}> = ({ rows }) => {
  if (rows.length === 0) {
    return (
      <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
        No regression runs for this device yet. Click "Run regression on this device" in the
        Screen tab to start one.
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {rows.map((r) => (
        <div
          key={r.runId}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            background: 'var(--bg-color)',
            padding: '6px 10px',
            borderRadius: '4px',
            borderLeft: `3px solid ${r.status === 'passed' ? 'var(--state-healthy)' : 'var(--state-degraded)'}`,
            fontSize: '12px',
          }}
        >
          <span style={{
            color: r.status === 'passed' ? 'var(--state-healthy)' : 'var(--state-degraded)',
            fontWeight: 600,
            minWidth: '70px',
          }}>
            {r.status}
          </span>
          <span style={{ flex: 1, color: 'var(--text-main)' }}>{r.runId}</span>
          <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
            {new Date(r.completedAt).toLocaleString()}
          </span>
          {r.summary && (
            <span style={{ color: 'var(--text-muted)', fontSize: '11px', maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {r.summary}
            </span>
          )}
        </div>
      ))}
    </div>
  );
};

const Stat: React.FC<{ label: string; value: number | string }> = ({ label, value }) => (
  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '6px 12px', background: 'var(--bg-color)', borderRadius: '4px' }}>
    <span style={{ fontSize: '14px', fontWeight: 600 }}>{value}</span>
    <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{label}</span>
  </div>
);

// ----- AgentTab -----
//
// Read-only host-side agent capability. The companion APK's status and the
// device's installed-app inventory come back over `dumpsys package` and
// `pm list packages -f`. No new APK build, no permission expansion.
//
// The tab is honest about what the host can see without a richer on-device
// agent: package metadata, signatures, runtime-permission grants, and
// inventory. There is no claim of broad app-data scraping.

const AgentTab: React.FC<{ device: DeviceData }> = ({ device }) => {
  const [status, setStatus] = useState<{ ok: boolean; status?: any; error?: string } | null>(null);
  const [apps, setApps] = useState<{ ok: boolean; apps: any[]; error?: string } | null>(null);
  const [filter, setFilter] = useState('');
  const [perms, setPerms] = useState<{ ok: boolean; permissions: any[]; error?: string } | null>(null);
  const [pickerMsg, setPickerMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const TARGET_PKG = 'com.handyfarm.clipper';

  const refresh = async () => {
    if (!device?.id) return;
    setBusy(true);
    try {
      const api = window.electronAPI;
      const [s, a] = await Promise.all([
        api.getAgentStatus ? api.getAgentStatus(device.id, TARGET_PKG) : Promise.resolve({ ok: false, error: 'unsupported' }),
        api.getInstalledApps ? api.getInstalledApps(device.id) : Promise.resolve({ ok: false, apps: [], error: 'unsupported' }),
      ]);
      setStatus(s as any);
      setApps(a as any);
      const p = api.getGrantedPermissions
        ? await api.getGrantedPermissions(device.id, TARGET_PKG)
        : { ok: false, permissions: [], error: 'unsupported' };
      setPerms(p as any);
    } catch (err: any) {
      setStatus({ ok: false, error: err?.message || String(err) });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { refresh(); /* re-fetch when device changes */ }, [device?.id]);

  const filteredApps = useMemo(() => {
    if (!apps?.apps) return [];
    const q = filter.toLowerCase().trim();
    if (!q) return apps.apps;
    return apps.apps.filter((a: any) => a.package.toLowerCase().includes(q));
  }, [apps, filter]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
        Agent status is read via <code>adb shell dumpsys package</code>. No
        new on-device agent is installed; this tab is honest about what
        the host can see. For richer capabilities (per-app settings, media
        picker, motion photos), see{' '}
        <code>ANDROID-AGENT-SPEC.md</code>.
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <button
          className="secondary-btn"
          onClick={refresh}
          disabled={busy}
          style={{ padding: '4px 10px', fontSize: '12px' }}
          data-testid="agent-refresh"
        >
          {busy ? 'Loading…' : 'Refresh'}
        </button>
        {status?.ok && (
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            Companion {status.status?.versionName ? `v${status.status.versionName} (code ${status.status.versionCode})` : 'not installed'}
            {status.status?.signatureSha256?.length > 0 && (
              <> · sig <code>{status.status.signatureSha256[0]}</code></>
            )}
          </span>
        )}
        {status?.error && (
          <span style={{ fontSize: '11px', color: 'var(--status-error)' }}>{status.error}</span>
        )}
      </div>

      {/* Permissions */}
      {perms?.ok && (
        <div>
          <h4 style={{ margin: '4px 0', fontSize: '13px' }}>Granted runtime permissions ({perms.permissions.length})</h4>
          {perms.permissions.length === 0 ? (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>None declared.</div>
          ) : (
            <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '12px' }}>
              {perms.permissions.map((p: any) => (
                <li key={p.permission} style={{ color: p.state === 'granted' ? 'var(--text-main)' : 'var(--text-muted)' }}>
                  <span style={{
                    display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%',
                    background: p.state === 'granted' ? 'var(--state-healthy)' : 'var(--state-warning)',
                    marginRight: '6px',
                  }} />
                  {p.permission} <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>({p.state})</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Inventory */}
      <div>
        <h4 style={{ margin: '4px 0', fontSize: '13px' }}>
          Installed packages ({apps?.apps?.length ?? 0})
          <input
            type="text"
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ marginLeft: '8px', padding: '4px 8px', fontSize: '11px', border: '1px solid var(--border)', borderRadius: '4px', background: 'var(--bg-color)', color: 'var(--text-main)' }}
            data-testid="agent-filter"
          />
        </h4>
        <div style={{ maxHeight: '200px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: '4px' }}>
          {filteredApps.slice(0, 200).map((a: any) => (
            <div
              key={a.package + (a.path || '')}
              style={{
                padding: '4px 8px',
                borderBottom: '1px solid var(--border)',
                fontSize: '11px',
                display: 'flex',
                justifyContent: 'space-between',
                gap: '8px',
              }}
            >
              <span>{a.package}</span>
              <span style={{
                color: a.classification === 'system' ? 'var(--text-muted)' :
                       a.classification === 'user' ? 'var(--state-healthy)' : 'var(--text-muted)',
                fontSize: '10px',
              }}>{a.classification}</span>
            </div>
          ))}
          {filteredApps.length > 200 && (
            <div style={{ padding: '6px', fontSize: '10px', color: 'var(--text-muted)', textAlign: 'center' }}>
              +{filteredApps.length - 200} more (refine the filter)
            </div>
          )}
        </div>
      </div>

      {/* Photo picker test — host-side helper, no exfiltration */}
      <div>
        <h4 style={{ margin: '4px 0', fontSize: '13px' }}>Photo / media test</h4>
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            id="agent-test-image-path"
            type="text"
            placeholder="Path to a test image (e.g. C:\Users\you\Desktop\test.png)"
            style={{ flex: 1, padding: '6px 8px', fontSize: '12px', border: '1px solid var(--border)', borderRadius: '4px', background: 'var(--bg-color)', color: 'var(--text-main)' }}
          />
          <button
            className="secondary-btn"
            onClick={async () => {
              const el = document.getElementById('agent-test-image-path') as HTMLInputElement | null;
              const path = el?.value || '';
              if (!path) { setPickerMsg('enter a path first'); return; }
              const r = window.electronAPI.photoPickerTest
                ? await window.electronAPI.photoPickerTest(device.id, path)
                : { ok: false, message: 'unsupported' };
              setPickerMsg(r.message || (r.ok ? 'ok' : 'failed'));
            }}
            disabled={busy}
            style={{ padding: '4px 10px', fontSize: '12px' }}
            data-testid="agent-push-image"
          >
            Push &amp; test
          </button>
        </div>
        {pickerMsg && (
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
            {pickerMsg}
          </div>
        )}
        <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
          Pushes the file to <code>/data/local/tmp/</code> on the device and broadcasts
          the path to the companion. The file stays on device. No upload, no
          exfiltration. Useful for testing a photo-picker-style flow without
          granting storage permissions.
        </div>
      </div>
    </div>
  );
};

export default DeviceDetailModal;