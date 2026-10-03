import Database from 'better-sqlite3';
import { nativeImage } from 'electron';
import fs from 'fs';
import path from 'path';

export interface DeviceData {
  id: string;
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

  private stmtUpsertDevice!: Database.Statement;
  private stmtDeleteDevice!: Database.Statement;
  private stmtInsertHistory!: Database.Statement;
  private stmtGetHistory!: Database.Statement;
  private stmtPruneHistory!: Database.Statement;
  private stmtSelectAllDevices!: Database.Statement;

  constructor(dbPath: string, jsonBackupPath?: string) {
    // Ensure parent directory exists
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
    `);
  }

  private prepareStatements() {
    this.stmtUpsertDevice = this.db.prepare(`
      INSERT INTO devices (
        id, serial, status, model, manufacturer, name, custom_name, notes,
        is_bare_board, tags, connected_at, last_known_ip, battery_level, battery_charging, updated_at
      ) VALUES (
        @id, @serial, @status, @model, @manufacturer, @name, @customName, @notes,
        @isBareBoard, @tags, @connectedAt, @lastKnownIp, @batteryLevel, @batteryCharging, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
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
  }

  private migrateFromJsonIfEmpty(jsonPath: string) {
    const countRow = this.db.prepare(`SELECT COUNT(*) as count FROM devices`).get() as { count: number };
    if (countRow && countRow.count > 0) {
      return; // Already migrated or has records
    }

    try {
      console.log(`[SQLite Migration] Migrating legacy devices from ${jsonPath}...`);
      const raw = fs.readFileSync(jsonPath, 'utf-8');
      const data: Record<string, any> = JSON.parse(raw);
      const now = Date.now();

      const insertTx = this.db.transaction(() => {
        for (const [id, dev] of Object.entries(data)) {
          // Never migrate thumbnail base64 data to SQLite!
          this.stmtUpsertDevice.run({
            id,
            serial: dev.serial || id,
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
    // Exclude thumbnail from persisted state
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

  /**
   * Synchronously flush all pending writes immediately (e.g. on exit or manual flush).
   */
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
