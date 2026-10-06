# ROADMAP-NEXT.md — prioritized next-phase work

**Date:** 2026-10-06
**Source audit:** `PRODUCT-AUDIT.md`, `COMPETITIVE-REVIEW.md`, `ANDROID-AGENT-SPEC.md`

This document lists everything still to do. Items are ordered by:
**Blocker first** (audit's `Severity: blocker|high` findings that prevent
the product from being trustworthy), then high-value features that the
audit identifies as missing, then useful-later / explicitly-deferred.

Every item carries an acceptance criterion so we know when it's done.
No item is speculative: every one corresponds to either an audit
finding or a brief requirement.

---

## A. Blockers (audit §4, severity = high)

These prevent HandyFarm from being honest about its own state.

### BLK-1. Tracker handler accumulation on worker restarts
- **File:** `electron/main.ts`, `tracker.on('change'|'add'|'remove', …)` calls inside `restartWorker`.
- **Issue:** Each `restartWorker` re-registers tracker event handlers.
  After N restarts there are N handlers for the same device.
- **Acceptance:** After 10 simulated worker restarts on one device, only
  one `'change'` log entry fires per tracker event.
- **Test:** integration test that opens a Tracker, calls `restartWorker`
  10x, emits a tracker event, asserts the listener fires exactly once.

### BLK-2. `crashLogcatTail` child is orphaned on app quit
- **File:** `electron/main.ts`.
- **Issue:** Long-running `adb logcat -b crash -b events` child is not
  killed on `before-quit` or `will-quit`. Survives the app.
- **Acceptance:** After `app.quit()`, `ps` shows no `adb logcat` children
  left over.
- **Test:** spawn the tail, call stop(), assert child.killed.

### BLK-3. Duplicate-device identity (WiFi + USB same serial)
- **File:** `electron/main.ts` tracker + `electron/identity.ts` /
  `electron/db.ts` physicalMappings.
- **Issue:** USB and WiFi transports for the same physical device both
  produce the same `phys_*` id. The tracker sees them as separate workers
  but they collide on the lease / health counters.
- **Acceptance:** When both transports are present for the same physical
  device, `getAllPhysicalDeviceHealth()` returns one row, not two.
- **Test:** synthetic tracker event with two transports for the same
  serial → assert one row in the DB.

### BLK-4. `execFile` timeouts don't cancel the underlying child
- **File:** every `await execFileAsync('adb', [...], { timeout: … })`
  call. Audit found ~15 sites.
- **Issue:** `promisify(execFile)` rejects on timeout but the child
  process is not killed. Hung adb holds a child forever.
- **Acceptance:** Wrap adb calls in a helper that, on timeout, calls
  `child.kill('SIGKILL')` on the underlying process. Replace all 15
  sites.
- **Test:** unit test for the helper using a synthetic slow child.

### BLK-5. Heartbeat extends a lease the caller doesn't own
- **File:** `electron/db.ts` `heartbeatLease`.
- **Issue:** Any session can heartbeat any lease by `physId` alone. No
  check that the caller is the current lease holder.
- **Acceptance:** Heartbeat from a non-owner returns `{ success: false }`.
- **Test:** integration test on `DeviceStore`.

### BLK-6. Golden baselines are in-memory only
- **File:** `electron/main.ts` `goldenBaselines: Map<…>`.
- **Issue:** Closing the app loses every golden. There is no persisted
  screenshot baseline.
- **Acceptance:** Restart the app, the previously-set baseline is
  queryable via `diff-against-baseline` IPC.
- **Test:** integration test on `DeviceStore` + a new `golden_baselines`
  table.

### BLK-7. IPC handlers have no sender verification
- **File:** `electron/main.ts` every `ipcMain.handle(...)`.
- **Issue:** Any compromised renderer invokes IPCs without check.
- **Acceptance:** A sender-validation middleware rejects calls whose
  IPC sender is not the trusted renderer webContents. Add tests for the
  middleware.

### BLK-8. `setGoldenBaseline` accepts unbounded base64
- **File:** `electron/main.ts`.
- **Issue:** No size cap. 200MB string → 150MB Buffer → OOM.
- **Acceptance:** Reject base64 strings > 5MB with `{ ok: false,
  error: 'image too large' }`. Add test.

### BLK-9. Companion receiver trusts sender package without signature check
- **File:** `handyfarm-clipper/.../ClipperReceiver.java`.
- **Issue:** A sibling app with the same signing key could spoof the
  host. Signature-level check is missing.
- **Acceptance:** Companion rejects a send from a sibling app signed
  with a *different* certificate. Re-architectures the test to use a
  second key.

### BLK-10. `adb kill-server` doesn't auto-reconnect the tracker
- **File:** `electron/main.ts`.
- **Issue:** Once adb restarts, `client.trackDevices()` is dead.
- **Acceptance:** After `adb kill-server` + adb restart + new device
  online, the tracker emits an `'add'` event for the new device.
- **Test:** integration.

---

## B. Companion APK rebuild (Agent target permission set)

Documented in `ANDROID-AGENT-SPEC.md` §2.1.

### APK-1. Trim the companion manifest
- **File:** `handyfarm-clipper/app/src/main/AndroidManifest.xml`
- **Action:** Remove `ACCESS_FINE_LOCATION`, `ACCESS_MOCK_LOCATION`,
  `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`, `INTERNET`,
  `ACCESS_NETWORK_STATE`, `CHANGE_NETWORK_STATE`. Keep
  `ACCESS_CLIPBOARD` (signature-protected) only.
- **Remove** `services/HandyFarmVpnService.java`.
- **Acceptance:** The trimmed APK builds, installs on all 3 devices, and
  the existing `handyfarm.identity.get`, `clipper.get`, `clipper.set`
  actions still work.

### APK-2. Signature-level sender verification in the receiver
- **File:** `handyfarm-clipper/.../ClipperReceiver.java`.
- **Action:** Read caller's signing certificate (via `PackageManager`),
  compare SHA-256 against a hardcoded host key configured at build time.
- **Acceptance:** Send from an app signed with a different key → reject.
- **Test:** instrumentation test (or a mock-package test in CI).

### APK-3. Agent `echo` + `heartbeat` actions
- **Action:** Add `handyfarm.agent.echo` (returns version + last command)
  and `handyfarm.agent.heartbeat` (records timestamp + caller ID). Pure
  identity-only; no permissions required.
- **Acceptance:** Heartbeat from the host persists in the audit log.

---

## C. UI high-value work

### UI-1. Persist filter query across reload
- **File:** `src/components/FleetFilterBar.tsx`.
- **Action:** Save `filterQuery` to `localStorage`. Restore on mount.
- **Acceptance:** F5 keeps the filter.
- **Test:** component test.

### UI-2. Lease holder name shown when expired-but-not-released
- **File:** `src/components/DeviceRow.tsx`.
- **Issue:** A lease whose TTL expired but whose release hasn't been
  processed still says `Leased: ci (0s)`. Should say `Lease expired` or
  show the cooling-down state.
- **Acceptance:** When `leaseExpiresAt < now`, the row shows "lease
  expired".

### UI-3. Multi-device regression results view
- **File:** `src/components/DeviceDetailModal.tsx` Regression tab.
- **Action:** Show the cross-device clustering for the most recent run.

### UI-4. Crash cluster detail
- **File:** `src/components/DeviceDetailModal.tsx` Audit tab.
- **Action:** Show the recent crash records for this device (one row
  per record, expandable to full message).

---

## D. Persistence / state polish

### D-1. Persist golden baselines to SQLite
- **File:** `electron/db.ts` new `golden_baselines` table; new IPC;
  write-through to the table.
- **Acceptance:** (Same as BLK-6.)

### D-2. Delete legacy `devices.json` after migration
- **File:** `electron/db.ts` `migrateFromJsonIfEmpty`.
- **Action:** After successful migration, `fs.unlinkSync(legacyPath)` and
  log it.
- **Acceptance:** After a fresh migration, the legacy file is gone.

### D-3. Prune `sim_inventory` + `egress_history` + `leases` on retention
- **File:** `electron/db.ts`.
- **Action:** Add `pruneOldSims`, `pruneOldEgress`, `pruneOldLeases` (free
  leases only) called every 24h.

---

## E. Process lifecycle

### E-1. Drain `regressionScheduler` on `before-quit`
- **File:** `electron/main.ts`.
- **Action:** Call `regressionScheduler.stop()` on `before-quit` so
  in-flight runs are cancelled.
- **Acceptance:** No `Scheduler` child processes left after `app.quit()`.

### E-2. Drain `crashLogcatTail` on `before-quit`
- **File:** `electron/main.ts`.
- **Action:** Same as E-1, but for the long-running logcat child.

### E-3. Per-port USB current (where exposed by hub)
- **File:** `electron/power.ts`.
- **Action:** If the hub exposes per-port current draw, surface it in
  the device row. If not, document that we use reconnect-churn as a
  proxy.

---

## F. Three-device live verification (always-on)

### F-1. Three-device regression in CI
- **Action:** Wire the live regression smoke (`tests/agent.live.test.ts`
  + a new `tests/regression.smoke.test.ts`) into a CI matrix run with
  `HANDYFARM_LIVE_TESTS=1`. The matrix must have ≥ 3 physical devices
  available.

### F-2. Connection-loss recovery test
- **Action:** Add a test that simulates `adb kill-server` between two
  queries and asserts the tracker reconnects automatically.

---

## G. Explicitly deferred (per `COMPETITIVE-REVIEW.md` §5)

These are intentionally NOT in the immediate roadmap:

- **Multi-host / provider-hub split** — single-host is the explicit
  product boundary.
- **Team / role auth** — single-user tool.
- **Cloud-fleet catalog / marketplace** — out of scope per `CONTEXT.md`.
- **Per-device launch profiles** (scrcpy-gui pattern) — needs per-device
  config store (DB schema work); flagged in `UI-AUDIT.md`.
- **AGPL-licensed dependencies** (GADS) — incompatible with HandyFarm's
  permissive stance.
- **Contact harvesting, photo exfiltration, broad storage access** —
  explicitly disallowed by the brief.

---

## H. Acceptance criteria for the whole roadmap

The product is "honest production-ready for the scoped user" when:

1. All BLK-* items are fixed and unit/integration-tested.
2. APK-1 + APK-2 ship and the trimmed APK installs on all 3 devices.
3. Three devices run simultaneously and remain stable across restart +
   disconnect + reconnect (F-1 + F-2 green).
4. UI-1, UI-2, UI-3, UI-4 are merged and unit-tested.
5. D-1, D-2, D-3 are merged.
7. E-1, E-2, E-3 are merged and `before-quit` exits cleanly under
   `ps` inspection.
8. tsc -b clean, vitest run ≥ 95% pass on the offline suite, live
   suite green with the matrix in place.

When all 8 are met, the audit's `Fragile` items should be `Tested` or
`Verified`. Anything still `Fragile` is a roadmap item, not a feature.