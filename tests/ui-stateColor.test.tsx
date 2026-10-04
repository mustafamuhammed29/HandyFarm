import { describe, it, expect } from 'vitest';
import {
  healthTier,
  healthTierLabel,
  healthTierColorVar,
  leaseColorVar,
  connectionColorVar,
  connectionLabel,
  resolveDeviceStateColor,
  leaseLabel,
  LeaseState,
  DeviceConnectionStatus,
} from '../src/stateColor';

describe('stateColor — pure helpers', () => {
  describe('healthTier', () => {
    it('returns quarantined when lease state is quarantined regardless of score', () => {
      expect(healthTier(100, 'quarantined')).toBe('quarantined');
      expect(healthTier(0, 'quarantined')).toBe('quarantined');
    });

    it('returns healthy at score >= 80', () => {
      expect(healthTier(80, 'available')).toBe('healthy');
      expect(healthTier(100, 'available')).toBe('healthy');
    });

    it('returns degraded at score in [60, 80)', () => {
      expect(healthTier(60, 'available')).toBe('degraded');
      expect(healthTier(79, 'available')).toBe('degraded');
    });

    it('returns at_risk at score in (0, 60)', () => {
      expect(healthTier(1, 'available')).toBe('at_risk');
      expect(healthTier(59, 'available')).toBe('at_risk');
    });

    it('returns unknown at score 0', () => {
      expect(healthTier(0, 'available')).toBe('unknown');
    });
  });

  describe('resolveDeviceStateColor — precedence', () => {
    it('quarantined always wins over connection + lease', () => {
      const c = resolveDeviceStateColor('device', 'quarantined');
      expect(c).toBe('var(--state-quarantined)');
    });

    it('offline wins over a healthy available device', () => {
      const c = resolveDeviceStateColor('offline', 'available');
      expect(c).toBe('var(--state-offline)');
    });

    it('leased wins over a healthy online device', () => {
      const c = resolveDeviceStateColor('device', 'leased');
      expect(c).toBe('var(--state-leased)');
    });

    it('returns healthy color for online + available', () => {
      const c = resolveDeviceStateColor('device', 'available');
      expect(c).toBe('var(--state-healthy)');
    });
  });

  describe('leaseLabel', () => {
    const NOW = 1_700_000_000_000;

    it('formats leased label with seconds countdown', () => {
      const { label, countdownSec } = leaseLabel('leased', 'demo-runner', NOW + 47_000, NOW);
      expect(label).toBe('demo-runner (47s)');
      expect(countdownSec).toBe(47);
    });

    it('formats leased label with minutes when > 60s', () => {
      const { label, countdownSec } = leaseLabel('leased', 'ci', NOW + 5 * 60_000 + 12_000, NOW);
      expect(label).toBe('ci (5m)');
      expect(countdownSec).toBe(5 * 60 + 12);
    });

    it('formats cooling_down with 5s default when expires is missing', () => {
      const { label, countdownSec } = leaseLabel('cooling_down', undefined, undefined, NOW);
      expect(label).toBe('Cooling (5s)');
      expect(countdownSec).toBe(5);
    });

    it('formats quarantined without countdown', () => {
      const { label, countdownSec } = leaseLabel('quarantined', undefined, undefined, NOW);
      expect(label).toBe('Quarantined');
      expect(countdownSec).toBeUndefined();
    });

    it('formats available without holder', () => {
      const { label } = leaseLabel('available', undefined, undefined, NOW);
      expect(label).toBe('Available');
    });

    it('clamps negative remaining seconds to 0', () => {
      const { label, countdownSec } = leaseLabel('leased', 'late', NOW - 1000, NOW);
      expect(label).toBe('late (0s)');
      expect(countdownSec).toBe(0);
    });
  });

  describe('connectionLabel', () => {
    it('returns Online for device', () => {
      expect(connectionLabel('device')).toBe('Online');
    });
    it('returns Unauthorized for unauthorized', () => {
      expect(connectionLabel('unauthorized')).toBe('Unauthorized');
    });
    it('returns Unknown for unknown', () => {
      expect(connectionLabel('unknown' as DeviceConnectionStatus)).toBe('Unknown');
    });
  });

  describe('healthTierColorVar', () => {
    it('covers all tiers without throwing', () => {
      const tiers = ['healthy', 'degraded', 'at_risk', 'quarantined', 'unknown'] as const;
      for (const t of tiers) {
        const v = healthTierColorVar(t);
        expect(v).toMatch(/^var\(--state-/);
      }
    });
  });

  describe('healthTierLabel', () => {
    it('returns human-readable strings', () => {
      expect(healthTierLabel('healthy')).toBe('Healthy');
      expect(healthTierLabel('degraded')).toBe('Degraded');
      expect(healthTierLabel('at_risk')).toBe('At risk');
      expect(healthTierLabel('quarantined')).toBe('Quarantined');
      expect(healthTierLabel('unknown')).toBe('No data');
    });
  });

  describe('colorVars — shape', () => {
    it('leaseColorVar returns a CSS var', () => {
      const states: LeaseState[] = ['available', 'leased', 'cooling_down', 'quarantined', 'maintenance'];
      for (const s of states) expect(leaseColorVar(s)).toMatch(/^var\(--state-/);
    });

    it('connectionColorVar returns a CSS var', () => {
      const statuses: DeviceConnectionStatus[] = ['device', 'offline', 'disconnect', 'unauthorized', 'weak-connection', 'unknown'];
      for (const s of statuses) expect(connectionColorVar(s)).toMatch(/^var\(--state-/);
    });
  });
});