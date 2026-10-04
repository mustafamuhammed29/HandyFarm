# UI Audit and Control-Panel Review

**Date:** 2026-10-04
**Scope:** `src/` — `App.tsx` (1791 LoC), `src/components/FleetHealthPanel.tsx`, `src/components/ClipperPanel.tsx`, device tiles, sidebar.
**References:** DeviceFarmer / OpenSTF (openstf/stf), scrcpy-gui (SimonAKing/scrcpy-gui, GeorgeEnglezos/Scrcpy-GUI).

This audit covers two things: (1) what the references do that HandyFarm does not, with concrete patterns cited; (2) what's wrong with the current control panel that no reference can fix (information density, hierarchy, redundancy).

---

## Step 1 — Patterns borrowed from open-source references

### From OpenSTF (`openstf/stf`)

1. **Per-device current-user + lease-expiry inline in the list row.** STF's device list shows: `device · present · user@example.com (expires in 4m 32s)`. Today's HandyFarm tiles only show a lease badge emoji and a hover title — the *countdown* is rendered inside the lease branch but the *holder* is shown as a plain label. When 20 devices are leased, an operator has to click into each one to know "who has it and when does it come back." → **Borrowed as:** the consolidated device-row view will show `holder + countdown` inline, replacing the emoji-prefixed lease badge.

2. **Multi-attribute search with field chips.** STF's search bar filters by phone-number, ICCID, IMEI, Android version, operator, model, group, and presence. The current HandyFarm search (a single `searchQuery` string + `showOffline` checkbox) does substring matching against a few fields; there's no field-targeted query (`lease:leased`, `health:degraded`). → **Borrowed as:** the new FleetFilterBar accepts `<field>:<value>` tokens (`status:device`, `lease:leased`, `health:degraded`, `model:LH7n`) plus a free-text query, with the matched chips shown next to the input.

3. **Color-coded status pills on each row with a single visual language.** STF uses a 5-color palette (`ready` green, `present` blue, `unavailable` gray, `unauthorized` orange, `unplugged` red) consistently across every surface (list row, detail header, activity log). HandyFarm uses five separate CSS variables (`--status-online`, `--status-warning`, `--status-error`, `--text-muted`, plus inline hex like `#facc15`, `#fb923c`) for what are conceptually four states. → **Borrowed as:** the new `--state-*` palette consolidates all five into one named system, and the inline hex in the health badge is replaced with named tokens.

4. **Tabbed control panes in device detail.** STF's detail view uses tabs: `Screen / Info / Shell / Logcat / Apps / Clipboard / Performance`. HandyFarm's sidebar has flat action sections (Selection, Batch App, Batch Data, …) that aren't tied to the focused device. There is no "Apps / Clipboard / Logcat / Performance" tab for the focused device; you click into the ClipperPanel which lives in the sidebar and is shared across all devices. → **Borrowed as:** the new DeviceDetailModal is per-device and tabbed: `Screen / Health / Audit / Regression`.

5. **Group / partition + filter context.** STF's top bar has a "group" picker (per-team partition) that scopes everything below it. HandyFarm has no notion of device groups; everything is a flat list. → **Deferred:** flagged as future. Not needed for the current 1-host single-fleet shop. The FleetFilterBar accepts a `group:` token already so the surface is reserved.

### From scrcpy-gui (SimonAKing/scrcpy-gui, GeorgeEnglezos/Scrcpy-GUI)

1. **Toggle-driven configuration per device.** scrcpy-gui shows a panel of toggle switches (record-screen, show-touches, stay-awake, OTG, virtual display) per device. HandyFarm's per-tile configuration is mostly invisible: zoom level and grid density are global; there is no per-device "show touches / record / OTG" toggle. → **Deferred:** would need a per-device config store. Flagged as future. The DeviceDetailModal's Screen tab exposes a `showTouches` toggle using the existing `textInput` IPC.

2. **Visual connection-state card on every device.** scrcpy-gui cards show a colored "unauthorized — tap to authorize" overlay with a hint. HandyFarm does this weakly: it shows a generic "Connecting…" overlay with a Retry button only on `weak-connection`. → **Borrowed as:** the DeviceDetailModal's Status header shows the *exact* reason for each non-`device` status (unauthorized / offline / weak-connection / disconnect), and a one-click "Authorize" action using the existing adb trust flow.

3. **Multi-select + "Launch selected".** scrcpy-gui lets you check N device cards and launch scrcpy on all of them at once. HandyFarm has `selectedIds` and "Mirror Input" — but the launch path is implicit (the live view always starts when the tile mounts). → **Borrowed as:** a top-bar "Launch regression on selected" button surfaces the Phase 5 regression pipeline against the current selection.

4. **Save profiles per device.** scrcpy-gui can save and reload a launch profile (resolution, bitrate, max-size) bound to a device. → **Deferred:** the existing global zoom / density controls cover the current scope. Profile persistence would need a new DB table.

5. **Process list / "what's running" panel.** scrcpy-gui shows a `ps -A` view filtered to the foreground app and running services. → **Deferred:** already partially implemented via the ClipperPanel's "Foreground app" reader. Not a new pattern.

---

## Step 2 — Control-Panel review (no reference can fix these)

### Information density problems

What is hidden behind clicks / hover / panels that should be visible at a glance in the row:

- **Quarantine reason.** `lease-badge.quarantined` says "Quarantined" with no reason. The reason is in `healthByPhysId[...].reasons[]` but only visible as a tile title tooltip. → Fix: show reason inline when state === 'quarantined', truncated to 40 chars with a "show full" hover.
- **Last regression result per device.** The audit table has it (`scheduler_audit` joined by `physicalDeviceId`), but the renderer never queries for it. → Fix: device-detail modal "Regression" tab. Not in the row (that's too dense already).
- **Battery level is visible, thermal state is not.** `power.ts` probes thermal state but no IPC exposes it. → Flagged as future backend plumbing, not a UI-only fix.
- **Active `runId` per device.** During a regression run, the orchestrator sets `leasedBy = 'regression-r-…'`. The lease badge already shows `leasedBy`. → No fix needed; the holder label does this.

### Image visibility at glance after fix

What changes for the operator when each of the above is addressed:

- **Quarantine reason inline in the row** — eliminates the "click into each device" pattern when triaging a fleet event.
- **DeviceDetailModal with Health tab** — one-click access to all reasons, audit, and regression history without scrolling the sidebar.

### Visual hierarchy issues

The current tile mixes four visual languages on the same row:

1. **Connection status** uses `var(--status-online|warning|error)` plus 4 different `lucide-react` icons (`CheckCircle2`, `AlertTriangle`, `XCircle`, `MinusCircle`).
2. **Lease state** uses the same `var(--status-*)` variables *but* the `.lease-badge` class has its own CSS background that defaults to `--status-online`, masking the connection status.
3. **Health score** uses **inline hex** (`#facc15`, `#fb923c`) that doesn't exist anywhere else in the codebase.
4. **Baseline status** uses a separate `.baseline-badge.verified|drifted|unbaselined` class with a different visual language (✓, ⚠, "No Baseline" text).

Result: an online, leased, degraded-health device with a verified baseline shows green-check + orange-quarantine-emoji + amber-heart-100 + green-check-baseline in the same 200-px row. The eye cannot triage this.

→ **Fix:** consolidate into a `--state-*` palette with five tokens (`healthy`, `leased`, `quarantined`, `offline`, `warning`), and route all four signals through the same palette. Inline hex is replaced.

### Dead / redundant UI surfaces

From an inventory of the sidebar's `action-section`s vs the data they touch:

| Section | Lines | Backend | Verdict |
|---|---|---|---|
| Selection (mirror input, import/export, batch delay) | 591–637 | none | **Move** to top-right toolbar dropdown. Not fleet-data-related. |
| Batch App & Files (apk drop, package, install) | ~485 | `install-apk`, `launch-app` | **Keep**, but add a "run regression on selected" CTA. Reuse for the new modal's `Regression` tab. |
| Batch Data Input (text to send) | ~440 | `text-input`, `sync-clipboard` | **Keep**, but move under a "Bulk actions" expander. |
| Clipper Companion | ~569 | `get-clipper-info`, `install-clipper` | **Consolidate** into the DeviceDetailModal "Apps" tab. The sidebar panel is an SCP work-around. |
| Fleet Health | ~793 | `get-fleet-health` | **Consolidate** into the FleetFilterBar as a live summary strip (4 numbers). |

The five sections become three: top toolbar (Selection + global toggles), per-device modal (Apps / Health / Audit / Regression), and FleetFilterBar (search + 4-stat summary).

### Responsiveness / layout

- Sidebar is fixed-width (no collapse below a minimum). At a 1024×768 window the sidebar eats 280 px and the tile grid starts at 200 px per tile; only ~3 tiles fit.
- Tile grid uses `repeat(auto-fill, fixed-px)` — never shrinks below 200 px.
- The DeviceDetailModal does not exist yet; once added, it must work at narrow widths.

→ **Fix:** add a sidebar collapse toggle that's already half-built (`sidebarPinned` state), and the new FleetFilterBar + DeviceDetailModal are designed to wrap at narrow widths.

---

## Step 3 — Triaged implementation plan

| Item | Effort | Value | Triaged? |
|---|---|---|---|
| FleetFilterBar (search + 4-stat strip + field chips) | M (3h) | H | **IN** — high signal-to-noise ratio; pure presentation |
| `--state-*` palette + replace inline hex in health badge | S (1h) | H | **IN** — removes the most obvious visual collision |
| Consolidated device-row compact list + lease TTL countdown | M (4h) | H | **IN** — directly addresses STF pattern #1 |
| DeviceDetailModal (tabs: Screen / Apps / Health / Audit / Regression) | L (6h) | H | **IN** — the centerpiece of the audit; this is what STF pattern #4 calls for |
| Component tests for filter / TTL / modal state | M (2h) | M | **IN** — required by the brief |
| Top-bar "Launch regression on selected" | S (1h) | M | **IN** — borrows scrcpy-gui pattern #3 |
| Dark/light theme audit | L (4h) | M | **OUT** — would need a design-system pass; current dark/light toggle is sufficient |
| Per-device config store (resolution, OTG, show-touches) | XL (1d) | M | **OUT (deferred)** — flagged in commit message as future; needs new DB schema |
| Device groups / partitions | XL (1d) | L | **OUT (deferred)** — single-fleet shop today; `group:` token reserved in filter |
| Battery / thermal in row | S (1h) | M | **OUT (backend flag)** — needs `probeDevicePower` result exposed over IPC; pure UI flag |
| Sidebar collapse below min-width | S (1h) | L | **OUT (low priority)** — single-user desktop tool; current sidebar already has a pin toggle |

Total estimated implementation effort: **~16 h**. Triaging out the bottom 6 saves an estimated **~9 h** of work that has lower signal-to-noise given the current scope.

---

## Report-back (filled in after implementation)

| Item | Status | Notes |
|---|---|---|
| FleetFilterBar | shipped | 8 tests |
| `--state-*` palette + inline-hex removal | shipped | 0 tests (pure CSS variable rename) |
| Consolidated device row + TTL countdown | shipped | 8 tests |
| DeviceDetailModal | shipped | 6 tests |
| "Launch regression on selected" CTA | shipped | 0 tests (delegates to existing run-regression) |
| Component tests | shipped | 22 component tests added in this pass |