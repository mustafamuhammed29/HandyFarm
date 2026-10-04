import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  classifyDriftField,
  verifyClock,
  generateBaselineDiff,
  parseDumpsysPackage,
  parseAccountDump,
  parseSensorDump,
  parseGpuRenderer,
  parseWmOutput,
  type BaselineManifest,
  type ImmutableFingerprint,
  type MutableBaseline,
  type DriftClass
} from '../electron/baseline.ts';

describe('Phase 1: Verified State Baseline & Drift Classification', () => {
  describe('Parsers for Android CLI Outputs', () => {
    it('Parses dumpsys package output for versionName, versionCode, and granted permissions', () => {
      const sampleDumpsys = `
Packages:
  Package [com.example.testapp] (123456):
    userId=10100
    versionCode=42 minSdk=26 targetSdk=34
    versionName=2.1.0-prod
    install permissions:
      android.permission.INTERNET: granted=true
      android.permission.ACCESS_NETWORK_STATE: granted=true
    runtime permissions:
      android.permission.POST_NOTIFICATIONS: granted=true, flags=[ USER_SET ]
      android.permission.CAMERA: granted=false
      android.permission.ACCESS_FINE_LOCATION: granted=true, flags=[ USER_SET ]
      `;

      const parsed = parseDumpsysPackage(sampleDumpsys);
      expect(parsed.versionName).toBe('2.1.0-prod');
      expect(parsed.versionCode).toBe('42');
      expect(parsed.grantedPermissions).toEqual(expect.arrayContaining([
        'android.permission.INTERNET',
        'android.permission.ACCESS_NETWORK_STATE',
        'android.permission.POST_NOTIFICATIONS',
        'android.permission.ACCESS_FINE_LOCATION'
      ]));
      expect(parsed.grantedPermissions).not.toContain('android.permission.CAMERA');
    });

    it('Parses dumpsys account output', () => {
      const sampleAccounts = `
Accounts: 2
  Account {name=qa_tester@company.internal, type=com.google}
  Account {name=enterprise_user, type=com.workplace}
      `;
      const accounts = parseAccountDump(sampleAccounts);
      expect(accounts).toEqual([
        'qa_tester@company.internal (com.google)',
        'enterprise_user (com.workplace)'
      ]);
    });

    it('Parses dumpsys sensorservice sensor list', () => {
      const sampleSensors = `
Sensor List:
0x00000001) lsm6dsm_acc               | st              | ver: 1 | type: android.sensor.accelerometer(1)
0x00000002) lsm6dsm_gyro              | st              | ver: 1 | type: android.sensor.gyroscope(4)
0x00000003) akm09918_mag              | akm             | ver: 1 | type: android.sensor.magnetic_field(2)
      `;
      const sensors = parseSensorDump(sampleSensors);
      expect(sensors).toEqual(['lsm6dsm_acc', 'lsm6dsm_gyro', 'akm09918_mag']);
    });

    it('Parses SurfaceFlinger GLES renderer string', () => {
      const sampleSf = `
SurfaceFlinger state:
GLES: ARM, Mali-G57 MC2, OpenGL ES 3.2 v1.r32p1-01eac0
Other info...
      `;
      expect(parseGpuRenderer(sampleSf)).toBe('ARM, Mali-G57 MC2, OpenGL ES 3.2 v1.r32p1-01eac0');
    });

    it('Parses wm size and density', () => {
      const { size, density } = parseWmOutput('Physical size: 1080x2400', 'Physical density: 480');
      expect(size).toBe('1080x2400');
      expect(density).toBe('480');
    });
  });

  describe('Drift Class Classification (§1.2 & Roadmap)', () => {
    const classificationCases: Array<{ field: string; expected: DriftClass }> = [
      { field: 'immutable.bootSerial', expected: 'hardware' },
      { field: 'immutable.model', expected: 'hardware' },
      { field: 'immutable.screen.size', expected: 'hardware' },
      { field: 'immutable.screen.density', expected: 'hardware' },
      { field: 'immutable.gpuRenderer', expected: 'hardware' },
      { field: 'immutable.sensorList', expected: 'hardware' },
      { field: 'immutable.buildFingerprint', expected: 'system' },
      { field: 'immutable.verifiedBootState', expected: 'system' },
      { field: 'immutable.selinuxMode', expected: 'system' },
      { field: 'immutable.playServicesVersion', expected: 'system' },
      { field: 'mutable.installedPackages.com.test.app', expected: 'app' },
      { field: 'mutable.installedPackages.com.test.app.versionName', expected: 'app' },
      { field: 'mutable.grantedPermissions.com.test.app.CAMERA', expected: 'permission' },
      { field: 'mutable.accounts.user@test.com', expected: 'account' },
      { field: 'mutable.locale', expected: 'locale' },
      { field: 'mutable.timezone', expected: 'locale' },
      { field: 'mutable.networkConfig.wifiOn', expected: 'network' },
      { field: 'mutable.animationScales.window', expected: 'system' },
      { field: 'mutable.dozeAndBatterySaver.lowPower', expected: 'system' },
      { field: 'mutable.defaultLauncher', expected: 'system' },
      { field: 'clock.offsetMs', expected: 'system' }
    ];

    for (const { field, expected } of classificationCases) {
      it(`Classifies '${field}' as '${expected}'`, () => {
        expect(classifyDriftField(field)).toBe(expected);
      });
    }
  });

  describe('Clock Verification & Bounding (Never Clock Jitter)', () => {
    it('Passes when offset is within 2000ms bound and auto_time is enabled', () => {
      const hostEpoch = 1700000000000;
      const deviceEpoch = hostEpoch + 450; // +450ms offset
      const res = verifyClock(deviceEpoch, hostEpoch, '1', 2000);

      expect(res.bounded).toBe(true);
      expect(res.autoTimeEnabled).toBe(true);
      expect(res.offsetMs).toBe(450);
      expect(res.driftItem).toBeUndefined();
    });

    it('Flags drift when offset exceeds 2000ms bound', () => {
      const hostEpoch = 1700000000000;
      const deviceEpoch = hostEpoch + 2500; // +2500ms offset (exceeds 2s)
      const res = verifyClock(deviceEpoch, hostEpoch, '1', 2000);

      expect(res.bounded).toBe(false);
      expect(res.driftItem).toBeDefined();
      expect(res.driftItem?.field).toBe('clock.offsetMs');
      expect(res.driftItem?.drift_class).toBe('system');
      expect(res.driftItem?.description).toContain('Clock offset 2500ms exceeds bound');
    });

    it('Flags drift when auto_time is disabled even if offset is 0', () => {
      const hostEpoch = 1700000000000;
      const deviceEpoch = hostEpoch;
      const res = verifyClock(deviceEpoch, hostEpoch, '0', 2000);

      expect(res.bounded).toBe(false);
      expect(res.autoTimeEnabled).toBe(false);
      expect(res.driftItem).toBeDefined();
      expect(res.driftItem?.description).toContain('NTP auto_time is disabled');
    });
  });

  describe('Structured Baseline Diff Generation', () => {
    const mockBaseline: BaselineManifest = {
      deviceId: '106293738O006649',
      physicalDeviceId: 'phys_106293738O006649',
      capturedAt: 1700000000000,
      immutable: {
        bootSerial: '106293738O006649',
        model: 'TECNO LH7n',
        buildFingerprint: 'TECNO/LH7n/14:user/release-keys',
        screen: { size: '1080x2460', density: '480' },
        gpuRenderer: 'Mali-G57 MC2',
        sensorList: ['lsm6dsm_acc', 'lsm6dsm_gyro'],
        playServicesVersion: '24.10.15',
        verifiedBootState: 'green',
        selinuxMode: 'Enforcing'
      },
      mutable: {
        installedPackages: [
          { packageName: 'com.handyfarm.clipper', versionName: '1.0', versionCode: '1' },
          { packageName: 'com.test.app', versionName: '1.5.0', versionCode: '15' }
        ],
        grantedPermissions: {
          'com.test.app': ['android.permission.CAMERA']
        },
        accounts: ['test_user@internal.org (com.google)'],
        locale: 'en-US',
        timezone: 'Europe/Berlin',
        animationScales: { window: 0, transition: 0, animator: 0 },
        dozeAndBatterySaver: { lowPower: false },
        networkConfig: { wifiOn: true },
        defaultLauncher: 'com.android.launcher3'
      }
    };

    it('Yields 0 diffs when observed state strictly matches baseline', () => {
      const diffs = generateBaselineDiff(mockBaseline, {
        immutable: { ...mockBaseline.immutable },
        mutable: { ...mockBaseline.mutable },
        clock: {
          offsetMs: 120,
          bounded: true,
          autoTimeEnabled: true,
          deviceEpochMs: 1700000000120,
          hostEpochMs: 1700000000000
        }
      });

      expect(diffs).toEqual([]);
    });

    it('Detects unapproved package installed since baseline (drift_class: app)', () => {
      const currentMutable: MutableBaseline = {
        ...mockBaseline.mutable,
        installedPackages: [
          ...(mockBaseline.mutable.installedPackages || []),
          { packageName: 'com.malicious.scraper', versionName: '1.0' }
        ]
      };

      const diffs = generateBaselineDiff(mockBaseline, {
        immutable: mockBaseline.immutable,
        mutable: currentMutable
      });

      expect(diffs.length).toBe(1);
      expect(diffs[0].field).toBe('mutable.installedPackages.com.malicious.scraper');
      expect(diffs[0].drift_class).toBe('app');
      expect(diffs[0].expected).toBeNull();
      expect(diffs[0].actual).toBe('1.0');
    });

    it('Detects package version upgrade / drift (drift_class: app)', () => {
      const currentMutable: MutableBaseline = {
        ...mockBaseline.mutable,
        installedPackages: [
          { packageName: 'com.handyfarm.clipper', versionName: '1.0', versionCode: '1' },
          { packageName: 'com.test.app', versionName: '2.0.0', versionCode: '20' } // Upgraded from 1.5.0
        ]
      };

      const diffs = generateBaselineDiff(mockBaseline, {
        immutable: mockBaseline.immutable,
        mutable: currentMutable
      });

      expect(diffs.length).toBe(2); // versionName and versionCode
      expect(diffs.every(d => d.drift_class === 'app')).toBe(true);
      expect(diffs.some(d => d.field.includes('versionName') && d.expected === '1.5.0' && d.actual === '2.0.0')).toBe(true);
    });

    it('Detects permission granted without baseline approval (drift_class: permission)', () => {
      const currentMutable: MutableBaseline = {
        ...mockBaseline.mutable,
        grantedPermissions: {
          'com.test.app': ['android.permission.CAMERA', 'android.permission.RECORD_AUDIO']
        }
      };

      const diffs = generateBaselineDiff(mockBaseline, {
        immutable: mockBaseline.immutable,
        mutable: currentMutable
      });

      expect(diffs.length).toBe(1);
      expect(diffs[0].field).toBe('mutable.grantedPermissions.com.test.app.android.permission.RECORD_AUDIO');
      expect(diffs[0].drift_class).toBe('permission');
      expect(diffs[0].expected).toBe(false);
      expect(diffs[0].actual).toBe(true);
    });

    it('Detects account added on shop floor (drift_class: account)', () => {
      const currentMutable: MutableBaseline = {
        ...mockBaseline.mutable,
        accounts: [
          ...(mockBaseline.mutable.accounts || []),
          'unauthorized@gmail.com (com.google)'
        ]
      };

      const diffs = generateBaselineDiff(mockBaseline, {
        immutable: mockBaseline.immutable,
        mutable: currentMutable
      });

      expect(diffs.length).toBe(1);
      expect(diffs[0].field).toBe('mutable.accounts.unauthorized@gmail.com (com.google)');
      expect(diffs[0].drift_class).toBe('account');
      expect(diffs[0].expected).toBeNull();
      expect(diffs[0].actual).toBe('unauthorized@gmail.com (com.google)');
    });

    it('Detects locale and timezone changes (drift_class: locale)', () => {
      const currentMutable: MutableBaseline = {
        ...mockBaseline.mutable,
        locale: 'de-DE',
        timezone: 'Asia/Tokyo'
      };

      const diffs = generateBaselineDiff(mockBaseline, {
        immutable: mockBaseline.immutable,
        mutable: currentMutable
      });

      expect(diffs.length).toBe(2);
      expect(diffs.every(d => d.drift_class === 'locale')).toBe(true);
      expect(diffs.some(d => d.field === 'mutable.locale' && d.actual === 'de-DE')).toBe(true);
      expect(diffs.some(d => d.field === 'mutable.timezone' && d.actual === 'Asia/Tokyo')).toBe(true);
    });

    it('Detects animation scale drift (drift_class: system)', () => {
      const currentMutable: MutableBaseline = {
        ...mockBaseline.mutable,
        animationScales: { window: 1.5, transition: 0, animator: 0 }
      };

      const diffs = generateBaselineDiff(mockBaseline, {
        immutable: mockBaseline.immutable,
        mutable: currentMutable
      });

      expect(diffs.length).toBe(1);
      expect(diffs[0].field).toBe('mutable.animationScales.window');
      expect(diffs[0].drift_class).toBe('system');
      expect(diffs[0].expected).toBe(0);
      expect(diffs[0].actual).toBe(1.5);
    });

    it('Detects immutable hardware tamper or mismatch (drift_class: hardware)', () => {
      const currentImm: ImmutableFingerprint = {
        ...mockBaseline.immutable,
        model: 'Tampered Model XYZ'
      };

      const diffs = generateBaselineDiff(mockBaseline, {
        immutable: currentImm,
        mutable: mockBaseline.mutable
      });

      expect(diffs.length).toBe(1);
      expect(diffs[0].field).toBe('immutable.model');
      expect(diffs[0].drift_class).toBe('hardware');
      expect(diffs[0].expected).toBe('TECNO LH7n');
      expect(diffs[0].actual).toBe('Tampered Model XYZ');
    });
  });

  describe('Property-Based Invariants (fast-check)', () => {
    it('Property 1: Purity & Determinism - matching states always produce exactly 0 diffs', () => {
      fc.assert(
        fc.property(
          fc.record({
            bootSerial: fc.stringMatching(/^[a-zA-Z0-9]{6,16}$/),
            model: fc.stringMatching(/^[a-zA-Z0-9 ]{3,16}$/),
            locale: fc.constantFrom('en-US', 'de-DE', 'fr-FR', 'ar-SA'),
            timezone: fc.constantFrom('Europe/Berlin', 'UTC', 'America/New_York'),
            windowAnim: fc.constantFrom(0, 0.5, 1.0),
            wifiOn: fc.boolean()
          }),
          (data) => {
            const manifest: BaselineManifest = {
              deviceId: data.bootSerial,
              physicalDeviceId: `phys_${data.bootSerial}`,
              capturedAt: 1700000000000,
              immutable: {
                bootSerial: data.bootSerial,
                model: data.model
              },
              mutable: {
                locale: data.locale,
                timezone: data.timezone,
                animationScales: { window: data.windowAnim },
                networkConfig: { wifiOn: data.wifiOn }
              }
            };

            const diffs = generateBaselineDiff(manifest, {
              immutable: { ...manifest.immutable },
              mutable: { ...manifest.mutable }
            });

            expect(diffs.length).toBe(0);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Property 2: Modifying an arbitrary property guarantees detection with the exact correct drift class', () => {
      type EditableField = 'locale' | 'timezone' | 'model' | 'wifiOn';

      fc.assert(
        fc.property(
          fc.constantFrom<EditableField>('locale', 'timezone', 'model', 'wifiOn'),
          (fieldToMutate) => {
            const manifest: BaselineManifest = {
              deviceId: 'prop_dev_1',
              physicalDeviceId: 'phys_prop_dev_1',
              capturedAt: 1700000000000,
              immutable: { model: 'Original Model' },
              mutable: {
                locale: 'en-US',
                timezone: 'Europe/Berlin',
                networkConfig: { wifiOn: true }
              }
            };

            const current = {
              immutable: { ...manifest.immutable },
              mutable: { ...manifest.mutable, networkConfig: { ...manifest.mutable.networkConfig } }
            };

            let expectedClass: DriftClass;
            switch (fieldToMutate) {
              case 'model':
                current.immutable.model = 'Mutated Model';
                expectedClass = 'hardware';
                break;
              case 'locale':
                current.mutable.locale = 'fr-FR';
                expectedClass = 'locale';
                break;
              case 'timezone':
                current.mutable.timezone = 'UTC';
                expectedClass = 'locale';
                break;
              case 'wifiOn':
                current.mutable.networkConfig.wifiOn = false;
                expectedClass = 'network';
                break;
            }

            const diffs = generateBaselineDiff(manifest, current);
            expect(diffs.length).toBe(1);
            expect(diffs[0].drift_class).toBe(expectedClass);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Property 3: Clock bounding invariant: bounded is true iff |offset| <= maxOffset AND autoTime === true', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: -5000, max: 5000 }),
          fc.constantFrom('0', '1', 'true', 'false', ''),
          (offset, autoTimeVal) => {
            const hostEpoch = 1700000000000;
            const deviceEpoch = hostEpoch + offset;
            const res = verifyClock(deviceEpoch, hostEpoch, autoTimeVal, 2000);

            const expectedBounded = Math.abs(offset) <= 2000 && String(autoTimeVal).trim() === '1';
            expect(res.bounded).toBe(expectedBounded);
            if (!expectedBounded) {
              expect(res.driftItem).toBeDefined();
              expect(res.driftItem?.drift_class).toBe('system');
            } else {
              expect(res.driftItem).toBeUndefined();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
