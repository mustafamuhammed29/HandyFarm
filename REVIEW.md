# HandyFarm — Deep Technical Review

Reviewed against the working tree at `696ae46` ("Add Logcat viewer, device worker enhancements, and UI updates").
Scope: `electron/main.ts` (1149 lines), `electron/deviceWorker.ts` (185), `electron/preload.ts` (50),
`src/App.tsx` (1261), `src/components/LiveViewPoc.tsx` (299), `src/types.ts` (74), `package.json`, `README.md`.

---

## 0. Executive summary

**Your instinct about the VPN plan is the one place I'd push back hardest — but not in the direction you
expect.** The problem isn't that WireGuard is the wrong tool; it's that the WireGuard plan is aimed at
the *wrong problem*. "Device appears to be in Tokyo" is a four-part assertion (egress IP, timezone,
locale, **GPS**), and your plan only covers two of the four. The result will be devices claiming a
Japanese timezone over a Japanese IP while GPS reports your shop in Germany — an inconsistency that is
*itself* a strong fraud signal. Meanwhile the cheapest, most robust, completely undetectable solution
to 80% of geo-QA is a server-side test seam, which is a one-afternoon backend change.

**Three concrete bugs are shipping right now**, one of which breaks a feature you shipped in your last
commit (logcat). Details in §2.

**The single biggest thing standing between you and 20 devices is not the device tracker — it's
`saveDb()`.** You synchronously rewrite the entire JSON state file, including base64 PNG thumbnails for
every device, on every event. At 4 devices that's wasteful; at 20 it's a self-inflicted denial of
service. See §3.1.

**Do not adopt OpenSTF.** You already beat it on install complexity and day-to-day usability at this
scale. But there are six specific ideas worth stealing from it and its successors — listed in §4.

---

## 1. What you're doing better than the open-source field

Worth saying out loud, because the usual instinct is to assume you're behind:

- **Install complexity.** A one-click `Setup.exe` that a shop-floor operator can double-click. STF requires
  RethinkDB, ZeroMQ, protobuf, CMake, GraphicsMagick, node-jpeg-turbo, yasm, and 15 cooperating containers.
  For a 4-device shop, STF is a 3-day infrastructure project to build something you'd use 4 hours a week.
- **Embedded live view.** Most farms launch external `scrcpy` windows. You decode H.264 in-process via
  `@yume-chan/scrcpy-decoder-webcodecs` and paint to a canvas inside your own UI, bridged over a
  loopback WebSocket. That's genuinely better ergonomics for a single operator.
- **Multi-touch input injection** through the scrcpy control channel. Real farms historically needed
  separate minicap/minitouch binaries (STF still does).
- **Batch actions with placeholder substitution** and a distribution matrix — closer to what test
  operators actually need than "remote desktop for 160 devices" ever was.

---

## 2. Live defects (verified in the working tree)

### 2.1 `spawn` is not imported — the logcat viewer is dead

`electron/main.ts:5`
```ts
import { fork, ChildProcess, exec } from 'child_process';
```

`electron/main.ts:1104` and `:1110`
```ts
const activeLogcats = new Map<string, ReturnType<typeof spawn>>();
// ...
const proc = spawn('adb', ['-s', deviceId, 'logcat', '-v', 'time']);
```

`spawn` is never imported. At runtime this is a `ReferenceError`, caught by the surrounding
`try/catch`, surfaced to the renderer as `{ success: false, error: "spawn is not defined" }`.
`start-logcat` can never succeed. This was introduced in the most recent commit.

Also note the type annotation on line 1104 uses `ReturnType<typeof spawn>`, which should have been a
TypeScript compile error — which suggests the electron build isn't type-checking the main process.
Check `tsconfig.node.json` / the vite-plugin-electron build step; `tsc -b` in the build script may not be
covering `electron/`.

**Fix:** add `spawn` to the import; use `import type { ChildProcess }` and `ReturnType<typeof fork>`.

### 2.2 The packaged app cannot start live view — `ENOENT` on the scrcpy server jar

`electron/main.ts:503`
```ts
const serverBuffer = fs.readFileSync(path.join(process.cwd(), 'scrcpy-server-v2.4.jar'));
```

Two independent problems:
1. `process.cwd()` in a packaged Electron app is wherever the user happened to launch from, not the
   install directory. It must be something like `path.join(app.getAppPath(), 'resources', ...)`.
2. `package.json` `build.files` is `["dist/**/*", "dist-electron/**/*"]`. The jar sits at the repo root
   (confirmed: 69,007 bytes). **It is not in the packaged output at all.** `clipper.apk` (268,913 bytes,
   at root) has the same problem — so clipboard sync is also broken in the packaged build.

The "Option B: Final Packaged Version" path in your README — the one you tell shop staff to use —
loses your two most impressive features. This is exactly the kind of thing that only shows up when you
test the artifact instead of `npm run dev`.

**Fix:** move both into `resources/`, add `"resources/**/*"` to `files`, resolve with
`app.isPackaged ? app.getAppPath() : __dirname`.

### 2.3 Worker orphaning race — the map and reality desynchronize

`electron/main.ts:369-382`
```ts
worker.on('exit', (code) => {
  workers.delete(deviceId);        // <-- unconditional
  checkQueue();
  broadcastScreencapInterval();
  if (localDb[deviceId] && localDb[deviceId].status !== 'offline' && ...) {
    setTimeout(() => queueWorker(deviceId, localDb[deviceId].status), 2000);
  }
});
```

`retry-device` (`:397-434`) does:
```ts
existingWorker.kill();
workers.delete(deviceId);          // <-- also unconditional
// ...then queueWorker() -> spawnWorker() -> workers.set(deviceId, newWorker)
```

Sequence: retry kills worker A and deletes the entry, spawns worker B and registers it. Then A's
`exit` event fires **late** and calls `workers.delete(deviceId)` — deleting **B**. B is now running but
untracked: nothing can kill it, nothing pauses its screencap timer, `closeLiveView` can't reach it, and
`workers.size` under-reports. The next `queueWorker` call sees no worker and spawns C. You now have two
live workers per device, both hammering `screencap` every 10 seconds, doubling USB bandwidth and
permanently inflating `workers.size` until the queue stalls at `MAX_CONCURRENT_WORKERS = 8`.

This is exactly the failure mode that gets misdiagnosed as "USB is flaky" or "ADB is slow."

**Fix:** capture the worker reference in a closure and only mutate state if it is still the registered
one:
```ts
worker.on('exit', () => {
  if (workers.get(deviceId) === worker) workers.delete(deviceId);
  ...
});
```
Also add a monotonic generation counter per device so exit handlers from superseded generations are
ignored outright.

### 2.4 `Promise.race` doesn't cancel the losing ADB call

`electron/deviceWorker.ts:41-46`
```ts
const properties = await Promise.race([
  client.getDevice(deviceId).getProperties(),
  new Promise<never>((_, reject) => setTimeout(() => reject(...), 8000)),
]);
```

When the 8s timer wins, `getProperties()` keeps running and keeps its socket open on the ADB server.
On a hung device this leaks a socket per attempt, and `updateDeviceData` isn't re-entrant-safe — every
`STATUS_CHANGE` calls it again (`:170-172`), so a flapping device leaks repeatedly. At 20 devices this
is a slow ADB-server resource leak with no upper bound and no visibility.

### 2.5 `getShellProp` has no timeout and no error path

`electron/deviceWorker.ts:13-21` — if `adb shell getprop` hangs, the promise never settles,
`updateDeviceData()` never resolves, `DEVICE_DATA` is never sent, and the worker has no watchdog. The
tile renders as permanently blank with no error state. The `stream.on('error')` handler resolves `''`,
which then becomes `'Unknown'` — so a dead device and a slow device look identical in the UI.

### 2.6 `unauthorized` devices consume worker slots

`main.ts:155`, `:178`, `:217` all call `queueWorker()` for `device.type === 'unauthorized'`. The worker
spawns, immediately sees `status !== 'device'`, sends one message, and then idles forever on
`setInterval(() => {}, 3600000)`. It holds a slot against `MAX_CONCURRENT_WORKERS = 8` and does nothing.

Plug in 8 unauthorized devices and **zero** real devices get workers. Queue only `'device'`.

### 2.7 Logcat listener leak in the preload

`electron/preload.ts:41`
```ts
onLogcatData: (deviceId, callback) => {
  ipcRenderer.on(`logcat-data-${deviceId}`, (_event, data) => callback(data));
},
```
Unlike `onDevicesUpdated` (`:10`), this does **not** call `removeAllListeners` first. Every mount of
`LogcatViewer` adds another listener on the same channel. Switch devices repeatedly and you get
`MaxListenersExceededWarning` plus duplicated log lines. Add the `removeAllListeners` call.

### 2.8 `stay_on_while_plugged_in` is never restored on the common exit paths

The original value is captured at `main.ts:482-489` and restored **only** in the WebSocket `close`
handler at `:717-721`. But:

- `closeLiveView()` (`:440-460`) is called from `tracker.on('remove')` (`:199`) and from the dedupe
  eviction path (`:350`) — **neither restores the setting**.
- On app crash, quit, or `adb kill-server`, no restore runs.
- Reading it with `settings get global stay_on_while_plugged_in` can return `null`, which is then
  written back as the literal string `null`.
- Starting a second live view while one is open reads `3` as the "original" — the value you were about
  to restore becomes the corrupted state.

Net effect: devices drift into permanently-awake mode and the setting is never restored to a known-good
value. This is exactly the kind of slow state corruption that a device farm accumulates.

Move the save/restore into a device-scoped "session lease" with a shutdown hook (`app.on('before-quit')`)
and a reconciliation pass at startup.

### 2.9 Dedupe deletes user metadata

`main.ts:351`
```ts
delete localDb[idToKill];
```

When a device is seen over USB *and* Wi-Fi, the dedupe logic evicts one entry with a full `delete` —
destroying `customName`, `notes`, `tags`, and the last 50 `history` entries the operator has built up for
that physical device. The operator's carefully named "Shop Floor Unit 3 — camera focus bug" becomes an
anonymous auto-numbered tile every time it reconnects over Wi-Fi.

The intent (one tile per physical device) is right. The mechanism should be a **merge**, not a delete —
fold the doomed entry's metadata into the surviving entry, preferring non-empty values, then remove.

This also exposes the deeper issue in §3.2: the dedupe logic exists at all because the identity model is
wrong.

---

## 3. Architecture critique

### 3.1 The scale ceiling is `saveDb()`, not the tracker

`main.ts:96-98`
```ts
function saveDb() {
  fs.writeFileSync(dbPath, JSON.stringify(localDb, null, 2));
}
```

This is called from: every tracker `add`/`change`/`remove`, **every `DEVICE_DATA` worker message**, and
every `logAction`. `DEVICE_DATA` includes the screencap thumbnail as a base64 data URI
(`deviceWorker.ts:119-122`). A full-resolution `screencap` PNG is typically 200KB–1.5MB; base64 adds ~33%.
At 20 devices with a 10s interval you are **synchronously rewriting a 10–30MB JSON file roughly twice a
second**, on Electron's main thread, and then serializing that same 10–30MB object across IPC to the
renderer on every tick (`notifyUpdate`, `:386-391`).

The failure mode at 20 devices is not gradual degradation — the UI locks up, the ADB tracker starves,
workers get killed for being slow, and the auto-restart logic in §2.3 amplifies it into a fork bomb.

**Fix, in priority order:**
1. **Stop persisting thumbnails.** They're ephemeral view state, not device state. Keep them in a separate
   in-memory map (or a bounded LRU), never in `localDb`.
2. **Move to SQLite** (`better-sqlite3`, WAL mode). Device state is relational and you already have
   per-device sub-documents. This gives you atomic writes, indexed queries, and history tables for free.
3. **Send deltas over IPC**, not the full array. `devices-updated` should carry `{ id, patch }` messages.
4. **Downscale thumbnails** before they ever reach the DB or the renderer. A 240px-wide tile does not
   need a 1440×3120 PNG.
5. **Debounce writes** — coalesce to at most once per second, and flush on quit.

### 3.2 Identity is the root architectural problem

You key state by `device.id` (the ADB transport identifier) and treat `serial` as a dedupe afterthought.
This is why you need a startup dedupe pass, a runtime dedupe pass, a `lastKnownIp` reconnect loop, and a
"prefer USB" heuristic. **Those four mechanisms are all compensating for the same modeling error.**

`device.id` is not stable:
- USB: `11160b2a51ec0a02`
- Wi-Fi: `192.168.1.42:5555`

The same physical device has two identities. Everything downstream inherits that instability.

And `ro.serialno` — which you use as the dedupe key — is not reliable either. It returns empty on some
OEMs, is duplicated across units on others, and on some devices is writable via `setprop`.

**The right model:** assign your own stable `deviceId` at first contact, derived from hardware-stable
properties, and maintain an explicit mapping table:

```
physicalDeviceId (stable)  ->  { currentTransportId, lastSeenTransportId, serials[] }
```

Better source keys than `ro.serialno`, in rough order of reliability:
- `ro.boot.serialno` (survives more factory resets, less spoofable)
- A value from a companion APK you install (see §4.4 — this is the strongest option)
- A composite of `ro.product.device` + `ro.build.fingerprint` + a hardware serial
- The physical USB port path (works great, breaks on Wi-Fi)

This is exactly the problem **STF solved with `STFService.apk`** — a companion app installed on every
device that establishes identity and heartbeats independently of the ADB transport. See §4.4.

Also worth noting: you're already importing `stf-device-db` but only using it for a display name
(`deviceWorker.ts:76-84`). That database contains full device specifications — CPU, RAM, screen,
release date, ABI. Those are exactly the fields you need for the coverage matrix in §5.4.

### 3.3 One ADB client per device process is the wrong shape

`deviceWorker.ts:7`
```ts
const client = Adb.createClient();
```

Every worker opens its own connection to the ADB server on port 5037. At 20 devices that's 20 sockets,
20 independent connection lifecycles, and 20 sets of timers — all of which must be individually reasoned
about when the ADB server restarts.

STF's model is one long-lived **provider process** per host that owns the single ADB connection and
multiplexes work to devices. That's the right shape.

**Recommendation:** collapse to a single `deviceWorker` process that owns one ADB client and manages all
devices with a per-device state machine. You'll delete the fork/spawn/exit race in §2.3 as a side effect.
If you want process isolation for crash-resistance, shard — 4 processes × 5 devices — not 20 × 1.

While you're at it: consider evaluating [`appium-adb`](https://github.com/appium/appium-adb) as a
replacement for raw adbkit. It's a far more complete ADB wrapper (streaming installs, cached device list
with change events, logcat specifiers, `tcpip`/`openRemotePort`, `getProp` with caching, JPEG screenshot
optimization) and is battle-tested at far larger scale than adbkit.

### 3.4 The auto-reconnect loop is an unbounded process spawner

`main.ts:223-241` — every 15 seconds, for every device in the DB that is offline with a `lastKnownIp`:
```ts
await execAsync(`adb connect ${dev.lastKnownIp}:5555`);
```

At 20 devices where 15 are permanently gone, that's **60 `adb connect` process spawns per minute,
forever**, with no backoff, no failure counting, and no give-up. Each one is a shell + adb process.

Add exponential backoff with jitter, a failure counter, a hard give-up threshold that flips the device
to a `retired` state (user-visible, manually recoverable), and a cap on concurrent attempts. Use
`execFile` with an argument array.

### 3.5 Other tracker issues

- **Startup double-processing.** The startup scan (`main.ts:142-164`) calls `queueWorker` for devices
  that the tracker will *also* announce as `add`. Combined with `change` events, a single device can
  enter the queue multiple times in the first second.
- **`unauthorized` → `device` transitions** rely on a `change` event arriving. If it doesn't, the device
  sits with no worker until the operator hits Retry.
- **`notifyUpdate()` fires when `mainWindow` is null** (guarded, but) — after a window is recreated the
  renderer holds stale state until the next event, which for an idle fleet could be a long time.
- **No state machine.** Status strings are passed around as raw adb values (`'device'`, `'offline'`,
  `'unauthorized'`, `'disconnect'`) with ad-hoc comparisons. There's no notion of
  `available → leased → quarantined → maintenance` (§5.1).

---

## 4. Open-source landscape — what to borrow, what to ignore

### 4.1 DeviceFarmer / OpenSTF — borrow the ideas, don't adopt the software

[github.com/DeviceFarmer/stf](https://github.com/DeviceFarmer/stf) — 2.8k stars, last touched March 2025.
Originally built at CyberAgent to manage 160+ devices. Development stalled in July 2020 when the
original team abandoned it; it's been volunteer-maintained since.

Be honest about the current state: the last official release (v3.4.1) only supports up to Android 9,
it's pinned to Node 8/20-era dependencies, it needs RethinkDB + ZeroMQ + protobuf + GraphicsMagick +
node-jpeg-turbo, and it has 150+ open issues with incomplete Android 14/15 support. **Adopting it for a
4-device shop would be a serious mistake.** You would spend days on infrastructure to get something
strictly worse to use than what you already have.

The genuinely valuable part is that it's a well-documented record of how this problem is actually solved.
Six ideas worth taking:

1. **Provider process per host** — a dedicated ADB-owning daemon, separate from the control plane, so
   an ADB crash doesn't take down the UI. (§3.3)
2. **Booking and partitioning** — time-limited device reservation, and device sets partitioned by user
   or project. This is the single biggest missing primitive in HandyFarm. (§5.1)
3. **`STFService.apk`** — a companion app installed on each device. (§4.4)
4. **Stable provider-assigned device identity** decoupled from the ADB transport. (§3.2)
5. **Reverse port forwarding (`minirev`)** so a device can reach a server on your machine even across
   networks — invaluable for pointing a device under test at a local staging backend.
6. **A REST API from day one.** STF exposes a full REST API specifically so CI can drive it. Your only
   interface today is a GUI, which makes automation impossible. (§5.10)

### 4.2 GADS — closer to what you're actually building

[github.com/shamanec/GADS](https://github.com/shamanec/GADS) — 160 stars. A self-hosted alternative to
AWS Device Farm and Firebase Test Lab, with a Hub/Provider split, Appium test execution, and — most
relevant to you — **browser-based device streaming as a primary feature**, plus adb-tunnel for local
debugging against a remotely-controlled device. That's much closer to HandyFarm's shape than STF is.

Two things to steal: the **adb-tunnel** workflow (attach your local `adb` to a device you're driving
through the farm's UI, so your IDE and debugger work against a remote device), and the
**smart-TV / non-phone device** framing — if the shop ever tests on anything that isn't a phone, that
surface area is already built.

### 4.3 appium-device-farm — the allocation primitive you actually need

[github.com/AppiumTestDistribution/appium-device-farm](https://github.com/AppiumTestDistribution/appium-device-farm)
— 493 stars. An Appium 2.0 plugin that manages driver sessions against available devices.

The important idea is that **device allocation is a transactional, leased resource with timeouts and
automatic release.** Devices aren't just "present" or "absent" — they're allocated, held for a duration,
and returned to the pool when the session ends *or crashes*. If a test runner segfaults, the device must
still come back.

This is the missing abstraction in HandyFarm. Everything you'd build for "run a regression suite across
the fleet" depends on having it.

### 4.4 STFService.apk — the highest-leverage single idea

[github.com/DeviceFarmer/STFService.apk](https://github.com/DeviceFarmer/STFService.apk) — a companion
app installed on every device in the farm, explicitly *"not meant for actual user devices."*

This is the answer to several of your problems at once:
- **Stable device identity** that survives ADB transport changes (Wi-Fi ↔ USB ↔ reboot).
- **Heartbeat / liveness** independent of the ADB tracker, so you can distinguish "device is busy in a
  test" from "device died."
- **A channel to do things ADB cannot do reliably** on modern Android: read the clipboard without the
  clipper-broadcast hack you have at `main.ts:914`, observe which app is actually in the foreground,
  read precise location/GPS state, monitor thermal and battery events, and report app-level crash
  signals.
- **A place to run a "prepare device" reset** that clears permissions, Doze state, animations, and
  background restrictions to a known baseline.

You already ship a companion APK (`clipper.apk`) — you already have the distribution problem half-solved.
Generalizing it is a much smaller leap than adopting STF.

### 4.5 Maestro — the automation layer that fits your existing UX

[github.com/mobile-dev-inc/Maestro](https://github.com/mobile-dev-inc/Maestro) is the best current answer
to "regression orchestration across a fleet," and it composes unusually well with what you've built:

- YAML flows, no compilation step, framework-agnostic (works against your APK as-shipped, no instrumentation).
- **Built-in smart waiting** — every command retries against a fresh view hierarchy until it succeeds or
  times out. This eliminates the single largest source of mobile test flakiness, and it's the reason
  Maestro has largely displaced hand-rolled Appium scripts for smoke and critical-path suites.
- `maestro list-devices` and `maestro --device <id> test flow.yaml` — it discovers and targets devices
  through ADB, exactly like yours.
- `maestro test -e APP_ID=com.example.app` env substitution, which maps directly onto your existing
  `{serial}` / `{model}` placeholder system in the batch-action layer.
- The Android driver talks to an on-device `maestro-server.apk` over gRPC — same companion-APK pattern
  as STFService.

**The integration is obvious and high-value:** "select these 4 devices → run flow X → collect artifacts."
You already have the device selection UI. You need the lease (§5.1) and the API (§5.10), and then
Maestro becomes a one-button action.

### 4.6 Other references worth knowing

- **[code-root/emulator-android](https://github.com/code-root/emulator-android)** — an AVD farm built
  FastAPI + React with **per-device fingerprint profiles and per-device HTTP/SOCKS proxy as first-class
  device properties.** Directly relevant to your geo question: it treats "which IP does this device see"
  and "what does this device look like" as declarative device attributes, which is the right model.
- **[DeviceFarmer/docker-adb](https://github.com/DeviceFarmer/docker-adb)** — containerized ADB with udev
  rules. The pattern matters if you ever move off Windows or onto Linux, which is where ADB fleet tooling
  actually lives.
- **[budtmo/docker-android](https://github.com/budtmo/docker-android)** — prebuilt emulator images per
  API level with pre-installed tooling. Strong option for the emulator tier of the hybrid strategy in §6.4.
- **[Zebrunner Community Edition](https://github.com/zebrunner/community-edition)** — test
  orchestration and reporting layered on top of a fleet. Useful as a reference for result modeling if you
  want trends across runs rather than per-run results.
- **[microsoft/HydraLab](https://github.com/microsoft/HydraLab)** — performance/regression analysis for
  large device fleets. Worth a read if battery or performance testing becomes a priority.

---

## 5. Feature proposals

Ordered by value-per-effort. The first three are structural and I'd do them before any new feature.

### 5.1 Device leases and a real state machine *(structural, do first)*

Today a device is present or absent, and any operator can act on any device at any time. Introduce:

```
available → leased(by: session, until: T) → cooling_down → quarantined
                                        ↘ maintenance
```

With heartbeat-based auto-release: if the lease holder's process dies, the device returns to `available`
after a TTL rather than being stuck. This is `appium-device-farm`'s allocation model, and it is the
prerequisite for every automated feature below. Without it, a crashed test run permanently loses devices.

### 5.2 Health scoring and automatic quarantine

Track per device: `getProperties()` failure rate, thermal throttle events, unexpected reboots, charge
cycle count (battery swelling is a real shop-floor failure mode), USB reconnect frequency, and a rolling
flakiness score derived from test outcomes.

Then: **only lease healthy devices**, surface a "device health" view, and auto-quarantine anything that
fails thresholds with a clear reason. This is what makes a 20-device farm maintainable — you're not
scaling "devices," you're scaling "trustworthy devices," and the difference shows up as unattended
overnight runs that don't need a human to notice that unit 7 died at 2am.

### 5.3 Deterministic device fingerprints *(highest value per line of code)*

Capture a full fingerprint once, at enrollment, and store it:

```
model, manufacturer, ro.build.fingerprint, ro.boot.serialno, SDK level,
screen density + resolution, locales installed, timezone, GPU/GLES renderer,
sensor list, Play Services version, SELinux enforcing/permissive,
verified boot state, screen refresh rate, OEM skin version
```

This buys you four things:
- **Drift detection** — "device 3 OTA'd overnight and is no longer the device you baselined."
- **Reproducibility** — "reproduce last week's bug on the same device" means the same *configuration*,
  not just the same serial.
- **Coverage matrix** — a view showing you're testing 2× stock Android 14, 1× One UI 6.1, 1× HyperOS,
  with the gaps made explicit.
- **Crash correlation** — "this crash occurs only on Note 5 / SELinux enforcing / GLES 4.5."

You already have `stf-device-db` imported and are using maybe 5% of it.

### 5.4 Cross-device screenshot diffing

You screencap every device every 10 seconds. That's an unintentional but powerful signal you're
throwing away.

Build "golden state" baselines keyed by `(package, scenario, deviceFingerprintId)`. When a scenario runs
across N devices, diff them against each other and against the baseline:

1. **Normalize** — mask/blank the status bar clock, battery indicator, and notification shade.
2. **Fast candidate filter** — perceptual hash (pHash/dHash) to reject near-identical frames cheaply.
3. **Confirm** — SSIM or pixelmatch for the actual pixel diff on candidates.
4. **Present** — side-by-side plus a red heat-map overlay, and **group identical failures** so one root
   cause appearing on 6 devices is one entry, not six.

Diff *in the main process before persisting* — you're already decoding these buffers. This also gives you
free change detection: a device tile that suddenly renders differently is worth flagging.

### 5.5 Network condition simulation per device

The canonical approach is AOSP's [`NetworkSimulation.sh`](https://source.android.com/docs/automotive/tools/network-simulation)
(`tc` + `netem` + `ifb`), but it requires `adb root` and `setenforce 0` — heavy, and it destroys device
integrity (§6.3).

Get most of the value more cheaply:

- **Real network transitions, non-rooted** — `adb shell svc wifi disable` / `svc data disable` /
  `cmd connectivity airplane-mode enable`. Arguably *more* realistic than throttling, because it exercises
  the actual reconnection paths that break apps in production.
- **Host-side throttling** — a rate-limiting proxy (mitmproxy, or `tc netem` on the *host* NIC) so you
  never touch the device. Nothing on the device knows.
- **Per-app network denial** — `adb shell cmd netpolicy add restrict-background-uid <uid>`. This lets you
  test "what does the app do when background sync is blocked," which is a genuine and increasingly
  common Android 15 regression class, and it's a single non-rooted command.
- **DNS-level** — point devices at a local resolver you control to simulate NXDOMAIN, resolution
  failures, and slow authoritative responses. Catches a class of bugs that bandwidth throttling misses
  entirely.

### 5.6 Crash and ANR aggregation

Scraping `logcat` is the weak version. The strong version:

- `adb shell logcat -b crash -b events` → parse `am_crash` and `am_anr` events into structured records.
- `adb shell dumpsys dropbox --print` → `data_app_crash`, `data_app_anr`, `system_app_crash` — these
  **survive reboot**, unlike a live logcat stream.
- `adb shell dumpsys batterystats` and `dumpsys procstats` for ANR-adjacent signals.
- `adb bugreport` on anomaly for full context (expensive — trigger it, don't poll it).

Store as a matrix keyed by `(package, exception, appVersion, deviceFingerprintId)` so you get
cross-device crash clustering, not a wall of text. Then: "this crash is on 3/20 devices, all
One UI 6.1, all SDK 34" is an answer you can act on.

### 5.7 Battery and thermal soak testing

Unglamorous, and nobody in the open-source space does it well for a 4–20 device shop:

- `dumpsys batterystats --reset` → run scenario → `dumpsys batterystats --charged` → parse
  `Uid power use` for the app under test → compute mAh/hr.
- Thermal: `dumpsys thermalservice` or `/sys/class/thermal/thermal_zone*/temp` (the latter needs root).
- A scheduler that claims **idle** devices overnight, runs a defined scenario matrix, and emits a drain
  and thermal-throttle regression report against last night's baseline.

This is the kind of capability that justifies owning physical devices over renting cloud ones, and it's
a real differentiator for a shop doing battery-sensitive work.

### 5.8 Declarative device policy with reconciliation *(the Kubernetes model)*

Replace imperative buttons with declared policy, scoped to a device or a tag:

```yaml
devicePolicy: shop-floor-b
  timezone: Asia/Tokyo
  locale: ja-JP
  networkProfile: lte-300ms-1pct
  proxyProfile: jp-tokyo-residential-01
  stayAwake: true
  autoInstall: [qa-harness.apk, maestro-server.apk]
  airplaneMode: false
```

Plus a reconciler that converges actual → desired and **surfaces drift** in the UI. This is how the VPN
and timezone work stops being a pile of ad-hoc buttons and becomes composable, auditable fleet
configuration. The drift view alone will save you hours: "unit 3's timezone reverted to Europe/Berlin at
03:00 because NTP reasserted itself" is a bug class you will otherwise discover manually.

### 5.9 Environment normalization

Cross-device flakiness is dominated by state drift nobody is tracking: permission dialogs, Doze, battery
saver, background execution limits, notification permissions, dark mode, animations, autoplay.

A single **"prepare device"** action that resets all of it to a declared baseline is the highest
value-per-line code in this entire list. Compose it with §5.8 and every other test becomes reproducible.

### 5.10 A real API and CLI

Give HandyFarm a loopback-only REST API plus a `handyfarm` CLI:

```bash
handyfarm devices list
handyfarm lease --tag shop-floor-b --ttl 30m
handyfarm run flow.yaml --flow checkout-test.yaml
handyfarm artifacts ./out
```

This is the difference between a tool and a platform, it's what lets CI drive the farm, and it's the
prerequisite for Maestro integration (§4.5). STF and GADS both ship one; it's table stakes.

### 5.11 Power and USB topology as first-class state

You will hit USB bandwidth and power limits at 8–16 devices long before you hit CPU limits. The
screencap interval ramp in `getComputedInterval` (`main.ts:255-260`) is a band-aid over exactly this.

Make it a first-class concern: per-port current draw, powered-hub health, per-port enable/disable
switching, and a **bandwidth budget** per device that the scheduler respects. A device farm that
misbehaves mysteriously is almost always a power problem wearing a costume.

---

## 6. The VPN / geo-testing path — risks and a better plan

### 6.1 Your plan covers 2 of the 4 things that determine a device's apparent location

An app determines "where am I" from at least six independent signals:

| Signal | Does your plan change it? |
|---|---|
| Egress IP / IP geolocation | ✅ WireGuard |
| `TimeZone.getDefault()` / `persist.sys.timezone` | ✅ your `service call alarm` |
| Locale / language | ❌ not addressed |
| **GPS / FusedLocationProvider** | ❌ **not addressed** |
| Carrier MCC/MNC (SIM) | ❌ not addressed |
| Wi-Fi SSID / BSSID / network environment | ❌ not addressed |

Most geo-gated apps gate on **GPS**, which your plan does not touch. So the device reports a Tokyo
timezone and a Tokyo egress IP while GPS says "Europe/Berlin." That inconsistency is not a neutral
state — it is a *strong* signal to exactly the fraud-detection SDKs you'd be trying to satisfy (§6.3).

Mocking GPS on a non-rooted device requires a mock-location app holding `ACCESS_MOCK_LOCATION` with the
developer setting enabled, or a Play Services mock. That's a real project, and it's the missing half of
your geo story.

### 6.2 The timezone mechanism is right, but `alarm 3` is not portable

`setprop persist.sys.timezone` is the commonly-cited approach and it only takes effect **after a
reboot** — [StackOverflow](https://stackoverflow.com/questions/8062827/how-do-i-change-timezone-using-adb)
documents this repeatedly, and `service call alarm 3 s16 <tz>` is the standard workaround precisely
because it takes effect **immediately and broadcasts `ACTION_TIMEZONE_CHANGED`**, which is what apps
actually listen for. Your choice is correct.

But the `3` is the **transaction index of `setTimeZone()` in `IAlarmManager.aidl`** — an internal
implementation detail that varies by Android version and OEM skin. The same StackOverflow answer says so
explicitly: *"On my Android 11 system it is 'alarm 3 s16 America/Chicago', so please find the correct
IAlarmManager.aidl file for your OS version and find the index of setTimeZone()."* Hardcoding `3` across
a heterogeneous fleet running One UI, HyperOS, and stock Android 12–15 is a latent per-device failure
that will present as "the timezone command silently does nothing on that one phone."

**Three fixes, apply all of them:**
1. Disable NTP first, or it reverts your work: `settings put global auto_time_zone 0` and
   `settings put global auto_time 0`. Carina's `DeviceTimeZone.format` does exactly this sequence
   (`settings put global auto_time_zone 0` → `setprop persist.sys.timezone ...`), and it's the correct
   order.
2. Also set `settings put global time_zone <tz>`, which is the Settings-database path some OEM skins
   honor instead.
3. **Verify and fail loudly.** After setting, read back `getprop persist.sys.timezone` and
   `settings get global time_zone` and confirm they match. Treat a mismatch as a failed operation, not a
   success. A silent no-op here corrupts every downstream test result.

On the rooted path, `su -c date -s` — see §6.3 for why rooting is worse than it looks.

### 6.3 Rooting for date control destroys the reason you own physical devices

`MEETS_DEVICE_INTEGRITY` from the [Play Integrity API](https://developer.android.com/google/play/integrity/verdicts)
requires, on Android 13+, hardware-backed proof that **the bootloader is locked and the OS is a certified
manufacturer image**. A blank `deviceIntegrity` verdict means the device is rooted, tampered with, or an
emulator that doesn't pass checks.

So: **rooting a device to set the date invalidates the exact property that makes real-hardware testing
valuable.** Your rooted/non-rooted split is self-defeating for any app that gates on device integrity —
the rooted path produces a device that's *less* representative, not more.

The same applies to AOSP's own `NetworkSimulation.sh` network-throttling recipe, which starts with
`adb root` and `setenforce 0`.

### 6.4 VPN detection: a whitelisting problem, not a binary one

The argument *for* VPN is strong and real: Android's system HTTP proxy is **advisory, not enforced**.
Apps with custom HTTP stacks (OkHttp with an explicit proxy, Cronet, native sockets) ignore
`settings put global http_proxy` entirely — as does essentially anything not using the default
`ProxySelector`. Proxy authentication keys (`global_http_proxy_username` / `_password`) are only honored
from **Android 11+**, and the setting doesn't survive reboot. By contrast, `VpnService` is enforced at
the network layer: apps can't bypass it, and they never see a proxy configuration. [Fluxzy's Android
debugging writeup](https://www.fluxzy.io/resources/blogs/introducing-fluxzy-connect-android-http-debugging)
states this more directly than I can: *"Android doesn't have a mechanism to force all network traffic
through a proxy at the OS level… Unless you use a VPN."*

So the enforcement argument for VPN is correct. But **VPN is also visible**, and the visibility is
where the risk lives:

- `ConnectivityManager.getActiveNetwork()` reports `TRANSPORT_VPN`; any app can enumerate VPN interfaces.
- Commercial fraud SDKs check for this explicitly. A documented reverse-engineering writeup of a
  production SDK lists separate detection codes for `VPN_ENABLED_CODE` (*"VPN interface active"*),
  `VPN_CERT_DETECTION_CODE`, and — crucially — **`VPN_WHITELIST_BY_NETWORK_ADDRESS_CODE`**.
- The [Play Integrity API explicitly does *not* cover VPN detection](https://fingerprint.com/blog/google-play-integrity-apis/)
  (*"does not cover other aspects, like factory resets, VPN detection, or Frida detection"*) — that comes
  from commercial fraud vendors. So it *will* reach your app under test if that app uses one.

**The key insight: `VPN_WHITELIST_BY_NETWORK_ADDRESS_CODE` means production systems detect VPNs *and
allowlist them by IP address*.** VPN detection is a whitelisting problem, not a binary one. Which means
the dominant signal is **IP reputation**, not the presence of a tunnel interface. A clean, correctly-geolocated
residential IP is far less suspicious than a datacenter IP — and WireGuard exit nodes are, almost by
definition, datacenter IP ranges with known-VPN ASN attribution.

**This inverts the usual reasoning:** full-tunnel WireGuard from a VPS is *worse* for detection than a
per-app local VPN forwarding to a residential proxy, even though the latter sounds more complex.

### 6.5 What I'd build instead

Split the problem into two, because they have different right answers.

**Layer 1 — egress IP (needs a VPN or proxy):**
- Run **one** WireGuard or SOCKS5 daemon on the host. Give each device a *different upstream*, not a
  different tunnel. With a residential/mobile proxy provider's rotating pool, you get 20 distinct,
  geo-accurate, ISP-attributed egress IPs for a few dollars a month. With per-peer WireGuard, you need to
  **rent 20 servers** to get 20 IPs. That cost difference is the whole decision.
- Prefer **mobile carrier proxies** over residential-datacenter or VPN exit nodes. Better ASN type,
  closer to real user conditions, and much less likely to be on a blocklist.
- **Per-app split tunneling, not full tunnel.** A local `VpnService` app you control, with the app under
  test as the *only* included app. [WG Tunnel](https://github.com/wgtunnel/android) implements both
  per-app split tunneling and a "Local Proxy Mode" that exposes a tunnel as a local SOCKS5/HTTP proxy
  without claiming the VPN slot at all — the latter is useful if you need to compose with another
  firewall app.
- **This solves a self-lockout you haven't hit yet:** if you full-tunnel a device and route it over the
  network, `adbd`'s traffic goes through the tunnel too. If the tunnel drops, you lose ADB access to the
  device with no recovery path. Keep ADB on USB, or explicitly exclude the `com.android.shell` UID and
  the VPN's own traffic from the tunnel.
- **Make egress IP rotatable without touching the device.** A proxy you can re-point from the host beats a
  tunnel you have to reconfigure on each phone.

**Layer 2 — "device claims to be in country X" (needs a local VpnService app or root):**
- This is where a companion APK earns its keep. A small app you control can set a mock location provider,
  and can hold a per-app VPN without touching the system settings.

**Layer 3 — the actual QA goal (do this first, and you may not need the other two):**

**Most geo-QA bugs are not IP bugs.** Date formatting, currency symbols, DST boundaries, number
formatting, locale-specific sorting — these are *locale and timezone* problems, not network problems.
Those are cheap, reliable, and completely invisible to the app:

- `setprop persist.sys.timezone` + `service call alarm 3 s16` (with the read-back verification from §6.2)
- Per-app language via `cmd locale set-app-locales <pkg> --locales <tag>` (Android 13+), which is
  cleaner than a system-wide locale change and doesn't disturb the rest of the device
- Appium's `mobile: setDeviceLanguage` / `mobile: setDeviceTimezone` if you drive tests through Appium

**And if your app has a server-side geo gate — which is the common case — the correct fix is a
server-side test seam, not a network-layer hack.** A debug-only header, a forced-region override, or a
`X-Test-Region` on staging that the app under test can set. It's:

- **Completely undetectable** — there's no VPN, no proxy, no mock location, nothing to fingerprint.
- **Deterministic and instant** — no tunnel handshake, no external dependency, no flakiness.
- **One afternoon of backend work** versus weeks of fleet infrastructure.
- **Scales to 100 devices** for free, because it's a request header.

Every serious company does this. If the app you're testing is yours, push for it. If it isn't, it's
still the right recommendation to make.

**The decisive point:** WireGuard doesn't buy you "undetectable." It buys you "a different IP." If the
app under test is sophisticated enough to detect it, you have a problem that no amount of tunnel
sophistication solves — because that same app is sophisticated enough to detect the emulator you'd switch
to instead. The variable that actually matters is **IP reputation and behavioral consistency**, and
those are cheaper to fix elsewhere.

### 6.6 Legal and ToS exposure

The risk isn't the VPN. It's four adjacent things:

1. **The app's ToS.** Geo-spoofing to circumvent regional restrictions on a third party's app can breach
   their terms. If you're testing *your own* app, this is a non-issue. If you're testing a third party's,
   it's a real one, and in some jurisdictions anti-circumvention provisions have teeth.
2. **Your proxy provider's ToS.** Most explicitly forbid fraud, abuse, and ban-evasion. Residential pools
   in particular can be sourced from SDKs that opt users into monetization — the IP may have a fraud
   history attached. **Ask the provider directly whether their egress is suitable for QA traffic, and get
   it in writing.**
3. **Real financial rails.** If the app under test touches payments, a foreign egress IP can trip real
   risk controls and generate chargebacks against a real merchant account — your actual money.
4. **Data protection.** If you're exercising flows that create "EU residents" or collecting telemetry
   under a simulated identity, you're manufacturing personal-data processing obligations that don't
   exist today.

**Practical policy I'd adopt:**
- Keep all geo testing against a **staging backend**, never production you don't own.
- Ship a **kill switch** that reverts every device to direct egress in one action, and confirm it works.
- **Document** the geo-test policy: which apps, which providers, what data is created, who approved it.
- Run geo tests on a **dedicated device subset** (a tag), not the whole fleet — so a proxy provider
  problem can't take out your primary test bench.
- Never let geo state leak into a non-geo test run. Declarative policy (§5.8) with reconciliation
  handles this for free.

### 6.7 Emulator vs. physical — it's a hybrid, not a choice

The emulator case is stronger than the "invalidate my hardware" framing suggests. The Android 15+
emulator exposes a **gRPC control API** (`-grpc-use-token`, `-idle-grpc-timeout`) with deterministic
endpoints for `setLocation`, `setGps`, `setCellularSignalStrength`, and `setBandwidthLimit`. That's
precise, reproducible, scriptable, and has **no VPN fingerprint at all**. Google's own test
infrastructure is built on it. The classic `-netspeed` / `-netdelay` flags (GSM/GPRS/EDGE/UMTS/LTE/HSPA
profiles) remain available.

The emulator's weakness is the same one as rooting: Play Integrity returns `MEETS_VIRTUAL_INTEGRITY` or a
blank verdict, and modern apps detect emulators — via sensor plausibility, GPU/GLES renderer strings,
Play Integrity, and behavioral analysis. Sensor attestation in particular has gotten good.

But here's the thing that should decide it for you: **that same app will also detect your VPN.** The
detection surface is not meaningfully different. "Physical device + VPN" is not the safe middle ground
it appears to be — it's a physical device with an extra tell.

**So use both, for different jobs:**

| | Physical + controlled egress | Emulator + gRPC |
|---|---|---|
| Hardware realism, camera, sensors, RF | ✅ | ❌ |
| Play Integrity `MEETS_DEVICE_INTEGRITY` | ✅ (if not rooted) | ❌ |
| Deterministic location/network | ⚠️ messy | ✅ first-class |
| GPS mocking | ❌ needs a mock provider | ✅ built in |
| Packet loss / jitter | ❌ needs root or host proxy | ✅ `setBandwidthLimit` + host proxy |
| Flakiness | real-world | near-zero |
| Cost per device-month | ~$0 + cables + power | ~$0 software, real CPU/RAM |
| Scale | USB/power ceiling ~8–16/host | scales to whatever the host can run |

Emulators for the deterministic functional/geo/network matrix; physical devices for hardware-real and
integrity-passing coverage. Treat them as two tiers of one fleet, and let the lease system (§5.1) choose
which tier a test needs.

---

## 7. Security

Ordered by severity.

**7.1 `run-adb-command` is an unauthenticated remote shell exposed to the renderer.**
`main.ts:1061-1070` passes an arbitrary string straight to `client.getDevice(deviceId).shell(command)`.
Anything that can execute JavaScript in the renderer has a shell on every connected device. The renderer
loads `VITE_DEV_SERVER_URL` in dev and `file://` in prod, with no CSP. Gate this behind an explicit
"expert mode" with a typed allowlist, or remove it. This is the finding I'd fix first.

**7.2 `sandbox: false`.** `main.ts:101-107`. Prefer `sandbox: true` with a narrow preload. `contextIsolation`
defaults to true, so this isn't catastrophic today, but `sandbox: false` gives the preload full Node
access and there is no reason for it here.

**7.3 Eleven `execAsync` calls with string interpolation.** `main.ts:233, 484, 492, 493, 718, 939, 945, 956, 1089, 1091, 1201`.
`adb connect ${ip}` at `:1201` takes `ip` **directly from the renderer** — that's injection. Every one of
these should be `execFile('adb', ['-s', deviceId, 'shell', 'settings', 'put', ...])` with an argument
array. Argument arrays don't go through a shell; strings do.

**7.4 `sanitizeFreeText` is a blocklist.** `main.ts:750-754`. It strips `` ` ; & | `` and escapes
`$ ( ) " \`, but it's a denylist applied to shell-bound input, which is the wrong shape. It doesn't
handle newlines, and escaping inside double quotes is fragile. The robust fix is structural: stop
interpolating. For `input text`, pass arguments as an array; for arbitrary text, base64-encode and decode
on-device.

**7.5 `adb tcpip 5555` is unauthenticated network ADB.** `main.ts:939`. After `switch-to-wireless`, anyone
on the shop LAN has full unauthenticated access to that device. At 4 devices that's a nuisance; at 20 on
a shared network it's a serious exposure. Firewall it, or tunnel ADB over the existing USB connection
(GADS does the tunneling properly).

**7.6 VPN configs will be secrets, and your current storage pattern is a trap.** You're about to store
per-device WireGuard private keys. Note the existing pattern: `devices.json` is **plaintext**, and
`export-config` (`:836-850`) dumps the *entire* DB to a user-chosen path. You got the test-account
passwords right with `safeStorage` (`:1149-1161`) — apply the identical discipline to tunnel keys, from
day one, before the first config is written. Store only a key *reference* in `localDb`; keep the material
in `safeStorage`.

**7.7 Logcat is forwarded to the renderer unfiltered.** `main.ts:1110-1116`. Test account passwords,
session tokens, and PII in app logs land directly in the UI. Add redaction before forwarding.

**7.8 `import-config` merges unvalidated JSON.** `main.ts:852-869`. A malformed or hostile file can inject
arbitrary fields, set `status: 'device'` on fabricated devices, or resurrect deleted ones. Validate the
schema and reject unknown fields.

**7.9 Store notes will contain credentials.** `DeviceData.notes` is free text persisted in plaintext and
included in `export-config`. Worth an explicit warning in the UI, or encrypt the field.

---

## 8. Recommended order of work

1. **Fix the four live bugs:** `spawn` import (§2.1), jar/APK packaging (§2.2), worker orphan race (§2.3),
   `onLogcatData` listener leak (§2.7). Half a day; the first two are shipping-broken.
2. **Stop persisting thumbnails** and move state to SQLite (§3.1). This is the gate on everything else
   scaling past ~8 devices.
3. **Fix the timezone sequence** — disable NTP, set all three paths, verify by read-back, fail loudly
   (§6.2). Twenty minutes, and it makes the geo work trustworthy.
4. **Stabilize identity** (§3.2) and turn dedupe into a merge, not a delete (§2.9).
5. **Add device leases + state machine** (§5.1). Unblocks automation.
6. **Add the loopback REST API** (§5.10). Unblocks CI and Maestro.
7. **Build the companion APK** (§4.4) — identity, foreground app, mock location, reliable clipboard.
8. **Then** build the egress-IP layer, with per-app split tunneling, host-side rotation, and IP-reputation
   as the primary design constraint (§6.5). And push for the server-side test seam in parallel — it may
   make most of this unnecessary.
9. **Emulator tier** alongside physical (§6.7) for the deterministic matrix.

The two things I'd most encourage you to do *before* any of it: get a **second machine** in the picture
early (STF's provider model exists because one host's USB and power limits are a hard wall around 8–16
devices), and get **USB power delivery** sorted before you reach 8 devices. Most "the farm is flaky"
reports at this scale turn out to be power, not software.
