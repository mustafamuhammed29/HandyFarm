import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import crypto from 'crypto';
import { generatePhysicalDeviceId, DeviceHardwareProps } from '../electron/identity.ts';

describe('Area 1: Identity Fallback Chain & Suspect Heuristics', () => {
  const suspectSerials = [
    '',
    '   ',
    'unknown',
    'UNKNOWN',
    'Unknown',
    '0123456789abcdef',
    '0123456789ABCDEF',
    '0123456789',
    'ab',
    '1',
    '  x  '
  ];

  describe('Deterministic Fallback Hierarchy', () => {
    it('Priority 1: Uses ro.boot.serialno when valid', () => {
      const id = generatePhysicalDeviceId({
        bootSerial: 'valid_boot_123',
        serial: 'valid_serial_456',
        companionUuid: '11111111-2222-3333-4444-555555555555',
        productDevice: 'pixel8',
        buildFingerprint: 'google/pixel8/14'
      });
      expect(id).toBe('phys_valid_boot_123');
    });

    it('Priority 2: Falls back to ro.serialno when bootSerial is suspect or missing', () => {
      for (const suspect of suspectSerials) {
        const id = generatePhysicalDeviceId({
          bootSerial: suspect,
          serial: 'valid_serial_789',
          companionUuid: '11111111-2222-3333-4444-555555555555',
          productDevice: 'pixel8',
          buildFingerprint: 'google/pixel8/14'
        });
        expect(id).toBe('phys_valid_serial_789');
      }
    });

    it('Priority 3: Falls back to companion UUID when both bootSerial and serial are suspect or missing', () => {
      for (const suspectBoot of suspectSerials) {
        for (const suspectSerial of suspectSerials) {
          const id = generatePhysicalDeviceId({
            bootSerial: suspectBoot,
            serial: suspectSerial,
            companionUuid: 'e6962ea9-a868-4f51-b8f9-4672fa99ee70',
            productDevice: 'tecno_lh7n',
            buildFingerprint: 'tecno/lh7n/14'
          });
          expect(id).toBe('phys_app_e6962ea9-a868-4f51-b8f9-4672fa99ee70');
        }
      }
    });

    it('Priority 4: Falls back to composite hash when all serials and companion UUID are suspect or missing', () => {
      const device = 'lh7n';
      const fingerprint = 'Tecno/LH7n-GL/TECNO-LH7n:14/UP1A.231005.007/250416V781';
      const composite = `${device}:${fingerprint}`;
      const expectedHash = crypto.createHash('sha256').update(composite).digest('hex').substring(0, 16);

      const id = generatePhysicalDeviceId({
        bootSerial: 'unknown',
        serial: '0123456789abcdef',
        companionUuid: 'short', // <= 5 chars is rejected as invalid uuid
        productDevice: device,
        buildFingerprint: fingerprint
      });

      expect(id).toBe(`phys_${device}_${expectedHash}`);
    });
  });

  describe('Suspect Heuristic & ID Collision / De-duplication', () => {
    it('Collapses clone devices with generic suspect serials and identical build fingerprint to shared ID', () => {
      const clone1 = generatePhysicalDeviceId({
        bootSerial: '0123456789ABCDEF',
        serial: 'unknown',
        productDevice: 'generic_board',
        buildFingerprint: 'generic/board/14:userdebug'
      });

      const clone2 = generatePhysicalDeviceId({
        bootSerial: 'unknown',
        serial: '0123456789abcdef',
        productDevice: 'generic_board',
        buildFingerprint: 'generic/board/14:userdebug'
      });

      // Both clones had fake suspect serials, so they appropriately resolve to the same composite identity
      expect(clone1).toBe(clone2);
      expect(clone1).toMatch(/^phys_generic_board_[a-f0-9]{16}$/);
    });

    it('Companion UUID prevents collision when two clone devices have identical generic suspect serials', () => {
      const clone1 = generatePhysicalDeviceId({
        bootSerial: '0123456789ABCDEF',
        serial: 'unknown',
        companionUuid: 'device-1-uuid-unique-aaaa',
        productDevice: 'generic_board',
        buildFingerprint: 'generic/board/14:userdebug'
      });

      const clone2 = generatePhysicalDeviceId({
        bootSerial: 'unknown',
        serial: '0123456789abcdef',
        companionUuid: 'device-2-uuid-unique-bbbb',
        productDevice: 'generic_board',
        buildFingerprint: 'generic/board/14:userdebug'
      });

      // Companion UUID prevents the collision!
      expect(clone1).toBe('phys_app_device-1-uuid-unique-aaaa');
      expect(clone2).toBe('phys_app_device-2-uuid-unique-bbbb');
      expect(clone1).not.toBe(clone2);
    });

    it('Trims leading and trailing whitespace from identifiers', () => {
      const id = generatePhysicalDeviceId({
        bootSerial: '   ABC123XYZ   '
      });
      expect(id).toBe('phys_ABC123XYZ');
    });
  });

  describe('Property-Based Invariants (fast-check)', () => {
    const validSerialArbitrary = fc.stringMatching(/^[a-zA-Z0-9_-]{4,32}$/)
      .filter(s => {
        const l = s.toLowerCase();
        return l !== 'unknown' && l !== '0123456789abcdef' && l !== '0123456789';
      });

    const suspectSerialArbitrary = fc.constantFrom(
      '', '   ', 'unknown', 'UNKNOWN', '0123456789abcdef', '0123456789', 'x', '12', '  ab  '
    );

    const validUuidArbitrary = fc.uuid();
    const alphanumericWord = fc.stringMatching(/^[a-zA-Z0-9_]{1,20}$/);

    it('Invariant 1: Pure & Deterministic - same inputs always yield identical output', () => {
      fc.assert(
        fc.property(
          fc.record({
            bootSerial: fc.option(fc.string(), { nil: undefined }),
            serial: fc.option(fc.string(), { nil: undefined }),
            companionUuid: fc.option(fc.string(), { nil: undefined }),
            productDevice: fc.option(fc.string(), { nil: undefined }),
            buildFingerprint: fc.option(fc.string(), { nil: undefined }),
          }),
          (props) => {
            const id1 = generatePhysicalDeviceId(props);
            const id2 = generatePhysicalDeviceId(props);
            expect(id1).toBe(id2);
            expect(id1.startsWith('phys_')).toBe(true);
          }
        ),
        { numRuns: 200 }
      );
    });

    it('Invariant 2: When bootSerial is valid, output is strictly phys_${bootSerial.trim()}', () => {
      fc.assert(
        fc.property(
          validSerialArbitrary,
          fc.option(fc.string(), { nil: undefined }),
          fc.option(fc.string(), { nil: undefined }),
          fc.option(alphanumericWord, { nil: undefined }),
          fc.option(alphanumericWord, { nil: undefined }),
          (validBoot, serial, uuid, dev, fp) => {
            const id = generatePhysicalDeviceId({
              bootSerial: validBoot,
              serial,
              companionUuid: uuid,
              productDevice: dev,
              buildFingerprint: fp,
            });
            expect(id).toBe(`phys_${validBoot.trim()}`);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Invariant 3: When bootSerial is suspect and serial is valid, output is strictly phys_${serial.trim()}', () => {
      fc.assert(
        fc.property(
          suspectSerialArbitrary,
          validSerialArbitrary,
          fc.option(fc.string(), { nil: undefined }),
          fc.option(alphanumericWord, { nil: undefined }),
          fc.option(alphanumericWord, { nil: undefined }),
          (suspectBoot, validSerial, uuid, dev, fp) => {
            const id = generatePhysicalDeviceId({
              bootSerial: suspectBoot,
              serial: validSerial,
              companionUuid: uuid,
              productDevice: dev,
              buildFingerprint: fp,
            });
            expect(id).toBe(`phys_${validSerial.trim()}`);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Invariant 4: When both serials are suspect and companionUuid is valid, output is strictly phys_app_${uuid.trim()}', () => {
      fc.assert(
        fc.property(
          suspectSerialArbitrary,
          suspectSerialArbitrary,
          validUuidArbitrary,
          fc.option(alphanumericWord, { nil: undefined }),
          fc.option(alphanumericWord, { nil: undefined }),
          (suspectBoot, suspectSerial, validUuid, dev, fp) => {
            const id = generatePhysicalDeviceId({
              bootSerial: suspectBoot,
              serial: suspectSerial,
              companionUuid: validUuid,
              productDevice: dev,
              buildFingerprint: fp,
            });
            expect(id).toBe(`phys_app_${validUuid.trim()}`);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Invariant 5: When all candidates are suspect, output strictly matches composite sha256 format', () => {
      fc.assert(
        fc.property(
          suspectSerialArbitrary,
          suspectSerialArbitrary,
          fc.constantFrom(undefined, '', '123', 'short'),
          alphanumericWord,
          alphanumericWord,
          (suspectBoot, suspectSerial, suspectUuid, dev, fp) => {
            const id = generatePhysicalDeviceId({
              bootSerial: suspectBoot,
              serial: suspectSerial,
              companionUuid: suspectUuid,
              productDevice: dev,
              buildFingerprint: fp,
            });
            const expectedHash = crypto.createHash('sha256').update(`${dev}:${fp}`).digest('hex').substring(0, 16);
            expect(id).toBe(`phys_${dev}_${expectedHash}`);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
