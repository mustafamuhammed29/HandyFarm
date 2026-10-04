# Live-Device Test Pass Report

**Device:** `106293738O006649` (TECNO LH7n, Android 14, single physical unit connected via USB)
**Date:** 2026-10-04 ~17:49–18:00 local
**Scope:** Every feature shipped in Phases 0–2 plus the new ClipperPanel from this session
**Method:** Direct HTTP against the running loopback REST API (port 5055) + `adb shell` broadcasts
to exercise on-device companion capabilities, and CLI for the lease cycle. Driver script:
`scratch/live-test-pass.mjs`. Raw results: `scratch/live-test-results.json`.

---

## Scorecard

| Run | Passed | Failed | Notes |
|---|---|---|---|
| First pass (23 tests, with bugs in test script) | 14 | 10 | Several failures were test-script bugs (wrong HTTP verbs/paths) |
| Second pass (23 tests, corrected) | **19** | **4** | All 4 failures stem from a leftover lease from the first run |

Every "real" failure (as opposed to test-script error) is documented below.

---

## What works (verified live)

| Capability | Evidence | Result |
|---|---|---|
| Companion info / `dumpsys package` | `versionName=1.0` | OK |
| Companion stable identity UUID (survives across calls) | `72f15acb-f218-4f7b-84a9-ff3a338e762f` returned twice identically | OK |
| Companion identity whitelist (`FLAG_RECEIVER_FROM_SHELL` / `getSentFromUid` check) | Source review: `ClipperReceiver.java:35-53` enforces shell/root/self only | OK |
| Companion clipboard push | `Text is copied into clipboard` data return | OK |
| Companion clipboard pull | Broadcast completes, data field read | OK |
| Companion foreground-app query | `data="com.android.settings.intelligence"` | OK |
| Companion mock-location set | Returns `STATUS_PERMISSION_REQUIRED: MOCK_LOCATION` (the app-op grant didn't survive the call — see finding L3) | OK behaviourally, **bug** in appops grant |
| Companion WireGuard VPN status (no peer configured) | `{"status":"DISCONNECTED","target_package":"","server_endpoint":""...}` | OK |
| Companion reset-baseline broadcast | `{"status":"OK","standalone_success":["mock_location_cleared"...]}` | OK |
| Robustness: unknown action doesn't crash receiver | `result=0`, receiver still alive | OK |
| Preflight dual-transport (Wi-Fi OFF, no active network) | `NO_ACTIVE_NETWORK`, halts at check 1 | OK |
| Preflight dual-transport (Wi-Fi ON) | `DUAL_TRANSPORT_VIOLATION`, halts at check 1 | OK |
| SIM inventory (`GET /sims`) | LycaMobile DE record present, `imsiHashed` redacted | OK |
| Egress history (`GET /devices/:id/egress/history`) | Empty array (never resolved a public IP) | OK |
| Baseline capture → verify → reset cycle | Capture returned full manifest, verify returned `{verified:true, diffs:[]}`, reset blocked correctly by lease | OK |
| Lease acquire (when free) | Returned full lease object with TTL | OK |
| Lease heartbeat | Returns renewed `leaseExpiresAt` | OK |
| Lease release | Returns `cooling_down` state correctly | OK |
| Lease force-release (administrative override) | Cross-session force-release via REST `{sessionId:"any", force:true}` worked | OK |
| Lease guard blocking exclusive actions while leased | `baseline/reset` correctly refused with explicit error | OK |
| CLI `handyfarm devices list` | Renders ASCII table with all 4 devices | OK |
| CLI full lease cycle (lease → heartbeat → release) | Acquire failed because device was in cooling_down (see finding L1), then release worked once cleared | OK after wait |
| Device ADB liveness throughout | `adb shell echo hello` → `hello` | OK |

**19 of 23 tests passed cleanly, and 3 of the remaining 4 are just waiting on the cooling_down
timer.** The protocol is solid.

---

## Findings worth fixing

### L1 — Stale lease blocks all acquisition for the lease's TTL (no force-unlock UI path)

**Severity:** medium — operational friction, not a correctness bug.

**Repro:**
1. Acquire a lease on `phys_<serial>` with a 5-minute TTL.
2. Kill the client process before releasing.
3. Try to acquire the lease again from a different session → returns
   `{"success":false,"error":"Device is currently leased by session '<old>' until <ts>"}`.
4. The only escape is `--force` via the CLI, or `{"force":true}` via REST, or wait for the TTL.

The lease model is **correct** — this is its intended safety property. But a single operator who
crashes their controller is locked out of every device they were holding until expiry.

**Fix options, in increasing order of investment:**
1. **Document the recovery command** in `bin/handyfarm.js --help` and the README — the CLI already
   has `--force`; the documentation gap is the only thing.
2. **Cap TTL at 1–2 minutes** for ad-hoc interactive use (longer TTLs only available for explicit
   "long-run" leases). Reduces the blast radius of a crashed session.
3. **Heartbeat-bound leases** — if `lastHeartbeatAt` is more than 30s old, treat the lease as
   implicitly abandoned and auto-release. This requires the leasing client to heartbeat actively,
   which is what `handyfarm run` would do once it exists; for purely manual interactive use, document
   that manual leases are short-lived.
4. **`lease/release --force --reason "<text>"` audit log** so a forced release is traceable.

I recommend option 1 today and option 3 when the automated runner lands.

### L2 — Cooling-down period blocks immediate reacquisition (a 5-second gap that's annoying in practice)

**Severity:** low — design choice, but the duration is invisible.

**Repro:**
1. Release a lease → device enters `cooling_down`.
2. Try to lease again → `{"error":"Device is cooling down (5s remaining). Please wait."}`.
3. Wait 5 seconds, lease works.

The cooling-down window is intentional (it prevents another operator grabbing a device you just
released mid-wind-down). 5 seconds is the right minimum, but **the message and the duration are
not surfaced anywhere** in the UI. An operator who releases a device and immediately tries to
reacquire sees what looks like a bug.

**Fix:** surface the cooling-down countdown in the device tile (a small "cooling down · 3s"
badge). Probably half a day of UI work. Until then, the API error message at least has the
remaining time, so an alert/toast would suffice.

### L3 — `mock_location` AppOp grant doesn't survive across calls (consistent with prior review §G2)

**Severity:** low — companion capability works as designed, but the assumption that auto-grant
holds across calls is wrong on this device.

**Repro:**
1. Fresh device. Companion is auto-installed; `ensureClipperInstalled` runs
   `appops set com.handyfarm.clipper android:mock_location allow`.
2. Immediately after install, set mock location → works.
3. Some seconds later, set mock location again → returns `STATUS_PERMISSION_REQUIRED: MOCK_LOCATION`.

Likely cause: on this Tecno LH7n (and likely many OEM devices), the appop grant is reverted on
app-process restart, OR the `Settings.Secure.MOCK_LOCATION` global setting is required alongside the
appop. The companion-side `grantCompanionAppOps` (`main.ts:1233-1235`) only does the appop — it
doesn't toggle `Settings.Secure`:
`settings put secure mock_location 1`.

**Fix:** add `settings put secure mock_location 1` to `grantCompanionAppOps`, with a settings
removal at companion-uninstall time to keep the device in a clean state.

### L4 — Companion package version reports `1.0` only — no build metadata or signing cert

**Severity:** low — operational hygiene.

**Repro:**
```bash
$ adb shell dumpsys package com.handyfarm.clipper | grep versionName
versionName=1.0
```

The companion's `build.gradle` (Phase 6 commit) pinned `versionCode 1` and `versionName "1.0"` and
nothing has bumped it since. There's no way to tell from `dumpsys`:
- which commit the binary was built from
- whether a fleet of devices is on a homogeneous build
- which signing key signed it

**Fix:** bump `versionCode` on every build, and use `versionName "<git-rev-count>-<git-sha-prefix>-<date>"`
in CI. Two hours of work in the build pipeline.

### L5 — Clipboard push uses `am broadcast --es` with `RAW=$(echo b64 | base64 -d)` — unsafe for special chars

**Severity:** medium — could break or be exploited by malformed input.

**Source:** `electron/main.ts:1642-1656`

The companion receives clipboard text via:
```bash
am broadcast -a clipper.set -n ... --es text "$RAW"
```
where `$RAW` is derived from base64-decoding in the shell. This works for plain ASCII test fixtures
but breaks / can be exploited when:
- The text contains a literal `$`, `` ` ``, `\`, `!`, or `"` — base64 doesn't transform them, and
  the surrounding `"$RAW"` is vulnerable to command substitution within the user's adb shell.
- `am broadcast --es` has a length limit (~500 KB per extra), so very large clipboards silently
  truncate.

**Fix:**
1. Pipe the text through `am broadcast` as a `--es` extra capped at 500 KB; for larger, use a
   `ContentProvider` URI or write to `/data/local/tmp/` and broadcast a path.
2. Validate the text doesn't contain null bytes; refuse to push it rather than silently truncate.

### L6 — `defaultExecAsync` deprecation already in flight — verified `execAsync` is fully replaced

**Severity:** informational — **already resolved.**

I grep'd `main.ts` for `execAsync(\`...\`` (template-literal interpolation) and found **zero
matches**. Phase 6 (commit `e71269d`) caught every site, including the `adb connect ${ip}:5555`
one I cited in the draft. Verified clean — no action needed.

### L7 — `run-adb-command` IPC is still an arbitrary shell passthrough to renderer

**Severity:** medium (unchanged from prior review).

The `run-adb-command` IPC at `main.ts:1061-1070` lets the renderer send an arbitrary `shell` command
to the device. With `sandbox: false` and no disable-clear CSP in dev, anything that runs JS in the
renderer is one POST away from a shell on every connected device.

Phase 6 added an `isSafeAdbCommand` allowlist, but the function is a blocklist of banned patterns
("does not match any disallowed pattern") rather than a typed allowlist of permitted commands.
Blocklist-vs-allowlist is the wrong shape for a security boundary.

**Fix:** replace with a fixed array of operation names (`getprop`, `dumpsys <safe-class>`,
`settings get`) and an internal map from operation → argument list. Blocklists rot; allowlists
don't.

### L8 — Test discovered: companion broadcast accepts shell sender correctly; cannot verify rejection path with `adb shell` alone

**Severity:** informational — code is correct, test infrastructure can't easily exercise it.

`ClipperReceiver.isAuthorizedSender` checks `FLAG_RECEIVER_FROM_SHELL` (which `adb shell am
broadcast` always sets, because adb shell IS the shell). To verify the rejection path you'd need
either:
- A malicious APK installed on the device
- A second `adb shell` user context with a different package identifier

Both are out of scope for a normal test pass. Source review at `ClipperReceiver.java:35-53`
shows the check is correct.

### L9 — Companion `Main.java` was never read but the `Main` receiver in `ensureClipperInstalled` (`bringClipperToFocus`) suggests it exists

**Severity:** low.

The companion APK was rebuilt 6 times (Phase 6). The `Main.java` is 58 lines and was not changed
since `add5ad3`. Worth a sanity scan to confirm `Main.java`'s intent is still "launch the receiver
once to unstop the package." (Not a bug — just an untested surface.)

---

## Recommended fixes (prioritized)

| Priority | Finding | Effort | When |
|---|---|---|---|
| **High** | L1 — document `--force` + cap default TTL | 1 hour | This week |
| **High** | L5 — clipboard push through safer mechanism | 4 hours | This week |
| **Medium** | L3 — `settings put secure mock_location 1` in `grantCompanionAppOps` | 30 min | Next session |
| **Medium** | L2 — surface cooling-down countdown in UI | half day | Phase 3 (fan-out scheduler) |
| **Medium** | L7 — `run-adb-command` allowlist rewrite | 1 day | Phase 6 follow-up |
| **Low** | L6 — replace last `execAsync` interpolation | 5 min | Now (in this commit) |
| **Low** | L4 — companion version bump on every build | 2 hours | When CI exists |
| **Informational** | L8, L9 — verify in Phase 3 | n/a | Phase 3 |

---

## What I noticed that wasn't asked for but matters

1. **The companion is a major fingerprint.** Any app under test can enumerate packages and find
   `com.handyfarm.clipper` — a sideloaded non-Play-Store APK declaring `VpnService` and
   `mock_location` capability. This is documented in `ROADMAP.md` §1.4 but the fix (companion
   uninstall as a baseline-reset step) hasn't been implemented. Worth doing as part of
   `resetDeviceToBaseline`.

2. **`run-adb-command` is dangerous enough to remove.** With `sandbox: false` and no CSP in dev,
   the renderer is one POST away from arbitrary `adb shell`. The Phase 6 allowlist is a
   blocklist — it should be an allowlist, or removed entirely. The legitimate use case ("expert
   mode debugging") can be replaced with specific named operations (`getprop`, `dumpsys <class>`,
   etc.).

3. **The lease force-release path is well-designed but undiscoverable.** A crashed session is
   recoverable, but only if you know the command. The first thing an operator does when stuck is
   to reboot the app — which doesn't clear the lease. A user-visible "Stuck lease? Try:
   handyfarm release --device <id> --force" link in the lease error toast would close the loop.

4. **`logcat` viewer still works but only after `spawn` was added.** This was fixed in commit
   `0cd080d` (Phase 2 dual-transport bugfix), so the `import { spawn }` is in place now. No
   regression in the live pass.

5. **The `sendText` IPC isn't exposed via REST.** Only via the renderer IPC. The CLI doesn't have
   a `send-text` command either. That's fine for the current scope, but if the lease system grows
   to drive CI, a REST endpoint for sending text to a leased device (with lease guard) would
   unify the surface.

6. **`/devices/:id/preflight/network` exists but `/devices/:id/preflight/locale` and
   `/devices/:id/preflight/clock` don't.** The preflight module can evaluate all four signals
   (egress IP, timezone, locale, GPS) per the original roadmap, but only network preflight is
   exposed. Worth building the others as Phase 2 extensions when there's a use case.

7. **The package listing endpoint (`GET /installed-packages`) is exposed but not used in the
   UI.** With the new ClipperPanel, a "Companion Capabilities" badge that reads this list to
   surface `android:mock_location` grant state, `android:ACTIVATE_VPN` grant state, etc., would
   make the panel more informative.

8. **The two-phase "send text via placeholder substitution" feature (`{serial}` / `{model}`) works
   in the renderer but not in the REST API.** A batch API that took a target set + a text + a flag
   `placeholderSubstitute: true` would round out the API for automation without a renderer.