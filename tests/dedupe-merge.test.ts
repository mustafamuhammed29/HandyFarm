import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { DeviceStore, DeviceData } from '../electron/db.ts';

describe('Area 3: Dedupe Merge & Non-Destructive State Preservation (e6ad487)', () => {
  let tmpDir: string;
  let dbPath: string;
  let jsonPath: string;
  let store: DeviceStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handyfarm-merge-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    jsonPath = path.join(tmpDir, 'devices.json');
    store = new DeviceStore(dbPath, jsonPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('Field-Level Metadata Preservation', () => {
    it('Preserves customName from losingId when survivingId has none', () => {
      store.updateDevice('usb_101', { customName: 'Shop Device Alpha' });
      store.updateDevice('net_101', { model: 'Tecno LH7n' });

      // Wi-Fi transport (net_101) becomes surviving, USB (usb_101) is losing
      const merged = store.mergeDevices('net_101', 'usb_101');

      expect(merged.customName).toBe('Shop Device Alpha');
      expect(store.hasDevice('usb_101')).toBe(false);
      expect(store.hasDevice('net_101')).toBe(true);
    });

    it('Prefers survivingId customName when both devices have names', () => {
      store.updateDevice('dev_old', { customName: 'Old Name' });
      store.updateDevice('dev_new', { customName: 'New Preferred Name' });

      const merged = store.mergeDevices('dev_new', 'dev_old');
      expect(merged.customName).toBe('New Preferred Name');
    });

    it('Preserves notes from losingId when survivingId has none', () => {
      store.updateDevice('dev_losing', { notes: 'Important QA bench note: fragile USB-C port' });
      store.updateDevice('dev_surviving', { model: 'Samsung Galaxy A15' });

      const merged = store.mergeDevices('dev_surviving', 'dev_losing');
      expect(merged.notes).toBe('Important QA bench note: fragile USB-C port');
    });

    it('Union-merges tags with zero loss and deduplication', () => {
      store.updateDevice('dev_1', { tags: ['carrier_vodafone', 'qa_bench', 'tokyo'] });
      store.updateDevice('dev_2', { tags: ['tokyo', 'android_14', 'priority_high'] });

      const merged = store.mergeDevices('dev_1', 'dev_2');
      expect(merged.tags).toEqual(expect.arrayContaining([
        'carrier_vodafone', 'qa_bench', 'tokyo', 'android_14', 'priority_high'
      ]));
      expect(merged.tags?.length).toBe(5);
    });

    it('Preserves isBareBoard boolean flag correctly', () => {
      store.updateDevice('dev_bare', { isBareBoard: true });
      store.updateDevice('dev_normal', { isBareBoard: false });

      const merged1 = store.mergeDevices('dev_bare', 'dev_normal');
      expect(merged1.isBareBoard).toBe(true);
    });

    it('Re-parents device history rows in SQLite without loss', () => {
      store.updateDevice('dev_usb', { serial: 'SERIAL123' });
      store.updateDevice('dev_wifi', { serial: 'SERIAL123' });

      store.logDeviceAction('dev_usb', 'Connected via USB 3.0');
      store.logDeviceAction('dev_usb', 'Screen turned on');
      store.logDeviceAction('dev_wifi', 'Switched to Wireless TCP/IP');

      const merged = store.mergeDevices('dev_wifi', 'dev_usb');
      expect(merged.history?.length).toBe(3);
      expect(merged.history?.some(h => h.action === 'Connected via USB 3.0')).toBe(true);
      expect(merged.history?.some(h => h.action === 'Screen turned on')).toBe(true);
      expect(merged.history?.some(h => h.action === 'Switched to Wireless TCP/IP')).toBe(true);
    });

    it('Transfers active lease state from losing device if surviving was unleased', () => {
      const physId = 'phys_SERIAL123';
      store.updateDevice('dev_usb', { physicalDeviceId: physId, leaseState: 'leased', leasedBy: 'session_worker_1' });
      store.updateDevice('dev_wifi', { physicalDeviceId: physId, leaseState: 'available' });

      const merged = store.mergeDevices('dev_wifi', 'dev_usb');
      expect(merged.leaseState).toBe('leased');
      expect(merged.leasedBy).toBe('session_worker_1');
    });

    it('Maintains physical device mapping with all observed serials', () => {
      const physId = 'phys_HW999';
      store.updateDevice('usb_dev', { physicalDeviceId: physId, serial: 'HW999' });
      store.updateDevice('wifi_dev', { physicalDeviceId: physId, serial: 'HW999' });

      store.mergeDevices('wifi_dev', 'usb_dev');

      const mapping = store.getPhysicalMapping(physId);
      expect(mapping).toBeDefined();
      expect(mapping?.currentTransportId).toBe('wifi_dev');
      expect(mapping?.lastSeenTransportId).toBe('usb_dev');
      expect(mapping?.serials).toContain('HW999');
    });
  });

  describe('Property-Based Merge Invariants (fast-check)', () => {
    it('Invariant: Zero tag loss under arbitrary tag combinations', () => {
      fc.assert(
        fc.property(
          fc.array(fc.stringMatching(/^[a-z_]{2,15}$/), { minLength: 0, maxLength: 8 }),
          fc.array(fc.stringMatching(/^[a-z_]{2,15}$/), { minLength: 0, maxLength: 8 }),
          (tags1, tags2) => {
            const id1 = `dev_${Math.random()}`;
            const id2 = `dev_${Math.random()}`;

            store.updateDevice(id1, { tags: tags1 });
            store.updateDevice(id2, { tags: tags2 });

            const merged = store.mergeDevices(id1, id2);
            const expectedAllTags = new Set([...tags1, ...tags2]);

            // Assert every tag that was in tags1 or tags2 is in the merged tags
            for (const tag of expectedAllTags) {
              expect(merged.tags).toContain(tag);
            }
            expect(merged.tags?.length).toBe(expectedAllTags.size);
          }
        ),
        { numRuns: 50 }
      );
    });

    it('Invariant: Non-empty customName and notes are never dropped', () => {
      fc.assert(
        fc.property(
          fc.option(fc.stringMatching(/^[a-zA-Z0-9 ]{1,30}$/), { nil: undefined }),
          fc.option(fc.stringMatching(/^[a-zA-Z0-9 ]{1,30}$/), { nil: undefined }),
          fc.option(fc.stringMatching(/^[a-zA-Z0-9 ]{1,100}$/), { nil: undefined }),
          fc.option(fc.stringMatching(/^[a-zA-Z0-9 ]{1,100}$/), { nil: undefined }),
          (name1, name2, notes1, notes2) => {
            const id1 = `dev_${Math.random()}`;
            const id2 = `dev_${Math.random()}`;

            store.updateDevice(id1, { customName: name1, notes: notes1 });
            store.updateDevice(id2, { customName: name2, notes: notes2 });

            const merged = store.mergeDevices(id1, id2);

            // Name invariant: if either device had a non-empty name, merged MUST have a name
            const hadName = (name1 && name1.trim()) || (name2 && name2.trim());
            if (hadName) {
              expect(merged.customName).toBeDefined();
              expect(typeof merged.customName).toBe('string');
              expect(merged.customName!.length).toBeGreaterThan(0);
            }

            // Notes invariant: if either device had non-empty notes, merged MUST have notes
            const hadNotes = (notes1 && notes1.trim()) || (notes2 && notes2.trim());
            if (hadNotes) {
              expect(merged.notes).toBeDefined();
              expect(typeof merged.notes).toBe('string');
              expect(merged.notes!.length).toBeGreaterThan(0);
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});
