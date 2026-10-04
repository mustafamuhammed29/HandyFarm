import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  substitutePlaceholders,
  parseFailures,
  probeMaestro,
  runMaestroFlow,
} from '../electron/maestro';

describe('Phase 5 — Maestro executor', () => {
  describe('substitutePlaceholders', () => {
    it('replaces {name} tokens with values', () => {
      const { content, applied } = substitutePlaceholders(
        'appId: {appId}\nserial: {serial}',
        { appId: 'com.example', serial: 'ABC123' },
      );
      expect(content).toBe('appId: com.example\nserial: ABC123');
      expect(applied).toEqual({ appId: 'com.example', serial: 'ABC123' });
    });

    it('leaves unknown tokens untouched', () => {
      const { content, applied } = substitutePlaceholders(
        'a={a} b={b}',
        { a: '1' },
      );
      expect(content).toBe('a=1 b={b}');
      expect(applied).toEqual({ a: '1' });
    });

    it('does not double-substitute values that themselves contain braces', () => {
      const { content } = substitutePlaceholders(
        'a={x} and {y}',
        { x: '{y}', y: 'zzz' },
      );
      expect(content).toBe('a={y} and zzz');
    });

    it('property: substitution is a fixed point', () => {
      fc.assert(
        fc.property(
          fc.dictionary(fc.stringMatching(/^[a-z]{1,3}$/), fc.string({ maxLength: 10 })),
          fc.string({ maxLength: 30 }),
          (subs, content) => {
            const { content: c1 } = substitutePlaceholders(content, subs);
            const { content: c2 } = substitutePlaceholders(c1, subs);
            return c1 === c2;
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  describe('parseFailures', () => {
    it('collects Failure / Error lines from maestro output', () => {
      const out = parseFailures(
        'some debug\nFailure: step "click Settings" at line 5\nOK',
        'Assertion failed: x\n',
      );
      expect(out.length).toBeGreaterThanOrEqual(2);
      expect(out.some(f => f.message.includes('click Settings'))).toBe(true);
      expect(out.some(f => f.message.includes('Assertion failed'))).toBe(true);
    });

    it('returns empty array for clean output', () => {
      expect(parseFailures('all good\n', '')).toEqual([]);
    });
  });

  describe('probeMaestro', () => {
    it('returns MAESTRO_NOT_FOUND when binary is missing', async () => {
      const probe = await probeMaestro('this-binary-does-not-exist-12345');
      expect(probe.ok).toBe(false);
      if (!probe.ok) expect(probe.error).toBe('MAESTRO_NOT_FOUND');
    });
  });

  describe('runMaestroFlow', () => {
    it('reports an error when neither flowPath nor flowContent is provided', async () => {
      const result = await runMaestroFlow({}, 'SERIAL');
      expect(result.status).toBe('error');
      expect(result.stderr).toMatch(/required/i);
    });

    it('runs inline content and reports MAESTRO_NOT_FOUND cleanly', async () => {
      const result = await runMaestroFlow(
        { flowContent: 'appId: {appId}\n- launchApp: com.example', substitutions: { appId: 'com.handyfarm.clipper' }, maestroPath: 'this-binary-does-not-exist-12345' },
        'SERIAL',
      );
      expect(result.status).toBe('error');
      expect(result.stderr).toMatch(/MAESTRO_NOT_FOUND/);
      expect(result.appliedSubstitutions.appId).toBe('com.handyfarm.clipper');
      expect(result.resolvedFlowPath).toBeDefined();
    }, 15_000);
  });
});