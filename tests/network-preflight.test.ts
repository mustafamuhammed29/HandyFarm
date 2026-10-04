/**
 * Phase 2 — Network Preflight & SIM Inventory Tests
 *
 * Tests the pure, side-effect-free functions in network.ts using:
 *  - Unit assertions for known concrete cases
 *  - Property-based tests (fast-check) to cover the entire input space
 *
 * No ADB devices are required; all I/O is injected via mock executors.
 */

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';

import {
  hashImsi,
  redactMsisdn,
  sanitizeSimRecord,
  evaluateDataBudget,
  calculateFleetDataBudget,
  parseConnectivityDumpsys,
  checkCellularDefaultRoute,
  captureDeviceEgress,
  executeNetworkPreflight,
  CircuitBreakerTrippedError,
  type SimRecord,
  type ObservedEgress,
} from '../electron/network.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSim(overrides: Partial<SimRecord> = {}): SimRecord {
  return {
    id: 'sim_test_01',
    slot: 1,
    iccid: '8949430123456789012',
    carrier: 'LycaMobile DE',
    apn: 'data.lycamobile.de',
    plan: 'Prepaid Smart S - 10GB',
    dataCapBytes: 10 * 1024 * 1024 * 1024,
    dataUsedBytes: 0,
    renewalDate: '2026-10-31',
    status: 'active',
    imsiHashed: 'a'.repeat(64),
    msisdnRedacted: '+49 151 **** 6789',
    assignedDeviceId: 'device_abc',
    createdAt: 1000000,
    updatedAt: 1000000,
    ...overrides
  };
}

function mockAdb(responses: Record<string, string> = {}) {
  return async (args: string[]) => {
    const cmd = args.join(' ');
    for (const [key, val] of Object.entries(responses)) {
      if (cmd.includes(key)) return { stdout: val, stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
}

// ---------------------------------------------------------------------------
// §1 — PII Sanitization
// ---------------------------------------------------------------------------

describe('§1 PII Sanitization', () => {
  describe('hashImsi()', () => {
    it('returns a 64-char hex SHA-256 hash for a raw IMSI', () => {
      const hash = hashImsi('262010123456789');
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('is idempotent — passing an already-hashed value returns the same value', () => {
      const hash = hashImsi('262010123456789');
      expect(hashImsi(hash)).toBe(hash);
    });

    it('returns empty string for empty input', () => {
      expect(hashImsi('')).toBe('');
    });

    it('produces different hashes for different IMSIs', () => {
      expect(hashImsi('262010000000001')).not.toBe(hashImsi('262010000000002'));
    });

    it('[property] output is always 64 hex chars for any non-empty non-hex-64 IMSI', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 1, maxLength: 20 }), (imsi) => {
          if (/^[a-f0-9]{64}$/i.test(imsi)) return true;
          return /^[a-f0-9]{64}$/.test(hashImsi(imsi));
        })
      );
    });
  });

  describe('redactMsisdn()', () => {
    it('redacts a full international German number', () => {
      const r = redactMsisdn('+4915123456789');
      expect(r).toMatch(/\*\*\*\*/);
      expect(r).toContain('6789');
    });

    it('redacts a local German number', () => {
      const r = redactMsisdn('015123456789');
      expect(r).toMatch(/\*\*\*\*/);
      expect(r).toContain('6789');
    });

    it('passes through already-redacted values unchanged', () => {
      const already = '+49 151 **** 6789';
      expect(redactMsisdn(already)).toBe(already);
    });

    it('returns **** for very short inputs', () => {
      expect(redactMsisdn('123')).toBe('****');
    });

    it('returns empty string for empty input', () => {
      expect(redactMsisdn('')).toBe('');
    });
  });

  describe('sanitizeSimRecord()', () => {
    it('hashes IMSI and redacts MSISDN, keeping no plaintext', () => {
      const sim = sanitizeSimRecord({
        iccid: '8949430123456789',
        carrier: 'TestCarrier',
        apn: 'internet',
        plan: '5GB',
        dataCapBytes: 5_000_000_000,
        renewalDate: '2026-12-01',
        imsi: '262010123456789',
        msisdn: '+4915123456789'
      });
      expect(sim.imsiHashed).toMatch(/^[a-f0-9]{64}$/);
      expect(sim.msisdnRedacted).toMatch(/\*\*\*\*/);
      expect(JSON.stringify(sim)).not.toContain('262010123456789');
      expect(JSON.stringify(sim)).not.toContain('15123456789');
    });

    it('auto-generates id from last 6 digits of ICCID', () => {
      const sim = sanitizeSimRecord({
        iccid: '8949430000009012',
        carrier: 'X', apn: 'x', plan: 'x', dataCapBytes: 1, renewalDate: '2026-01-01'
      });
      expect(sim.id).toBe('sim_009012');
    });

    it('defaults status to active when assignedDeviceId present', () => {
      const sim = sanitizeSimRecord({
        iccid: '1234567890123456',
        carrier: 'X', apn: 'x', plan: 'x', dataCapBytes: 1,
        renewalDate: '2026-01-01', assignedDeviceId: 'dev_01'
      });
      expect(sim.status).toBe('active');
    });

    it('defaults status to unassigned when no assignedDeviceId', () => {
      const sim = sanitizeSimRecord({
        iccid: '1234567890123456',
        carrier: 'X', apn: 'x', plan: 'x', dataCapBytes: 1, renewalDate: '2026-01-01'
      });
      expect(sim.status).toBe('unassigned');
    });
  });
});

// ---------------------------------------------------------------------------
// §2 — Data Budget & Circuit Breaker
// ---------------------------------------------------------------------------

describe('§2 Data Budget & Circuit Breaker', () => {
  describe('evaluateDataBudget()', () => {
    it('ok when usage is below 80%', () => {
      const budget = evaluateDataBudget(makeSim({ dataCapBytes: 10_000, dataUsedBytes: 500 }));
      expect(budget.status).toBe('ok');
      expect(budget.isWarning).toBe(false);
      expect(budget.isBreakerTripped).toBe(false);
    });

    it('warning at exactly 80%', () => {
      const budget = evaluateDataBudget(makeSim({ dataCapBytes: 10_000, dataUsedBytes: 8_000 }));
      expect(budget.status).toBe('warning');
      expect(budget.isWarning).toBe(true);
      expect(budget.isBreakerTripped).toBe(false);
      expect(budget.message).toMatch(/BUDGET_WARNING/);
    });

    it('tripped at exactly 100% — circuit breaker fires', () => {
      const budget = evaluateDataBudget(makeSim({ dataCapBytes: 10_000, dataUsedBytes: 10_000 }));
      expect(budget.status).toBe('tripped');
      expect(budget.isBreakerTripped).toBe(true);
      expect(budget.remainingBytes).toBe(0);
      expect(budget.message).toMatch(/CIRCUIT_BREAKER_TRIPPED/);
    });

    it('tripped when used > cap', () => {
      const budget = evaluateDataBudget(makeSim({ dataCapBytes: 10_000, dataUsedBytes: 15_000 }));
      expect(budget.isBreakerTripped).toBe(true);
    });

    it('additionalBytes projection trips breaker correctly', () => {
      const budget = evaluateDataBudget(makeSim({ dataCapBytes: 10_000, dataUsedBytes: 9_500 }), 600);
      expect(budget.isBreakerTripped).toBe(true);
    });

    it('additionalBytes projection shows warning at >=80%', () => {
      const budget = evaluateDataBudget(makeSim({ dataCapBytes: 10_000, dataUsedBytes: 7_500 }), 700);
      expect(budget.isWarning).toBe(true);
    });

    it('[property] remainingBytes is always 0 when breaker is tripped', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 10_000_000 }),
          fc.integer({ min: 0, max: 20_000_000 }),
          (cap, used) => {
            const budget = evaluateDataBudget(makeSim({ dataCapBytes: cap, dataUsedBytes: used }));
            return !budget.isBreakerTripped || budget.remainingBytes === 0;
          }
        )
      );
    });

    it('[property] usagePercent is always >= 0', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 100_000 }),
          fc.integer({ min: 0, max: 100_000 }),
          (cap, used) => evaluateDataBudget(makeSim({ dataCapBytes: cap, dataUsedBytes: used })).usagePercent >= 0
        )
      );
    });

    it('[property] warning and tripped are mutually exclusive', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 1_000_000 }),
          fc.integer({ min: 0, max: 2_000_000 }),
          (cap, used) => {
            const { isWarning, isBreakerTripped } = evaluateDataBudget(makeSim({ dataCapBytes: cap, dataUsedBytes: used }));
            return !(isWarning && isBreakerTripped);
          }
        )
      );
    });

    it('[property] status is always one of ok/warning/tripped', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 1_000_000 }),
          fc.integer({ min: 0, max: 2_000_000 }),
          (cap, used) => ['ok', 'warning', 'tripped'].includes(
            evaluateDataBudget(makeSim({ dataCapBytes: cap, dataUsedBytes: used })).status
          )
        )
      );
    });
  });

  describe('calculateFleetDataBudget()', () => {
    it('counts tripped and warning SIMs correctly', () => {
      const sims = [
        makeSim({ id: 'a', dataCapBytes: 1000, dataUsedBytes: 1000 }),
        makeSim({ id: 'b', dataCapBytes: 1000, dataUsedBytes: 800 }),
        makeSim({ id: 'c', dataCapBytes: 1000, dataUsedBytes: 100 }),
      ];
      const summary = calculateFleetDataBudget(sims);
      expect(summary.trippedCount).toBe(1);
      expect(summary.trippedSimIds).toContain('a');
      expect(summary.warningCount).toBe(1);
      expect(summary.warningSimIds).toContain('b');
    });

    it('returns zero counts for empty fleet', () => {
      const summary = calculateFleetDataBudget([]);
      expect(summary.totalSims).toBe(0);
      expect(summary.fleetUsagePercent).toBe(0);
    });

    it('[property] fleetUsagePercent is 0–100 when used <= cap for all SIMs', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({ cap: fc.integer({ min: 1, max: 1_000_000 }), used: fc.integer({ min: 0, max: 1_000_000 }) }),
            { minLength: 0, maxLength: 20 }
          ),
          (pairs) => {
            const sims = pairs.map((p, i) => makeSim({ id: `s${i}`, dataCapBytes: p.cap, dataUsedBytes: Math.min(p.used, p.cap) }));
            const { fleetUsagePercent } = calculateFleetDataBudget(sims);
            return fleetUsagePercent >= 0 && fleetUsagePercent <= 100;
          }
        )
      );
    });
  });
});

// ---------------------------------------------------------------------------
// §3 — Dual-Transport Route Enforcement
// ---------------------------------------------------------------------------

describe('§3 Dual-Transport Route Enforcement', () => {
  describe('parseConnectivityDumpsys()', () => {
    const CELLULAR_OUTPUT = `
Active default network: 100
NetworkAgentInfo{network{100}
  Transports: CELLULAR
}`;
    const WIFI_OUTPUT = `
Active default network: 200
NetworkAgentInfo{network{200}
  Transports: WIFI
}`;

    it('identifies cellular as active transport', () => {
      const result = parseConnectivityDumpsys(CELLULAR_OUTPUT);
      expect(result.transport).toBe('cellular');
      expect(result.activeNetId).toBe('100');
    });

    it('identifies wifi as active transport', () => {
      expect(parseConnectivityDumpsys(WIFI_OUTPUT).transport).toBe('wifi');
    });

    it('returns unknown when output is empty', () => {
      expect(parseConnectivityDumpsys('').transport).toBe('unknown');
      expect(parseConnectivityDumpsys('').activeNetId).toBeNull();
    });
  });

  describe('checkCellularDefaultRoute()', () => {
    const CELLULAR_DUMPSYS = 'Active default network: 5\nNetworkAgentInfo{network{5}\n  Transports: CELLULAR\n}';

    it('passes when Wi-Fi off, mobile data on, transport is cellular', async () => {
      const exec = mockAdb({ 'wifi_on': '0', 'mobile_data': '1', 'dumpsys connectivity': CELLULAR_DUMPSYS });
      const result = await checkCellularDefaultRoute('dev_01', exec);
      expect(result.isCellularDefault).toBe(true);
      expect(result.wifiEnabled).toBe(false);
    });

    it('FAILS — dual-transport violation when Wi-Fi is enabled', async () => {
      const exec = mockAdb({ 'wifi_on': '1', 'mobile_data': '1', 'dumpsys connectivity': '' });
      const result = await checkCellularDefaultRoute('dev_02', exec);
      expect(result.isCellularDefault).toBe(false);
      expect(result.reason).toMatch(/DUAL_TRANSPORT_VIOLATION/);
    });

    it('FAILS — when mobile data is disabled', async () => {
      const exec = mockAdb({ 'wifi_on': '0', 'mobile_data': '0', 'dumpsys connectivity': '' });
      const result = await checkCellularDefaultRoute('dev_03', exec);
      expect(result.isCellularDefault).toBe(false);
      expect(result.reason).toMatch(/CELLULAR_DATA_DISABLED/);
    });
  });
});

// ---------------------------------------------------------------------------
// §4 — Observed Egress Capture
// ---------------------------------------------------------------------------

describe('§4 Observed Egress Capture', () => {
  const GOOD_JSON = JSON.stringify({
    publicIp: '185.22.1.200', asn: 'AS3320', carrier: 'Deutsche Telekom',
    geo: { country: 'DE', city: 'Berlin' }, transport: 'cellular', observedAt: 1700000000000
  });

  it('parses a well-formed egress broadcast response', async () => {
    const exec = async (_: string[]) => ({
      stdout: `Broadcast completed: result=0, data="${GOOD_JSON}"`, stderr: ''
    });
    const egress = await captureDeviceEgress('dev_01', 'phys_01', 'run_test', exec);
    expect(egress.publicIp).toBe('185.22.1.200');
    expect(egress.transport).toBe('cellular');
    expect(egress.geo.country).toBe('DE');
  });

  it('throws when broadcast returns no data field', async () => {
    const exec = async (_: string[]) => ({ stdout: 'Broadcast completed: result=0', stderr: '' });
    await expect(captureDeviceEgress('dev_01', 'phys_01', 'run_test', exec))
      .rejects.toThrow('Failed to capture egress broadcast');
  });

  it('throws when JSON is malformed', async () => {
    const exec = async (_: string[]) => ({ stdout: 'Broadcast completed: result=0, data="bad-json"', stderr: '' });
    await expect(captureDeviceEgress('dev_01', 'phys_01', 'run_test', exec)).rejects.toThrow('Invalid JSON');
  });

  it('throws when egress response contains an error field', async () => {
    const errJson = JSON.stringify({ error: 'Network timeout' });
    const exec = async (_: string[]) => ({ stdout: `Broadcast completed: result=0, data="${errJson}"`, stderr: '' });
    await expect(captureDeviceEgress('dev_01', 'phys_01', 'run_test', exec)).rejects.toThrow('Observed egress resolution failed');
  });

  it('throws when publicIp is missing', async () => {
    const partialJson = JSON.stringify({ asn: 'AS1234', transport: 'cellular' });
    const exec = async (_: string[]) => ({ stdout: `Broadcast completed: result=0, data="${partialJson}"`, stderr: '' });
    await expect(captureDeviceEgress('dev_01', 'phys_01', 'run_test', exec)).rejects.toThrow('did not return a public IP');
  });
});

// ---------------------------------------------------------------------------
// §5 — Full Network Preflight Orchestration
// ---------------------------------------------------------------------------

describe('§5 Full Network Preflight Orchestration', () => {
  const GOOD_JSON = JSON.stringify({
    publicIp: '185.22.1.200', asn: 'AS3320', carrier: 'Deutsche Telekom',
    geo: { country: 'DE', city: 'Berlin' }, transport: 'cellular', observedAt: 1700000000000
  });

  const goodExec = mockAdb({
    'wifi_on': '0',
    'mobile_data': '1',
    'dumpsys connectivity': 'Active default network: 5\nNetworkAgentInfo{network{5}\n  Transports: CELLULAR\n}',
    'am broadcast': `Broadcast completed: result=0, data="${GOOD_JSON}"`
  });

  it('passes all 4 checks on a well-configured cellular device', async () => {
    const recorded: ObservedEgress[] = [];
    const result = await executeNetworkPreflight(
      { deviceId: 'dev_01', runId: 'run_green' },
      { getSimForDevice: () => makeSim({ carrier: 'Deutsche Telekom' }), recordEgress: (e) => recorded.push(e), execAdb: goodExec, physicalDeviceId: 'phys_01' }
    );
    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(4);
    expect(result.checks.every(c => c.passed)).toBe(true);
    expect(recorded).toHaveLength(1);
    expect(result.egress?.publicIp).toBe('185.22.1.200');
  });

  it('fails at check 1 on dual-transport violation and short-circuits', async () => {
    const exec = mockAdb({ 'wifi_on': '1', 'mobile_data': '1' });
    const result = await executeNetworkPreflight(
      { deviceId: 'dev_01' },
      { getSimForDevice: () => makeSim(), recordEgress: vi.fn(), execAdb: exec }
    );
    expect(result.passed).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].check).toBe('dual_transport_cellular_route');
    expect(result.error).toMatch(/DUAL_TRANSPORT_VIOLATION/);
  });

  it('fails at check 2 when no SIM is assigned', async () => {
    const result = await executeNetworkPreflight(
      { deviceId: 'dev_01' },
      { getSimForDevice: () => undefined, recordEgress: vi.fn(), execAdb: goodExec }
    );
    expect(result.passed).toBe(false);
    expect(result.checks).toHaveLength(2);
    expect(result.error).toMatch(/No SIM card assigned/);
  });

  it('fails at check 2 when carrier does not match expectedCarrier', async () => {
    const result = await executeNetworkPreflight(
      { deviceId: 'dev_01', expectedCarrier: 'Vodafone' },
      { getSimForDevice: () => makeSim({ carrier: 'LycaMobile DE' }), recordEgress: vi.fn(), execAdb: goodExec }
    );
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/Carrier mismatch/);
  });

  it('passes carrier check with partial substring match', async () => {
    const recorded: ObservedEgress[] = [];
    const result = await executeNetworkPreflight(
      { deviceId: 'dev_01', expectedCarrier: 'Lyca' },
      { getSimForDevice: () => makeSim({ carrier: 'LycaMobile DE' }), recordEgress: (e) => recorded.push(e), execAdb: goodExec }
    );
    expect(result.passed).toBe(true);
    expect(result.checks[1].passed).toBe(true);
  });

  it('HARD CIRCUIT BREAKER: fails at check 3 when data cap is exhausted', async () => {
    const result = await executeNetworkPreflight(
      { deviceId: 'dev_01', requiredBytes: 1 },
      { getSimForDevice: () => makeSim({ dataCapBytes: 1_000, dataUsedBytes: 1_000 }), recordEgress: vi.fn(), execAdb: goodExec }
    );
    expect(result.passed).toBe(false);
    expect(result.checks).toHaveLength(3);
    expect(result.checks[2].check).toBe('budget_headroom');
    expect(result.error).toMatch(/CIRCUIT_BREAKER_TRIPPED/);
  });

  it('ALERT AT 80%: passes check 3 with warning message at 85% usage', async () => {
    const recorded: ObservedEgress[] = [];
    const result = await executeNetworkPreflight(
      { deviceId: 'dev_01', requiredBytes: 0 },
      { getSimForDevice: () => makeSim({ dataCapBytes: 10_000, dataUsedBytes: 8_500 }), recordEgress: (e) => recorded.push(e), execAdb: goodExec }
    );
    expect(result.passed).toBe(true);
    expect(result.checks[2].passed).toBe(true);
    expect(result.checks[2].message).toMatch(/Warning.*>=80%/i);
  });

  it('fails at check 4 when egress broadcast fails on device', async () => {
    const failExec = async (args: string[]) => {
      const cmd = args.join(' ');
      if (cmd.includes('wifi_on')) return { stdout: '0', stderr: '' };
      if (cmd.includes('mobile_data')) return { stdout: '1', stderr: '' };
      if (cmd.includes('dumpsys')) return { stdout: 'Active default network: 5\nNetworkAgentInfo{network{5}\n  Transports: CELLULAR\n}', stderr: '' };
      return { stdout: 'Broadcast completed: result=0', stderr: '' }; // no data
    };
    const result = await executeNetworkPreflight(
      { deviceId: 'dev_01' },
      { getSimForDevice: () => makeSim(), recordEgress: vi.fn(), execAdb: failExec }
    );
    expect(result.passed).toBe(false);
    expect(result.checks[3].check).toBe('observed_egress');
    expect(result.error).toMatch(/Failed to capture egress broadcast/);
  });
});

// ---------------------------------------------------------------------------
// §6 — CircuitBreakerTrippedError
// ---------------------------------------------------------------------------

describe('§6 CircuitBreakerTrippedError', () => {
  it('is instanceof Error and CircuitBreakerTrippedError', () => {
    const err = new CircuitBreakerTrippedError('sim_01', 10_000, 10_000);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CircuitBreakerTrippedError);
  });

  it('carries simId, dataUsedBytes, dataCapBytes and correct name', () => {
    const err = new CircuitBreakerTrippedError('sim_lyca_01', 5_000_000, 4_000_000);
    expect(err.simId).toBe('sim_lyca_01');
    expect(err.dataUsedBytes).toBe(5_000_000);
    expect(err.dataCapBytes).toBe(4_000_000);
    expect(err.name).toBe('CircuitBreakerTrippedError');
    expect(err.message).toMatch(/CIRCUIT_BREAKER_TRIPPED/);
  });
});
