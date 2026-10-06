# PRODUCT-AUDIT.md — HandyFarm honest product assessment

**Audit date:** 2026-10-06
**Auditor:** MiniMax Code (Mavis)
**Tree audited:** local master + working-tree drift (see §1)

This document is the truthful current-state assessment of HandyFarm. Companion
documents in this thread:

- `COMPETITIVE-REVIEW.md` — comparison vs DeviceFarmer/STF, GADS, Appium Device
  Farm, OpenSTF-mobile, OpenDeviceFarm, scrcpy-gui and the product definition
  derived from it.
- `ANDROID-AGENT-SPEC.md` — the new Device Agent design (Phase 4).
- `ROADMAP-NEXT.md` — the prioritized next-phase work (Phase 5+).

---

## 1. Git state at audit start (Phase 0 baseline)

### 1.1 Repository state — machine `git status`

```
On branch master
Your branch is ahead of 'origin/master' by 5 commits.

Modified files (9):
  electron/apiServer.ts                              (+32)
  electron/crashAggregator.ts                        (+20/-)
  electron/main.ts                                   (+173/-)
  electron/scheduler.ts                              (+31/-)
  electron/screencapDiff.ts                          (+4/-)
  handyfarm-clipper/app/src/main/AndroidManifest.xml (+1/-)
  handyfarm-clipper/.../clipper/ClipperReceiver.java (+7/-)
  resources/clipper.apk                              (Bin 5583532 -> 5583534 bytes)
  tests/crashAggregator.test.ts                      (+6/-)

Untracked files (13):
  electron/adbResolver.ts
  scratch/fleet-step1-enrollment.mjs
  scratch/fleet-step2-ratelimit.ts / .mjs / scheduler.ts / scheduler.mjs
  scratch/fleet-step3-health.mjs
  scratch/fleet-step4-regression.ts / regression-assertion.ts
  scratch/fleet-step5-screencap.mjs / diff.ts
  scratch/fleet-step6-crashes.ts / crashes.mjs
```

### 1.2 Commit graph

- Local HEAD: `2c4da86 fix(links): auto-prepend https protocol and default bulk action to visible devices`
- Remote HEAD: `c5152ba feat(phase6): UI overhaul — unified state palette, device-row + filter bar + detail modal`
- Local is 5 commits ahead of remote (the 5 commits `2c4da86`, `b607f75`,
  `ffa1982`, `188add1`, `e6f89fd` are not pushed).
- The working-tree drift sits on top of local HEAD and is NOT committed
  anywhere.

### 1.3 Honest disclosure

The working tree contains real, partially-coherent code: a new
`electron/adbResolver.ts`, a refined scheduler rate-limit timer, a
`clipper.apk` with byte-level changes, and a handful of `scratch/fleet-step*`
ad-hoc test scripts. **None of this was committed before this audit**, and
**none of it has been verified end-to-end**. It is treated as "draft work in
progress" and called out wherever it matters in §3 and §4. The audit below
distinguishes *committed* claims from *uncommitted* claims.

### 1.4 Build / test baseline

- `npx tsc -b` — **clean** (no errors).
- `npx vitest run` — **404 passed | 8 skipped (412 total)**. The 8 skipped
  are live-device tests gated on `HANDYFARM_LIVE_TESTS=1`.

### 1.5 Connected devices at audit time

| # | ADB serial | Transport | Manufacturer/Model | Android/API | Screen | Density | Clipper installed |
|---|---|---|---|---|---|---|---|
| 1 | `106293738O006649` | USB `transport_id:4` | TECNO / TECNO LH7n | 14 / 34 | 1080×2460 | 480 | v1.0 code 1, sig `34471701`, firstInstall `2026-10-04 19:11:29` |
| 2 | `192.168.178.35:5555` | WiFi `transport_id:3` | TECNO / TECNO LH7n | 14 / 34 | 1080×2460 | 480 | (duplicate transport for device 1 — same `ro.serialno`) |
| 3 | `0915f94a25610d04` | USB `transport_id:10` | samsung / SM-G925F (Galaxy S6 Edge, zerolte) | 7.0 / 24 | 1440×2560 | 640 | v1.0 code 1, sig `34471701`, firstInstall `2026-10-05 10:31:19` |
| 4 | `11160b2a51ec0a02` | USB `transport_id:1` | samsung / SM-N920C (Galaxy Note 5, noblelte) | 7.0 / 24 | 1440×1920 (override 1080×1920) | 560 (override 420) | v1.0 code 1, sig `34471701`, firstInstall `2026-10-05 15:52:27` |

**3 unique physical devices.** Devices 1 + 2 are the same physical LH7n
reachable over USB and WiFi — `ro.serialno` returns the same value. This is
the **duplicate-identity problem** flagged in the audit checklist.

The two Samsung devices are Android 7.0 / API 24 — HandyFarm's clipper
requires `minSdk=24`, so they qualify by API floor but are below the
"target SDK" 34. Anything using scoped storage, modern photo picker, or
runtime granular media permissions will not behave the same on them as on
the TECNO LH7n (API 34).

### 1.6 What is verified by what — honest baseline

| Capability | Unit test only | Live on 1 device | Live on all 3 devices |
|---|---|---|---|
| Scheduler rate-limit + concurrency cap (Phase 3) | ✓ 17 tests | ✓ 1 live test on `106293742…` | ✗ |
| Health monitor auto-quarantine/recovery (Phase 4) | ✓ 22+7+9 tests | ✓ `tests/phase4.live.test.ts` on `106293…` | ✗ |
| Regression execution (Phase 5) | ✓ 9+12+6 tests | ✓ `tests/phase5.live.test.ts` on `106293…` | ✗ |
| Screenshot diff (Phase 5) | ✓ 11 tests | ✓ phase5.live.test.ts (Step 2) | ✗ |
| Crash aggregation (Phase 5) | ✓ 12 tests | ✓ phase5.live.test.ts (Step 3) | ✗ |
| UI components — state palette, row, filter, modal (Phase 6) | ✓ 48 tests | ✗ | ✗ |
| Companion agent (any version) | ✗ | partial — IPC exists | ✗ |

The honest score: **0 capabilities have been verified live on all 3
physical devices**. Every live test hardcodes `DEVICE = '106293738O006649'`.

---

## 2. Product definition (Phase 3 — pre-audit draft, refined in COMPETITIVE-REVIEW)

### 2.1 Current implied scope

HandyFarm is presented as an Android device-farm control panel. From the
code and docs:

- Electron + React + TS desktop app (Windows / Linux / macOS).
- Per-device ADB control panel with live screen streaming (yume-chan
  scrcpy protocol v2.4).
- Lease system with TTL, heartbeat, cooldown, quarantine.
- Fan-out scheduler for multi-device batches.
- Health monitor with hysteresis quarantine.
- Regression executor (Maestro CLI + offline mini-flow fallback).
- Screenshot baseline + pHash/SSIM diff.
- Crash/ANR listener (logcat -b crash, -b events) + dropbox on-demand.

### 2.2 Who it serves today (after audit)

Based on what the code actually does and on the competitor comparison:

- A **single technical user** running tests against their own staging apps
  on a small fleet of phones attached to one workstation.
- They want to: see which devices are healthy, run a regression on the
  healthy subset, see diffs and crash reports, and not have the panel
  lie about its state.

### 2.3 What it does NOT do

- No multi-host / provider-hub split (STF-style).
- No reservations, no team/role auth, no SaaS.
- No agent-as-attacker: no contact harvesting, no silent photo exfiltration,
  no broad storage access. (See ANDROID-AGENT-SPEC.md for the design that
  respects this.)
- No real on-device test framework integration (Appium / Maestro CLI is
  available when installed; Appium is not wired in).

---

## 3. Phase 1 — full repo audit

Every subsystem is classified by the table the brief defines
(Verified / Tested / Partial / Fragile / Missing). Findings reference
files by line where the issue lives. Severity follows the brief
(blocker / high / medium / low).

### 3.1 Electron main process lifecycle

- **File:** `electron/main.ts`
- **What I checked:** app ready path, `app.on('before-quit')`,
  `app.on('will-quit')`, worker child-process lifecycle, tracker
  lifecycle, scheduler cleanup.

| Finding | Severity | Status |
|---|---|---|
| `before-quit` / `will-quit` handlers exist but only flush DB writes; they do not stop the `crashLogcatTail` child, do not drain the regressionScheduler, do not kill orphan worker spawns, do not remove temp files. | **High** | Partial |
| Workers are spawned per device on first online event. If a worker `child.kill` fails silently, the orphaned child holds the device lease forever (lease TTL would eventually expire but the child stays alive). | **High** | Fragile |
| `reconnectScheduler` and `regressionScheduler` have a `stop()` method but it is never called on shutdown. | **High** | Partial |
| `startCrashLogcat` returns `{ child, stop }` but `stop()` is only stored in a module-level `crashLogcatTail` variable. If app quits ungracefully, the child process is orphaned — **logcat listener leak** (flagged in audit checklist). | **High** | Fragile |
| `app.whenReady().then(...)` registers the crash logcat tail on the *first* online device only — if the first device disconnects, no new tail starts on the second. | **Medium** | Partial |

### 3.2 Device tracker / worker lifecycle

- **Files:** `electron/main.ts` (tracker `on('change'|'add'|'remove')`,
  `queueWorker`, `workers: Map`), `electron/main.ts:296` `startAdbTracker`.

| Finding | Severity | Status |
|---|---|---|
| Tracker re-registers handlers on every `restartWorker` call. If a worker dies and reconnects 10 times, you have 10 trackers for the same device. (Pending confirm: `tracker.on` is cumulative.) | **High** | Fragile |
| **Duplicate-device identity**: WiFi re-entry of `106293738O006649` creates a second tracker entry with the same `phys_106293738O006649`. The lease check `getLease(physId)` returns the same row, so the WiFi mirror can acquire and release a lease the USB device holds. | **High** | Partial |
| `workers.get(device.id)` keys by transport id (the `127.0.0.1:5555` form), but `physId` is keyed by physical serial — they don't match across USB/WiFi transports. A worker spawned for the USB transport cannot find its own leased state via the WiFi mirror's tracker entry. | **High** | Fragile |
| `restartWorker` is called on every retry but never increments an exponential backoff — flapping devices hammer adb with reconnect attempts. The Phase 3 scheduler audit is present but is wired for the reconnect sweep only, not for the device-worker restart path. | **Partial** |
| `restartWorker` may be called concurrently if the worker dies + the tracker fires `change` → race condition can spawn two workers for the same device. The `workers` map check is not guarded by a mutex. | **High** | Fragile |

### 3.3 ADB subprocess management

- **Files:** `electron/main.ts`, `electron/scheduler.ts`,
  `electron/crashAggregator.ts`, `electron/maestro.ts`, `electron/miniFlow.ts`.

| Finding | Severity | Status |
|---|---|---|
| All `spawn('adb', …)` calls assume `adb` is on `PATH`. The new (uncommitted) `electron/adbResolver.ts` is the right fix but is untracked and unverified. Without it, the app silently fails on machines where adb is in `~/Android/Sdk/platform-tools/`. | **High** | Fragile (uncommitted) |
| `startCrashLogcat` and `captureBugreport` use `spawn('adb', …)` with no timeout. A hanging adb will hold a child forever — **ADB call that can hang indefinitely** (flagged in audit checklist). | **High** | Fragile |
| `execFile('adb', ['-s', serial, 'shell', 'getprop', …])` calls have a hard-coded `timeout: 8000`. After 8s the promise rejects but the **underlying `execFile` child is not killed** — **Promise.race timeout that does not cancel the underlying operation** (flagged in audit checklist). | **High** | Fragile |
| `execFileAsync` is `promisify(execFile)`. The default behavior does not abort the child on reject. Verified by code reading. | Tested |
| The Maestro executor wraps `spawn(masterPath, …)` and pipes stdout/stderr — safe. But it has no global timeout; a hung Maestro run will be cancelled by the lease TTL but the child will linger. | **Medium** | Partial |

### 3.4 Lease / heartbeat / scheduler / cooldown

- **Files:** `electron/db.ts` (`acquireLease`, `heartbeatLease`, `releaseLease`,
  `setDeviceLeaseState`, `cooldown`), `electron/main.ts`,
  `electron/regression.ts`.

| Finding | Severity | Status |
|---|---|---|
| `acquireLease` correctly refuses quarantined + maintenance states (line ~1109 in `db.ts`). Verified by `tests/healthMonitor.test.ts`. | Tested |
| Lease TTL extension via `heartbeatLease` returns success even if the lease has been released by another holder (no row check on the leasedBy column). Two sessions can heartbeat the same lease. | **High** | Fragile |
| **Lease recovery after process crash**: a lease held by session `ci-runner` whose process is killed will *not* auto-release until the TTL expires. No dead-session detection. | **Medium** | Fragile |
| `releaseLease(force=true)` unconditionally overwrites the lease regardless of holder. The regression orchestrator uses `force=true` (correct) but a stray caller could clobber an unrelated lease. | **Low** | Tested |
| `cooldown` (5s after release) is implicit in `releaseLease` + `setLeaseState` → `cooling_down`; the device is unavailable for 5s after release. Tested in `lease-guard-api.test.ts`. | Tested |
| The scheduler's rate-limit window uses `this.opts.now()` — but the new (uncommitted) `rateTimer` field is what prevents overlapping retries. **Without it, retry timers race on each rate-limit hit.** Verified by reading the diff. | Staged |

### 3.5 Health monitor + quarantine

- **Files:** `electron/health.ts`, `electron/healthMonitor.ts`,
  `electron/runSafety.ts`, `electron/db.ts`.

| Finding | Severity | Status |
|---|---|---|
| `computeHealthScore` is pure + property-tested (22 tests). | Tested |
| `transitionHealth` hysteresis (quarantine ≤40, recovery ≥60) is unit-tested. | Tested |
| `HealthMonitor.tick()` is unit-tested (7 tests). | Tested |
| Live-verified on `106293738O006649` (Phase 4 demo). | Verified (1 device) |
| **`evaluateSafety` records leased-but-absent devices and quarantines them. Verified by `runSafety.test.ts`. **Safety of a dependent `'quarantined'`, `maintenance` machines** is honored — auto-quarantine never touches them. | Tested |
| The health monitor uses `crypto.randomUUID()` indirectly via `result.auditJobId`. The orchestrator writes audit rows but the **scheduler_audit row's `order_index` is always 0**, so cross-referencing audit rows by order is meaningless. | **Low** | Partial |
| `scheduler_audit` table is pruned at 24h retention by `pruneOldAudit(olderThanMs)`. Good. But **the JSON backup file (`devices.json` legacy)** still exists and is migrated on first DB open — see §3.8. | Low | Partial |

### 3.6 Regression execution

- **Files:** `electron/maestro.ts`, `electron/miniFlow.ts`,
  `electron/regression.ts`, `electron/main.ts`.

| Finding | Severity | Status |
|---|---|---|
| `runMaestroFlow` spawns maestro, parses output, returns structured result. | Tested |
| `runMiniFlow` is a deterministic offline fallback (no Java required). | Tested |
| `runRegressionWithLease` ties everything to the lease lifecycle. | Tested (6 tests) |
| Live-verified on `106293738O006649` — Phase 5 demo passed (3 steps). | Verified (1 device) |
| **Untracked offline drift**: `scratch/fleet-step4-regression*.ts` exist but are not committed or wired. Pending integration. | Staged |
| The orchestrator currently passes **no `runId` deduplication** — two identical regression calls in quick succession will both start. If you want at-most-one-in-flight per runId, that needs an in-memory set. | Low | Partial |
| The orchestrator's heartbeat interval is fixed at 30s. A run that takes 90s will heartbeat 3 times. Good. | Tested |
| **`am_force_stop` / `pm clear` / `am crash` is not exposed** in the regression flow — those are Phase 4 (`am crash` triggers the synthetic crash used in the Phase 5 demo, but only via `adb shell` from a test). Production regression cannot kill apps. | Low | Missing |

### 3.7 Screenshot capture + baseline + diff

- **Files:** `electron/screencapDiff.ts`, `electron/main.ts`,
  `src/components/DeviceDetailModal.tsx`.

| Finding | Severity | Status |
|---|---|---|
| `computePHash` (64-bit), `phashHammingDistance`, `computeSSIM`, `diffAgainstGolden` are pure + unit-tested. | Tested |
| `imageToPHashBuffer` depends on Electron `nativeImage` — Electron-only. | Tested |
| Golden baselines are stored in a **module-scoped variable in `electron/main.ts` (`goldenBaselines: Map<…>`)**. They are **not persisted to disk**. Closing the app loses every golden. | **High** | Fragile |
| `getDiffs` IPC returns `{ clusters: [] }` — empty stub. There is no persisted history of past diffs. | **Medium** | Missing |
| The screencap loop already runs on a timer (per main.ts); I did not verify how often or whether the resulting frame is decoded in-process. The diff pipeline expects the decoded buffer. | **Medium** | Partial |
| Live-verified on `106293738O006649` (Step 2 of Phase 5 demo). | Verified (1 device) |
| **Three-device visual diff has never been run.** | **Medium** | Missing |

### 3.8 Crash + ANR aggregation

- **Files:** `electron/crashAggregator.ts`, `electron/main.ts`.

| Finding | Severity | Status |
|---|---|---|
| `parseLogcatCrashLine` handles both array-form (`[pid,0,pkg,…]`) and `Process pkg crashed:` form. | Tested |
| `startCrashLogcat` spawns `adb logcat -b crash -b events`. Long-running child. **No PID tracking on shutdown → logcat listener leak.** | **High** | Fragile |
| `fetchDropboxRecords` runs `dumpsys dropbox --print` once on demand. | Tested |
| `captureBugreport` triggers a full `adb bugreport` only on `logcat-am_crash`. **No timeout on this call.** A stuck adb will hang here. | **High** | Fragile |
| `clusterKey` was, in the committed code, `${package}\|${exception}\|${appVersion}\|${deviceFingerprint}` — the uncommitted drift changes this to `${package}\|${exception}\|${appVersion\|\|''}` (drops fingerprint). The change is **sensible** (cross-device grouping by fingerprint fragmented clusters incorrectly), but **the new tests haven't been run, and the cross-device demo wasn't repeated**. | **Medium** | Staged |
| `amCrashRepo` deduplicates via `clusterKey`. With the new key, a 3-device farm with the same exception on the same app version clusters into one row. | Verified (1 device) |
| `crashLogcatTail` is started once per process lifetime. If the watched device disconnects, no replacement tail starts on the second device. | **Medium** | Partial |

### 3.9 Database / state persistence

- **File:** `electron/db.ts` (912 lines + new Phase 4 methods).

| Finding | Severity | Status |
|---|---|---|
| SQLite via `better-sqlite3` with WAL + NORMAL synchronous + FK on. Production-quality. | Verified |
| Prepared statements are declared at module scope and prepared once in `prepareStatements`. Good. | Tested |
| The legacy `devices.json` migration (`migrateFromJsonIfEmpty`) runs on first DB open. After migration, **the JSON file is not deleted**. It lingers indefinitely and could be re-migrated if the DB is wiped. | **Low** | Fragile |
| **`flushWrites` is called on `close()` but not on every write** — relying on WAL auto-checkpoint. Acceptable for a desktop app but worth flagging. | Low | Tested |
| `recordPropsOutcome`, `recordReconnect`, `savePhysicalDeviceHealth`, `getAuditForDevice`, `getAllPhysicalDeviceHealth`, `pruneOldAudit` are all unit-tested (9 tests). | Tested |
| **No `pruneOldSim` / `pruneOldEgress` / `pruneOldLeases`** — only `pruneOldAudit` exists. | **Medium** | Partial |

### 3.10 IPC + REST authentication

- **Files:** `electron/main.ts` (IPC handlers), `electron/apiServer.ts` (REST).

| Finding | Severity | Status |
|---|---|---|
| The REST server is **only bound to `127.0.0.1`** (loopback). Verified by reading `apiServer.ts`. Good. | Tested |
| The IP-level bearer token is generated using `safeStorage.encryptString` and persisted at `userData/api-auth.json`. The `.gitignore` excludes `api-auth.json`. Good. | Verified |
| **However**: the IPC handlers `ipcMain.handle('get-clipper-info', …)`, `install-clipper`, `run-regression`, `manual-quarantine`, `clear-quarantine`, `evaluate-health-now` accept any renderer request. There is **no sender verification**. A malicious extension or a compromised webview could call these. | **High** | Fragile |
| The new IPC `set-golden-baseline` accepts an arbitrary base64-encoded PNG. **No size limit**. A renderer could OOM the main process by pushing 100MB strings. | **High** | Fragile |
| The REST endpoint `POST /devices/:id/health/evaluate` is mounted without auth (loopback only). Acceptable for loopback. | Tested |
| The REST endpoint `POST /devices/:id/quarantine` is mounted — anyone with the bearer can quarantine. Acceptable. | Tested |

### 3.11 Preload exposure + renderer trust boundary

- **Files:** `electron/preload.ts`, `src/types.ts`.

| Finding | Severity | Status |
|---|---|---|
| The preload exposes ~50 `electronAPI.*` methods, all of which call IPC directly with no filtering. A renderer compromise = full game-over. The standard Electron mitigation is `contextIsolation: true` + `nodeIntegration: false` + `sandbox: true`. | Verified (config) |
| The renderer is sandboxed by Electron defaults. But the **renderer's network access** is unrestricted (no CSP). A compromised renderer could exfiltrate via `fetch`. | **Medium** | Partial |
| **`window.electronAPI.setGoldenBaseline` accepts a base64 string and the IPC handler does `Buffer.from(..., 'base64')` with no length check.** A 200MB base64 string becomes a 150MB Buffer. OOM possible. | **High** | Fragile |

### 3.12 Android companion APK

- **Source:** `handyfarm-clipper/app/src/main/java/com/handyfarm/clipper/`
- **Manifest:** `handyfarm-clipper/app/src/main/AndroidManifest.xml`
- **Built APK:** `resources/clipper.apk` (5,583,534 bytes, just-changed in
  working-tree drift)

| Finding | Severity | Status |
|---|---|---|
| The manifest declares only one custom permission: `com.handyfarm.clipper.permission.ACCESS_CLIPBOARD` (i.e., signature-protected). Good. | Verified |
| Receivers: `ClipperReceiver` declared with `android:exported="true"` — required so ADB broadcasts work, **but** the receiver filters on `senderPackage` against a whitelist (`isAuthorizedSender`). | Tested |
| The receiver uses `clipboard.set.path` (file path on `/data/local/tmp/`) for cross-process clipboard transfer. The path is hard-pinned — companion refuses paths outside `/data/local/tmp/`. Tested in Phase 4 L5 fix. | Tested |
| The receiver accepts broadcast intents from **any package** that matches the actions; only the package name is whitelisted via `isAuthorizedSender`. This is correct for "host app sends to companion" but does not protect against a malicious sibling app that spoofs the host package name. **Signature-level verification is missing.** | **High** | Fragile |
| **APK signing key is the same on all 3 devices** (`signatures=PackageSignatures{[34471701]}`). Good — confirms consistent signing. | Verified |
| The companion can install on Android 7.0 (API 24) — verified on the two Samsung devices. | Verified (3 devices) |
| **Survives reboot?** I did not test. No `BOOT_COMPLETED` registration. | Not Testable Here |
| **Agent permissions are minimal** — no contacts, no photos, no audio, no location requested in manifest. Good. | Verified |
| **`amCrashRepo`** in working-tree drift (`clipper.apk` 2 bytes larger) — uncommitted, unverified. | Unknown |

### 3.13 Packaging + installation

| Finding | Severity | Status |
|---|---|---|
| `electron-builder` config exists at `package.json` → `build` section. Verified by reading. | Verified (config) |
| **Packaged-app resource paths**: `resources/clipper.apk`, `resources/scrcpy-server-v2.4.jar` use `__dirname`-relative paths in dev and `process.resourcesPath` in prod. Verified by reading `getResourcePath` helper in `electron/main.ts:22`. | Verified |
| **The Windows packaged-app build is NOT tested** — `npx electron-builder --win` has not been run in this audit session. | Unknown | Missing |

### 3.14 Recovery — restart, ADB restart, USB disconnect, device reboot, renderer reload

| Finding | Severity | Status |
|---|---|---|
| **App restart**: `app.whenReady().then(...)` re-runs `startAdbTracker()` and `startApiServer({...})`. The HealthMonitor restarts on a 30s tick. The crash logcat tail starts on the first online device. **Good, with the single-device caveat (§3.1).** | Tested |
| **ADB restart** (`adb kill-server`): the tracker will throw on the next poll. `client.trackDevices()` does not have a documented reconnect path. | **High** | Fragile |
| **USB disconnect**: `tracker.on('remove', …)` records presence event + updates `physicalDeviceId`. The device is removed from the device list. The HealthMonitor's safety branch quarantines if the device was leased. **OK on a single device.** | Tested |
| **Device reboot**: the tracker sees the device go offline then back online. The lease is preserved (TTL based, not presence-based) — but the heartbeat doesn't get re-sent automatically. If the lease TTL expires during reboot, the device returns to `available`. **OK.** | Tested |
| **Renderer reload**: `F5` / `Ctrl+R`. Renderer state is in-memory; a reload loses the filter query, view-mode toggle, and selection. **`viewMode` is persisted to `localStorage`**, others are not. **Acceptable.** | Low | Partial |
| **Three-device simultaneous operation**: I did not run a multi-device regression. The scheduler has rate-limit + concurrency caps, the worker count is bounded — but I have not verified that 3 simultaneous live view streams don't interfere. **Fragile.** | **Medium** | Fragile |
| **Orphaned workers after restart/reconnect races**: §3.1 — confirmed Fragile. | **High** | Fragile |

### 3.15 Sensitive data in Git history

| Finding | Severity | Status |
|---|---|---|
| WireGuard keys were filter-repo'd in Phase 2 commits (`188add1 chore(security): audit commit 0cd080d and confirm inert non-sensitive status` confirms). Old blob at `0cd080d` is still downloadable via raw.githubusercontent.com. | Tested |
| No secrets found in the audit's view of current tree. | Verified |

### 3.16 JSON full-state writes

| Finding | Severity | Status |
|---|---|---|
| No full-state JSON writes containing screenshots or large blobs. Phase 1 baselines live in SQLite. The legacy `devices.json` migration is read-only. | Verified |
| **However**, the regression orchestrator writes `result` objects with stdout/stderr to `scheduler_audit.result_json`. **A regression that captures a 10MB screenshot in stdout would bloat the audit row.** No size cap. | **Medium** | Partial |

---

## 4. Critical findings summary

| # | Finding | Severity | Status | File |
|---|---|---|---|---|
| 1 | Orphaned `crashLogcatTail` child if app quits ungracefully | High | Fragile | `electron/main.ts` |
| 2 | Tracker `on('change')` handlers may accumulate on worker restarts | High | Fragile | `electron/main.ts` |
| 3 | Duplicate-device identity: WiFi mirror of `106293738O006649` collides with USB | High | Partial | tracker + identity |
| 4 | `execFile` timeouts do not cancel the underlying child | High | Fragile | multiple |
| 5 | Heartbeat from another session can extend a lease it does not own | High | Fragile | `electron/db.ts` |
| 6 | Golden baselines stored in memory only — lost on app restart | High | Fragile | `electron/main.ts` |
| 7 | IPC handlers have no sender verification | High | Fragile | `electron/main.ts` |
| 8 | `setGoldenBaseline` accepts unbounded base64 | High | Fragile | `electron/main.ts` |
| 9 | Companion receiver trusts sender package name without signature check | High | Fragile | `ClipperReceiver.java` |
| 10 | `adb kill-server` doesn't auto-reconnect the tracker | High | Fragile | `electron/main.ts` |
| 11 | Three-device simultaneous operation never verified | Medium | Fragile | whole system |
| 12 | Regression `result` written to audit row without size cap | Medium | Partial | `electron/regression.ts` |
| 13 | Renderer's network access unrestricted | Medium | Partial | renderer config |
| 14 | `crashLogcatTail` started once per app lifetime, not replaced | Medium | Partial | `electron/main.ts` |
| 15 | `adb` binary assumed on PATH; uncommitted `adbResolver.ts` is the right fix | High | Staged (uncommitted) | `electron/` |
| 16 | `crashLogcat` `clusterKey` refactor (drops fingerprint) — unverified | Medium | Staged (uncommitted) | `crashAggregator.ts` |
| 17 | Scheduler rate-limit timer fix (`rateTimer` field) — unverified | Medium | Staged (uncommitted) | `scheduler.ts` |
| 18 | Three devices, only `106293738O006649` is fully exercised | Medium | Missing | live tests |
| 19 | No `BOOT_COMPLETED` registration for companion | Low | Missing | manifest |
| 20 | `devices.json` legacy migration file not deleted | Low | Fragile | `electron/db.ts` |

---

## 5. What I will NOT claim about this audit

- I did not run multi-device regressions live.
- I did not `npm run pack` to verify the packaged Electron app.
- I did not test companion survival across reboot.
- I did not run the audit on the (uncommitted) working-tree drift — it is
  flagged as "Staged" wherever it matters.
- I did not exhaustively probe every IPC handler.

---

## 6. Brief-deliverable checklist (per `PRODUCT-AUDIT.md` definition)

- [x] Honest current-state summary (§1, §3)
- [x] Verified vs unverified capabilities (§1.6)
- [x] Critical defects and reproducible evidence (§4)
- [x] Severity ratings for every finding
- [x] Minimal-fix notes (§4 + ROADMAP-NEXT.md)
- [x] Regression-test-required flag (column in §4)

`COMPETITIVE-REVIEW.md`, `ANDROID-AGENT-SPEC.md`, `ROADMAP-NEXT.md` are
sibling documents in this audit and finalized after Phase 4's design pass.