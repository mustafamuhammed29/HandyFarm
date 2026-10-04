import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { validateDeviceConfigImport } from '../electron/configValidation.ts';

describe('Area 4: Configuration Schema Validation & Boundary Enforcement', () => {
  const inventory = new Set(['dev_001', 'dev_002', '106293738O006649', '172.20.10.2:5555']);

  describe('Root and Structure Validation', () => {
    it('Rejects non-object root structures', () => {
      expect(validateDeviceConfigImport(null, inventory).valid).toBe(false);
      expect(validateDeviceConfigImport(undefined, inventory).valid).toBe(false);
      expect(validateDeviceConfigImport('string', inventory).valid).toBe(false);
      expect(validateDeviceConfigImport(12345, inventory).valid).toBe(false);
      expect(validateDeviceConfigImport(true, inventory).valid).toBe(false);
      expect(validateDeviceConfigImport([1, 2, 3], inventory).valid).toBe(false);
    });

    it('Rejects empty configuration object', () => {
      const res = validateDeviceConfigImport({}, inventory);
      expect(res.valid).toBe(false);
      expect(res.error).toContain('contains no devices');
    });

    it('Rejects prototype pollution at root level', () => {
      const raw = JSON.parse('{"__proto__": {"isAdmin": true}}');
      const res = validateDeviceConfigImport(raw, inventory);
      expect(res.valid).toBe(false);
      expect(res.error).toContain('Prohibited property');
    });

    it('Rejects prototype pollution inside patch object', () => {
      const raw = {
        dev_001: JSON.parse('{"__proto__": {"isAdmin": true}, "customName": "Test"}')
      };
      const res = validateDeviceConfigImport(raw, inventory);
      expect(res.valid).toBe(false);
      expect(res.error).toContain('Prohibited property');
    });
  });

  describe('Inventory & Device ID Enforcement', () => {
    it('Rejects devices not present in the current inventory', () => {
      const raw = {
        unrecognized_device_xyz: {
          customName: 'Ghost Phone'
        }
      };
      const res = validateDeviceConfigImport(raw, inventory);
      expect(res.valid).toBe(false);
      expect(res.error).toContain("does not exist in the current device inventory");
    });

    it('Rejects invalid or oversized device IDs', () => {
      const longId = 'a'.repeat(129);
      const res1 = validateDeviceConfigImport({ '': { customName: 'Empty ID' } }, inventory);
      expect(res1.valid).toBe(false);

      const res2 = validateDeviceConfigImport({ [longId]: { customName: 'Long ID' } }, inventory);
      expect(res2.valid).toBe(false);
    });
  });

  describe('Field Allowlist & Type Constraints', () => {
    it('Rejects unauthorized / dangerous fields (e.g., status, serial, command, exec)', () => {
      const unauthorizedFields = ['status', 'serial', 'id', 'command', 'exec', 'role', 'isAdmin', 'token'];
      for (const field of unauthorizedFields) {
        const raw = {
          dev_001: {
            customName: 'Legit Name',
            [field]: 'malicious_override'
          }
        };
        const res = validateDeviceConfigImport(raw, inventory);
        expect(res.valid).toBe(false);
        expect(res.error).toContain(`Unauthorized or unknown field '${field}'`);
      }
    });

    it('Validates customName constraints (string, <= 100 chars)', () => {
      // Type mismatch
      const resType = validateDeviceConfigImport({ dev_001: { customName: 12345 as any } }, inventory);
      expect(resType.valid).toBe(false);
      expect(resType.error).toContain("'customName' for 'dev_001' must be a string");

      // Length exceeded
      const resLen = validateDeviceConfigImport({ dev_001: { customName: 'x'.repeat(101) } }, inventory);
      expect(resLen.valid).toBe(false);
      expect(resLen.error).toContain("exceeds 100 characters");

      // Valid boundary
      const resValid = validateDeviceConfigImport({ dev_001: { customName: 'x'.repeat(100) } }, inventory);
      expect(resValid.valid).toBe(true);
      expect(resValid.sanitized?.dev_001?.customName).toBe('x'.repeat(100));
    });

    it('Validates notes constraints (string, <= 2000 chars)', () => {
      const resType = validateDeviceConfigImport({ dev_001: { notes: { text: 'bad' } as any } }, inventory);
      expect(resType.valid).toBe(false);
      expect(resType.error).toContain("'notes' for 'dev_001' must be a string");

      const resLen = validateDeviceConfigImport({ dev_001: { notes: 'n'.repeat(2001) } }, inventory);
      expect(resLen.valid).toBe(false);
      expect(resLen.error).toContain("exceeds 2000 characters");

      const resValid = validateDeviceConfigImport({ dev_001: { notes: 'n'.repeat(2000) } }, inventory);
      expect(resValid.valid).toBe(true);
      expect(resValid.sanitized?.dev_001?.notes).toBe('n'.repeat(2000));
    });

    it('Validates tags constraints (array of strings, <= 30 tags, <= 50 chars each)', () => {
      // Non-array
      const resArr = validateDeviceConfigImport({ dev_001: { tags: 'not-an-array' as any } }, inventory);
      expect(resArr.valid).toBe(false);
      expect(resArr.error).toContain("must be an array of strings");

      // Exceeds max count of 30
      const thirtyOneTags = Array.from({ length: 31 }, (_, i) => `tag_${i}`);
      const resCount = validateDeviceConfigImport({ dev_001: { tags: thirtyOneTags } }, inventory);
      expect(resCount.valid).toBe(false);
      expect(resCount.error).toContain("exceeds maximum of 30 tags");

      // Non-string item
      const resItemType = validateDeviceConfigImport({ dev_001: { tags: ['valid_tag', 123 as any] } }, inventory);
      expect(resItemType.valid).toBe(false);
      expect(resItemType.error).toContain("must be a string <= 50 characters");

      // Item exceeds 50 chars
      const resItemLen = validateDeviceConfigImport({ dev_001: { tags: ['t'.repeat(51)] } }, inventory);
      expect(resItemLen.valid).toBe(false);
      expect(resItemLen.error).toContain("must be a string <= 50 characters");

      // Valid boundary
      const validTags = Array.from({ length: 30 }, (_, i) => `t_${i}_${'x'.repeat(40)}`);
      const resValid = validateDeviceConfigImport({ dev_001: { tags: validTags } }, inventory);
      expect(resValid.valid).toBe(true);
      expect(resValid.sanitized?.dev_001?.tags?.length).toBe(30);
    });

    it('Validates isBareBoard constraints (boolean)', () => {
      const resBad = validateDeviceConfigImport({ dev_001: { isBareBoard: 'true' as any } }, inventory);
      expect(resBad.valid).toBe(false);
      expect(resBad.error).toContain("'isBareBoard' for 'dev_001' must be a boolean");

      const resTrue = validateDeviceConfigImport({ dev_001: { isBareBoard: true } }, inventory);
      expect(resTrue.valid).toBe(true);
      expect(resTrue.sanitized?.dev_001?.isBareBoard).toBe(true);

      const resFalse = validateDeviceConfigImport({ dev_001: { isBareBoard: false } }, inventory);
      expect(resFalse.valid).toBe(true);
      expect(resFalse.sanitized?.dev_001?.isBareBoard).toBe(false);
    });

    it('Sanitizes and produces pure output mapping only allowed fields', () => {
      const raw = {
        dev_001: {
          customName: 'Device One',
          notes: 'Test note',
          tags: ['alpha', 'beta'],
          isBareBoard: true
        },
        dev_002: {
          customName: 'Device Two'
        }
      };

      const res = validateDeviceConfigImport(raw, inventory);
      expect(res.valid).toBe(true);
      expect(res.sanitized).toEqual({
        dev_001: {
          customName: 'Device One',
          notes: 'Test note',
          tags: ['alpha', 'beta'],
          isBareBoard: true
        },
        dev_002: {
          customName: 'Device Two'
        }
      });
    });
  });

  describe('Property-Based Validation Invariants (fast-check)', () => {
    const validConfigArbitrary = fc.record({
      customName: fc.option(fc.stringMatching(/^[a-zA-Z0-9 _-]{1,100}$/), { nil: undefined }),
      notes: fc.option(fc.stringMatching(/^[a-zA-Z0-9 _.,\n-]{1,500}$/), { nil: undefined }),
      tags: fc.option(fc.array(fc.stringMatching(/^[a-z0-9_-]{1,40}$/), { minLength: 0, maxLength: 20 }), { nil: undefined }),
      isBareBoard: fc.option(fc.boolean(), { nil: undefined })
    });

    it('Property: Valid structured configurations are always accepted and sanitized without mutation', () => {
      fc.assert(
        fc.property(
          validConfigArbitrary,
          validConfigArbitrary,
          (config1, config2) => {
            const raw = {
              dev_001: config1,
              dev_002: config2
            };

            const res = validateDeviceConfigImport(raw, inventory);
            expect(res.valid).toBe(true);
            expect(res.sanitized).toBeDefined();
            expect(res.sanitized?.dev_001).toBeDefined();
            expect(res.sanitized?.dev_002).toBeDefined();
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Property: Injections with unexpected keys are rejected 100% of the time', () => {
      const invalidKeyArbitrary = fc.stringMatching(/^[a-z]{3,10}$/)
        .filter(k => !['customName', 'notes', 'tags', 'isBareBoard'].includes(k));

      fc.assert(
        fc.property(
          invalidKeyArbitrary,
          fc.anything(),
          (badKey, badVal) => {
            const raw = {
              dev_001: {
                [badKey]: badVal
              }
            };
            const res = validateDeviceConfigImport(raw, inventory);
            expect(res.valid).toBe(false);
            expect(res.error).toBeDefined();
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
