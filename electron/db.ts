import Database from 'better-sqlite3';
import { nativeImage } from 'electron';
import fs from 'fs';
import path from 'path';

export interface DeviceData {
  id: string;
  physicalDeviceId?: string;
  status: string;
  model?: string;
  manufacturer?: string;
  serial?: string;
  name?: string;
  customName?: string;
  thumbnail?: string;
  notes?: string;
  isBareBoard?: boolean;
  history?: { action: string; timestamp: string }[];
  tags?: string[];
  connectedAt?: number;
  lastKnownIp?: string;
  battery?: { level: number; charging: boolean };
}

import type { PhysicalDeviceMapping, DeviceHardwareProps } from './identity.js';
import { generatePhysicalDeviceId } from './identity.js';
export type { PhysicalDeviceMapping, DeviceHardwareProps };
export { generatePhysicalDeviceId };

// -------------------------------------------------------------
// In-Memory Bounded LRU Thumbnail Cache
// -------------------------------------------------------------
export class ThumbnailLRU {
  private cache = new Map<string, string>();
  private readonly maxSize: number;

  constructor(maxSize = 100) {
    this.maxSize = maxSize;
  }

  get(deviceId: string): string | undefined {
    const val = this.cache.get(deviceId);
    if (val !== undefined) {
      this.cache.delete(deviceId);
      this.cache.set(deviceId, val);
    }
    return val;
  }

  set(deviceId: string, dataUrl: string): void {
    if (this.cache.has(deviceId)) {
      this.cache.delete(deviceId);
    } else if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(deviceId, dataUrl);
  }

  delete(deviceId: string): void {
    this.cache.delete(deviceId);
  }

  clear(): void {
    this.cache.clear();
  }
}

export const thumbnailCache = new ThumbnailLRU(100);

/**
 * Downscale raw screencap image buffer to ~240px width JPEG data URI.
 * Guarantees that high-resolution PNGs are never passed to the DB or renderer.
 */
export function downscaleThumbnail(rawBuffer: Buffer): string | null {
  try {
    const img = nativeImage.createFromBuffer(rawBuffer);
    const size = img.getSize();
    if (size.width === 0 || size.height === 0) return null;

    const targetWidth = 240;
    const targetHeight = Math.round((size.height / size.width) * targetWidth);
    const resized = img.resize({ width: targetWidth, height: targetHeight, quality: 'good' });
    const jpegBuf = resized.toJPEG(75);
    return `data:image/jpeg;base64,${jpegBuf.toString('base64')}`;
  } catch (err) {
    console.warn('[Thumbnail] Downscaling failed:', err);
    return null;
  }
}

// -------------------------------------------------------------
// SQLite Device Storage with WAL Mode & Debounced Writes
// -------------------------------------------------------------
export class DeviceStore {
  private db: Database.Database;
  private pendingWrites = new Map<string, Partial<DeviceData>>();
  private debounceTimer: NodeJS.Timeout | null = null;
  private inMemoryDevices = new Map<string, DeviceData>();
  private physicalMappings = new Map<string, PhysicalDeviceMapping>();

  private stmtUpsertDevice!: Database.Statement;
  private stmtDeleteDevice!: Database.Statement;
  private stmtInsertHistory!: Database.Statement;
  private stmtGetHistory!: Database.Statement;
  private stmtPruneHistory!: Database.Statement;
  private stmtSelectAllDevices!: Database.Statement;
  private stmtReparentHistory!: Database.Statement;
  private stmtUpsertPhysicalMapping!: Database.Statement;
  private stmtGetAllPhysicalMappings!: Database.Statement;

  constructor(dbPath: string, jsonBackupPath?: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');

    this.createTables();
    this.prepareStatements();

    // Migrate from legacy devices.json if database is currently empty
    if (jsonBackupPath && fs.existsSync(jsonBackupPath)) {
      this.migrateFromJsonIfEmpty(jsonBackupPath);
    }

    // Load initial device state into in-memory cache
    this.loadAllIntoMemory();
  }

  private createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        physical_device_id TEXT,
        serial TEXT,
        status TEXT NOT NULL,
        model TEXT,
        manufacturer TEXT,
        name TEXT,
        custom_name TEXT,
        notes TEXT,
        is_bare_board INTEGER DEFAULT 0,
        tags TEXT,
        connected_at INTEGER,
        last_known_ip TEXT,
        battery_level INTEGER,
        battery_charging INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_devices_physical_id ON devices(physical_device_id);
      CREATE INDEX IF NOT EXISTS idx_devices_serial ON devices(serial);
      CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);

      CREATE TABLE IF NOT EXISTS device_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        action TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_history_device_id ON device_history(device_id, id DESC);

      CREATE TABLE IF NOT EXISTS physical_devices (
        physical_device_id TEXT PRIMARY KEY,
        current_transport_id TEXT NOT NULL,
        last_seen_transport_id TEXT NOT NULL,
        serials TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // Ensure physical_device_id column exists if table was created in an earlier migration
    const cols = this.db.pragma('table_info(devices)') as any[];
    if (!cols.some(c => c.name === 'physical_device_id')) {
      this.db.exec('ALTER TABLE devices ADD COLUMN physical_device_id TEXT;');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_devices_physical_id ON devices(physical_device_id);');
    }
  }

  private prepareStatements() {
    this.stmtUpsertDevice = this.db.prepare(`
      INSERT INTO devices (
        id, physical_device_id, serial, status, model, manufacturer, name, custom_name, notes,
        is_bare_board, tags, connected_at, last_known_ip, battery_level, battery_charging, updated_at
      ) VALUES (
        @id, @physicalDeviceId, @serial, @status, @model, @manufacturer, @name, @customName, @notes,
        @isBareBoard, @tags, @connectedAt, @lastKnownIp, @batteryLevel, @batteryCharging, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        physical_device_id = COALESCE(excluded.physical_device_id, devices.physical_device_id),
        serial = COALESCE(excluded.serial, devices.serial),
        status = COALESCE(excluded.status, devices.status),
        model = COALESCE(excluded.model, devices.model),
        manufacturer = COALESCE(excluded.manufacturer, devices.manufacturer),
        name = COALESCE(excluded.name, devices.name),
        custom_name = COALESCE(excluded.custom_name, devices.custom_name),
        notes = COALESCE(excluded.notes, devices.notes),
        is_bare_board = COALESCE(excluded.is_bare_board, devices.is_bare_board),
        tags = COALESCE(excluded.tags, devices.tags),
        connected_at = COALESCE(excluded.connected_at, devices.connected_at),
        last_known_ip = COALESCE(excluded.last_known_ip, devices.last_known_ip),
        battery_level = COALESCE(excluded.battery_level, devices.battery_level),
        battery_charging = COALESCE(excluded.battery_charging, devices.battery_charging),
        updated_at = excluded.updated_at
    `);

    this.stmtDeleteDevice = this.db.prepare(`DELETE FROM devices WHERE id = ?`);
    this.stmtInsertHistory = this.db.prepare(`
      INSERT INTO device_history (device_id, action, timestamp, created_at)
      VALUES (?, ?, ?, ?)
    `);
    this.stmtGetHistory = this.db.prepare(`
      SELECT action, timestamp FROM device_history
      WHERE device_id = ?
      ORDER BY id DESC
      LIMIT ?
    `);
    this.stmtPruneHistory = this.db.prepare(`
      DELETE FROM device_history
      WHERE device_id = ? AND id NOT IN (
        SELECT id FROM device_history WHERE device_id = ? ORDER BY id DESC LIMIT 50
      )
    `);
    this.stmtSelectAllDevices = this.db.prepare(`SELECT * FROM devices`);
    this.stmtReparentHistory = this.db.prepare(`
      UPDATE device_history SET device_id = ? WHERE device_id = ?
    `);
    this.stmtUpsertPhysicalMapping = this.db.prepare(`
      INSERT INTO physical_devices (
        physical_device_id, current_transport_id, last_seen_transport_id, serials, updated_at
      ) VALUES (
        @physicalDeviceId, @currentTransportId, @lastSeenTransportId, @serials, @updatedAt
      )
      ON CONFLICT(physical_device_id) DO UPDATE SET
        current_transport_id = excluded.current_transport_id,
        last_seen_transport_id = excluded.last_seen_transport_id,
        serials = excluded.serials,
        updated_at = excluded.updated_at
    `);
    this.stmtGetAllPhysicalMappings = this.db.prepare(`SELECT * FROM physical_devices`);
  }

  private migrateFromJsonIfEmpty(jsonPath: string) {
    const countRow = this.db.prepare(`SELECT COUNT(*) as count FROM devices`).get() as { count: number };
    if (countRow && countRow.count > 0) {
      return;
    }

    try {
      console.log(`[SQLite Migration] Migrating legacy devices from ${jsonPath}...`);
      const raw = fs.readFileSync(jsonPath, 'utf-8');
      const data: Record<string, any> = JSON.parse(raw);
      const now = Date.now();

      const insertTx = this.db.transaction(() => {
        for (const [id, dev] of Object.entries(data)) {
          const serial = dev.serial || id;
          const physId = dev.physicalDeviceId || `phys_${serial}`;
          this.stmtUpsertDevice.run({
            id,
            physicalDeviceId: physId,
            serial,
            status: dev.status || 'offline',
            model: dev.model || null,
            manufacturer: dev.manufacturer || null,
            name: dev.name || null,
            customName: dev.customName || null,
            notes: dev.notes || null,
            isBareBoard: dev.isBareBoard ? 1 : 0,
            tags: dev.tags ? JSON.stringify(dev.tags) : null,
            connectedAt: dev.connectedAt || null,
            lastKnownIp: dev.lastKnownIp || null,
            batteryLevel: dev.battery?.level ?? null,
            batteryCharging: dev.battery?.charging ? 1 : 0,
            updatedAt: now
          });

          if (Array.isArray(dev.history)) {
            for (const h of dev.history.slice(0, 50)) {
              if (h.action && h.timestamp) {
                this.stmtInsertHistory.run(id, h.action, h.timestamp, now);
              }
            }
          }

          this.recordPhysicalMapping(physId, id, [serial]);
        }
      });

      insertTx();
      console.log(`[SQLite Migration] Successfully migrated ${Object.keys(data).length} devices to SQLite!`);
    } catch (err) {
      console.error('[SQLite Migration] Error migrating devices.json:', err);
    }
  }

  private loadAllIntoMemory() {
    this.inMemoryDevices.clear();
    const rows = this.stmtSelectAllDevices.all() as any[];
    for (const r of rows) {
      let tags: string[] = [];
      try {
        if (r.tags) tags = JSON.parse(r.tags);
      } catch {}

      const history = (this.stmtGetHistory.all(r.id, 50) as { action: string; timestamp: string }[]) || [];

      const dev: DeviceData = {
        id: r.id,
        physicalDeviceId: r.physical_device_id || undefined,
        serial: r.serial || r.id,
        status: r.status,
        model: r.model || undefined,
        manufacturer: r.manufacturer || undefined,
        name: r.name || undefined,
        customName: r.custom_name || undefined,
        notes: r.notes || undefined,
        isBareBoard: Boolean(r.is_bare_board),
        tags,
        connectedAt: r.connected_at || undefined,
        lastKnownIp: r.last_known_ip || undefined,
        battery: (r.battery_level !== null && r.battery_level !== undefined)
          ? { level: r.battery_level, charging: Boolean(r.battery_charging) }
          : undefined,
        history
      };

      this.inMemoryDevices.set(r.id, dev);
    }

    // Load physical mappings
    this.physicalMappings.clear();
    try {
      const mappingRows = this.stmtGetAllPhysicalMappings.all() as any[];
      for (const m of mappingRows) {
        let serials: string[] = [];
        try {
          serials = JSON.parse(m.serials);
        } catch {}
        this.physicalMappings.set(m.physical_device_id, {
          physicalDeviceId: m.physical_device_id,
          currentTransportId: m.current_transport_id,
          lastSeenTransportId: m.last_seen_transport_id,
          serials,
          updatedAt: m.updated_at
        });
      }
    } catch {}
  }

  // --- Public API for In-Memory Queries ---

  getDevice(id: string): DeviceData | undefined {
    return this.inMemoryDevices.get(id);
  }

  getAllDevices(includeThumbnails = true): DeviceData[] {
    const list: DeviceData[] = [];
    for (const dev of this.inMemoryDevices.values()) {
      list.push({
        ...dev,
        thumbnail: includeThumbnails ? thumbnailCache.get(dev.id) : undefined
      });
    }
    return list;
  }

  getDeviceCount(): number {
    return this.inMemoryDevices.size;
  }

  hasDevice(id: string): boolean {
    return this.inMemoryDevices.has(id);
  }

  /**
   * Update device in in-memory state and schedule a debounced SQLite write.
   * Never stores thumbnail in SQLite.
   */
  updateDevice(id: string, patch: Partial<DeviceData>): DeviceData {
    const cleanPatch = { ...patch };
    delete cleanPatch.thumbnail;

    const existing = this.inMemoryDevices.get(id) || { id, status: 'offline', serial: id };
    const updated: DeviceData = {
      ...existing,
      ...cleanPatch,
      id
    };

    if (!updated.serial) updated.serial = id;
    this.inMemoryDevices.set(id, updated);

    // Queue debounced write
    const pending = this.pendingWrites.get(id) || {};
    this.pendingWrites.set(id, { ...pending, ...cleanPatch });
    this.scheduleDebouncedFlush();

    // Maintain physical mapping if physicalDeviceId is present
    if (updated.physicalDeviceId) {
      this.recordPhysicalMapping(updated.physicalDeviceId, id, [updated.serial]);
    }

    return updated;
  }

  deleteDevice(id: string): void {
    this.inMemoryDevices.delete(id);
    this.pendingWrites.delete(id);
    thumbnailCache.delete(id);

    try {
      this.stmtDeleteDevice.run(id);
    } catch (err) {
      console.warn(`[SQLite] Failed to delete device ${id}:`, err);
    }
  }

  /**
   * Turn deduplication into a MERGE rather than a destructive delete.
   * Merges customName, notes, tags, and device_history rows from losingId into survivingId,
   * preferring non-empty values on conflict, then removes the duplicate row.
   */
  mergeDevices(survivingId: string, losingId: string): DeviceData {
    const surviving = this.inMemoryDevices.get(survivingId) || { id: survivingId, status: 'offline', serial: survivingId };
    const losing = this.inMemoryDevices.get(losingId) || { id: losingId, status: 'offline', serial: losingId };

    // Merge fields, preferring non-empty values on conflict
    const mergedCustomName = (surviving.customName && surviving.customName.trim())
      ? surviving.customName
      : ((losing.customName && losing.customName.trim()) ? losing.customName : undefined);

    const mergedNotes = (surviving.notes && surviving.notes.trim())
      ? surviving.notes
      : ((losing.notes && losing.notes.trim()) ? losing.notes : undefined);

    const mergedTags = Array.from(new Set([
      ...(Array.isArray(surviving.tags) ? surviving.tags : []),
      ...(Array.isArray(losing.tags) ? losing.tags : [])
    ]));

    const mergedPhysicalDeviceId = surviving.physicalDeviceId || losing.physicalDeviceId;
    const mergedSerial = surviving.serial || losing.serial || survivingId;
    const mergedModel = surviving.model || losing.model;
    const mergedManufacturer = surviving.manufacturer || losing.manufacturer;
    const mergedName = surviving.name || losing.name;
    const mergedIsBareBoard = surviving.isBareBoard ?? losing.isBareBoard ?? false;
    const mergedLastKnownIp = surviving.lastKnownIp || losing.lastKnownIp;

    // Re-parent history rows in SQLite
    try {
      this.stmtReparentHistory.run(survivingId, losingId);
      this.stmtPruneHistory.run(survivingId, survivingId);
    } catch (err) {
      console.warn(`[DeviceStore] Failed to re-parent history from ${losingId} to ${survivingId}:`, err);
    }

    // Transfer thumbnail if needed
    if (!thumbnailCache.get(survivingId) && thumbnailCache.get(losingId)) {
      thumbnailCache.set(survivingId, thumbnailCache.get(losingId)!);
    }
    thumbnailCache.delete(losingId);

    // Delete redundant duplicate row from SQLite & in-memory map
    try {
      this.stmtDeleteDevice.run(losingId);
    } catch (err) {
      console.warn(`[DeviceStore] Failed to delete redundant duplicate ${losingId}:`, err);
    }
    this.inMemoryDevices.delete(losingId);
    this.pendingWrites.delete(losingId);

    // Re-fetch merged history for surviving device
    const updatedHistory = (this.stmtGetHistory.all(survivingId, 50) as { action: string; timestamp: string }[]) || [];

    // Assemble merged record
    const mergedData: DeviceData = {
      ...surviving,
      customName: mergedCustomName,
      notes: mergedNotes,
      tags: mergedTags,
      physicalDeviceId: mergedPhysicalDeviceId,
      serial: mergedSerial,
      model: mergedModel,
      manufacturer: mergedManufacturer,
      name: mergedName,
      isBareBoard: mergedIsBareBoard,
      lastKnownIp: mergedLastKnownIp,
      history: updatedHistory
    };

    const currentThumb = thumbnailCache.get(survivingId);
    if (currentThumb) {
      mergedData.thumbnail = currentThumb;
    }

    this.inMemoryDevices.set(survivingId, mergedData);

    // Queue write for surviving device and flush immediately to SQLite
    const pending = this.pendingWrites.get(survivingId) || {};
    this.pendingWrites.set(survivingId, { ...pending, ...mergedData });
    this.flushWrites();

    // Maintain physical mapping
    if (mergedPhysicalDeviceId) {
      this.recordPhysicalMapping(mergedPhysicalDeviceId, survivingId, [surviving.serial, losing.serial]);
    }

    console.log(`[DeviceStore] Successfully merged device ${losingId} into ${survivingId} (physicalId: ${mergedPhysicalDeviceId})`);
    return mergedData;
  }

  // --- Physical Device Mapping (physicalDeviceId -> currentTransportId, lastSeenTransportId, serials[]) ---

  recordPhysicalMapping(physicalDeviceId: string, currentTransportId: string, additionalSerials?: (string | undefined)[]): PhysicalDeviceMapping {
    const existing = this.physicalMappings.get(physicalDeviceId);
    const serialSet = new Set<string>(existing?.serials || []);
    if (additionalSerials) {
      for (const s of additionalSerials) {
        if (s && s.trim()) serialSet.add(s.trim());
      }
    }

    const lastSeen = (existing?.currentTransportId && existing.currentTransportId !== currentTransportId)
      ? existing.currentTransportId
      : (existing?.lastSeenTransportId || currentTransportId);

    const mapping: PhysicalDeviceMapping = {
      physicalDeviceId,
      currentTransportId,
      lastSeenTransportId: lastSeen,
      serials: Array.from(serialSet),
      updatedAt: Date.now()
    };

    this.physicalMappings.set(physicalDeviceId, mapping);

    try {
      this.stmtUpsertPhysicalMapping.run({
        physicalDeviceId: mapping.physicalDeviceId,
        currentTransportId: mapping.currentTransportId,
        lastSeenTransportId: mapping.lastSeenTransportId,
        serials: JSON.stringify(mapping.serials),
        updatedAt: mapping.updatedAt
      });
    } catch (err) {
      console.warn('[DeviceStore] Failed to update physical_devices table:', err);
    }

    return mapping;
  }

  getPhysicalMapping(physicalDeviceId: string): PhysicalDeviceMapping | undefined {
    return this.physicalMappings.get(physicalDeviceId);
  }

  getAllPhysicalMappings(): PhysicalDeviceMapping[] {
    return Array.from(this.physicalMappings.values());
  }

  logDeviceAction(deviceId: string, action: string): void {
    const now = Date.now();
    const timestamp = new Date(now).toISOString();

    let dev = this.inMemoryDevices.get(deviceId);
    if (!dev) {
      dev = { id: deviceId, status: 'offline', serial: deviceId, history: [] };
      this.inMemoryDevices.set(deviceId, dev);
    }

    if (!dev.history) dev.history = [];
    dev.history.unshift({ action, timestamp });
    dev.history = dev.history.slice(0, 50);

    try {
      this.stmtInsertHistory.run(deviceId, action, timestamp, now);
      this.stmtPruneHistory.run(deviceId, deviceId);
    } catch (err) {
      console.warn(`[SQLite] Failed to log action for ${deviceId}:`, err);
    }
  }

  // --- Debounced Coalescing Writer (at most 1 write/sec/device) ---

  private scheduleDebouncedFlush() {
    if (!this.debounceTimer) {
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        this.flushWrites();
      }, 1000);
    }
  }

  flushWrites(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.pendingWrites.size === 0) return;

    const toWrite = Array.from(this.pendingWrites.entries());
    this.pendingWrites.clear();

    const now = Date.now();
    try {
      const tx = this.db.transaction(() => {
        for (const [id, patch] of toWrite) {
          const current = this.inMemoryDevices.get(id);
          if (!current) continue;

          this.stmtUpsertDevice.run({
            id,
            physicalDeviceId: patch.physicalDeviceId ?? current.physicalDeviceId ?? null,
            serial: patch.serial ?? current.serial ?? id,
            status: patch.status ?? current.status ?? 'offline',
            model: patch.model ?? current.model ?? null,
            manufacturer: patch.manufacturer ?? current.manufacturer ?? null,
            name: patch.name ?? current.name ?? null,
            customName: patch.customName ?? current.customName ?? null,
            notes: patch.notes ?? current.notes ?? null,
            isBareBoard: (patch.isBareBoard ?? current.isBareBoard) ? 1 : 0,
            tags: (patch.tags || current.tags) ? JSON.stringify(patch.tags || current.tags) : null,
            connectedAt: patch.connectedAt ?? current.connectedAt ?? null,
            lastKnownIp: patch.lastKnownIp ?? current.lastKnownIp ?? null,
            batteryLevel: patch.battery?.level ?? current.battery?.level ?? null,
            batteryCharging: (patch.battery?.charging ?? current.battery?.charging) ? 1 : 0,
            updatedAt: now
          });
        }
      });

      tx();
    } catch (err) {
      console.error('[SQLite] Failed to flush debounced writes:', err);
    }
  }

  close(): void {
    this.flushWrites();
    try {
      this.db.close();
    } catch (err) {
      console.warn('[SQLite] Error closing db:', err);
    }
  }
}
