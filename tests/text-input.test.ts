import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import {
  isAsciiOnly,
  determineTextRoute,
  buildAsciiInputCommand,
  buildClipboardPasteCommand,
  sendTextToDevice,
  CLIPPER_DEFAULT_RECEIVER,
  KEYCODE_PASTE
} from '../electron/textInput.ts';

describe('Text Input & Non-ASCII Clipboard Routing', () => {
  describe('isAsciiOnly and determineTextRoute', () => {
    it('correctly identifies pure-ASCII strings', () => {
      const asciiSamples = [
        '',
        'hello',
        'Hello, World!',
        '1234567890',
        '!@#$%^&*()_+-=[]{}|;:\'",.<>/?`~',
        'multi\nline\twith\rwhitespace',
        'a',
        'Z'
      ];
      for (const sample of asciiSamples) {
        expect(isAsciiOnly(sample)).toBe(true);
        expect(determineTextRoute(sample)).toBe('ascii_direct');
      }
    });

    it('property test: any arbitrary ASCII string routes to ascii_direct', () => {
      fc.assert(
        fc.property(fc.stringMatching(/^[\x20-\x7E]*$/), (s) => {
          return isAsciiOnly(s) === true && determineTextRoute(s) === 'ascii_direct';
        })
      );
    });

    it('identifies Arabic text as non-ASCII and routes to clipboard_paste (reproducing bug)', () => {
      const arabicSamples = [
        'مرحبا',
        'مرحبا بك في هاندي فارم',
        'السلام عليكم ورحمة الله وبركاته',
        'أهلاً وسهلاً',
        'نص تجريبي 123',
        'اختبار الكليبورد',
        'تأكيد الدخول'
      ];
      for (const sample of arabicSamples) {
        expect(isAsciiOnly(sample)).toBe(false);
        expect(determineTextRoute(sample)).toBe('clipboard_paste');
      }
    });

    it('identifies CJK, Cyrillic, accented Latin, and emoji text as non-ASCII', () => {
      const nonAsciiSamples = [
        '你好世界', // Chinese
        'こんにちは', // Japanese
        '안녕하세요', // Korean
        'Привет мир', // Russian
        'Café', // Accented Latin (e with acute)
        'München', // German Umlaut (u with diaeresis)
        'español', // Spanish eñe
        'naïve', // French i with diaeresis
        '🚀 Rocket', // Emoji
        'HandyFarm 🚜' // Mixed emoji
      ];
      for (const sample of nonAsciiSamples) {
        expect(isAsciiOnly(sample)).toBe(false);
        expect(determineTextRoute(sample)).toBe('clipboard_paste');
      }
    });

    it('handles mixed ASCII and non-ASCII text by routing to clipboard_paste', () => {
      const mixed = 'User_مستخدم_123';
      expect(isAsciiOnly(mixed)).toBe(false);
      expect(determineTextRoute(mixed)).toBe('clipboard_paste');
    });
  });

  describe('Command Building', () => {
    it('builds ASCII input command with correct base64 encoding', () => {
      const text = 'hello world';
      const cmd = buildAsciiInputCommand(text);
      const expectedB64 = Buffer.from(text, 'utf-8').toString('base64');
      expect(cmd.b64).toBe(expectedB64);
      expect(cmd.shellCommand).toBe(`RAW=$(echo ${expectedB64} | base64 -d); input text "$RAW"`);
    });

    it('builds clipboard paste command with correct base64, broadcast, and paste keyevent', () => {
      const text = 'مرحبا بك';
      const cmd = buildClipboardPasteCommand(text);
      const expectedB64 = Buffer.from(text, 'utf-8').toString('base64');
      expect(cmd.b64).toBe(expectedB64);
      expect(cmd.broadcastCommand).toBe(
        `RAW=$(echo ${expectedB64} | base64 -d); am broadcast -a clipper.set -n ${CLIPPER_DEFAULT_RECEIVER} --es text "$RAW"`
      );
      expect(cmd.pasteCommand).toBe(`input keyevent ${KEYCODE_PASTE}`);
      expect(cmd.combinedCommand).toBe(`${cmd.broadcastCommand} && ${cmd.pasteCommand}`);
    });

    it('supports custom receiver in buildClipboardPasteCommand', () => {
      const text = 'نص مخصص';
      const customReceiver = 'com.custom.pkg/.CustomReceiver';
      const cmd = buildClipboardPasteCommand(text, customReceiver);
      expect(cmd.broadcastCommand).toContain(customReceiver);
    });
  });

  describe('sendTextToDevice Orchestrator', () => {
    it('routes ASCII text directly via input text without touching companion clipboard', async () => {
      const executedCommands: string[] = [];
      const logs: string[] = [];
      const ensureClipperMock = vi.fn().mockResolvedValue(undefined);
      const execShellMock = vi.fn().mockImplementation(async (_devId: string, cmd: string) => {
        executedCommands.push(cmd);
        return '';
      });
      const logActionMock = vi.fn().mockImplementation((_devId: string, action: string) => {
        logs.push(action);
      });

      const res = await sendTextToDevice({
        deviceId: 'device-123',
        text: 'pure ascii text 456',
        ensureClipperInstalled: ensureClipperMock,
        execShell: execShellMock,
        logAction: logActionMock
      });

      expect(res.success).toBe(true);
      expect(res.route).toBe('ascii_direct');
      expect(ensureClipperMock).not.toHaveBeenCalled();
      expect(executedCommands.length).toBe(1);
      expect(executedCommands[0]).toContain('input text "$RAW"');
      expect(logs).toContain('Sent text: pure ascii text 456');
    });

    it('routes Arabic text through companion clipboard and KEYCODE_PASTE (279)', async () => {
      const executedCommands: string[] = [];
      const logs: string[] = [];
      const ensureClipperMock = vi.fn().mockResolvedValue(undefined);
      const execShellMock = vi.fn().mockImplementation(async (_devId: string, cmd: string) => {
        executedCommands.push(cmd);
        return '';
      });
      const logActionMock = vi.fn().mockImplementation((_devId: string, action: string) => {
        logs.push(action);
      });

      const arabicText = 'مرحبا بك في هاندي فارم';
      const res = await sendTextToDevice({
        deviceId: 'device-123',
        text: arabicText,
        ensureClipperInstalled: ensureClipperMock,
        execShell: execShellMock,
        logAction: logActionMock
      });

      expect(res.success).toBe(true);
      expect(res.route).toBe('clipboard_paste');
      expect(ensureClipperMock).toHaveBeenCalledWith('device-123');
      expect(executedCommands.length).toBe(2);
      expect(executedCommands[0]).toContain('am broadcast -a clipper.set');
      expect(executedCommands[1]).toBe(`input keyevent ${KEYCODE_PASTE}`);
      expect(logs[0]).toContain('Sent non-ASCII text via clipboard paste');
    });

    it('propagates error when shell execution fails on ASCII input', async () => {
      const ensureClipperMock = vi.fn().mockResolvedValue(undefined);
      const execShellMock = vi.fn().mockRejectedValue(new Error('ADB device disconnected'));

      const res = await sendTextToDevice({
        deviceId: 'device-123',
        text: 'hello',
        ensureClipperInstalled: ensureClipperMock,
        execShell: execShellMock
      });

      expect(res.success).toBe(false);
      expect(res.route).toBe('ascii_direct');
      expect(res.error).toContain('ADB device disconnected');
    });

    it('propagates error when ensureClipperInstalled fails on non-ASCII input', async () => {
      const ensureClipperMock = vi.fn().mockRejectedValue(new Error('APK install failed'));
      const execShellMock = vi.fn().mockResolvedValue('');

      const res = await sendTextToDevice({
        deviceId: 'device-123',
        text: 'عربي',
        ensureClipperInstalled: ensureClipperMock,
        execShell: execShellMock
      });

      expect(res.success).toBe(false);
      expect(res.route).toBe('clipboard_paste');
      expect(res.error).toContain('APK install failed');
      expect(execShellMock).not.toHaveBeenCalled();
    });
  });
});
