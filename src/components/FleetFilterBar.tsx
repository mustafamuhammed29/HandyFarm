import React, { useMemo } from 'react';
import { Search, X } from 'lucide-react';
import type { DeviceData } from '../types';
import {
  healthTier,
  healthTierLabel,
  healthTierColorVar,
} from '../stateColor';
import type { LeaseState } from '../stateColor';

/**
 * Tokens we accept as `<key>:<value>` filters:
 *   status:device|offline|unauthorized|weak-connection|disconnect|unknown
 *   lease:available|leased|cooling_down|quarantined|maintenance
 *   health:healthy|degraded|at_risk|quarantined|unknown
 *   model:<substring>
 *   serial:<substring>
 *   name:<substring>
 *
 * Anything that isn't a token becomes part of the free-text query and
 * matches against model / serial / name (case-insensitive substring).
 *
 * The exported `applyFilter(devices, query, healthByPhysId)` is the pure
 * function; the React component just wraps it with input handling.
 */
export interface FilterHealthRow {
  healthScore: number;
  reasons: string[];
  leaseState: string;
}

export interface FilterResult {
  matched: DeviceData[];
  /** Active tokens shown as chips. */
  tokens: Array<{ key: string; value: string }>;
  /** Total before filtering (for the "X of Y" display). */
  totalCount: number;
  matchedCount: number;
}

const VALID_STATUSES = new Set(['device', 'offline', 'unauthorized', 'weak-connection', 'disconnect', 'unknown']);
const VALID_LEASES = new Set<LeaseState>(['available', 'leased', 'cooling_down', 'quarantined', 'maintenance']);
const VALID_HEALTHS = new Set(['healthy', 'degraded', 'at_risk', 'quarantined', 'unknown']);

export function parseFilterTokens(query: string): {
  tokens: Array<{ key: string; value: string }>;
  freeText: string[];
} {
  const tokens: Array<{ key: string; value: string }> = [];
  const freeText: string[] = [];
  for (const part of query.split(/\s+/).filter(Boolean)) {
    const m = part.match(/^([a-z]+):(.+)$/i);
    if (!m) { freeText.push(part.toLowerCase()); continue; }
    const [, key, value] = m;
    const lk = key.toLowerCase();
    if (lk === 'status' && VALID_STATUSES.has(value)) { tokens.push({ key: 'status', value }); continue; }
    if (lk === 'lease' && VALID_LEASES.has(value as LeaseState)) { tokens.push({ key: 'lease', value }); continue; }
    if (lk === 'health' && VALID_HEALTHS.has(value)) { tokens.push({ key: 'health', value }); continue; }
    if (lk === 'model' || lk === 'serial' || lk === 'name') {
      tokens.push({ key: lk, value: value.toLowerCase() });
      continue;
    }
    freeText.push(part.toLowerCase());
  }
  return { tokens, freeText };
}

/**
 * Pure filter. Test it without React: pass an arbitrary device list + a
 * query + a health lookup. Returns the filtered list + the tokens that
 * were applied.
 */
export function applyFilter(
  devices: DeviceData[],
  query: string,
  healthByPhysId: Record<string, FilterHealthRow>,
  showOffline: boolean,
): FilterResult {
  const { tokens, freeText } = parseFilterTokens(query);
  const totalCount = devices.length;

  const matched = devices.filter((d) => {
    if (!showOffline && (d.status === 'offline' || d.status === 'disconnect')) return false;
    for (const t of tokens) {
      if (t.key === 'status' && d.status !== t.value) return false;
      if (t.key === 'lease') {
        const ls = (d.leaseState || 'available') as LeaseState;
        if (ls !== t.value) return false;
      }
      if (t.key === 'health') {
        const physId = d.physicalDeviceId || `phys_${d.serial || d.id}`;
        const h = healthByPhysId[physId];
        const tier = healthTier(h?.healthScore ?? 0, (d.leaseState || 'available') as LeaseState);
        if (tier !== t.value) return false;
      }
      if (t.key === 'model') {
        if (!(d.model || '').toLowerCase().includes(t.value)) return false;
      }
      if (t.key === 'serial') {
        if (!(d.serial || '').toLowerCase().includes(t.value)) return false;
      }
      if (t.key === 'name') {
        const label = d.customName || d.name || d.model || '';
        if (!label.toLowerCase().includes(t.value)) return false;
      }
    }
    if (freeText.length > 0) {
      const hay = `${d.model || ''} ${d.serial || ''} ${d.customName || ''} ${d.name || ''}`.toLowerCase();
      for (const ft of freeText) {
        if (!hay.includes(ft)) return false;
      }
    }
    return true;
  });

  return { matched, tokens, totalCount, matchedCount: matched.length };
}

export interface FleetSummary {
  total: number;
  matched: number;
  healthy: number;
  degraded: number;
  at_risk: number;
  quarantined: number;
  offline: number;
  leased: number;
}

export function computeFleetSummary(
  devices: DeviceData[],
  matched: DeviceData[],
  healthByPhysId: Record<string, FilterHealthRow>,
): FleetSummary {
  const out: FleetSummary = {
    total: devices.length,
    matched: matched.length,
    healthy: 0,
    degraded: 0,
    at_risk: 0,
    quarantined: 0,
    offline: 0,
    leased: 0,
  };
  for (const d of matched) {
    const ls = d.leaseState || 'available';
    if (ls === 'quarantined') out.quarantined++;
    if (ls === 'leased') out.leased++;
    if (d.status === 'offline' || d.status === 'disconnect') out.offline++;
    const physId = d.physicalDeviceId || `phys_${d.serial || d.id}`;
    const h = healthByPhysId[physId];
    const tier = healthTier(h?.healthScore ?? 0, ls as LeaseState);
    if (tier === 'healthy') out.healthy++;
    else if (tier === 'degraded') out.degraded++;
    else if (tier === 'at_risk') out.at_risk++;
    // quarantined already incremented above; unknowns are ignored in the strip.
  }
  return out;
}

export const FleetFilterBar: React.FC<{
  devices: DeviceData[];
  filtered: DeviceData[];
  healthByPhysId: Record<string, FilterHealthRow>;
  query: string;
  setQuery: (q: string) => void;
}> = ({ devices, filtered, healthByPhysId, query, setQuery }) => {
  const { tokens } = useMemo(() => parseFilterTokens(query), [query]);
  const summary = useMemo(
    () => computeFleetSummary(devices, filtered, healthByPhysId),
    [devices, filtered, healthByPhysId],
  );

  const removeToken = (key: string, value: string) => {
    const next = query
      .split(/\s+/)
      .filter((t) => t !== `${key}:${value}`)
      .join(' ')
      .trim();
    setQuery(next);
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '8px 16px',
        background: 'var(--card-bg)',
        borderBottom: '1px solid var(--border)',
      }}
      data-testid="fleet-filter-bar"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            background: 'var(--bg-color)',
            border: '1px solid var(--border)',
            borderRadius: '6px',
            padding: '4px 8px',
            flex: 1,
            maxWidth: '480px',
          }}
        >
          <Search size={14} color="var(--text-muted)" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='Filter: "status:device lease:leased" or free text…'
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'var(--text-main)',
              fontSize: '13px',
            }}
            data-testid="fleet-filter-input"
          />
          {query.length > 0 && (
            <button
              onClick={() => setQuery('')}
              title="Clear filter"
              className="icon-btn"
              style={{ padding: '2px' }}
            >
              <X size={12} />
            </button>
          )}
        </div>

        <div
          style={{
            display: 'flex',
            gap: '12px',
            fontSize: '11px',
            color: 'var(--text-muted)',
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <Stat label="Matched" value={`${summary.matched}/${summary.total}`} color="var(--text-main)" />
          <Stat label="Healthy" value={summary.healthy} color={healthTierColorVar('healthy')} />
          <Stat label="Degraded" value={summary.degraded} color={healthTierColorVar('degraded')} />
          <Stat label="At risk" value={summary.at_risk} color={healthTierColorVar('at_risk')} />
          <Stat label="Quarantined" value={summary.quarantined} color={healthTierColorVar('quarantined')} />
          <Stat label="Leased" value={summary.leased} color="var(--state-leased)" />
          <Stat label="Offline" value={summary.offline} color="var(--state-offline)" />
        </div>
      </div>

      {tokens.length > 0 && (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {tokens.map((t, i) => {
            const colorVar =
              t.key === 'health' ? healthTierColorVar(t.value as any)
              : t.key === 'lease' ? (t.value === 'leased' ? 'var(--state-leased)' : t.value === 'quarantined' ? 'var(--state-quarantined)' : 'var(--text-muted)')
              : 'var(--accent)';
            return (
              <span
                key={`${t.key}:${t.value}:${i}`}
                style={{
                  fontSize: '11px',
                  padding: '2px 6px',
                  border: `1px solid ${colorVar}`,
                  borderRadius: '4px',
                  color: colorVar,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
                data-testid="filter-chip"
              >
                {t.key}:{t.value}
                <button
                  onClick={() => removeToken(t.key, t.value)}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'inherit', padding: 0 }}
                  aria-label={`Remove ${t.key}:${t.value}`}
                >
                  <X size={10} />
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* suppress unused-var lint for healthTierLabel */}
      {false && <span>{healthTierLabel('healthy')}</span>}
    </div>
  );
};

const Stat: React.FC<{ label: string; value: number | string; color: string }> = ({ label, value, color }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }} data-testid={`fleet-stat-${label.toLowerCase()}`}>
    <span style={{ color: 'var(--text-muted)' }}>{label}</span>
    <span style={{ color, fontWeight: 600 }}>{value}</span>
  </div>
);

export default FleetFilterBar;