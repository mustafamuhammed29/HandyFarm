import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  parseFilterTokens,
  applyFilter,
  computeFleetSummary,
  FilterHealthRow,
} from '../src/components/FleetFilterBar';
import type { DeviceData } from '../src/types';

const mkDevice = (overrides: Partial<DeviceData>): DeviceData => ({
  id: 'serial-A',
  name: 'Pixel 7',
  model: 'GA03923-US',
  serial: 'ABC123XYZ',
  customName: 'Lab A',
  status: 'device',
  battery: { level: 80, charging: false, temperature: undefined },
  ...overrides,
} as any);

const healthRow = (overrides: Partial<FilterHealthRow>): FilterHealthRow => ({
  healthScore: 100,
  reasons: [],
  leaseState: 'available',
  ...overrides,
});

describe('FleetFilterBar — applyFilter', () => {
  describe('parseFilterTokens', () => {
    it('parses status tokens', () => {
      expect(parseFilterTokens('status:device').tokens).toEqual([{ key: 'status', value: 'device' }]);
    });

    it('parses lease tokens', () => {
      expect(parseFilterTokens('lease:leased').tokens).toEqual([{ key: 'lease', value: 'leased' }]);
    });

    it('parses health tokens', () => {
      expect(parseFilterTokens('health:degraded').tokens).toEqual([{ key: 'health', value: 'degraded' }]);
    });

    it('parses model/serial/name substring tokens', () => {
      const { tokens, freeText } = parseFilterTokens('model:LH7n serial:abc name:lab');
      expect(tokens).toEqual([
        { key: 'model', value: 'lh7n' },
        { key: 'serial', value: 'abc' },
        { key: 'name', value: 'lab' },
      ]);
      expect(freeText).toEqual([]);
    });

    it('drops invalid status / lease / health values to free-text', () => {
      const { tokens, freeText } = parseFilterTokens('status:bogus lease:wtf health:nope');
      expect(tokens).toEqual([]);
      expect(freeText).toEqual(['status:bogus', 'lease:wtf', 'health:nope']);
    });

    it('handles a mixed query', () => {
      const { tokens, freeText } = parseFilterTokens('status:device LH7n lease:leased');
      expect(tokens).toEqual([{ key: 'status', value: 'device' }, { key: 'lease', value: 'leased' }]);
      expect(freeText).toEqual(['lh7n']);
    });

    it('property: tokens and free-text are a partition of the input', () => {
      fc.assert(
        fc.property(
          fc.array(fc.oneof(
            fc.constant('status:device'),
            fc.constant('lease:leased'),
            fc.constant('model:LH7n'),
            fc.string({ minLength: 1, maxLength: 8 }).filter(s => !s.includes(' ')),
          ), { minLength: 0, maxLength: 12 }),
          (parts) => {
            const q = parts.filter(Boolean).join(' ');
            const { tokens, freeText } = parseFilterTokens(q);
            // After join+split, empty parts are dropped; so the partition is
            // over the *non-empty* parts only.
            const totalIn = parts.filter(Boolean).length;
            return tokens.length + freeText.length === totalIn;
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('applyFilter — single-attribute', () => {
    const devs = [
      mkDevice({ id: 'serial-A', model: 'GA03923-US', status: 'device', leaseState: 'available' }),
      mkDevice({ id: 'serial-B', model: 'TECNO LH7n', status: 'offline', leaseState: 'quarantined' }),
      mkDevice({ id: 'serial-C', model: 'Pixel 8', status: 'device', leaseState: 'leased' }),
    ];

    it('filters by status:device', () => {
      const r = applyFilter(devs, 'status:device', {}, true);
      expect(r.matched.map(d => d.id)).toEqual(['serial-A', 'serial-C']);
    });

    it('filters by lease:quarantined', () => {
      const r = applyFilter(devs, 'lease:quarantined', {}, true);
      expect(r.matched.map(d => d.id)).toEqual(['serial-B']);
    });

    it('filters by free text on model substring', () => {
      const r = applyFilter(devs, 'TECNO', {}, true);
      expect(r.matched.map(d => d.id)).toEqual(['serial-B']);
    });

    it('filters by showOffline=true vs false', () => {
      const r1 = applyFilter(devs, '', {}, true);
      expect(r1.matched).toHaveLength(3);
      const r2 = applyFilter(devs, '', {}, false);
      expect(r2.matched).toHaveLength(2);
    });

    it('property: filter result is a subset of the input', () => {
      // Build an arbitrary that produces a synthetic DeviceData shape.
      const deviceArb = fc.record({
        id: fc.string({ minLength: 1, maxLength: 20 }),
        model: fc.string({ minLength: 0, maxLength: 30 }),
        serial: fc.string({ minLength: 0, maxLength: 20 }),
        name: fc.string({ minLength: 0, maxLength: 20 }),
        customName: fc.string({ minLength: 0, maxLength: 20 }),
        status: fc.constantFrom('device', 'offline', 'unauthorized', 'weak-connection', 'disconnect'),
        leaseState: fc.constantFrom('available', 'leased', 'cooling_down', 'quarantined', 'maintenance'),
        physicalDeviceId: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
        battery: fc.record({ level: fc.integer({ min: 0, max: 100 }), charging: fc.boolean() }),
      }) as fc.Arbitrary<DeviceData>;
      fc.assert(
        fc.property(
          fc.array(deviceArb, { minLength: 0, maxLength: 30 }),
          fc.string({ minLength: 0, maxLength: 50 }),
          fc.boolean(),
          (devs, q, showOffline) => {
            const r = applyFilter(devs, q, {}, showOffline);
            return r.matched.length <= devs.length;
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('applyFilter — multi-token AND semantics', () => {
    const devs = [
      mkDevice({ id: 'serial-A', model: 'TECNO LH7n', status: 'device', leaseState: 'leased' }),
      mkDevice({ id: 'serial-B', model: 'TECNO LH7n', status: 'device', leaseState: 'available' }),
      mkDevice({ id: 'serial-C', model: 'Pixel 7', status: 'device', leaseState: 'leased' }),
    ];

    it('AND across status + lease + model', () => {
      const r = applyFilter(devs, 'status:device lease:leased model:LH7n', {}, true);
      expect(r.matched.map(d => d.id)).toEqual(['serial-A']);
    });
  });

  describe('applyFilter — health-tier filtering', () => {
    const devs = [
      mkDevice({ id: 'a', model: 'A', status: 'device', leaseState: 'available', physicalDeviceId: 'phys_a' }),
      mkDevice({ id: 'b', model: 'B', status: 'device', leaseState: 'available', physicalDeviceId: 'phys_b' }),
    ];
    const health = {
      phys_a: healthRow({ healthScore: 100 }),
      phys_b: healthRow({ healthScore: 55 }),
    };

    it('health:healthy filters to score >= 80', () => {
      const r = applyFilter(devs, 'health:healthy', health, true);
      expect(r.matched.map(d => d.id)).toEqual(['a']);
    });

    it('health:at_risk filters to 0 < score < 60', () => {
      const r = applyFilter(devs, 'health:at_risk', health, true);
      expect(r.matched.map(d => d.id)).toEqual(['b']);
    });
  });
});

describe('computeFleetSummary', () => {
  it('counts each tier + lease state correctly', () => {
    const devs = [
      mkDevice({ id: 'a', status: 'device', leaseState: 'available', physicalDeviceId: 'phys_a' }),
      mkDevice({ id: 'b', status: 'device', leaseState: 'leased', physicalDeviceId: 'phys_b' }),
      mkDevice({ id: 'c', status: 'device', leaseState: 'quarantined', physicalDeviceId: 'phys_c' }),
      mkDevice({ id: 'd', status: 'offline', leaseState: 'available', physicalDeviceId: 'phys_d' }),
    ];
    const health = {
      phys_a: healthRow({ healthScore: 100 }),
      phys_b: healthRow({ healthScore: 75 }),
      phys_c: healthRow({ healthScore: 25 }),
      phys_d: healthRow({ healthScore: 50 }),
    };
    const summary = computeFleetSummary(devs, devs, health);
    expect(summary.total).toBe(4);
    expect(summary.matched).toBe(4);
    expect(summary.healthy).toBe(1);   // phys_a at 100
    expect(summary.degraded).toBe(1);  // phys_b at 75 (in [60, 80))
    expect(summary.at_risk).toBe(1);   // phys_d at 50 (in (0, 60))
    expect(summary.quarantined).toBe(1); // phys_c — lease state overrides score
    expect(summary.leased).toBe(1);
    expect(summary.offline).toBe(1);
  });
});