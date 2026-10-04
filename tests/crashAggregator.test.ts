import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  clusterKey,
  parseLogcatCrashLine,
  parseDropboxEntry,
  clusterCrashes,
  CrashRecord,
} from '../electron/crashAggregator';

describe('Phase 5 — crash aggregator', () => {
  describe('parseLogcatCrashLine', () => {
    it('parses am_crash lines', () => {
      const line = '10-04 14:23:01 1234 5678 I am_crash: [1234,1,com.example,684310085,java.lang.NullPointerException,test,Main.java,42,0]';
      const r = parseLogcatCrashLine(line, 'SERIAL', 'phys_1');
      expect(r).not.toBeNull();
      expect(r!.package).toBe('com.example');
      expect(r!.exception).toMatch(/NullPointerException/);
      expect(r!.source).toBe('logcat-am_crash');
      expect(r!.deviceFingerprint).toBe('phys_1');
      expect(r!.deviceSerial).toBe('SERIAL');
    });

    it('parses am_crash array format from the events buffer', () => {
      const line = '10-04 21:51:52.631  1676  1690 I am_crash: [10023,0,com.android.settings,684310085,android.app.RemoteServiceException$CrashedByAdbException,shell-induced crash,ActivityThread.java,2201,0]';
      const r = parseLogcatCrashLine(line, 'SERIAL', 'phys_1');
      expect(r).not.toBeNull();
      expect(r!.package).toBe('com.android.settings');
      expect(r!.exception).toMatch(/RemoteServiceException/);
      expect(r!.source).toBe('logcat-am_crash');
    });

    it('parses am_anr lines', () => {
      const r = parseLogcatCrashLine(
        'am_anr: Process com.example failed to respond in 5000ms',
        'S', 'fp',
      );
      expect(r).not.toBeNull();
      expect(r!.package).toBe('com.example');
      expect(r!.exception).toBe('ANR');
      expect(r!.source).toBe('logcat-am_anr');
    });

    it('returns null on unrelated logcat lines', () => {
      expect(parseLogcatCrashLine('am_proc_start: [1200,1400]', 'S', 'fp')).toBeNull();
      expect(parseLogcatCrashLine('', 'S', 'fp')).toBeNull();
    });
  });

  describe('parseDropboxEntry', () => {
    it('parses an entry that contains an exception class', () => {
      const body = `Process: com.example\nException: java.lang.RuntimeException: boom\nStack trace follows...`;
      const r = parseDropboxEntry(body, 'S', 'fp');
      expect(r).not.toBeNull();
      expect(r!.package).toBe('com.example');
      expect(r!.exception).toBe('java.lang.RuntimeException');
      expect(r!.source).toBe('dropbox');
    });

    it('detects ANR-only entries', () => {
      const body = `ANR in com.example\nReason: input dispatching timed out`;
      const r = parseDropboxEntry(body, 'S', 'fp');
      expect(r).not.toBeNull();
      expect(r!.exception).toBe('ANR');
    });

    it('returns null when no crash markers present', () => {
      expect(parseDropboxEntry('Process: com.example\nMethod: foo\n', 'S', 'fp')).toBeNull();
    });
  });

  describe('clusterKey', () => {
    it('property: identical (pkg, exc, ver, fp) → identical clusterKey', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 10 }),
          fc.string({ minLength: 1, maxLength: 10 }),
          fc.string({ minLength: 1, maxLength: 10 }),
          fc.string({ minLength: 1, maxLength: 10 }),
          (a, b, c, d) => clusterKey({ package: a, exception: b, appVersion: c, deviceFingerprint: d } as any) ===
                         clusterKey({ package: a, exception: b, appVersion: c, deviceFingerprint: d } as any),
        ),
        { numRuns: 30 },
      );
    });

    it('different fields → different keys', () => {
      const base = { package: 'a', exception: 'b', appVersion: 'c', deviceFingerprint: 'd' };
      const k1 = clusterKey(base as any);
      const k2 = clusterKey({ ...base, exception: 'X' } as any);
      expect(k1).not.toBe(k2);
    });
  });

  describe('clusterCrashes', () => {
    const mk = (overrides: Partial<CrashRecord>): CrashRecord => ({
      package: 'com.example', exception: 'java.lang.NullPointerException',
      appVersion: '1.0.0', deviceFingerprint: 'phys_1', deviceSerial: 'A',
      observedAt: 100, source: 'logcat-am_crash', message: '...',
      ...overrides,
    });

    it('groups identical fingerprints into one entry', () => {
      const groups = clusterCrashes([
        mk({ deviceSerial: 'A' }),
        mk({ deviceSerial: 'B' }),
        mk({ deviceSerial: 'C' }),
      ]);
      expect(groups).toHaveLength(1);
      expect(groups[0].affectedCount).toBe(3);
      expect(groups[0].affectedSerials.sort()).toEqual(['A', 'B', 'C']);
    });

    it('does not group across different fingerprints', () => {
      const groups = clusterCrashes([
        mk({ deviceFingerprint: 'phys_1', deviceSerial: 'A' }),
        mk({ deviceFingerprint: 'phys_2', deviceSerial: 'B' }),
      ]);
      expect(groups).toHaveLength(2);
    });

    it('keeps firstSeenAt = min and lastSeenAt = max', () => {
      const groups = clusterCrashes([
        mk({ deviceSerial: 'A', observedAt: 200 }),
        mk({ deviceSerial: 'B', observedAt: 100 }),
        mk({ deviceSerial: 'C', observedAt: 300 }),
      ]);
      expect(groups[0].firstSeenAt).toBe(100);
      expect(groups[0].lastSeenAt).toBe(300);
    });
  });
});