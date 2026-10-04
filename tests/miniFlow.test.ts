import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import {
  substitutePlaceholders,
  parseMiniFlow,
  runMiniFlow,
} from '../electron/miniFlow';

const adbOk = (stdout = '', code = 0) => async (_args: string[]) => ({ stdout, stderr: '', code });

describe('Phase 5 — mini-flow runner', () => {
  describe('substitutePlaceholders (shared with maestro)', () => {
    it('matches maestro substitution semantics', () => {
      const { content } = substitutePlaceholders('appId: {appId}', { appId: 'com.x' });
      expect(content).toBe('appId: com.x');
    });
  });

  describe('parseMiniFlow', () => {
    it('parses single-arg list items', () => {
      const steps = parseMiniFlow(`
        - launchApp: com.android.settings
        - sleep: 500
        - keyevent: KEYCODE_HOME
      `);
      expect(steps).toEqual([
        { verb: 'launchApp', arg: 'com.android.settings' },
        { verb: 'sleep', arg: '500' },
        { verb: 'keyevent', arg: 'KEYCODE_HOME' },
      ]);
    });

    it('parses multi-line args after empty colon', () => {
      const steps = parseMiniFlow(`
        - assertVisible:
            Bluetooth
            Connected devices
      `);
      expect(steps).toEqual([{ verb: 'assertVisible', arg: 'Bluetooth\nConnected devices' }]);
    });

    it('skips comments and blank lines', () => {
      const steps = parseMiniFlow(`
        # comment
        - sleep: 100
        # another comment
      `);
      expect(steps).toEqual([{ verb: 'sleep', arg: '100' }]);
    });

    it('property: parse round-trips for any list of single-arg steps', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.tuple(
              fc.constantFrom('launchApp', 'sleep', 'tap', 'keyevent'),
              fc.stringMatching(/^[a-zA-Z0-9 .]{1,20}$/),
            ),
            { minLength: 1, maxLength: 8 },
          ),
          (pairs) => {
            const yaml = pairs.map(([v, a]) => `- ${v}: ${a}`).join('\n');
            const parsed = parseMiniFlow(yaml);
            return parsed.length === pairs.length
              && parsed.every((s, i) => s.verb === pairs[i][0] && s.arg.trim() === pairs[i][1].trim());
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  describe('runMiniFlow', () => {
    it('executes launchApp / sleep / keyevent in order', async () => {
      const execAdb = vi.fn().mockImplementation(adbOk('', 0));
      const result = await runMiniFlow(
        { flowContent: '- launchApp: com.x\n- sleep: 10\n- keyevent: KEYCODE_BACK\n', substitutions: {} },
        { execAdb },
      );
      expect(result.status).toBe('passed');
      expect(result.steps.map(s => s.verb)).toEqual(['launchApp', 'sleep', 'keyevent']);
      // execAdb called for launchApp + keyevent (sleep has no shell call)
      expect(execAdb).toHaveBeenCalledWith(['shell', 'monkey', '-p', 'com.x', '-c', 'android.intent.category.LAUNCHER', '1']);
      expect(execAdb).toHaveBeenCalledWith(['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
    });

    it('substitutes placeholders before executing', async () => {
      const execAdb = vi.fn().mockImplementation(adbOk('', 0));
      const result = await runMiniFlow(
        {
          flowContent: '- launchApp: {pkg}\n',
          substitutions: { pkg: 'com.handyfarm.clipper' },
        },
        { execAdb },
      );
      expect(result.status).toBe('passed');
      expect(execAdb).toHaveBeenCalledWith(['shell', 'monkey', '-p', 'com.handyfarm.clipper', '-c', 'android.intent.category.LAUNCHER', '1']);
      expect(result.appliedSubstitutions.pkg).toBe('com.handyfarm.clipper');
    });

    it('stops at first failure and reports failed status', async () => {
      let call = 0;
      const execAdb = vi.fn().mockImplementation(async (args: string[]) => {
        call++;
        // Fail runAdb so the runner can observe the non-zero exit.
        if (args[0] === 'shell' && args[1] === 'logcat' && args[2] === '-d') return { stdout: '', stderr: 'fail', code: 1 };
        return { stdout: '', stderr: '', code: 0 };
      });
      const result = await runMiniFlow(
        { flowContent: '- launchApp: com.x\n- runAdb: shell logcat -d\n- keyevent: BACK\n' },
        { execAdb },
      );
      expect(result.status).toBe('failed');
      // 3 calls expected: launchApp monkey + runAdb + (no further calls)
      expect(call).toBe(2);
      expect(result.steps[1].verb).toBe('runAdb');
      expect(result.steps[1].status).toBe('failed');
    });
  });
});