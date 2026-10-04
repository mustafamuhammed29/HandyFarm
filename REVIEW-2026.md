# HandyFarm vs. State-of-the-Art Device Farm Projects (2026)

**Scope.** Comparison against active (2025–2026) Android-device-farm and mobile-test-orchestration
projects — open source and commercial — that weren't in the original `REVIEW.md` §4 sweep, with a
second pass on the ones that were. HandyFarm's architecture is taken as the post-Phase-2 tree
(`add5ad3..307a320` plus `.gitignore` hardening), not the state covered in the original review.

---

## TL;DR

HandyFarm is genuinely **at or ahead** of the field on three things and **behind** on roughly five.
None of the gaps justify a rewrite; they justify targeted follow-ups in the next two phases. The
single biggest strategic mismatch is that HandyFarm is a control panel pretending not to be one
while the rest of the industry has accepted that "control panel + automation" is the correct shape —
so the question isn't "are we current?" but "do we formalize the automation surface we already have?"

---

## What's already best-in-class in HandyFarm

### 1. Single-machine install complexity

Compared to every open-source option:

| Project | Install complexity | What you give up for it |
|---|---|---|
| **HandyFarm** | `npm install && npm run dev`, single artifact | nothing |
| STF / DeviceFarmer | RethinkDB + ZeroMQ + protobuf + GraphicsMagick + node-jpeg-turbo + 15 containers | abandoned at Android 9, 150+ open issues, Node 8 era |
| GADS | Go binary + SQLite + a Node UI, but multi-process and provider/host topology | still heavier than HandyFarm, but reasonable |
| appium-device-farm | Appium 2 server + Node plugin + driver stack | automation-only, no live control |
| Maestro | CLI + on-device companion APK | not a control panel at all |
| Mobot (commercial) | vendor-hosted | recurring cost, your devices become their property |
| Farmly (commercial, 2026) | npm-installable orchestrator + runner pair | SaaS-ish |
| AWS Device Farm | none (cloud) | per-minute billing; physical slot pool shared with strangers |
| Firebase Test Lab | none (cloud) | limited concurrency, no persistent devices |

For 4–20 devices on one host, HandyFarm is the right shape. Adopting STF would be a multi-day
infrastructure project to build something strictly worse to use.

### 2. Embedded live view via `@yume-chan/scrcpy-decoder-webcodecs`

GADS uses MJPEG/WebRTC for its live stream. STF runs `scrcpy` as a separate window. HandyFarm
decodes H.264 in-process and paints to a canvas inside the renderer. **For a single operator doing
QA, this is the right ergonomics.** The 2026 upstream — scrcpy v3.3.4 (Dec 2025) — adds AV1 and
H.265 codec support, which is interesting for higher-fidelity streams but is the same architectural
choice HandyFarm already has; you'd just swap the codec.

**Gap:** HandyFarm's bundled `scrcpy-server-v2.4.jar` is from `scrcpy` v2.4, released in late 2023.
The current upstream is v3.x. The 2.4 server still works against Android 13+, but newer features
(H.265, virtual display, AV1) are missing. **Action:** update the bundled jar (covered in §3.3
below).

### 3. Stable physical-device identity with non-destructive dedupe merge

STF solves device identity by storing provider-assigned IDs in a database. HandyFarm's
`identity.ts` (post-Phase-4) does the same on a smaller surface: fallback chain
`ro.boot.serialno → ro.serialno → companion UUID → composite`, with non-destructive dedupe that
preserves operator metadata (customName, notes, tags) on Wi-Fi ↔ USB transitions.

This is the **right shape** for the data model. Most homegrown farms key by `device.id` and then
spend the next two years chasing the resulting identity instability. HandyFarm is one of the few that
got this right at the model layer rather than the patch layer.

---

## Where the industry has actually moved (2025–2026)

### A. Appium 3 (released 2025)

Appium 2's "New Architecture" (synchronous native module calls) shipped stable in 2024 and Appium 3
followed in 2025 as a smaller-than-2 release that mostly moves work into drivers/plugins. The
important 2026 facts:

- Appium 2 driver/plugin model is now the supported path; the legacy Appium 1 client/server pair is
  effectively EOL.
- Appium 3 inherits the same architecture; the major version bump is mostly ABI / packaging
  changes, not new testing capability.
- **`appium-device-farm` (the Appium 2 plugin) has REMOVED its manual/live-device-control
  surface.** The plugin now focuses purely on automation driver sessions against a pool. Remote
  control lives elsewhere — that's HandyFarm's niche, not Appium's.

**Implication for HandyFarm.** The device-farm *plugin* space is converging on "give me an
allocation, return me a driver" — HandyFarm should explicitly *not* try to be a plugin for that
ecosystem, because HandyFarm is solving the other half (operator visibility and control) that the
plugin space has dropped. Worth documenting this positioning internally so a future contributor
doesn't waste time trying to integrate the two.

### B. Maestro's rise and its 2026 release cadence

Maestro reached ~10,800 stars by February 2026 and is in production use at Microsoft, Meta, and
DoorDash. The release cadence in 2026 is unusually fast:

- CLI 2.11 (Oct 2026): Android 17 (API 37) support, command-correlated screen recording
- CLI 2.10 (Sep 2026): boot specific Android system images (AOSP, GMS-flavored variants)
- CLI 2.9: dark-mode commands across iOS / Android / Web; negation globs in `config.yaml`
- CLI 2.7: AI agent can debug failed Cloud runs
- CLI 2.6: **Maestro Viewer — coding agent gets the live device embedded in the editor**

Maestro's most consequential architectural contribution is `dadb` — a pure-Kotlin ADB protocol
implementation that **removes the dependency on the standalone ADB binary** for client-side work.
The Maestro team ships `dadb` standalone; HandyFarm's heavy reliance on the `adb` shell-out for
many operations (`adb shell settings get`, `adb shell input keyevent`, etc.) is exactly the
`dadb` sweet spot.

There's also `maestro-runner` from DeviceLab — a Go-based, drop-in YAML-compatible replacement
that's 2–3.6× faster, uses 13× less RAM, and eliminates JVM startup cost. The two have version skew
(cloud fork at 1.39.x, open-source at 2.10+), which is a known operational issue worth tracking.

**Implication for HandyFarm.** Two paths:

1. **The cheap, high-value path:** write a thin `dadb`-backed client for the operations HandyFarm
   does most frequently (settings reads, input events, dumpsys, screencap streaming). This collapses
   the ADB-spawn overhead and unifies the language (Kotlin via JNI or pure TS via `adbkit` style).
   Effort: 2–3 weeks.
2. **The bigger path:** add a Maestro `flow.yaml` runner mode to HandyFarm — fleet picks a YAML
   flow, HandyFarm leases the device, executes via Maestro, captures artifacts. Composes well with
   the lease model that already exists. Effort: 1–2 weeks. Worth doing as part of the fan-out
   scheduler (Roadmap §3).

### C. Farmly (2026) — npm-installable, Appium-compatible

A new commercial option that emerged in 2026 with two npm packages (`farm-orchestrator` +
`farm-runner`) and an Appium compatibility layer. Important **not because HandyFarm should adopt
it** — it would mean abandoning the lease model and the verified-baseline layer — but because it
validates the npm-installable, no-Docker shape that HandyFarm already has. Worth reading for UX
inspiration on the rental/booking flow.

### D. AWS Device Farm: alive, not deprecated

The 2024 reporting that "AWS Device Farm is shutting down" was wrong — it was the **remote access
** feature that retired, not the device farm itself. As of 2026:

- $0.17/min, or ~$250/slot/month reserved (1,000 device-minutes one-time free for new accounts).
- 2,500+ devices.
- No free plan beyond the one-time trial.

For a 20-device shop running **regression + soak tests daily**, the math is roughly:
- **$0.17/min × 60 min/run × 4 runs/day × 30 days = ~$1,224/month** at full slot occupancy
- **Reserved: $250 × 20 slots = $5,000/month** (with dedicated allocation)

This is a *real* number to compare against HandyFarm's hardware amortization (≈€1,000 one-time +
power/space), but only when you actually need the cloud scale. HandyFarm's host-local position
holds for everything that doesn't need cross-geo device diversity.

**The interesting 2026 commercial developments are pricing ones, not architectural ones.**
BrowserStack ($199/mo for App Automate), Sauce Labs Real Device Cloud ($199/mo), Firebase Test
Lab (Spark: 10 virtual + 5 physical/day free; Blaze: $1/hr virtual, $5/hr physical), TestMu
($15/mo), Kobiton ($83/mo), and HeadSpin (network/performance specialty). None of these change
the local-farm architecture for a shop with persistent devices.

### E. STF has been forked and quietly abandoned

DeviceFarmer/stf was last touched in March 2025. There is no Android-14/15 main branch build.
156+ open issues. The org has not produced a release since 2020. The codebase is a museum piece
that compiles against a 2020 toolchain. **Don't adopt it.**

### F. Android 15/16 testing APIs worth knowing about

- **Android 15 (API 35):** photo picker + scoped storage; `dumpsys jobscheduler` exposes queue
  state; `cmd jobscheduler` can be driven from ADB. Useful for background-work regression tests.
- **Android 16 (API 36):** major accessibility refactor. UIAutomator2 still works; Maestro's
  accessibility-layer approach tracks these changes upstream.
- **`dumpsys media_session`** is now reliable for foreground media-app state — HandyFarm's
  Clipper `handyfarm.foreground.get` could potentially use it instead of `USAGE_STATS` for
  media apps (less permission-burdened).
- **Android 15 `cmd connectivity airplane-mode enable/disable`** — the `svc wifi enable` /
  `svc data enable` patterns HandyFarm already uses are equivalent and continue to work.
- **AppOps changes:** Android 15 added finer-grained AppOps scopes. HandyFarm's
  `appops set ... allow` (3-line sequence at `main.ts:1233-1235`) still works; just be aware that
  some ops are read-only on production builds.

These are *small* wins, not architectural shifts. None justify a project-level change.

---

## Concrete gap analysis — what's missing or outdated in HandyFarm

Ranked by ROI, not by drama.

### G1. No automation surface (Big gap — but the right kind of gap)

**Status.** HandyFarm is a control panel only. Every action requires a human at the keyboard. The
closest thing to automation is the loopback REST API + CLI from Phase 7.

**What 2026 leaders do.** Maestro, Appium, GADS all have CI-friendly execution paths built in.
STF was the same. Modern self-hosted farms ship a `runs.yaml` or flow-as-code primitive.

**What HandyFarm should do (Roadmap §5 already covers this).** Make Maestro flow execution a
first-class action: pick a device (already leased), pick a YAML flow, run, capture artifacts. The
lease model + REST API + CLI make this a small amount of glue code on top of what's already there.

**Effort:** 1–2 weeks, building on existing lease + API work.

**What HandyFarm should NOT do.** Don't try to be an Appium driver. That's a different product.

### G2. Companion-based capabilities are visible to app-under-test (Medium gap)

**Status.** The companion is `com.handyfarm.clipper`, declared as a `VpnService`, holding
`ACCESS_MOCK_LOCATION` and `PACKAGE_USAGE_STATS`, and sideloaded. Any app under test can enumerate
installed packages and find it; `PackageManager.getInstalledApplications` returns all packages,
including non-Play-Store ones.

**What 2026 leaders do.** GADS doesn't have a companion app at all — it relies on ADB only.
STF's `STFService.apk` is more minimal but is also an installed package. Appium's `settings-allow-auto
` flow leaves no on-device artifact.

**What HandyFarm should do (no code, just policy).**
1. **Document this fingerprint in `CONTEXT.md`** as a known property of testing-on-HandyFarm.
2. Make the companion **uninstall-able as a step in the baseline reset** — uninstall + reinstall
   as part of `resetDeviceToBaseline` — so a test that asserts "no third-party packages
   present" can pass between runs.
3. Add a per-device **"anonymize before test"** toggle that uninstalls the companion, runs the
   test, reinstalls, and verifies. This is the only way to test apps that enumerate packages.

**Effort:** 1 day (the policy + uninstall hook).

### G3. Bundled `scrcpy-server-v2.4.jar` is two years stale (Small, but shipping)

**Status.** Bundled jar is from scrcpy 2.4 (late 2023). The upstream is scrcpy 3.3.4 (Dec 2025).
2.4 still works against Android 13+, but loses:
- H.265/AV1 codec support
- Virtual display support
- Newer Android 16 quirks and input-event handling improvements

**What HandyFarm should do.** Update the bundled jar in `resources/`. The protocol is stable
enough that the change is `cp` + verify. Probably 30 minutes plus testing.

### G4. Single-process `main.ts` is at 2,000 lines (Maintenance gap)

**Status.** `electron/main.ts` has 2,000 lines. Several distinct subsystems live in it (tracker,
worker, lease, preflight, baseline, scrcpy, leases, leases again, broadcast, REST).

**What 2026 leaders do.** GADS splits into `internal/provider` + `internal/hub` + `internal/api`
+ `internal/client`. STF has 14 microservices. HandyFarm doesn't need microservices, but does
need file separation.

**What HandyFarm should do.** Split `main.ts` into:
- `electron/main.ts` — app lifecycle, window, plugin entrypoint (~200 lines)
- `electron/clipper.ts` — companion-related IPC + helpers (~500 lines)
- `electron/baseline.ts` — capture/verify/reset (~250 lines)
- `electron/preflight.ts` — Phase 2 preflight (~150 lines)
- `electron/devicestore.ts` (already extracted) + `electron/lease.ts` (already extracted)
- `electron/rest.ts` — REST API server (~470 lines)

The current `main.ts` would shrink to roughly 200 lines of composition. No behavior change.

**Effort:** 1–2 days (carefully, with regression tests covering each subsystem). **Risk:** the
internal dependency graph between subsystems is non-trivial — moving Clipper will surface
suspensions to `mainWindow`, `deviceStore`, `client`, `broadcastDelta` that need to be threaded
through imports.

### G5. No screenshot diffing or evidence pipeline (Phase-5 item, still missing)

**Status.** The screencap loop runs but the diffs are not stored, golden baselines don't exist
across runs, and there's no Fleet view of "what changed since last good run."

**What 2026 leaders do.** Maestro integrates trivially with screenshot tooling via the
`assertVisible` + visual screenshot mode. GADS has a basic capture-and-archive per session.

**What HandyFarm should do (already in Roadmap §5).** Wire pHash + SSIM diffing on the existing
screencap loop. Group identical failures so one regression across six devices is one entry. The
infrastructure (thumbnails already in memory) is already in place.

### G6. No load shedding / power management (Roadmap §4, still missing)

**Status.** Concurrent screencap across 20 devices on one host will saturate USB bandwidth and
exhaust power budget before CPU. The screencap-interval ramp in `main.ts` is a band-aid.

**What 2026 leaders do.** STF has a per-device bitrate budget. GADS lets the operator throttle
streams. BrowserStack's hosted model hides the problem (their hardware is sized correctly).

**What HandyFarm should do.** Per-port power draw, hub health, per-device bitrate budget, and a
circuit breaker that says "device 7 is drawing 1.8A from a 0.5A-port-rated hub — disable."

**Effort:** 2–3 weeks. Worth doing before scaling past 8 devices.

---

## What HandyFarm should NOT do

Three temptations worth resisting:

1. **Don't adopt STF, don't adopt GADS core code.** Both have a different deployment shape and
   either adoption would mean rebuilding the install path and the lease model.
2. **Don't try to compete with cloud device farms on device count.** The business case for
   HandyFarm is "test against our actual physical devices cheaply," not "have the biggest device
   catalog." Cloud has won on catalog count; HandyFarm wins on proximity-to-dev and integration
   cost.
3. **Don't add OAuth2 / SAML / RBAC yet.** GADS has none. Maestro has none. The current local-only
   API with a token file is the right shape for a single-shop deployment. Adding enterprise auth
   before the automation loop exists is overengineering.

---

## Recommendation

Adopt three of the above in the next quarter:
1. **Maestro flow execution** (G1, 1–2 weeks)
2. **`scrcpy-server-v3.x.jar` update** (G3, 30 minutes)
3. **`main.ts` split** (G4, 1–2 days, low risk, high cleanup)

Defer:
- G2 (companion uninstall in reset) — when needed, 1 day
- G5 (screenshot diff) — Roadmap §5 already plans this
- G6 (power management) — Roadmap §4 already plans this

Skip:
- Cloud-device-farm integration
- STF adoption
- Enterprise auth before automation exists