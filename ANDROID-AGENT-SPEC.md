# ANDROID-AGENT-SPEC.md — Device Agent design

**Audit date:** 2026-10-06
**Current companion APK:** `resources/clipper.apk` (5,583,534 bytes, signed `[34471701]`)
**Manifest:** `handyfarm-clipper/app/src/main/AndroidManifest.xml`
**Source:** `handyfarm-clipper/app/src/main/java/com/handyfarm/clipper/`

This document describes (a) the *current* companion APK honestly, (b) the
*target* Device Agent design that satisfies the brief's permission /
least-privilege / Android-version rules, and (c) the minimum-viable
Phase 5 implementation that ships in this PR.

---

## 1. Current APK — what is on disk today

### 1.1 Manifest permissions (verbatim)

```xml
<permission android:name="com.handyfarm.clipper.permission.ACCESS_CLIPBOARD"
            android:protectionLevel="signature" />
<uses-permission android:name="android.permission.PACKAGE_USAGE_STATS" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_MOCK_LOCATION" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_SPECIAL_USE" />
<uses-permission android:name="android.permission.QUERY_ALL_PACKAGES" />
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
<uses-permission android:name="android.permission.CHANGE_NETWORK_STATE" />
```

### 1.2 Honest assessment vs the brief

The brief is explicit:

> "The companion APK should not receive dangerous broad permissions
> merely to make the product appear more powerful."

Today's APK violates this in three ways:

1. **`ACCESS_FINE_LOCATION` + `ACCESS_MOCK_LOCATION`** — required for the
   Phase 2 network preflight's mock-location injection feature. Not
   needed for the Phase 4+ agent scope.
2. **`QUERY_ALL_PACKAGES`** — Play-Store-restricted permission that
   exposes the user's full app inventory. The brief asks for app
   inventory but limits it to the agent's host (the user's own apps).
3. **`FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_SPECIAL_USE`** +
   `INTERNET` + `CHANGE_NETWORK_STATE` + `ACCESS_NETWORK_STATE` —
   backing the `HandyFarmVpnService` (a WireGuard VPN client baked into
   the APK). The brief's product definition does not include VPN at
   all. A dedicated VPN does not belong in a control-panel companion.

A separate concern: **`ACCESS_CLIPBOARD`** is declared at
`protectionLevel="signature"` — only callers signed with the same key
can send a clipboard broadcast. This is good; verified in
`ClipperReceiver.java:49-67`. But the existing receiver still accepts
sends from `FLAG_RECEIVER_FROM_SHELL` (i.e., adb shell / `am broadcast`)
without further sender authentication — fine for development, risky in
production where any app holding the same signature can send. The brief
asks for signature-level verification; we have *partial* (sender flag
check), not *full*.

### 1.3 Exported surface (receiver actions)

```xml
<intent-filter>
  <action android:name="clipper.get" />
  <action android:name="clipper.set" />
  <action android:name="get" />
  <action android:name="set" />
  <action android:name="handyfarm.identity.get" />
  <action android:name="handyfarm.foreground.get" />
  <action android:name="handyfarm.crash" />
  <action android:name="handyfarm.location.set" />
  <action android:name="handyfarm.location.get" />
  <action android:name="handyfarm.reset.baseline" />
  <action android:name="handyfarm.vpn.connect" />
  <action android:name="handyfarm.vpn.disconnect" />
  <action android:name="handyfarm.vpn.status" />
  <action android:name="handyfarm.egress.get" />
</intent-filter>
```

The `handyfarm.vpn.*` actions go through the `HandyFarmVpnService`. The
agent redesign will **remove these**.

### 1.4 Sender authentication

`ClipperReceiver.isAuthorizedSender` (lines 49–67):

1. Checks `FLAG_RECEIVER_FROM_SHELL` (0x00400000) is set. Android sets
   it automatically only for shell/root sends.
2. If API 34+, reads `getSentFromUid()` and allows only
   `Process.SHELL_UID` (2000), `0` (root), or `Process.myUid()` (self).
3. If `sentUid == -1` (masked), falls back to the flag.

**Gap**: the receiver still accepts an empty `Intent` from any caller
with the same signing key as the companion. A signature-only check is
not enforced today; only the package-flag check. The brief asks for
signature-level verification — this is the next fix.

### 1.5 APK survival across reboot

Not tested in this audit. The current manifest does **not** register a
`BOOT_COMPLETED` receiver — the agent does not auto-start on device
boot. For a desktop control panel, the user launches HandyFarm on the
host which then talks to the agent via `adb`; survival across reboot is
not a hard requirement.

### 1.6 Verifies across 3 phones

Verified — the same signed APK installs and runs on the TECNO LH7n
(API 34), Galaxy S6 Edge (API 24), and Galaxy Note 5 (API 24). All
three report the same signing key `[34471701]` in `dumpsys package`.

### 1.7 Android 7 vs 14 behavior differences observed

| Behavior | API 24 (Samsung Galaxy S6 Edge / Note 5) | API 34 (TECNO LH7n) |
|---|---|---|
| Companion installs | ✓ | ✓ |
| Clipboard `clipper.set` | ✓ | ✓ |
| `getSentFromUid()` available | ✗ — fallback to flag | ✓ |
| `QUERY_ALL_PACKAGES` granted without prompt | ⚠️ | ⚠️ (Play policy blocks production) |
| File-based clipboard push via `adb push` to `/data/local/tmp/` | ✓ (with `adb shell chmod` workaround) | ✓ |
| Scoped storage (`MediaStore` only) | ✗ (legacy storage model) | ✓ |

### 1.8 Uninstall

`adb uninstall com.handyfarm.clipper` works on all 3. Verified.

---

## 2. Target Device Agent — design that satisfies the brief

### 2.1 Permission model (target)

For the Phase 5 minimum-viable implementation, the agent uses **zero
runtime permissions**. All agent capabilities run over `adb shell`
from the host, which the user accepted when they plugged the device in.
No companion APK install required for inventory / install / permissions
inspection.

For Phase 5+ enhancements where the companion helps, the target
permission set is:

```xml
<permission android:name="com.handyfarm.agent.permission.ACCESS_AGENT"
             android:protectionLevel="signature" />

<uses-permission android:name="android.permission.QUERY_ALL_PACKAGES"
                 tools:ignore="QueryAllPackagesPermission" />
<!-- Removed from target:
     ACCESS_FINE_LOCATION, ACCESS_MOCK_LOCATION,
     FOREGROUND_SERVICE, FOREGROUND_SERVICE_SPECIAL_USE,
     INTERNET, ACCESS_NETWORK_STATE, CHANGE_NETWORK_STATE,
     PACKAGE_USAGE_STATS
     HandyFarmVpnService
-->
```

`QUERY_ALL_PACKAGES` is Play-restricted; we add
`tools:ignore="QueryAllPackagesPermission"` for the open-source build
and remove it for any Play Store submission (or replace with the
photo-picker-based media access, see §2.6).

### 2.2 Exported actions (target)

The companion re-emits at this scope:

| Action | Purpose | Permission required | Notes |
|---|---|---|---|
| `handyfarm.identity.get` | Returns stable device id (Phase 1 fingerprint). | none | Already exists. |
| `handyfarm.foreground.get` | Returns foreground package name. | none (Android 7+) | Android 5+ via `getRunningTasks`. Android 10+ requires USAGE_STATS or foreground service. Honest — we tell the operator when this fails. |
| `handyfarm.clipboard.set.path` | L5 file-based clipboard push (already exists). | none | Path hard-pinned to `/data/local/tmp/`. |
| `handyfarm.clipboard.get` | Reads current clipboard (already exists). | none | |
| `handyfarm.agent.echo` | Health check (responds with version + last command). | none | **NEW for Phase 5.** |
| `handyfarm.agent.heartbeat` | Periodic record. | none | **NEW for Phase 5.** |
| `handyfarm.media.pick` | (Future) Open system photo picker. | READ_MEDIA_IMAGES (Android 13+) | **Defer.** |

Removed from target scope:
- `handyfarm.location.*` — not needed.
- `handyfarm.vpn.*` — out of scope per the brief.
- `handyfarm.egress.get` — out of scope (was for the network preflight,
  which itself is being de-prioritized).
- `handyfarm.crash` — moved to host-side `am crash` from main, no
  companion action needed.
- `handyfarm.reset.baseline` — moved to host-side `pm clear` /
  equivalent.

### 2.3 Command protocol

Every agent action has the same envelope:

```json
{
  "action": "handyfarm.identity.get",
  "requestId": "uuid-v4",
  "sessionId": "ci-runner-1",
  "timestampMs": 1762376000000
}
```

The companion replies with a JSON object:

```json
{
  "requestId": "uuid-v4",
  "ok": true,
  "result": { "physId": "phys_…", "fingerprint": "…" }
}
```

Or on failure:

```json
{ "requestId": "uuid-v4", "ok": false, "error": "INVALID_SENDER" }
```

Commands must be **idempotent** where possible (heartbeat, inventory,
permissions). Destructive operations (uninstall, clear-data) require
`confirm: true` in the envelope and a non-empty `actor` field.

### 2.4 Security model**: signature verification

`isAuthorizedSender` is upgraded to a strict check:

1. Sender UID must be `Process.SHELL_UID` (2000) OR `Process.myUid()`
   (self, which we never expect) OR (the host app's UID if running on
   the same device — out of scope for single-host use).
2. Caller's signing certificate hash (read via
   `PackageManager.getPackageInfo(pkg, GET_SIGNATURES)` for the sender
   package) must match a hardcoded SHA-256 of the host's signing
   certificate, configured at APK-build time.
3. Caller's `Intent.action` must be in the allowlist.
5. For TUNNELED broadcasts from adb, require `FLAG_RECEIVER_FROM_SHELL`.

### 2.5 Data-retention and redaction rules

- Inventory + heartbeat timestamps are kept 7 days in `scheduler_audit`.
- All agent responses are redacted in audit records: package name and
  app version are kept; `clipData.text` is replaced with `redacted: <N>
  bytes` unless the operator enables `--record-scrape`.
- Photos never leave the device unless the user explicitly taps "Share with
  the command result" in the device detail modal. Default: keep photos
  on device only.
- No contact or name harvesting. If the test scenario needs a name,
  prefer seeded test data over real contacts (per the brief).

### 2.6 Photo / media picker (deferred per scope)

Android 13+ supports the system photo picker — explicit user gesture,
no broad media permission needed. Android 12 and below use the
`READ_EXTERNAL_STORAGE` legacy model only when the test scenario
genuinely needs it. **Defer the photo picker feature to Phase 6+**
until a real test scenario requires it.

### 2.7 Agent UI surface

A new tab in `DeviceDetailModal` called **Agent**. Contents (per the
brief):

- Online / offline badge.
- Version + last heartbeat.
- Permission-health summary (one row per dangerous permission:
  granted / denied / restricted / unavailable-on-version).
- App inventory list with search / filter.
- Selected-app details (signature, versionCode, targetSdk, install
  date, last update).
- APK install / update action — file picker + confirmation.
- Optional contacts test action (defer per §2.6).
- Device-preparation actions (lock screen, keep-awake, animation
  scale).
- Command history (most-recent-first).
- Clear warnings for operations unavailable without root / newer Android.

All agent operations must require an active lease (already enforced by
the orchestrator for regression; reused for new agent flows). Read-only
inventory and health inspection are the only exceptions — those can run
without a lease.

---

## 3. Phase 5 minimum-viable implementation (this PR)

The brief's scope rule is "do not produce dozens of speculative features." I
am shipping the *smallest* slice that exercises the highest-value audit
items on all three devices:

1. **No new APK build.** The current `clipper.apk` is left as-is for
   now. A re-built minimal APK (without the VPN / location / QUERY_ALL
   permissions) is documented as future work. The host-side scaffolding
   ships in this PR.

2. **Host-side scaffolding** (new `electron/agent.ts` module):
   - `getAgentStatus(deviceId)` — runs `adb -s <serial> shell dumpsys
     package com.handyfarm.clipper | head -40`. Parses out version,
     lastUpdate, signature hash.
   - `getInstalledApps(deviceId)` — runs `adb -s <serial> shell pm list
     packages -f`. Returns package name + path.
   - `getGrantedPermissions(deviceId, packageName)` — runs `adb shell
     dumpsys package <pkg> | grep "granted="`. Returns the granted
     runtime permissions.
   - `installAppPackage(deviceId, filePath)` — wraps existing
     `install-apk` IPC. Confirms before writing the APK.
   - `triggerPhotoPickerTest(deviceId, imagePath)` — uses the existing
     companion's `handyfarm.clipboard.set.path` to push a test image
     path to the device. **No photo exfiltration** — the path stays on
     device; we just verify the broadcast was accepted.

3. **IPC + REST surface**:
   - `get-agent-status`, `get-installed-apps`, `get-granted-permissions`,
     `install-apk-from-host` (with confirmation), `photo-picker-test`.

4. **UI**: a new **Agent** tab in `DeviceDetailModal` with a minimal
   layout. Read-only by default; destructive actions behind a
   confirmation dialog.

5. **Tests**: covered in `tests/agent.test.ts`. Property-based on
   permission-state normalization; integration tests on real device
   data via the parsed `dumpsys` output.

6. **Three-device verification** (`tests/agent.live.test.ts`):
   - Inventory on each device — verify the same APK with the same
     signature is installed.
   - Granted permissions for `com.handyfarm.clipper` on each device.
   - Negative test: `getAgentStatus` for a non-existent package returns
     a clear error.

7. **Documentation**: update `PRODUCT-AUDIT.md` to mark Phase 5 done;
   add `ROADMAP-NEXT.md` for what comes next.

---

## 4. Honest disclosure

The current APK has a WireGuard VPN service, location permissions, and
`QUERY_ALL_PACKAGES`. The redesign documents the path to remove them
but **does not ship the new APK** in this PR. The Phase 5 minimum
implementation runs entirely over `adb shell` from the host, which
requires zero new APK permission and is the same risk profile as the
existing Phase 2 preflight. A real APK rebuild with the trimmed
permission set is tracked in `ROADMAP-NEXT.md` (item APK-1).

## 5. Files affected by Phase 5

- NEW: `electron/agent.ts` — host-side scaffolding
- NEW: `tests/agent.test.ts` — unit + property
- NEW: `tests/agent.live.test.ts` — three-device live verification
- MOD: `electron/main.ts` — wire Agent IPC handlers + new module-level
  state
- MOD: `electron/apiServer.ts` — REST endpoints
- MOD: `electron/preload.ts` — new IPC exposure
- MOD: `src/types.ts` — new electronAPI methods
- MOD: `src/components/DeviceDetailModal.tsx` — new Agent tab
- MOD: `handyfarm-clipper/app/src/main/AndroidManifest.xml` — *future*
  (Phase 6+), not this PR

The companion APK is **not** modified in this PR.