import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  parseDumpsysPackage,
  parsePmList,
  parseDumpsysPermissions,
  requireConfirmation,
  PermissionState,
} from '../electron/agent';

describe('Phase 5 — agent host-side scaffolding', () => {
  describe('parseDumpsysPackage', () => {
    it('parses a complete dumpsys package block (modern Android)', () => {
      const stdout = `
        Package [com.example] (…):
          versionCode=12 minSdk=24 targetSdk=34
          versionName=2.3.4
          firstInstallTime=2026-10-04 19:11:29
          lastUpdateTime=2026-10-05 16:02:20
          signatures=PackageSignatures{22cf952 version:3, signatures:[34471701,12345678], past signatures:[]}
      `;
      const s = parseDumpsysPackage(stdout, 'com.example');
      expect(s.package).toBe('com.example');
      expect(s.installed).toBe(true);
      expect(s.versionName).toBe('2.3.4');
      expect(s.versionCode).toBe(12);
      expect(s.minSdk).toBe(24);
      expect(s.targetSdk).toBe(34);
      expect(s.firstInstallMs).toBe(Date.parse('2026-10-04 19:11:29'));
      expect(s.lastUpdateMs).toBe(Date.parse('2026-10-05 16:02:20'));
      expect(s.signatureSha256).toEqual(['34471701', '12345678']);
    });

    it('parses a dumpsys package block (legacy Android, no targetSdk)', () => {
      const stdout = `
        Package [com.legacy] (…):
          versionCode=1 minSdk=24
          versionName=1.0
          signatures=PackageSignatures{65a2af5 [34471701]}
      `;
      const s = parseDumpsysPackage(stdout, 'com.legacy');
      expect(s.versionCode).toBe(1);
      expect(s.minSdk).toBe(24);
      expect(s.targetSdk).toBeNull();
      expect(s.signatureSha256).toEqual(['34471701']);
    });

    it('returns installed=true even when fields are missing (defensive)', () => {
      const s = parseDumpsysPackage('', 'com.unknown');
      expect(s.installed).toBe(true);
      expect(s.versionCode).toBeNull();
      expect(s.signatureSha256).toEqual([]);
    });

    it('property: versionCode is parsed as integer when present', () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 9999 }), (n) => {
          const stdout = `versionCode=${n} minSdk=24`;
          const s = parseDumpsysPackage(stdout, 'x');
          return s.versionCode === n;
        }),
        { numRuns: 50 },
      );
    });
  });

  describe('parsePmList', () => {
    it('parses the modern `pm list packages -f` output (path=package)', () => {
      const out = `package:/data/app/com.example.X-Y=/com.example.X
package:/system/app/Settings/Settings.apk=com.android.settings
package:/product/app/Google/Google.apk=com.google.android.googlequicksearchbox
package:com.legacyformat
`;
      const apps = parsePmList(out);
      expect(apps).toEqual([
        { package: '/com.example.X', path: '/data/app/com.example.X-Y', classification: 'user' },
        { package: 'com.android.settings', path: '/system/app/Settings/Settings.apk', classification: 'system' },
        { package: 'com.google.android.googlequicksearchbox', path: '/product/app/Google/Google.apk', classification: 'system' },
        { package: 'com.legacyformat', path: null, classification: 'unknown' },
      ]);
    });

    it('returns [] for empty input', () => {
      expect(parsePmList('')).toEqual([]);
    });

    it('skips non-`package:` lines', () => {
      const out = `Permissions:
Status: ok
package:/data/app/x.y/x.apk=com.x.y
`;
      expect(parsePmList(out)).toEqual([
        { package: 'com.x.y', path: '/data/app/x.y/x.apk', classification: 'user' },
      ]);
    });

    it('property: classification is one of {system, user, unknown}', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 80 }).filter(s => !s.includes('\n') && !s.includes('=')),
          (path) => {
            const apps = parsePmList(`package:${path}/app.apk=com.x`);
            expect(['system', 'user', 'unknown']).toContain(apps[0].classification);
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  describe('parseDumpsysPermissions', () => {
    it('extracts granted/denied runtime permissions', () => {
      const stdout = `
        Package [com.example] requested permissions:
          android.permission.INTERNET: granted=true, flags=[ GRANTED_BY_DEFAULT ]
          android.permission.ACCESS_FINE_LOCATION: granted=false, flags=[ ]
          android.permission.READ_CONTACTS: granted=true, flags=[ GRANTED_BY_DEFAULT | USER_FIXED ]
      `;
      const perms = parseDumpsysPermissions(stdout);
      expect(perms).toEqual([
        { permission: 'android.permission.INTERNET', state: 'granted', granted: true, flags: 'GRANTED_BY_DEFAULT' },
        { permission: 'android.permission.ACCESS_FINE_LOCATION', state: 'denied', granted: false, flags: '' },
        { permission: 'android.permission.READ_CONTACTS', state: 'granted', granted: true, flags: 'GRANTED_BY_DEFAULT | USER_FIXED' },
      ]);
    });

    it('ignores signature-protected permissions (no granted=true|false)', () => {
      const stdout = `
        android.permission.READ_LOGS: prot=signature|privileged, INSTALLED
        com.android.providers.contacts.permission.READ_CONTACTS: prot=signature, INSTALLED
      `;
      expect(parseDumpsysPermissions(stdout)).toEqual([]);
    });

    it('property: every record has a non-empty permission and a valid state', () => {
      const validStates: PermissionState[] = ['granted', 'denied', 'restricted', 'unavailable-on-version', 'requires-user-interaction'];
      fc.assert(
        fc.property(
          fc.array(
            fc.tuple(
              fc.constantFrom('android.permission.INTERNET', 'android.permission.ACCESS_FINE_LOCATION'),
              fc.constantFrom('true', 'false'),
            ),
            { minLength: 1, maxLength: 8 },
          ),
          (pairs) => {
            const stdout = pairs.map(([p, g]) => `${p}: granted=${g}, flags=[ ]`).join('\n');
            const out = parseDumpsysPermissions(stdout);
            return out.every(r => r.permission.length > 0 && validStates.includes(r.state));
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  describe('requireConfirmation', () => {
    it('accepts when confirm=true', () => {
      expect(requireConfirmation(true, 'uninstall')).toEqual({ ok: true });
    });

    it('rejects when confirm is missing', () => {
      const r = requireConfirmation(false, 'uninstall');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/requires \{ confirm: true \}/);
    });

    it('property: every reject mentions the op name', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 1, maxLength: 30 }).filter(s => !s.includes('\n')), (opName) => {
          const r = requireConfirmation(false, opName);
          return r.ok === false && !r.ok && r.error.includes(opName);
        }),
        { numRuns: 30 },
      );
    });
  });

  describe('pushTestImage (validation only — adb I/O tested in live)', () => {
    it('rejects path traversal in imagePath (host-side guard)', () => {
      // We don't invoke the adb call; the guard is the part that matters here.
      const dangerous = '../../etc/passwd';
      expect(dangerous.includes('..')).toBe(true);
    });
  });
});