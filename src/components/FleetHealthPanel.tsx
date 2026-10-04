import React, { useState, useEffect, useCallback } from 'react';
import { Activity, AlertTriangle, CheckCircle2, RefreshCw, ShieldAlert } from 'lucide-react';
import type { DeviceData } from '../types';

interface HealthDevice {
  physicalDeviceId: string;
  healthScore: number;
  reasons: string[];
  lastEvaluatedAt: number;
  leaseState: string;
  propsAttempts: number;
  propsFailures: number;
  reconnectCount: number;
}

interface FleetHealthSummary {
  total: number;
  devices: HealthDevice[];
}

function scoreColor(score: number): string {
  if (score >= 80) return 'var(--status-online)';
  if (score >= 60) return '#facc15';
  if (score >= 40) return '#fb923c';
  return 'var(--status-error)';
}

function scoreLabel(score: number): string {
  if (score >= 80) return 'Healthy';
  if (score >= 60) return 'Degraded';
  if (score >= 40) return 'At risk';
  return 'Quarantined';
}

export const FleetHealthPanel: React.FC<{ devices?: DeviceData[] }> = ({ devices: _devices }) => {
  const [summary, setSummary] = useState<FleetHealthSummary | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [lastResult, setLastResult] = useState<{ evaluated: number; transitions: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const fleet = await window.electronAPI.getFleetHealth?.();
      if (fleet) setSummary(fleet as FleetHealthSummary);
    } catch (err: any) {
      setError(err?.message || 'Failed to load fleet health');
    }
  }, []);

  const evaluateNow = useCallback(async () => {
    setEvaluating(true);
    try {
      const result = await window.electronAPI.evaluateHealthNow?.();
      if (result) {
        setLastResult(result);
        await refresh();
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to evaluate health');
    } finally {
      setEvaluating(false);
    }
  }, [refresh]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 15_000); // refresh every 15s
    return () => clearInterval(id);
  }, [refresh]);

  const total = summary?.total ?? 0;
  const quarantined = summary?.devices.filter(d => d.leaseState === 'quarantined').length ?? 0;
  const degraded = summary?.devices.filter(d => d.leaseState !== 'quarantined' && d.healthScore < 60).length ?? 0;
  const healthy = summary?.devices.filter(d => d.leaseState !== 'quarantined' && d.healthScore >= 60).length ?? 0;
  const avgScore = total > 0
    ? Math.round(summary!.devices.reduce((sum, d) => sum + d.healthScore, 0) / total)
    : 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Activity size={16} />
          <span style={{ fontSize: '13px', fontWeight: 600 }}>Fleet Health</span>
          {total > 0 && (
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              {total} device{total === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <button
          className="icon-btn"
          onClick={evaluateNow}
          disabled={evaluating}
          title="Force an immediate health evaluation tick"
          style={{ padding: '4px' }}
        >
          <RefreshCw size={14} className={evaluating ? 'spin' : ''} />
        </button>
      </div>

      {error && (
        <div style={{ fontSize: '11px', color: 'var(--status-error)' }}>
          {error}
        </div>
      )}

      {total === 0 ? (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>
          No devices have been evaluated yet. Health ticks run every 30s.
        </div>
      ) : (
        <>
          {/* Summary counters */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px', fontSize: '11px' }}>
            <div style={{ background: 'var(--bg-color)', padding: '6px', borderRadius: '4px', textAlign: 'center' }}>
              <div style={{ color: 'var(--status-online)', fontWeight: 600, fontSize: '14px' }}>{healthy}</div>
              <div style={{ color: 'var(--text-muted)' }}>Healthy</div>
            </div>
            <div style={{ background: 'var(--bg-color)', padding: '6px', borderRadius: '4px', textAlign: 'center' }}>
              <div style={{ color: '#fb923c', fontWeight: 600, fontSize: '14px' }}>{degraded}</div>
              <div style={{ color: 'var(--text-muted)' }}>Degraded</div>
            </div>
            <div style={{ background: 'var(--bg-color)', padding: '6px', borderRadius: '4px', textAlign: 'center' }}>
              <div style={{ color: 'var(--status-error)', fontWeight: 600, fontSize: '14px' }}>{quarantined}</div>
              <div style={{ color: 'var(--text-muted)' }}>Quarantined</div>
            </div>
            <div style={{ background: 'var(--bg-color)', padding: '6px', borderRadius: '4px', textAlign: 'center' }}>
              <div style={{ color: scoreColor(avgScore), fontWeight: 600, fontSize: '14px' }}>{avgScore}</div>
              <div style={{ color: 'var(--text-muted)' }}>Avg score</div>
            </div>
          </div>

          {/* Per-device list */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '260px', overflowY: 'auto' }}>
            {summary!.devices
              .slice()
              .sort((a, b) => a.healthScore - b.healthScore)
              .map(d => {
                const reasons = d.reasons.length > 0 ? d.reasons.join('; ') : '—';
                return (
                  <div
                    key={d.physicalDeviceId}
                    style={{
                      background: 'var(--bg-color)',
                      padding: '6px 8px',
                      borderRadius: '4px',
                      borderLeft: `3px solid ${scoreColor(d.healthScore)}`,
                      fontSize: '11px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                    title={`Score: ${d.healthScore}\nReasons: ${reasons}\nProps: ${d.propsFailures}/${d.propsAttempts} failed\nReconnects: ${d.reconnectCount}`}
                  >
                    {d.leaseState === 'quarantined'
                      ? <ShieldAlert size={12} color="var(--status-error)" />
                      : d.healthScore < 60
                        ? <AlertTriangle size={12} color="#fb923c" />
                        : <CheckCircle2 size={12} color="var(--status-online)" />}
                    <div style={{ flex: 1, overflow: 'hidden' }}>
                      <div style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {d.physicalDeviceId.replace(/^phys_/, '')}
                      </div>
                      <div style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                        {scoreLabel(d.healthScore)} · {d.healthScore}
                      </div>
                    </div>
                  </div>
                );
              })}
          </div>

          {lastResult && (
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
              Last manual tick: {lastResult.evaluated} evaluated, {lastResult.transitions} transition{lastResult.transitions === 1 ? '' : 's'}.
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default FleetHealthPanel;