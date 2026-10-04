import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  MinusCircle,
  Wifi,
  Battery,
  Activity,
  ChevronRight,
} from 'lucide-react';
import type { DeviceData } from '../types';
import {
  resolveDeviceStateColor,
  connectionColorVar,
  healthTier,
  healthTierColorVar,
  healthTierLabel,
  leaseLabel,
  connectionLabel,
} from '../stateColor';
import type { DeviceConnectionStatus, LeaseState } from '../stateColor';

export interface DeviceRowHealth {
  healthScore: number;
  reasons: string[];
  leaseState: string;
}

const TICK_MS = 1000;

/**
 * Compact, scannable row view (STF-inspired) for the focused-view list
 * mode. Each row summarizes: connection status · lease holder + TTL
 * countdown · health score · baseline status. Click the row to open the
 * per-device detail modal.
 */
export const DeviceRow: React.FC<{
  device: DeviceData;
  health?: DeviceRowHealth;
  isSelected: boolean;
  onToggleSelect: (id: string) => void;
  onOpenDetail: (id: string) => void;
  now: number;
}> = ({ device, health, isSelected, onToggleSelect, onOpenDetail, now }) => {
  const connection = (device.status || 'unknown') as DeviceConnectionStatus;
  const leaseState = ((health?.leaseState) || device.leaseState || 'available') as LeaseState;
  const rowColor = resolveDeviceStateColor(connection, leaseState);
  const connColor = connectionColorVar(connection);

  const tier = healthTier(health?.healthScore ?? 0, leaseState);
  const healthColor = healthTierColorVar(tier);

  const { countdownSec } = leaseLabel(
    leaseState,
    device.leasedBy,
    device.leaseExpiresAt,
    now,
  );

  // TTL countdown: bump `now` once per second so the displayed "3m 12s"
  // ticks down without a full React re-render of the whole list. We use
  // a local hook so each row only re-renders itself.
  const [liveNow, setLiveNow] = useState(now);
  useEffect(() => {
    if (leaseState !== 'leased' && leaseState !== 'cooling_down') return;
    const id = setInterval(() => setLiveNow((n) => n + TICK_MS), TICK_MS);
    return () => clearInterval(id);
  }, [leaseState]);
  const liveLease = leaseLabel(
    leaseState,
    device.leasedBy,
    device.leaseExpiresAt,
    liveNow,
  );

  // Quarantine reason: if state is quarantined and we have reasons, show
  // the first one truncated inline (per the audit).
  let quarantineReason: string | undefined;
  if (leaseState === 'quarantined' && health?.reasons && health.reasons.length > 0) {
    quarantineReason = health.reasons[0];
    if (quarantineReason.length > 60) quarantineReason = quarantineReason.slice(0, 57) + '…';
  }

  const ConnIcon =
    connection === 'device' ? CheckCircle2 :
    connection === 'unauthorized' || connection === 'weak-connection' ? AlertTriangle :
    connection === 'offline' || connection === 'disconnect' ? MinusCircle :
    XCircle;

  const baselineStatus = device.baselineStatus || 'unbaselined';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '8px 12px',
        background: isSelected ? 'rgba(59, 130, 246, 0.10)' : 'var(--card-bg)',
        borderLeft: `3px solid ${rowColor}`,
        borderRadius: '4px',
        cursor: 'pointer',
        minHeight: '52px',
      }}
      onClick={() => onOpenDetail(device.id)}
      data-testid={`device-row-${device.id}`}
    >
      {/* Select checkbox */}
      <input
        type="checkbox"
        checked={isSelected}
        onChange={() => onToggleSelect(device.id)}
        onClick={(e) => e.stopPropagation()}
        title="Select for batch actions"
      />

      {/* Connection status icon */}
      <ConnIcon size={16} color={connColor} />

      {/* Name + serial */}
      <div style={{ flex: '0 0 220px', minWidth: 0, overflow: 'hidden' }}>
        <div style={{ fontSize: '13px', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {device.customName || device.name || device.model || 'Unknown'}
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '6px' }}>
          {device.id.includes(':') && <Wifi size={10} />}
          <span>{device.model || '—'}</span>
          {device.serial && <span>· {device.serial.substring(0, 8)}</span>}
        </div>
      </div>

      {/* Connection status pill */}
      <span
        style={{
          fontSize: '11px',
          padding: '2px 8px',
          background: 'var(--bg-color)',
          color: connColor,
          border: `1px solid ${connColor}`,
          borderRadius: '4px',
          flex: '0 0 110px',
          textAlign: 'center',
        }}
        title={`Connection: ${connectionLabel(connection)}`}
      >
        {connectionLabel(connection)}
      </span>

      {/* Lease holder + TTL */}
      <div
        style={{
          flex: '1 1 220px',
          display: 'flex',
          flexDirection: 'column',
          fontSize: '12px',
          color: 'var(--text-main)',
          minWidth: 0,
        }}
      >
        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {liveLease.label}
        </span>
        {countdownSec !== undefined && leaseState === 'leased' && countdownSec <= 60 && (
          <span style={{ fontSize: '10px', color: 'var(--state-degraded)' }}>
            TTL expires soon
          </span>
        )}
        {quarantineReason && (
          <span style={{ fontSize: '10px', color: 'var(--state-quarantined)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {quarantineReason}
          </span>
        )}
      </div>

      {/* Health score */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          flex: '0 0 130px',
        }}
        title={health?.reasons?.length ? `Reasons: ${health.reasons.join('; ')}` : 'No health data yet'}
      >
        <Activity size={12} color={healthColor} />
        <span style={{ color: healthColor, fontWeight: 600, fontSize: '12px' }}>
          {healthTierLabel(tier)}
        </span>
        {health && (
          <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{health.healthScore}</span>
        )}
      </div>

      {/* Baseline status */}
      <span
        style={{
          fontSize: '10px',
          padding: '2px 6px',
          background: 'var(--bg-color)',
          borderRadius: '3px',
          color:
            baselineStatus === 'verified' ? 'var(--state-healthy)' :
            baselineStatus === 'drifted' ? 'var(--state-degraded)' :
            'var(--text-muted)',
          border: '1px solid var(--border)',
          flex: '0 0 80px',
          textAlign: 'center',
        }}
      >
        {baselineStatus === 'verified' ? '✓ Baseline' :
         baselineStatus === 'drifted' ? `⚠ Drift (${device.driftCount || 1})` :
         'No Baseline'}
      </span>

      {/* Battery */}
      {device.battery && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flex: '0 0 60px', color: 'var(--text-muted)', fontSize: '11px' }}>
          <Battery size={12} />
          {device.battery.level}%{device.battery.charging && '⚡'}
        </div>
      )}

      {/* Chevron indicator for opening the detail modal */}
      <ChevronRight size={14} color="var(--text-muted)" />
    </div>
  );
};

export default DeviceRow;