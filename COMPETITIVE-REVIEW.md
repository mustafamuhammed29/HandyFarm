# COMPETITIVE-REVIEW.md — Honest comparison vs open-source device-farm projects

**Audit date:** 2026-10-06

This document compares HandyFarm against five real open-source projects. Each
is a *different* style of device-farm control panel; together they define
the competitive shape of the category. After the table, every advantage is
classified by the brief's required rubric (Must build / Useful later / Not
relevant / Too expensive).

## 1. The projects (Reviewed)

| Project | Repo | Last push | Stars | License | Architecture | Status |
|---|---|---|---|---|---|---|
| **DeviceFarmer / OpenSTF** | [openstf/stf](https://github.com/openstf/stf) | 2023-05-31 | 13,960 | "Other" / NOASSERTION (custom) | Node.js + triadic (service, provider, CLI). Multi-host via provider/worker model. | **Dormant.** Not archived but no recent activity. 464 open issues. |
| **GADS** | [shamanec/GADS](https://github.com/shamanec/GADS) | 2026-10-04 | 382 | **AGPL-3.0** | Go (Hub + Provider), Vue UI. iOS + Android + Smart TV. Appium-driven. | **Active.** |
| **Appium Device Farm** | [AppiumTestDistribution/appium-device-farm](https://github.com/AppiumTestDistribution/appium-device-farm) | 2026-09-24 | 644 | **Apache-2.0** (with obfuscated proprietary `dashboard-frontend` and `src/modules/`) | Appium 2.x plugin + Node dashboard (mixed MIT + proprietary). | **Active.** |
| **scrcpy-gui (SimonAKing)** | [SimonAKing/scrcpy-gui](https://github.com/SimonAKing/scrcpy-gui) | 2026-10-02 | 4,093 | **MIT** | Electron + scrcpy binary. No farm features; per-device GUI. | **Active.** Single-developer. |
| **OpenSTF-java-client** | [yunusmete/openstf-java-client](https://github.com/yunusmete/openstf-java-client) | (lookup needed) | 41 | MIT | Java REST client for STF. Reference only — not a farm. | Dormant. |

I picked GADS over STF as the actively-maintained alternative. STF's
"Other" license and 3-year-dormant state make adopting it directly unwise;
its *patterns* (status model, lease display, search-by-attributes) are what
matter. GADS has the same hub/provider shape with an active maintainer and
an AGPL-3.0 license — which is itself a red flag for HandyFarm because
AGPL's network-copyleft clause would force HandyFarm to disclose source
if it integrated GADS code paths.

## 2. Capability matrix (real, not aspirational)

| Capability | HandyFarm (audited) | STF | GADS | Appium Device Farm | scrcpy-gui |
|---|---|---|---|---|---|
| **Device inventory** | ✓ electron + sqlite + Phase 4 health. 4 devices seen in audit (3 unique). | ✓ status: ready/offline/unauth/unplugged | ✓ | partial — only via Appium session |
| **Stable identity** | ✓ `physicalDeviceId` keyed on hardware props. Phase 1 immutable fingerprint. Duplicate-transport flaw (audit §3.2). | ✓ — IMEI/ICCID/serial | ✓ | n/a |
| **Reservations / leases** | ✓ with TTL, heartbeat, cooldown, quarantine. Phase 1 + 4. | partial, device-user mapping (who has it) | ✓ via Appium | ✓ via Appium session lifecycle |
| **Remote screen control** | ✓ scrcpy v2.4 (yume-chan) per tile | ✓ via stf-service.js / uiautomator | ✓ via appium-uiautomator2 | ✓ scrcpy binary |
| **Touch / text / clipboard** | ✓ via companion APK + L7 typed allowlist. Clipboard file-based. | ✓ via STF protocol | ✓ via Appium | ✓ via scrcpy input |
| **Shell / logcat** | ✓ shell via scrcpy worker; logcat for crashes (Phase 5). | ✓ dedicated logcat pane | ✓ | partial |
| **APK install** | ✓ via `install-apk` IPC | ✓ batch + per-device | ✓ via Appium | ✗ — pure display |
| **Test execution** | partial — Maestro CLI + mini-flow runner (Phase 5). Appium not wired. | ✓ via stf-testservice | ✓ Appium first-class | ✗ |
| **Screenshot baselines** | partial — pHash/SSIM pipeline built (Phase 5). In-memory only, lost on restart (audit §3.7). | ✗ | partial | ✗ |
| **Crash / ANR aggregation** | ✓ logcat + dropbox on-demand + bugreport on real crash (Phase 5). | partial — syslog only | partial | ✗ |
| **Health / quarantine** | ✓ Phase 4 with hysteresis. | ✗ — STF does not auto-quarantine. | partial | ✗ |
| **Multi-device scheduling** | ✓ Phase 3 fan-out scheduler. | ✓ stf-scheduler | ✓ via Appium | ✗ |
| **ADB tunnel** | ✗ no minicap / minitouch / no proxy. Direct adb only. | ✓ via STF protocol | ✓ | partial (scrcpy tunnel) |
| **Authentication / roles** | partial — loopback-only REST bearer. No renderer auth. | ✓ OAuth + user roles | ✓ basic auth | n/a (single-user) |
| **Reports / artifacts** | partial — `scheduler_audit` table, per-row limit via SVG blob. No per-regression artifacts dir surfaced in UI. | ✓ reports UI | ✓ reports UI | n/a |
| **Android companion agent** | ✓ — single-purpose clipboard + identity APK. No agent for app inventory / permissions / photos. | partial — APK pool agent | ✓ | ✗ |

## 3. Honest summary of where HandyFarm stands

**HandyFarm is honest at:** device tracking, scheduler, health/quarantine,
clipboard bridge, regression orchestration (Maestro CLI + offline fallback),
screenshot diffing, crash aggregation, single-host layout.

**HandyFarm is unproven at:** any multi-device scenario (the
brief's "three devices" criterion has not been verified live), packaged
Electron build, companion survival across reboot, golden-baseline
persistence.

**HandyFarm is missing:** agent-driven app inventory, safe APK ops
workflow, permission inspection, photo/media picker, contact handling
(opt-in), per-device config store.

**HandyFarm explicitly should NOT add:** multi-host coordination,
team/role auth, cloud-fleet catalog, anything AGPL-3.

## 4. Per-competitor observations

### 4.1 DeviceFarmer/STF (`openstf/stf`)

Dormant but historically the reference architecture. Patterns worth
borrowing:

- **Triadic service / provider / CLI shape.** HandyFarm is single-host
  so the provider/CLI part is overkill, but the *service* responsibility
  (per-device connection lifecycle) is what HandyFarm's tracker + worker
  pair is approximating. Verified by reading the audit checklist
  section in §3.2.
- **Status pills**: ready / offline / unauthorized / unplugged. HandyFarm
  has device / offline / unauthorized / weak-connection / disconnect /
  unknown. Worth keeping.
- **Search by attribute**: status, IMEI, ICCID, model, operator,
  group, presence. HandyFarm's Phase 6 FleetFilterBar adopted `status:`
  / `lease:` / `health:` / `model:` / `serial:` / `name:`. The
  `group:` token is reserved.
- **Booking system with time-bounded reservations**. STF's reservation
  flow is more granular than the current HandyFarm lease (which is a
  free-form heartbeat-with-TTL). Deferred per the brief.

Patterns NOT to borrow:

- AGPL-style licensing. STF is "Other / NOASSERTION" — actually clearer.
- Multi-host. Out of scope.
- Tri-process provider/CLI. Out of scope.

### 4.2 GADS (`shamanec/GADS`)

AGPL-3.0 — copyleft. **Do not import any GADS source into HandyFarm.**
What can be learned from the public architecture docs and demos:

- **Hub/Provider separation** — same as STF. Not relevant for
  single-host HandyFarm today.
- **Appium as primary test runtime**. HandyFarm chose Maestro; both are
  reasonable. Appium integration would add value (iOS path, broader
  ecosystem) but not a Phase-5 scope item.
- **Reservation workflow** — similar in spirit to HandyFarm's lease.

### 4.3 Appium Device Farm (`AppiumTestDistribution/appium-device-farm`)

Active. Apache-2.0 with obfuscated proprietary dashboard. The plugin
is what matters for HandyFarm:

- **Session allocation via plugin hooks** — a model HandyFarm does not
  need because it runs Appium nowhere.
- **Block / unblock semantics** — HandyFarm's quarantine is the same
  idea.
- **Auto-release on session end** — HandyFarm's `releaseLease(force=true)`
  in `runRegressionWithLease` does this.
- **Dashboard test-run reporting** — HandyFarm's audit table + the
  DeviceDetailModal Regression tab is a minimal version.
- **No manual device control** — HandyFarm's UI is the *opposite*
  choice: it's primarily a control panel with optional regression.
  Appium Device Farm is a test runner with optional control.

### 4.4 scrcpy-gui (SimonAKing)

Single-developer MIT. Patterns:

- **Multi-device card grid** — adopted in HandyFarm's Phase 6 row view.
- **Toggle-driven device configuration** — HandyFarm does not have a
  per-device config store yet; the `screen/Health/Audit/Regression`
  modal is a softer version.
- **Launch profiles per device** — flagged as future in
  `UI-AUDIT.md` §3.

### 4.5 OpenSTF-java-client

Reference only — Java client that talks to STF. Confirms the
OAuth + REST + provider separation STF ships. No new patterns.

## 5. Adoption classification (per the brief's rubric)

For each competitor capability above:

| Capability | Class | Why |
|---|---|---|
| STF: lease display inline | **Must build** (already done in Phase 6 `DeviceRow`) | Operator need; tiny scope. |
| STF: search-by-attribute with chips | **Must build** (already done in Phase 6 `FleetFilterBar`) | Same. |
| STF: tabbed device detail | **Must build** (already done in Phase 6 `DeviceDetailModal`) | Same. |
| STF: reservation system | **Useful later** | Free-form lease with TTL is sufficient for the single-host shop. |
| STF: triadic service/provider | **Not relevant to HandyFarm's scope** | Single-host. |
| STF: ADB protocol | **Useful later** | Adopting minicap / minitouch would let us ship lower-latency streaming. Out of scope this phase. |
| GADS: Appium integration | **Useful later** | Adds iOS + broader ecosystem; defer until we have a real iOS fleet. |
| GADS: Hub/Provider | **Not relevant to HandyFarm's scope** | Single-host. |
| Appium DF: block/unblock semantics | **Already adopted** as Phase 4 quarantine. |
| Appium DF: auto-release on test end | **Already adopted** — `releaseLease(force=true)` in `runRegressionWithLease`. |
| Appium DF: dashboard reporting | **Must build** — *just landed* as the Regression tab in the modal; we will need a real cross-device report before Phase 6 is done. |
| scrcpy-gui: launch profiles per device | **Useful later** | Needs per-device config store (DB schema). |
| scrcpy-gui: multi-device card grid | **Already adopted** (Phase 6 row view). |
| Multi-host coordination | **Not relevant to scope** | Single-host is the explicit product boundary. |
| AGPL adoption | **Reject** | Copyleft incompatible with HandyFarm's permissive stance. |
| Cloud-fleet catalog / marketplace devices | **Not relevant** | Explicit out-of-scope per `CONTEXT.md`. |

## 6. Honest verdict

HandyFarm does not need to compete with STF, GADS, or Appium Device
Farm head-on. Those products solve multi-host / multi-tenant / SaaS
problems that the brief explicitly excludes. The competition HandyFarm
*should* care about is:

- A solo developer with 2–10 Android phones on one workstation.
- They use HandyFarm instead of running adb by hand and staring at a
  scrcpy window.
- They want to verify regressions and see crash reports.

For this user, HandyFarm is genuinely useful today — provided the
audit's §4 critical findings are addressed (especially tracker leaks,
identity dedup, baseline persistence, IPC sender verification, and
companion signature verification). Once those are fixed, HandyFarm is
in a defensible position for the product it's already built for.

## 7. Product definition (Phase 3 of the brief)

After the audit, the product definition sharpens to:

> HandyFarm is a self-hosted Windows / macOS / Linux control panel for a
> single technical user who manages 2–20 Android devices connected to
> one workstation. It leases devices, runs regression flows, watches
> for crashes, and shows diffs — all without sending data outside the
> host. Out of scope: multi-host coordination, role-based auth, cloud
> catalogs, broad-storage or contacts harvesting. The companion APK is
> a thin identity + clipboard bridge, not an attacker. The Maestro CLI
> is the production regression runtime; the offline mini-flow runner is
> the development fallback.

If we cannot honestly support this, we narrow further to:
"HandyFarm is a desktop tool that watches a single connected Android
device, runs regression flows on it, and reports crashes to the local
user." Anything larger is a deferred feature with a documented
constraint.

## 8. Final recommendation

**Continue, but narrow.** Address the §4 critical findings, ship the
small Phase 5 implementation described in `ANDROID-AGENT-SPEC.md`,
verify on all 3 devices, then stop adding features until the audit's
fragile paths are stable. Multi-host, SaaS, AGPL, and cloud catalog
features stay out of scope.