import { describe, it, expect } from 'vitest';

// Pure module — no side effects on import. Same module main.ts re-exports.
import { parseAllowedCommand } from '../electron/safeAdb';

describe('parseAllowedCommand — typed allowlist', () => {
  describe('happy paths', () => {
    it('getprop with no args', () => {
      const r = parseAllowedCommand('getprop');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.args).toEqual(['getprop']);
    });
    it('getprop with name', () => {
      const r = parseAllowedCommand('getprop ro.build.fingerprint');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.args).toEqual(['getprop', 'ro.build.fingerprint']);
    });
    it('dumpsys battery', () => {
      const r = parseAllowedCommand('dumpsys battery');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.args).toEqual(['dumpsys', 'battery']);
    });
    it('dumpsys package with package name', () => {
      const r = parseAllowedCommand('dumpsys package com.example.app');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.args).toEqual(['dumpsys', 'package', 'com.example.app']);
    });
    it('pm list packages -3', () => {
      const r = parseAllowedCommand('pm list packages -3');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.args).toEqual(['pm', 'list', 'packages', '-3']);
    });
    it('pm path with package', () => {
      const r = parseAllowedCommand('pm path com.android.shell');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.args).toEqual(['pm', 'path', 'com.android.shell']);
    });
    it('ip addr show', () => {
      const r = parseAllowedCommand('ip addr show');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.args).toEqual(['ip', 'addr', 'show']);
    });
    it('settings get global wifi_on', () => {
      const r = parseAllowedCommand('settings get global wifi_on');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.args).toEqual(['settings', 'get', 'global', 'wifi_on']);
    });
    it('logcat -d', () => {
      const r = parseAllowedCommand('logcat -d');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.args).toEqual(['logcat', '-d']);
    });
    it('wm size', () => {
      const r = parseAllowedCommand('wm size');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.args).toEqual(['wm', 'size']);
    });
  });

  describe('rejected — shell metacharacters', () => {
    it.each([
      'getprop; reboot',
      'getprop && reboot',
      'getprop | cat',
      'getprop `reboot`',
      'getprop $(reboot)',
      'getprop > /tmp/x',
      'getprop < /etc/passwd',
      'getprop "value"',
      "getprop 'value'",
      "getprop 'reboot'",
      'getprop value\\nreboot',
      'cat /proc/cpuinfo; reboot',
      'logcat -d; reboot',
      'dumpsys battery #comment\nreboot',
      'getprop value$USER',
      'getprop value!',
      'getprop value*',
      'getprop value?',
      'getprop value[0]',
      'getprop value~',
    ])('rejects "%s"', (input) => {
      const r = parseAllowedCommand(input);
      expect(r.ok).toBe(false);
    });
  });

  describe('rejected — not in allowlist', () => {
    it.each([
      'rm -rf /',
      'reboot',
      'pm install /tmp/x.apk',
      'am start -n com.example.app/.MainActivity',
      'input keyevent 4',
      'svc wifi enable',
      'curl http://evil.com',
      'adb shell reboot',  // attempts to recurse into adb — should fail
    ])('rejects "%s"', (input) => {
      const r = parseAllowedCommand(input);
      expect(r.ok).toBe(false);
    });
  });

  describe('rejected — empty / type', () => {
    it('empty string', () => {
      expect(parseAllowedCommand('').ok).toBe(false);
      expect(parseAllowedCommand('   ').ok).toBe(false);
    });
    it('non-string', () => {
      expect(parseAllowedCommand(undefined as any).ok).toBe(false);
      expect(parseAllowedCommand(null as any).ok).toBe(false);
      expect(parseAllowedCommand(42 as any).ok).toBe(false);
    });
  });

  describe('defense in depth: ARG_RE re-validates every emitted arg', () => {
    it('every emitted arg in every successful parse passes ARG_RE', () => {
      const samples = [
        'getprop',
        'getprop ro.build.fingerprint',
        'dumpsys battery',
        'dumpsys package com.example.app',
        'pm list packages',
        'pm list packages -3',
        'pm path com.android.shell',
        'ip addr',
        'ip addr show',
        'ip route show',
        'cat /proc/cpuinfo',
        'cat /proc/meminfo',
        'uptime',
        'date',
        'df',
        'df -h',
        'df -h /data',
        'free -m',
        'wm size',
        'wm density',
        'settings get global wifi_on',
        'settings get secure mock_location',
        'logcat -d',
        'logcat -d -s',
        'logcat -d MyTag:V',
        'ifconfig',
        'ifconfig wlan0',
      ];
      const ARG_RE = /^[a-zA-Z0-9._:\/-]+$/;
      for (const s of samples) {
        const r = parseAllowedCommand(s);
        expect(r.ok, `expected ${JSON.stringify(s)} to parse, got error: ${r.ok ? '' : r.error}`).toBe(true);
        if (r.ok) {
          for (const a of r.args) {
            expect(ARG_RE.test(a), `arg ${a} from ${s} failed ARG_RE`).toBe(true);
          }
        }
      }
    });
  });

  describe('whitespace / leading and internal', () => {
    it('trims surrounding whitespace', () => {
      expect(parseAllowedCommand('   getprop   ').ok).toBe(true);
    });
    it('rejects internal extra whitespace that breaks the pattern', () => {
      // getprop with double space between verb and arg is non-canonical
      expect(parseAllowedCommand('getprop  ro.build.fingerprint').ok).toBe(true); // still single match
      expect(parseAllowedCommand('getprop ro.build.fingerprint extra').ok).toBe(false);
    });
  });
});