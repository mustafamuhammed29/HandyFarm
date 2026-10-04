import Database from 'better-sqlite3';
import { nativeImage } from 'electron';
import fs from 'fs';
import path from 'path';

export type LeaseState = 'available' | 'leased' | 'cooling_down' | 'quarantined' | 'maintenance';

export interface DeviceLeaseInfo {
  physicalDeviceId: string;
  state: LeaseState;
  leasedBy?: string;
  leaseExpiresAt?: number;
  lastHeartbeatAt?: number;
  updatedAt: number;
}

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
  leaseState?: LeaseState;
  leasedBy?: string;
  leaseExpiresAt?: number;
  lastHeartbeatAt?: number;
  baselineStatus?: 'verified' | 'drifted' | 'unbaselined';
  driftCount?: number;
  driftWarnings?: string[];
  lastVerifiedAt?: number;
  lastBaselineAt?: number;
  simId?: string;
  assignedSim?: SimRecord;
}

import type { PhysicalDeviceMapping, DeviceHardwareProps } from './identity.js';
import { generatePhysicalDeviceId } from './identity.js';
export type { PhysicalDeviceMapping, DeviceHardwareProps };
export { generatePhysicalDeviceId };

import type { BaselineManifest, BaselineVerificationResult } from './baseline.js';
export type { BaselineManifest, BaselineVerificationResult };

import type { SimRecord, ObservedEgress, DataBudgetStatus, FleetBudgetSummary } from './network.js';
import { calculateFleetDataBudget, evaluateDataBudget, sanitizeSimRecord } from './network.js';
export type { SimRecord, ObservedEgress, DataBudgetStatus, FleetBudgetSummary };
export { calculateFleetDataBudget, evaluateDataBudget, sanitizeSimRecord };

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
  private leases = new Map<string, DeviceLeaseInfo>();

  private stmtUpsertDevice!: Database.Statement;
  private stmtDeleteDevice!: Database.Statement;
  private stmtInsertHistory!: Database.Statement;
  private stmtGetHistory!: Database.Statement;
  private stmtPruneHistory!: Database.Statement;
  private stmtSelectAllDevices!: Database.Statement;
  private stmtReparentHistory!: Database.Statement;
  private stmtUpsertPhysicalMapping!: Database.Statement;
  private stmtGetAllPhysicalMappings!: Database.Statement;
  private stmtUpsertLease!: Database.Statement;
  private stmtGetLease!: Database.Statement;
  private stmtGetAllLeases!: Database.Statement;
  private stmtUpsertBaseline!: Database.Statement;
  private stmtGetBaseline!: Database.Statement;
  private stmtGetAllBaselines!: Database.Statement;
  private stmtDeleteBaseline!: Database.Statement;

  private sims = new Map<string, SimRecord>();
  private stmtUpsertSim!: Database.Statement;
  private stmtGetSim!: Database.Statement;
  private stmtGetSimByDevice!: Database.Statement;
  private stmtGetAllSims!: Database.Statement;
  private stmtDeleteSim!: Database.Statement;
  private stmtAssignSimToDevice!: Database.Statement;
  private stmtClearSimDeviceAssignment!: Database.Statement;
  private stmtClearDeviceSimId!: Database.Statement;
  private stmtUpdateDeviceSimId!: Database.Statement;
  private stmtUpdateSimUsage!: Database.Statement;
  private stmtInsertEgress!: Database.Statement;
  private stmtGetEgressHistory!: Database.Statement;
  private stmtGetLatestEgress!: Database.Statement;

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
        lease_state TEXT DEFAULT 'available',
        leased_by TEXT,
        lease_expires_at INTEGER,
        last_heartbeat_at INTEGER,
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

      CREATE TABLE IF NOT EXISTS leases (
        physical_device_id TEXT PRIMARY KEY,
        lease_state TEXT NOT NULL DEFAULT 'available',
        leased_by TEXT,
        lease_expires_at INTEGER,
        last_heartbeat_at INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_leases_state ON leases(lease_state);

      CREATE TABLE IF NOT EXISTS device_baselines (
        physical_device_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        captured_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_baselines_device_id ON device_baselines(device_id);

      CREATE TABLE IF NOT EXISTS sim_inventory (
        id TEXT PRIMARY KEY,
        slot INTEGER NOT NULL DEFAULT 1,
        iccid TEXT NOT NULL UNIQUE,
        carrier TEXT NOT NULL,
        apn TEXT NOT NULL,
        plan TEXT NOT NULL,
        data_cap_bytes INTEGER NOT NULL,
        data_used_bytes INTEGER NOT NULL DEFAULT 0,
        renewal_date TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unassigned',
        imsi_hashed TEXT NOT NULL,
        msisdn_redacted TEXT NOT NULL,
        assigned_device_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sim_assigned_device ON sim_inventory(assigned_device_id);
      CREATE INDEX IF NOT EXISTS idx_sim_iccid ON sim_inventory(iccid);
      CREATE INDEX IF NOT EXISTS idx_sim_status ON sim_inventory(status);

      CREATE TABLE IF NOT EXISTS egress_history (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        physical_device_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        public_ip TEXT NOT NULL,
        asn TEXT NOT NULL,
        carrier TEXT NOT NULL,
        geo_json TEXT NOT NULL,
        transport TEXT NOT NULL,
        observed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_egress_device_time ON egress_history(device_id, observed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_egress_phys_time ON egress_history(physical_device_id, observed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_egress_run_id ON egress_history(run_id);
    `);

    // Ensure physical_device_id column exists if table was created in an earlier migration
    const cols = this.db.pragma('table_info(devices)') as any[];
    if (!cols.some(c => c.name === 'physical_device_id')) {
      this.db.exec('ALTER TABLE devices ADD COLUMN physical_device_id TEXT;');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_devices_physical_id ON devices(physical_device_id);');
    }
    if (!cols.some(c => c.name === 'lease_state')) {
      this.db.exec("ALTER TABLE devices ADD COLUMN lease_state TEXT DEFAULT 'available';");
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_devices_lease_state ON devices(lease_state);');
    }
    if (!cols.some(c => c.name === 'leased_by')) {
      this.db.exec('ALTER TABLE devices ADD COLUMN leased_by TEXT;');
    }
    if (!cols.some(c => c.name === 'lease_expires_at')) {
      this.db.exec('ALTER TABLE devices ADD COLUMN lease_expires_at INTEGER;');
    }
    if (!cols.some(c => c.name === 'last_heartbeat_at')) {
      this.db.exec('ALTER TABLE devices ADD COLUMN last_heartbeat_at INTEGER;');
    }
    if (!cols.some(c => c.name === 'baseline_status')) {
      this.db.exec("ALTER TABLE devices ADD COLUMN baseline_status TEXT DEFAULT 'unbaselined';");
    }
    if (!cols.some(c => c.name === 'drift_count')) {
      this.db.exec('ALTER TABLE devices ADD COLUMN drift_count INTEGER DEFAULT 0;');
    }
    if (!cols.some(c => c.name === 'drift_warnings')) {
      this.db.exec('ALTER TABLE devices ADD COLUMN drift_warnings TEXT;');
    }
    if (!cols.some(c => c.name === 'last_verified_at')) {
      this.db.exec('ALTER TABLE devices ADD COLUMN last_verified_at INTEGER;');
    }
    if (!cols.some(c => c.name === 'last_baseline_at')) {
      this.db.exec('ALTER TABLE devices ADD COLUMN last_baseline_at INTEGER;');
    }
    if (!cols.some(c => c.name === 'sim_id')) {
      this.db.exec('ALTER TABLE devices ADD COLUMN sim_id TEXT;');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_devices_sim_id ON devices(sim_id);');
    }
    this.db.exec("UPDATE devices SET lease_state = 'available' WHERE lease_state IS NULL OR lease_state = '';");
    this.db.exec("UPDATE devices SET baseline_status = 'unbaselined' WHERE baseline_status IS NULL OR baseline_status = '';");
  }

  private prepareStatements() {
    this.stmtUpsertDevice = this.db.prepare(`
      INSERT INTO devices (
        id, physical_device_id, serial, status, model, manufacturer, name, custom_name, notes,
        is_bare_board, tags, connected_at, last_known_ip, battery_level, battery_charging,
        lease_state, leased_by, lease_expires_at, last_heartbeat_at,
        baseline_status, drift_count, drift_warnings, last_verified_at, last_baseline_at, sim_id,
        updated_at
      ) VALUES (
        @id, @physicalDeviceId, @serial, @status, @model, @manufacturer, @name, @customName, @notes,
        @isBareBoard, @tags, @connectedAt, @lastKnownIp, @batteryLevel, @batteryCharging,
        @leaseState, @leasedBy, @leaseExpiresAt, @lastHeartbeatAt,
        @baselineStatus, @driftCount, @driftWarnings, @lastVerifiedAt, @lastBaselineAt, @simId,
        @updatedAt
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
        lease_state = COALESCE(excluded.lease_state, devices.lease_state),
        leased_by = excluded.leased_by,
        lease_expires_at = excluded.lease_expires_at,
        last_heartbeat_at = excluded.last_heartbeat_at,
        baseline_status = COALESCE(excluded.baseline_status, devices.baseline_status),
        drift_count = COALESCE(excluded.drift_count, devices.drift_count),
        drift_warnings = COALESCE(excluded.drift_warnings, devices.drift_warnings),
        last_verified_at = COALESCE(excluded.last_verified_at, devices.last_verified_at),
        last_baseline_at = COALESCE(excluded.last_baseline_at, devices.last_baseline_at),
        sim_id = COALESCE(excluded.sim_id, devices.sim_id),
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
    this.stmtUpsertLease = this.db.prepare(`
      INSERT INTO leases (
        physical_device_id, lease_state, leased_by, lease_expires_at, last_heartbeat_at, updated_at
      ) VALUES (
        @physicalDeviceId, @leaseState, @leasedBy, @leaseExpiresAt, @lastHeartbeatAt, @updatedAt
      )
      ON CONFLICT(physical_device_id) DO UPDATE SET
        lease_state = excluded.lease_state,
        leased_by = excluded.leased_by,
        lease_expires_at = excluded.lease_expires_at,
        last_heartbeat_at = excluded.last_heartbeat_at,
        updated_at = excluded.updated_at
    `);
    this.stmtGetLease = this.db.prepare(`SELECT * FROM leases WHERE physical_device_id = ?`);
    this.stmtGetAllLeases = this.db.prepare(`SELECT * FROM leases`);

    this.stmtUpsertBaseline = this.db.prepare(`
      INSERT INTO device_baselines (
        physical_device_id, device_id, manifest_json, captured_at, updated_at
      ) VALUES (
        @physicalDeviceId, @deviceId, @manifestJson, @capturedAt, @updatedAt
      )
      ON CONFLICT(physical_device_id) DO UPDATE SET
        device_id = excluded.device_id,
        manifest_json = excluded.manifest_json,
        captured_at = excluded.captured_at,
        updated_at = excluded.updated_at
    `);
    this.stmtGetBaseline = this.db.prepare(`
      SELECT * FROM device_baselines WHERE physical_device_id = ? OR device_id = ?
    `);
    this.stmtGetAllBaselines = this.db.prepare(`SELECT * FROM device_baselines`);
    this.stmtDeleteBaseline = this.db.prepare(`DELETE FROM device_baselines WHERE physical_device_id = ?`);

    this.stmtUpsertSim = this.db.prepare(`
      INSERT INTO sim_inventory (
        id, slot, iccid, carrier, apn, plan, data_cap_bytes, data_used_bytes, renewal_date,
        status, imsi_hashed, msisdn_redacted, assigned_device_id, created_at, updated_at
      ) VALUES (
        @id, @slot, @iccid, @carrier, @apn, @plan, @dataCapBytes, @dataUsedBytes, @renewalDate,
        @status, @imsiHashed, @msisdnRedacted, @assignedDeviceId, @createdAt, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        slot = excluded.slot,
        iccid = excluded.iccid,
        carrier = excluded.carrier,
        apn = excluded.apn,
        plan = excluded.plan,
        data_cap_bytes = excluded.data_cap_bytes,
        data_used_bytes = excluded.data_used_bytes,
        renewal_date = excluded.renewal_date,
        status = excluded.status,
        imsi_hashed = excluded.imsi_hashed,
        msisdn_redacted = excluded.msisdn_redacted,
        assigned_device_id = excluded.assigned_device_id,
        updated_at = excluded.updated_at
    `);
    this.stmtGetSim = this.db.prepare(`SELECT * FROM sim_inventory WHERE id = ?`);
    this.stmtGetSimByDevice = this.db.prepare(`SELECT * FROM sim_inventory WHERE assigned_device_id = ?`);
    this.stmtGetAllSims = this.db.prepare(`SELECT * FROM sim_inventory ORDER BY id ASC`);
    this.stmtDeleteSim = this.db.prepare(`DELETE FROM sim_inventory WHERE id = ?`);
    this.stmtAssignSimToDevice = this.db.prepare(`UPDATE sim_inventory SET assigned_device_id = ?, status = 'active', updated_at = ? WHERE id = ?`);
    this.stmtClearSimDeviceAssignment = this.db.prepare(`UPDATE sim_inventory SET assigned_device_id = NULL, status = 'unassigned', updated_at = ? WHERE assigned_device_id = ?`);
    this.stmtClearDeviceSimId = this.db.prepare(`UPDATE devices SET sim_id = NULL WHERE id = ? OR physical_device_id = ?`);
    this.stmtUpdateDeviceSimId = this.db.prepare(`UPDATE devices SET sim_id = ? WHERE id = ?`);
    this.stmtUpdateSimUsage = this.db.prepare(`UPDATE sim_inventory SET data_used_bytes = data_used_bytes + ?, updated_at = ? WHERE id = ?`);

    this.stmtInsertEgress = this.db.prepare(`
      INSERT INTO egress_history (
        id, device_id, physical_device_id, run_id, public_ip, asn, carrier, geo_json, transport, observed_at
      ) VALUES (
        @id, @deviceId, @physicalDeviceId, @runId, @publicIp, @asn, @carrier, @geoJson, @transport, @observedAt
      )
    `);
    this.stmtGetEgressHistory = this.db.prepare(`
      SELECT * FROM egress_history WHERE device_id = ? OR physical_device_id = ? ORDER BY observed_at DESC LIMIT ?
    `);
    this.stmtGetLatestEgress = this.db.prepare(`
      SELECT * FROM egress_history WHERE device_id = ? OR physical_device_id = ? ORDER BY observed_at DESC LIMIT 1
    `);
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
            leaseState: 'available',
            leasedBy: null,
            leaseExpiresAt: null,
            lastHeartbeatAt: null,
            updatedAt: now
          });

          this.stmtUpsertLease.run({
            physicalDeviceId: physId,
            leaseState: 'available',
            leasedBy: null,
            leaseExpiresAt: null,
            lastHeartbeatAt: null,
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
    // 1. Load physical leases from SQLite
    this.leases.clear();
    try {
      const leaseRows = this.stmtGetAllLeases.all() as any[];
      for (const lr of leaseRows) {
        this.leases.set(lr.physical_device_id, {
          physicalDeviceId: lr.physical_device_id,
          state: (lr.lease_state as LeaseState) || 'available',
          leasedBy: lr.leased_by || undefined,
          leaseExpiresAt: lr.lease_expires_at || undefined,
          lastHeartbeatAt: lr.last_heartbeat_at || undefined,
          updatedAt: lr.updated_at
        });
      }
    } catch (err) {
      console.warn('[DeviceStore] Failed to load leases from SQLite:', err);
    }

    // 2. Load SIM inventory from SQLite
    this.sims.clear();
    try {
      const simRows = this.stmtGetAllSims.all() as any[];
      for (const sr of simRows) {
        this.sims.set(sr.id, {
          id: sr.id,
          slot: sr.slot,
          iccid: sr.iccid,
          carrier: sr.carrier,
          apn: sr.apn,
          plan: sr.plan,
          dataCapBytes: sr.data_cap_bytes,
          dataUsedBytes: sr.data_used_bytes,
          renewalDate: sr.renewal_date,
          status: sr.status,
          imsiHashed: sr.imsi_hashed,
          msisdnRedacted: sr.msisdn_redacted,
          assignedDeviceId: sr.assigned_device_id || null,
          createdAt: sr.created_at,
          updatedAt: sr.updated_at
        });
      }
    } catch (err) {
      console.warn('[DeviceStore] Failed to load SIM inventory from SQLite:', err);
    }

    // 3. Load devices from SQLite
    this.inMemoryDevices.clear();
    const rows = this.stmtSelectAllDevices.all() as any[];
    for (const r of rows) {
      let tags: string[] = [];
      try {
        if (r.tags) tags = JSON.parse(r.tags);
      } catch {}

      const history = (this.stmtGetHistory.all(r.id, 50) as { action: string; timestamp: string }[]) || [];
      const physId = r.physical_device_id || `phys_${r.serial || r.id}`;

      let lease = this.leases.get(physId);
      if (!lease) {
        lease = {
          physicalDeviceId: physId,
          state: (r.lease_state as LeaseState) || 'available',
          leasedBy: r.leased_by || undefined,
          leaseExpiresAt: r.lease_expires_at || undefined,
          lastHeartbeatAt: r.last_heartbeat_at || undefined,
          updatedAt: Date.now()
        };
        this.leases.set(physId, lease);
      }

      let driftWarnings: string[] = [];
      try {
        if (r.drift_warnings) driftWarnings = JSON.parse(r.drift_warnings);
      } catch {}

      const dev: DeviceData = {
        id: r.id,
        physicalDeviceId: physId,
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
        leaseState: lease.state,
        leasedBy: lease.leasedBy,
        leaseExpiresAt: lease.leaseExpiresAt,
        lastHeartbeatAt: lease.lastHeartbeatAt,
        baselineStatus: (r.baseline_status as any) || 'unbaselined',
        driftCount: r.drift_count || 0,
        driftWarnings,
        lastVerifiedAt: r.last_verified_at || undefined,
        lastBaselineAt: r.last_baseline_at || undefined,
        simId: r.sim_id || undefined,
        assignedSim: r.sim_id ? this.sims.get(r.sim_id) : undefined,
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

    const mergedLeaseState = (surviving.leaseState && surviving.leaseState !== 'available')
      ? surviving.leaseState
      : (losing.leaseState || surviving.leaseState || 'available');
    const mergedLeasedBy = (surviving.leaseState && surviving.leaseState !== 'available')
      ? surviving.leasedBy
      : (losing.leasedBy || surviving.leasedBy);
    const mergedLeaseExpiresAt = (surviving.leaseState && surviving.leaseState !== 'available')
      ? surviving.leaseExpiresAt
      : (losing.leaseExpiresAt || surviving.leaseExpiresAt);
    const mergedLastHeartbeatAt = (surviving.leaseState && surviving.leaseState !== 'available')
      ? surviving.lastHeartbeatAt
      : (losing.lastHeartbeatAt || surviving.lastHeartbeatAt);

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
      leaseState: mergedLeaseState,
      leasedBy: mergedLeasedBy,
      leaseExpiresAt: mergedLeaseExpiresAt,
      lastHeartbeatAt: mergedLastHeartbeatAt,
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

  findPhysicalMappingByTransport(transportId: string): PhysicalDeviceMapping | undefined {
    for (const mapping of this.physicalMappings.values()) {
      if (mapping.currentTransportId === transportId || mapping.lastSeenTransportId === transportId || mapping.serials.includes(transportId)) {
        return mapping;
      }
    }
    return undefined;
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
            leaseState: patch.leaseState ?? current.leaseState ?? 'available',
            leasedBy: patch.leasedBy !== undefined ? patch.leasedBy : (current.leasedBy ?? null),
            leaseExpiresAt: patch.leaseExpiresAt !== undefined ? patch.leaseExpiresAt : (current.leaseExpiresAt ?? null),
            lastHeartbeatAt: patch.lastHeartbeatAt !== undefined ? patch.lastHeartbeatAt : (current.lastHeartbeatAt ?? null),
            baselineStatus: patch.baselineStatus ?? current.baselineStatus ?? 'unbaselined',
            driftCount: patch.driftCount ?? current.driftCount ?? 0,
            driftWarnings: (patch.driftWarnings || current.driftWarnings) ? JSON.stringify(patch.driftWarnings || current.driftWarnings) : null,
            lastVerifiedAt: patch.lastVerifiedAt ?? current.lastVerifiedAt ?? null,
            lastBaselineAt: patch.lastBaselineAt ?? current.lastBaselineAt ?? null,
            simId: patch.simId !== undefined ? (patch.simId || null) : (current.simId ?? null),
            updatedAt: now
          });
        }
      });

      tx();
    } catch (err) {
      console.error('[SQLite] Failed to flush debounced writes:', err);
    }
  }

  // --- Device Lease State Machine ---

  getLease(physicalDeviceId: string): DeviceLeaseInfo {
    const existing = this.leases.get(physicalDeviceId);
    if (existing) return existing;
    try {
      const row = this.stmtGetLease.get(physicalDeviceId) as any;
      if (row) {
        const lease: DeviceLeaseInfo = {
          physicalDeviceId: row.physical_device_id,
          state: (row.lease_state as LeaseState) || 'available',
          leasedBy: row.leased_by || undefined,
          leaseExpiresAt: row.lease_expires_at || undefined,
          lastHeartbeatAt: row.last_heartbeat_at || undefined,
          updatedAt: row.updated_at
        };
        this.leases.set(physicalDeviceId, lease);
        return lease;
      }
    } catch {}
    return {
      physicalDeviceId,
      state: 'available',
      updatedAt: Date.now()
    };
  }

  saveLease(lease: DeviceLeaseInfo): string[] {
    this.leases.set(lease.physicalDeviceId, lease);
    try {
      this.stmtUpsertLease.run({
        physicalDeviceId: lease.physicalDeviceId,
        leaseState: lease.state,
        leasedBy: lease.leasedBy ?? null,
        leaseExpiresAt: lease.leaseExpiresAt ?? null,
        lastHeartbeatAt: lease.lastHeartbeatAt ?? null,
        updatedAt: lease.updatedAt
      });
    } catch (err) {
      console.warn(`[DeviceStore] Failed to persist lease for ${lease.physicalDeviceId}:`, err);
    }

    // Update in-memory devices matching this physicalDeviceId
    const affectedIds: string[] = [];
    for (const [id, dev] of this.inMemoryDevices.entries()) {
      if (dev.physicalDeviceId === lease.physicalDeviceId || (!dev.physicalDeviceId && (dev.serial === lease.physicalDeviceId || `phys_${dev.serial}` === lease.physicalDeviceId))) {
        dev.leaseState = lease.state;
        dev.leasedBy = lease.leasedBy;
        dev.leaseExpiresAt = lease.leaseExpiresAt;
        dev.lastHeartbeatAt = lease.lastHeartbeatAt;
        affectedIds.push(id);

        const pending = this.pendingWrites.get(id) || {};
        this.pendingWrites.set(id, {
          ...pending,
          leaseState: lease.state,
          leasedBy: lease.leasedBy,
          leaseExpiresAt: lease.leaseExpiresAt,
          lastHeartbeatAt: lease.lastHeartbeatAt
        });
      }
    }
    this.scheduleDebouncedFlush();
    return affectedIds;
  }

  acquireLease(physicalDeviceId: string, sessionId: string, ttlMinutes = 15): { success: boolean; error?: string; lease?: DeviceLeaseInfo; affectedDeviceIds: string[] } {
    if (!physicalDeviceId || !sessionId) {
      return { success: false, error: 'physicalDeviceId and sessionId are required', affectedDeviceIds: [] };
    }

    const current = this.getLease(physicalDeviceId);
    const now = Date.now();

    // Check current lease state
    if (current.state === 'leased') {
      // If lease is expired, allow taking it over
      if (current.leaseExpiresAt && current.leaseExpiresAt <= now) {
        // Expired lease, proceed with acquisition
      } else if (current.leasedBy && current.leasedBy !== sessionId) {
        return {
          success: false,
          error: `Device is currently leased by session '${current.leasedBy}' until ${new Date(current.leaseExpiresAt || now).toLocaleTimeString()}`,
          affectedDeviceIds: []
        };
      }
    } else if (current.state === 'cooling_down') {
      if (current.leaseExpiresAt && current.leaseExpiresAt > now) {
        const remainingSec = Math.ceil((current.leaseExpiresAt - now) / 1000);
        return {
          success: false,
          error: `Device is cooling down (${remainingSec}s remaining). Please wait.`,
          affectedDeviceIds: []
        };
      }
    } else if (current.state === 'quarantined') {
      return { success: false, error: 'Device is quarantined and unavailable for lease.', affectedDeviceIds: [] };
    } else if (current.state === 'maintenance') {
      return { success: false, error: 'Device is in maintenance mode and unavailable for lease.', affectedDeviceIds: [] };
    }

    const ttlMs = Math.max(0.1, ttlMinutes) * 60 * 1000;
    const newLease: DeviceLeaseInfo = {
      physicalDeviceId,
      state: 'leased',
      leasedBy: sessionId,
      leaseExpiresAt: Math.round(now + ttlMs),
      lastHeartbeatAt: now,
      updatedAt: now
    };

    const affected = this.saveLease(newLease);
    this.logPhysicalAction(physicalDeviceId, `Lease acquired by '${sessionId}' (TTL: ${ttlMinutes}m)`);
    return { success: true, lease: newLease, affectedDeviceIds: affected };
  }

  releaseLease(physicalDeviceId: string, sessionId: string, force = false): { success: boolean; error?: string; affectedDeviceIds: string[] } {
    if (!physicalDeviceId) {
      return { success: false, error: 'physicalDeviceId is required', affectedDeviceIds: [] };
    }

    const current = this.getLease(physicalDeviceId);
    if (current.state !== 'leased') {
      return { success: true, affectedDeviceIds: [] };
    }

    if (!force && sessionId && current.leasedBy && current.leasedBy !== sessionId) {
      return {
        success: false,
        error: `Cannot release lease held by session '${current.leasedBy}'`,
        affectedDeviceIds: []
      };
    }

    const now = Date.now();
    // Transition leased -> cooling_down for 5-second grace period
    const newLease: DeviceLeaseInfo = {
      physicalDeviceId,
      state: 'cooling_down',
      leasedBy: undefined,
      leaseExpiresAt: now + 5000,
      lastHeartbeatAt: undefined,
      updatedAt: now
    };

    const affected = this.saveLease(newLease);
    this.logPhysicalAction(physicalDeviceId, `Lease released by '${sessionId || 'system'}', cooling down for 5s`);
    return { success: true, affectedDeviceIds: affected };
  }

  heartbeatLease(physicalDeviceId: string, sessionId: string, extensionMinutes?: number): { success: boolean; error?: string; leaseExpiresAt?: number; affectedDeviceIds: string[] } {
    if (!physicalDeviceId || !sessionId) {
      return { success: false, error: 'physicalDeviceId and sessionId are required', affectedDeviceIds: [] };
    }

    const current = this.getLease(physicalDeviceId);
    const now = Date.now();

    if (current.state !== 'leased' || current.leasedBy !== sessionId) {
      return { success: false, error: 'No active lease held by this session', affectedDeviceIds: [] };
    }

    current.lastHeartbeatAt = now;
    if (extensionMinutes && extensionMinutes > 0) {
      current.leaseExpiresAt = Math.round(now + extensionMinutes * 60 * 1000);
    }
    current.updatedAt = now;

    const affected = this.saveLease(current);
    return { success: true, leaseExpiresAt: current.leaseExpiresAt, affectedDeviceIds: affected };
  }

  setDeviceLeaseState(physicalDeviceId: string, state: LeaseState, sessionId?: string): { success: boolean; error?: string; affectedDeviceIds: string[] } {
    if (!physicalDeviceId) {
      return { success: false, error: 'physicalDeviceId is required', affectedDeviceIds: [] };
    }

    const now = Date.now();
    const newLease: DeviceLeaseInfo = {
      physicalDeviceId,
      state,
      leasedBy: state === 'leased' ? sessionId : undefined,
      leaseExpiresAt: state === 'cooling_down' ? (now + 5000) : (state === 'leased' ? (now + 15 * 60 * 1000) : undefined),
      lastHeartbeatAt: state === 'leased' ? now : undefined,
      updatedAt: now
    };

    const affected = this.saveLease(newLease);
    this.logPhysicalAction(physicalDeviceId, `Lease state changed to '${state}'${sessionId ? ` (session: ${sessionId})` : ''}`);
    return { success: true, affectedDeviceIds: affected };
  }

  sweepExpiredLeases(): { changedLeases: DeviceLeaseInfo[]; affectedDeviceIds: string[] } {
    const now = Date.now();
    const changedLeases: DeviceLeaseInfo[] = [];
    const allAffectedIds = new Set<string>();

    for (const [physId, lease] of this.leases.entries()) {
      if (lease.state === 'leased' && lease.leaseExpiresAt && lease.leaseExpiresAt <= now) {
        console.log(`[Lease Sweep] Lease expired for physical device ${physId} (held by ${lease.leasedBy}). Auto-releasing to available.`);
        const updated: DeviceLeaseInfo = {
          physicalDeviceId: physId,
          state: 'available',
          leasedBy: undefined,
          leaseExpiresAt: undefined,
          lastHeartbeatAt: undefined,
          updatedAt: now
        };
        const affected = this.saveLease(updated);
        changedLeases.push(updated);
        for (const id of affected) allAffectedIds.add(id);
        this.logPhysicalAction(physId, `Lease expired without renewal; auto-returned to available`);
      } else if (lease.state === 'cooling_down' && lease.leaseExpiresAt && lease.leaseExpiresAt <= now) {
        console.log(`[Lease Sweep] Cooldown completed for physical device ${physId}. Transitioning to available.`);
        const updated: DeviceLeaseInfo = {
          physicalDeviceId: physId,
          state: 'available',
          leasedBy: undefined,
          leaseExpiresAt: undefined,
          lastHeartbeatAt: undefined,
          updatedAt: now
        };
        const affected = this.saveLease(updated);
        changedLeases.push(updated);
        for (const id of affected) allAffectedIds.add(id);
        this.logPhysicalAction(physId, `Cooldown period elapsed; returned to available`);
      }
    }

    return { changedLeases, affectedDeviceIds: Array.from(allAffectedIds) };
  }

  logPhysicalAction(physicalDeviceId: string, action: string) {
    for (const dev of this.inMemoryDevices.values()) {
      if (dev.physicalDeviceId === physicalDeviceId || dev.serial === physicalDeviceId) {
        this.logDeviceAction(dev.id, action);
      }
    }
  }

  // --- Phase 1: Baseline Manifest & Drift Tracking ---

  saveBaseline(manifest: BaselineManifest): void {
    const now = Date.now();
    this.stmtUpsertBaseline.run({
      physicalDeviceId: manifest.physicalDeviceId,
      deviceId: manifest.deviceId,
      manifestJson: JSON.stringify(manifest),
      capturedAt: manifest.capturedAt,
      updatedAt: now
    });

    const dev = this.inMemoryDevices.get(manifest.deviceId);
    if (dev) {
      dev.baselineStatus = 'verified';
      dev.driftCount = 0;
      dev.driftWarnings = [];
      dev.lastBaselineAt = manifest.capturedAt;
      dev.lastVerifiedAt = manifest.capturedAt;
      const pending = this.pendingWrites.get(manifest.deviceId) || {};
      this.pendingWrites.set(manifest.deviceId, { ...pending, ...dev });
      this.scheduleDebouncedFlush();
    }
  }

  getBaseline(physicalDeviceIdOrDeviceId: string): BaselineManifest | undefined {
    let physId = physicalDeviceIdOrDeviceId;
    const dev = this.inMemoryDevices.get(physicalDeviceIdOrDeviceId);
    if (dev?.physicalDeviceId) physId = dev.physicalDeviceId;

    try {
      const row = this.stmtGetBaseline.get(physId, physicalDeviceIdOrDeviceId) as any;
      if (row?.manifest_json) {
        return JSON.parse(row.manifest_json) as BaselineManifest;
      }
    } catch (e) {
      console.warn(`[DeviceStore] Failed to load baseline for ${physicalDeviceIdOrDeviceId}:`, e);
    }
    return undefined;
  }

  deleteBaseline(physicalDeviceId: string): boolean {
    const res = this.stmtDeleteBaseline.run(physicalDeviceId);
    return res.changes > 0;
  }

  getAllBaselines(): BaselineManifest[] {
    try {
      const rows = this.stmtGetAllBaselines.all() as any[];
      return rows.map(r => JSON.parse(r.manifest_json));
    } catch {
      return [];
    }
  }

  recordDriftVerification(deviceId: string, result: BaselineVerificationResult): void {
    const dev = this.inMemoryDevices.get(deviceId);
    if (dev) {
      dev.baselineStatus = result.verified ? 'verified' : 'drifted';
      dev.driftCount = result.diffs.length;
      dev.driftWarnings = result.diffs.map(d => d.description || `${d.field}: expected ${JSON.stringify(d.expected)}, got ${JSON.stringify(d.actual)}`);
      dev.lastVerifiedAt = result.verifiedAt;
      const pending = this.pendingWrites.get(deviceId) || {};
      this.pendingWrites.set(deviceId, { ...pending, ...dev });
      this.scheduleDebouncedFlush();
    }
  }

  // --- Phase 2: SIM Inventory & Egress Tracking ---

  saveSim(sim: Partial<SimRecord> & { iccid: string; carrier: string; apn: string; plan: string; dataCapBytes: number; renewalDate: string }): SimRecord {
    const clean = sanitizeSimRecord(sim);
    const now = Date.now();
    this.stmtUpsertSim.run({
      id: clean.id,
      slot: clean.slot,
      iccid: clean.iccid,
      carrier: clean.carrier,
      apn: clean.apn,
      plan: clean.plan,
      dataCapBytes: clean.dataCapBytes,
      dataUsedBytes: clean.dataUsedBytes,
      renewalDate: clean.renewalDate,
      status: clean.status,
      imsiHashed: clean.imsiHashed,
      msisdnRedacted: clean.msisdnRedacted,
      assignedDeviceId: clean.assignedDeviceId || null,
      createdAt: clean.createdAt,
      updatedAt: now
    });
    this.sims.set(clean.id, clean);

    if (clean.assignedDeviceId) {
      const dev = this.inMemoryDevices.get(clean.assignedDeviceId);
      if (dev) {
        dev.simId = clean.id;
        dev.assignedSim = clean;
        this.pendingWrites.set(clean.assignedDeviceId, { ...dev, simId: clean.id });
        this.scheduleDebouncedFlush();
      }
    }
    return clean;
  }

  getSim(simId: string): SimRecord | undefined {
    const cached = this.sims.get(simId);
    if (cached) return cached;
    try {
      const sr = this.stmtGetSim.get(simId) as any;
      if (sr) {
        const record: SimRecord = {
          id: sr.id,
          slot: sr.slot,
          iccid: sr.iccid,
          carrier: sr.carrier,
          apn: sr.apn,
          plan: sr.plan,
          dataCapBytes: sr.data_cap_bytes,
          dataUsedBytes: sr.data_used_bytes,
          renewalDate: sr.renewal_date,
          status: sr.status,
          imsiHashed: sr.imsi_hashed,
          msisdnRedacted: sr.msisdn_redacted,
          assignedDeviceId: sr.assigned_device_id || null,
          createdAt: sr.created_at,
          updatedAt: sr.updated_at
        };
        this.sims.set(record.id, record);
        return record;
      }
    } catch {}
    return undefined;
  }

  getSimForDevice(deviceIdOrPhysId: string): SimRecord | undefined {
    const dev = this.inMemoryDevices.get(deviceIdOrPhysId);
    if (dev?.simId) {
      return this.getSim(dev.simId);
    }
    for (const sim of this.sims.values()) {
      if (sim.assignedDeviceId === deviceIdOrPhysId || (dev?.physicalDeviceId && sim.assignedDeviceId === dev.physicalDeviceId)) {
        return sim;
      }
    }
    try {
      const sr = this.stmtGetSimByDevice.get(deviceIdOrPhysId) as any;
      if (sr) return this.getSim(sr.id);
    } catch {}
    return undefined;
  }

  getAllSims(): SimRecord[] {
    return Array.from(this.sims.values());
  }

  deleteSim(simId: string): boolean {
    const sim = this.sims.get(simId);
    if (sim?.assignedDeviceId) {
      const dev = this.inMemoryDevices.get(sim.assignedDeviceId);
      if (dev && dev.simId === simId) {
        dev.simId = undefined;
        dev.assignedSim = undefined;
        this.pendingWrites.set(sim.assignedDeviceId, { ...dev, simId: undefined });
        this.scheduleDebouncedFlush();
      }
    }
    this.sims.delete(simId);
    const res = this.stmtDeleteSim.run(simId);
    return res.changes > 0;
  }

  assignSim(simId: string, deviceId: string, slot?: number): SimRecord {
    const sim = this.sims.get(simId);
    if (!sim) {
      throw new Error(`SIM '${simId}' not found in inventory.`);
    }

    const now = Date.now();
    // Clear any previous SIM assignment on this device
    this.stmtClearSimDeviceAssignment.run(now, deviceId);
    for (const s of this.sims.values()) {
      if (s.assignedDeviceId === deviceId) {
        s.assignedDeviceId = null;
        s.status = 'unassigned';
        s.updatedAt = now;
      }
    }

    sim.assignedDeviceId = deviceId;
    sim.status = 'active';
    if (slot !== undefined) sim.slot = slot;
    sim.updatedAt = now;

    this.stmtAssignSimToDevice.run(deviceId, now, simId);
    this.stmtUpdateDeviceSimId.run(simId, deviceId);

    const dev = this.inMemoryDevices.get(deviceId);
    if (dev) {
      dev.simId = simId;
      dev.assignedSim = sim;
      this.pendingWrites.set(deviceId, { ...dev, simId });
      this.scheduleDebouncedFlush();
    }

    return sim;
  }

  unassignSim(deviceId: string): void {
    const now = Date.now();
    this.stmtClearSimDeviceAssignment.run(now, deviceId);
    this.stmtClearDeviceSimId.run(deviceId, deviceId);

    for (const s of this.sims.values()) {
      if (s.assignedDeviceId === deviceId) {
        s.assignedDeviceId = null;
        s.status = 'unassigned';
        s.updatedAt = now;
      }
    }

    const dev = this.inMemoryDevices.get(deviceId);
    if (dev) {
      dev.simId = undefined;
      dev.assignedSim = undefined;
      this.pendingWrites.set(deviceId, { ...dev, simId: undefined });
      this.scheduleDebouncedFlush();
    }
  }

  recordSimDataConsumption(simId: string, bytesUsed: number): SimRecord {
    const sim = this.sims.get(simId);
    if (!sim) {
      throw new Error(`SIM '${simId}' not found in inventory.`);
    }

    const now = Date.now();
    sim.dataUsedBytes += bytesUsed;
    sim.updatedAt = now;
    if (sim.dataUsedBytes >= sim.dataCapBytes) {
      sim.status = 'depleted';
    }

    this.stmtUpdateSimUsage.run(bytesUsed, now, simId);
    return sim;
  }

  getFleetDataBudget(): FleetBudgetSummary {
    return calculateFleetDataBudget(Array.from(this.sims.values()));
  }

  recordObservedEgress(egress: ObservedEgress): void {
    this.stmtInsertEgress.run({
      id: egress.id,
      deviceId: egress.deviceId,
      physicalDeviceId: egress.physicalDeviceId,
      runId: egress.runId,
      publicIp: egress.publicIp,
      asn: egress.asn,
      carrier: egress.carrier,
      geoJson: JSON.stringify(egress.geo || {}),
      transport: egress.transport,
      observedAt: egress.observedAt
    });
  }

  getEgressHistory(deviceId: string, limit = 50): ObservedEgress[] {
    let physId = deviceId;
    const dev = this.inMemoryDevices.get(deviceId);
    if (dev?.physicalDeviceId) physId = dev.physicalDeviceId;

    try {
      const rows = this.stmtGetEgressHistory.all(deviceId, physId, limit) as any[];
      return rows.map(r => ({
        id: r.id,
        deviceId: r.device_id,
        physicalDeviceId: r.physical_device_id,
        runId: r.run_id,
        publicIp: r.public_ip,
        asn: r.asn,
        carrier: r.carrier,
        geo: JSON.parse(r.geo_json || '{}'),
        transport: r.transport,
        observedAt: r.observed_at
      }));
    } catch (err) {
      console.warn(`[DeviceStore] Failed to load egress history for ${deviceId}:`, err);
      return [];
    }
  }

  getLatestEgress(deviceId: string): ObservedEgress | undefined {
    let physId = deviceId;
    const dev = this.inMemoryDevices.get(deviceId);
    if (dev?.physicalDeviceId) physId = dev.physicalDeviceId;

    try {
      const row = this.stmtGetLatestEgress.get(deviceId, physId) as any;
      if (!row) return undefined;
      return {
        id: row.id,
        deviceId: row.device_id,
        physicalDeviceId: row.physical_device_id,
        runId: row.run_id,
        publicIp: row.public_ip,
        asn: row.asn,
        carrier: row.carrier,
        geo: JSON.parse(row.geo_json || '{}'),
        transport: row.transport,
        observedAt: row.observed_at
      };
    } catch {
      return undefined;
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
