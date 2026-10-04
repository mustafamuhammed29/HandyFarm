# HandyFarm — Production Roadmap

Grounded in the tree at `add5ad3`, not `696ae46`. Seven phases have shipped since the original review:
live-defect fixes, SQLite/WAL store, stable physical identity + non-destructive dedupe merge, lease
state machine with guards, security hardening (sandbox, `execFile`, logcat redaction, schema validation),
loopback REST API + `handyfarm` CLI, and the first-party companion app with WireGuard split tunneling.

**This roadmap is about what remains, not what was proposed in `REVIEW.md`.**

---

## Part 1 — Three pushbacks

### 1.1 The framing is inverted from what a device farm is

A device farm optimizes for **control**: known devices, known state, reproducible results, one variable
changed at a time. The three new requirements as stated optimize for the opposite — **diversity**:
per-account IP, non-correlated timing, non-reusable identity. Those are the canonical properties of
account-creation infrastructure, not of a test rig. This is not a comment on intent; it's a comment on
which engineering decisions follow. The three requirements, taken literally, are:

| Requirement | Device-farm meaning | Anti-linkage meaning |
|---|---|---|
| Per-account carrier IP | Network-condition test axis | Separate identities must not share an egress |
| Randomized batch timing | Bound load, avoid self-inflicted failures, realistic concurrency | Simultaneous fleet actions are correlatable |
| Fingerprint rotation between accounts | Prove the device returned to a documented baseline | Never reuse a device across identities |

The left column is buildable, valuable, and defensible. The right column is the same code with a
different purpose — and if the accounts live on a third party's platform rather than your own, the
purpose is what determines the legal exposure, not the code. **Which bucket you're in is worth being
explicit about before Phase 2 gets built**, because it changes nothing about the engineering and
everything about how you document and defend it.

Everything below sequences the left column. The engineering is identical either way; the justification
you write down is the part that has to be right.

### 1.2 "A verified reset that produces a different device fingerprint" is not achievable, and chasing it makes things worse

This is a technical objection, independent of the above, and it's the strongest one I'd make.

**Device-scoped identity is hardware-fixed on non-rooted Android.** IMEI, hardware serial, sensor
calibration, GPU/GLES renderer string, and the bootloader/build fingerprint cannot be changed without
root. The parts that *could* be changed have their own problems:

- **IMEI is legally off-limits.** Altering it is criminalised in Germany under § 202c StGB and prohibited
  by the EU Radio Equipment Directive. You said "IMEI-adjacent identifiers," which suggests you already
  know this — worth stating explicitly in the design doc, because a future maintainer will not.
- **`ANDROID_ID` is app-scoped, not device-scoped.** Since Android 8 it's keyed by signing key + user.
  `pm clear` does not rotate it, and you cannot re-key it without rebuilding the APK.
- **GAID is user-resettable but global.** Resetting it affects every app on the device.
- **Rooting rotates some of it and destroys Play Integrity.** `MEETS_DEVICE_INTEGRITY` requires a locked
  bootloader and certified image on Android 13+. A rooted device that presents a "fresh" identity is a
  *worse* test subject than an unrooted one that presents a familiar identity.

So the requirement as literally written can only be satisfied by rooting, and rooting trades a
reproducibility problem for a trust problem. **The achievable version is strictly more useful for QA:**

> After `reset --to baseline`, **prove** the device is in the documented state, and emit a structured
> diff for anything that isn't.

That is a reproducibility guarantee, and it is the actual core value of a device farm. "Is this test
failure a real regression, or did device 7 drift because yesterday's run left it in an odd state?" is a
question a farm must answer and most never do. A reset that manufactures difference cannot answer it. A
verified baseline can.

### 1.3 20 German SIMs will give you roughly 3 egress IPs, not 20

Telekom, Vodafone and O2 all deploy **Carrier-Grade NAT** heavily for mobile data. Public IPv4 for
mobile subscribers is the exception; the norm is a shared public address fronting thousands of
subscribers. So the practical outcome of 20 prepaid SIMs across 3 carriers is:

- **~3 carrier-distinct egress identities**, not 20.
- Within a carrier, your devices share a CGNAT pool with **unrelated consumers**, whose behaviour you
  do not control. The reputation of that shared address is a random variable.
- CGNAT addresses **rotate** on a carrier schedule. Whatever egress you observe today is not what the
  next test run gets.

Three further operational facts that belong in the plan:

- **The Wi-Fi/USB conflict is the real blocker.** If devices sit on shop Wi-Fi for ADB, the SIM does
  nothing — Android routes app traffic over Wi-Fi. Getting cellular egress means either (a) USB for ADB
  with Wi-Fi disabled on-device, or (b) fighting per-app network binding, which non-rooted Android
  restricts. **Option (a) makes USB the hard ceiling again**, which is the constraint from the original
  review that you have not escaped — you have moved it, not removed it.
- **Prepaid SIMs in Germany require real-name activation.** 20 SIMs is 20 ID checks and a paper trail
  linking each device to a named person. Operationally fine; worth knowing before procurement starts.
- **Data budget is a real ceiling and fails silently.** Twenty devices on continuous duty is on the order
  of hundreds of GB/month against typical prepaid caps. Mid-test cap exhaustion produces partial runs
  that look like test failures. This needs a circuit breaker, not a dashboard.

None of this argues against the SIMs. It argues for recording **observed** egress per device per run
(rather than assuming a static IP), budgeting data, and treating carrier assignment as a test parameter.

### 1.4 Smaller, concrete, and worth saying now

**Your companion app is itself a large fingerprint.** Any app under test can enumerate installed packages
and find `com.handyfarm.clipper` — a sideloaded, non-Play-Store package that declares a `VpnService` and
mock-location capability. Enable `always_on_vpn_app` in secure settings and that's readable too. Mock
location being granted is observable via AppOps. This is completely fine for testing your own app. It is
a beacon when testing anyone else's, and the fix is a documented "companion present" disclosure policy
plus an uninstall/restore step in the baseline reset — not a redesign.

**Do not jitter device clocks.** You listed clock skew among the fingerprint concerns. In a farm, clock
skew is a *noise source to eliminate*, not one to randomize: time-based assertions across devices are only
comparable if clocks are NTP-synced and the offset is measured and bounded. Jitter the **action
schedule**; **verify** the clock. Conflating the two is an easy mistake to make here and it would quietly
corrupt every time-sensitive test result.

**`reset.baseline` is currently weaker than the requirement you think it meets.** As shipped
(`ClipperReceiver.java:278-362`) it clears mock location, clipboard, system dialogs, animation scales, and
VPN. That is ephemeral UI state. It does not touch app data, accounts, permissions, locale, or network
config. It is a "return to a clean-looking screen" reset, not a state baseline. Phase 1 is a build, not a
fix.

---

## Part 2 — The roadmap

Six phases. Each ships and is testable alone. The spine: **you cannot trust a fleet you cannot observe,
you cannot trust a reset you cannot verify, and you cannot run N-device work before you control fan-out.**

**Parallel track (starts Day 1, not a phase):** second-host procurement and powered-hub selection have
lead time in weeks and gate Phase 5. Start buying before you need them.

---

### Phase 0 — Ground truth: a regression net before more behavior

**Status: the highest-leverage three days in this roadmap, and it is currently zero.**

There is no test runner, no `test` script, no test directory, and no CI. `package.json` has `dev`,
`build`, `lint`, `preview`. The only test-shaped files are loose scratch scripts in the repo root
(`test-adb.ts`, `test-clipboard-ipc.ts`, `test-scrcpy-*.ts`) and `scratch/`. Meanwhile the codebase is
2,000 lines of `main.ts`, 912 of `db.ts`, 461 of `apiServer.ts`, 396 of CLI, and ~720 lines of Java in
the companion — with seven phases of behavior changes already landed.

**Ship:** vitest wired into `npm test`, CI on PR. Target the logic that has *already* produced bugs,
because that's where the value is:

- `identity.ts` — property-based tests over the fallback chain (`ro.boot.serialno` → `ro.serialno` →
  companion UUID → composite). The `isSuspect` heuristic is exactly the kind of thing that silently
  collapses to a shared ID across a fleet.
- **Lease state machine** — property-based over transition sequences. `available/leased/cooling_down/
  quarantined/maintenance` with TTL expiry is a state machine with an expiry clock, which is the classic
  shape for a bug you find at 3am.
- **Dedupe merge** — the non-destructive merge you shipped in `e6ad487`. Assert no metadata loss on
  merge. This was bug §2.9 in the original review; it is fixed, and nothing prevents regression.
- **Config schema validation** and **API lease-guard enforcement** — both are security boundaries and
  both are currently only tested by hand.
- **Reset verification diff** (Phase 1's core) — this is where you want the harness *before* the feature.

**Unblocks:** every later phase becomes a refactor rather than a gamble, and you can honestly call the
farm production-grade to someone auditing it.

**Effort:** 3–5 days.

**If skipped:** Phases 1–3 add reset verification, SIM state, and a scheduler to a 2,000-line file with
no regression net. The lease state machine and dedupe merge get silently broken by an unrelated edit and
you find out from a test run, not a unit test. You also cannot demonstrate the "defensible" property at
all — defensibility here means "the behavior is provably correct," and right now that argument is
"we looked at it once."

---

### Phase 1 — Verified state baseline

The reframe from §1.2, and the phase everything else depends on.

**Ship, in order:**

1. **Fingerprint manifest** captured at enrollment, split into two classes with different semantics:
   - *Immutable* (documented, never rotated): `ro.boot.serialno`, build fingerprint, model, screen,
     GPU/GLES renderer, sensor list, Play Services version, verified-boot state, SELinux mode.
   - *Mutable* (the baseline, reset and verified): installed packages + versions, granted permissions,
     accounts, locale + timezone, animation scales, Doze/battery-saver state, network config, wallpaper,
     default launcher.
2. **`baseline capture`** → stores a manifest per device.
3. **`reset --to baseline`** — the real implementation, not the current ephemeral-state clear. `pm clear`
   for app state, permission revocation, account removal, plus the existing companion-side resets.
4. **`verify --against baseline`** — returns a **structured diff**, not a boolean: `{ field, expected,
   actual, drift_class }` with `drift_class ∈ {app, permission, account, locale, network, system, hardware}`.
5. **Drift detection in the background** — a periodic verify that flags devices that drifted *without* a
   reset (OTA update overnight, an app auto-updated, a permission dialog answered by hand). This is the
   alarm that catches the silent-corruption class of bug.
6. **Clock verification** — NTP sync state and measured offset per device, surfaced and bounded. Phase 3
   jitters the schedule; this proves the clock is trustworthy. Never randomize device time.

**Unblocks:** attributable test results; the ability to say a failure is a regression and not setup
drift; a trustworthy foundation for soak tests, diffing, and any unattended overnight run.

**Effort:** 2–3 weeks.

**If skipped:** every future result is unattributable. "Device 7 failed" and "device 7 was left in a
weird state by yesterday's run" are indistinguishable, and you will chase phantom regressions for
months. This is the single largest source of silent false negatives in any device farm, and it is
invisible until it has cost you a week of debugging the wrong bug.

---

### Phase 2 — Network as a first-class test axis

**Ship:**

1. **SIM inventory** — one record per SIM: slot, ICCID, carrier, APN, plan, data cap, renewal date,
   status. Store IMSI hashed and MSISDN redacted: both are persistent identity values and neither belongs
   in a plaintext inventory file.
2. **Per-device assignment** + automatic **observed-egress capture** at run time (IP, ASN, carrier, geo,
   observed-at). Because CGNAT rotates, you record what egress *actually was* — you never assume it.
3. **Dual-transport decision, made explicit** — this is the load-bearing choice. If cellular is the
   egress, ADB must be USB and Wi-Fi must be off on-device, or the SIM is inert. Document the topology,
   and surface per-device "is cellular actually the default route" as a preflight assertion.
4. **Data budget** — per-device and per-fleet consumption tracking, alert at 80%, **circuit breaker**
   that halts the run rather than letting it fail opaquely mid-test.
5. **Preflight assertions** for any network-sensitive run: carrier is the expected one, observed egress
   matches expectation, cellular is the default route, data budget has headroom. **Fail the run if any
   check fails** rather than proceeding and producing contaminated results.

**Unblocks:** the network-condition matrix. German mobile networks have genuinely distinctive behavior
worth testing that no emulator reproduces: CGNAT, IPv6-preferred with 464XLAT translation, carrier DNS
filtering, MTU/MSS black-holing, and real packet loss on handover. That is a legitimate, defensible
reason to run 20 physical SIMs, and a better one than the one in the brief.

**Effort:** 2 weeks (hardware procurement in parallel).

**If skipped:** you don't have the network diversity you think you have, there's no data-cap safety, and
the entire class of mobile-native connectivity bugs stays untested. Worse, a test run that quietly
crossed its data cap mid-flight produces a partial result that looks exactly like an app failure.

---

### Phase 3 — Fan-out scheduler

Small, early, and a prerequisite for everything in Phase 4.

**Ship:** one central scheduler in the main process that all device actions route through:

- **Bounded concurrency** — a global cap with a per-transport cap, replacing the ad-hoc
  `for (const dev of allDevs)` loops currently in `main.ts` (e.g. the reconnect sweep at `main.ts:431`).
- **Per-device randomized delay** within a configurable window.
- **Priority and cancellation** — a long soak can yield to an interactive request.
- **Per-host rate limit** protecting your own infrastructure and USB/Wi-Fi bandwidth.
- Every action auditable: which device, when, in what order, and with what delay — so a run is
  reproducible after the fact.

Framing that holds up under scrutiny: this bounds load and avoids self-inflicted rate-limit failures
against your own staging backend, and it tests a realistic concurrency pattern. If the app and the
backend are yours, correlated timing isn't a liability — **it's a load test, and you'd want it tight.**

**Unblocks:** Maestro orchestration, screenshot diffing, soak runs. All are N-device fan-out and all will
reimplement this badly if it doesn't exist first.

**Effort:** 1 week.

**If skipped:** every fan-out feature builds its own version, inconsistently. Twenty devices acting
simultaneously saturate USB bandwidth and your own Wi-Fi, and produce self-inflicted rate-limit failures
that get misdiagnosed as app bugs. Cheap to build, expensive to retrofit.

---

### Phase 4 — Fleet health, quarantine, and the physical layer

**Ship:**

1. **Populate `quarantined`.** The lease state exists in `db.ts:6` and nothing sets it. Health scoring
   should drive it automatically: thermal throttle events, battery health and charge-cycle count,
   unexpected reboot frequency, USB reconnect churn, `getProperties` failure rate, and a rolling
   flakiness score from test outcomes.
2. **Powered-hub topology as first-class state** — per-port current draw, hub health, per-port enable /
   disable switching, and a **bandwidth budget** per device the scheduler respects. The
   `getComputedInterval` screencap ramp from the original review was a band-aid over exactly this.
3. **Second host + provider-process split** — the STF provider model: one ADB-owning process per host,
   control plane spanning both. Trigger on approaching a single host's device ceiling, not on CPU.
4. **Unattended run safety** — overnight runs need heartbeat monitoring, auto-quarantine on disappearance,
   and a resumable run log.

**Unblocks:** safe unattended operation and growth past the 8–16 device ceiling.

**Effort:** 2 weeks software, plus procurement lead time.

**If skipped:** "the farm is flaky" gets debugged as a software problem when the real cause is power,
heat, or a failing hub. Batteries swell, ports brown out, and you have no signal distinguishing
"device 7 is broken" from "device 7 is fine and its hub is undersized." Every large farm I've seen
stumble here first.

---

### Phase 5 — Regression orchestration and evidence

This is where a control panel becomes a device farm. It's the largest phase and the one with the clearest
ROI, because it's what turns device time into test coverage.

**Ship:**

1. **Maestro integration** — lease a device via the REST API that already exists, run a YAML flow,
   collect artifacts. Maestro's built-in smart waiting eliminates the largest single source of mobile test
   flakiness for free, and `-e APP_ID=...` maps onto your existing placeholder-substitution model.
   Phase 3's scheduler is the fan-out; the API is the transport.
2. **Cross-device screenshot diffing** — you already screencap every device on an interval. Normalize
   (mask status bar clock, battery, notification shade), filter candidates with perceptual hash, confirm
   with SSIM, and present side-by-side with a heat-map overlay. Golden baselines keyed by
   `(package, scenario, device)`. Diff on the main thread before persisting, and **group identical
   failures** so one root cause across six devices is one entry, not six.
3. **Crash and ANR aggregation** — `dumpsys dropbox --print` for records that survive reboot,
   `logcat -b crash -b events` for `am_crash`/`am_anr`, triggered `adb bugreport` for full context. Store
   as a matrix keyed by `(package, exception, appVersion, immutableFingerprint)` from Phase 1, so you
   get "3/20 devices, all One UI 6.1, all SDK 34" instead of a wall of text.
4. **Battery/thermal soak** — `dumpsys batterystats --reset` → scenario → `--charged`, parse
   `Uid power use`, track thermal state, and run overnight on idle leased devices. Nobody does this well
   at 4–20 device scale, and it's the capability that justifies owning hardware.

**Unblocks:** unattended regression across the fleet; evidence for every result; the actual payoff.

**Effort:** 3–4 weeks.

**If skipped:** HandyFarm is a very good multi-device remote control with a REST API. Useful, valuable,
and not a device farm. Everything in Phases 0–4 is infrastructure in service of this phase, so skipping
it means the infrastructure has no consumer.

---

## Part 3 — Sequencing summary

| Phase | Ship | Effort | Gate for |
|---|---|---|---|
| **0** | Test harness + CI on existing logic | 3–5 days | Every refactor after this |
| **1** | Verified state baseline + drift detection | 2–3 wks | Attributable results |
| **2** | SIM inventory, egress capture, data budget | 2 wks | Network test matrix |
| **3** | Fan-out scheduler | 1 wk | All N-device work |
| **4** | Health scoring, quarantine, power/USB, 2nd host | 2 wks + lead | Unattended ops, >8 devices |
| **5** | Maestro, diffing, crash aggregation, soak | 3–4 wks | The farm's actual value |

**Parallel from Day 1:** second host and powered-hub procurement (lead time gates Phase 4).

**Total:** roughly 10–13 weeks of focused work, and the ROI-visible phase is last by design — because
phases 0–4 are what make its output trustworthy.

## Part 4 — Deliberately not building

- **Any capability whose purpose is presenting a different identity to a third party.** Everything in
  Phases 1–2 is framed and implemented as state control and network testing, which is what they are good
  for. If a future requirement can't be reframed that way, that's the signal to stop and reconsider.
- **Rooting the fleet.** It would buy a little identity rotation at the cost of Play Integrity, secure
  boot, and your ability to test hardware-real behavior. Strictly negative for QA.
- **IMEI modification.** Illegal in Germany, and correctly excluded already.
- **Clock randomization.** Eliminated as noise, not added as camouflage.
- **Egress IPs as a static per-device property.** CGNAT rotates them; observed-per-run is the only
  honest model.
