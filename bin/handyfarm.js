#!/usr/bin/env node

/**
 * HandyFarm CLI (Phase 7)
 * Interacts with the HandyFarm Electron main process loopback REST API.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Parse command line arguments into command, subcommands, and flags
function parseArgs(args) {
  const flags = {};
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        flags[key] = args[i + 1];
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith('-')) {
      const key = arg.slice(1);
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        flags[key] = args[i + 1];
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

// Locate HandyFarm auth file in userData
function getAuthFilePath(customPath) {
  if (customPath) return path.resolve(customPath);
  if (process.env.HANDYFARM_AUTH_FILE) return path.resolve(process.env.HANDYFARM_AUTH_FILE);
  if (process.env.HANDYFARM_USER_DATA) return path.join(process.env.HANDYFARM_USER_DATA, 'api-auth.json');
  
  const appName = 'handyfarm';
  let base;
  if (process.platform === 'win32') {
    base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  } else if (process.platform === 'darwin') {
    base = path.join(os.homedir(), 'Library', 'Application Support');
  } else {
    base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  }
  return path.join(base, appName, 'api-auth.json');
}

// Load auth credentials
function loadAuth(customAuthPath) {
  const authPath = getAuthFilePath(customAuthPath);
  if (!fs.existsSync(authPath)) {
    console.error(`Error: HandyFarm API auth file not found at:\n  ${authPath}`);
    console.error('Please ensure the HandyFarm desktop app has been launched at least once.');
    process.exit(1);
  }

  try {
    const raw = fs.readFileSync(authPath, 'utf8');
    const data = JSON.parse(raw);
    if (!data.token) {
      throw new Error('Auth file is missing "token" property');
    }
    return {
      token: data.token,
      port: data.port || 5055,
      host: data.host || '127.0.0.1',
      authPath
    };
  } catch (err) {
    console.error(`Error reading HandyFarm auth file (${authPath}): ${err.message}`);
    process.exit(1);
  }
}

// Call loopback REST API
async function apiRequest(endpoint, options = {}, authConfig = {}) {
  const host = authConfig.host || '127.0.0.1';
  const port = authConfig.port || 5055;
  const token = authConfig.token;

  const url = `http://${host}:${port}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;
  const method = (options.method || 'GET').toUpperCase();
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    ...(options.headers || {})
  };

  let body;
  if (options.body && typeof options.body === 'object') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  } else if (options.body) {
    body = String(options.body);
  }

  try {
    const res = await fetch(url, {
      method,
      headers,
      body
    });

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }

    return {
      status: res.status,
      ok: res.ok,
      data: json
    };
  } catch (err) {
    if (err.code === 'ECONNREFUSED' || err.message.includes('ECONNREFUSED')) {
      console.error(`Error: Could not connect to HandyFarm REST API on http://${host}:${port}.`);
      console.error('Is the HandyFarm desktop application currently running?');
    } else {
      console.error(`Network error: ${err.message}`);
    }
    process.exit(1);
  }
}

// Parse TTL string like "30m", "1h", or "30" into integer minutes
function parseTtlMinutes(ttlStr) {
  if (!ttlStr) return 15;
  const str = String(ttlStr).trim().toLowerCase();
  if (str.endsWith('h')) {
    const hours = parseFloat(str.slice(0, -1));
    return isNaN(hours) ? 15 : Math.round(hours * 60);
  }
  if (str.endsWith('m')) {
    const mins = parseFloat(str.slice(0, -1));
    return isNaN(mins) ? 15 : Math.round(mins);
  }
  const val = parseFloat(str);
  return isNaN(val) ? 15 : Math.round(val);
}

// Generate default session id for CLI
function getDefaultSessionId() {
  const username = os.userInfo ? (os.userInfo().username || 'user') : 'user';
  return `cli-${username}`;
}

function printUsage() {
  console.log(`
HandyFarm CLI — Control and manage devices over the Loopback REST API

Usage:
  handyfarm <command> [options]

Commands:
  devices list                List all connected and known devices with lease states
  lease                       Acquire a lease on a device
    --device <id>               Physical device ID or transport ID (required)
    --ttl <minutes|e.g. 30m>    Lease duration (default: 15m)
    --session <id>              Lease session identifier (default: cli-<username>)

  release                     Release an active device lease
    --device <id>               Physical device ID or transport ID (required)
    --session <id>              Lease session identifier
    --force                     Force release regardless of session holder

  heartbeat                   Renew/extend an active lease
    --device <id>               Physical device ID or transport ID (required)
    --session <id>              Lease session identifier
    --ttl <minutes>             Extension in minutes

  shell                       Run an allowlisted diagnostic command on a device
    --device <id>               Device ID (required)
    --cmd "<command>"           Command string to execute (required)
    --session <id>              Session ID holding the lease (if device is leased)

  install                     Install an APK file onto a device
    --device <id>               Device ID (required)
    --apk <path>                Path to .apk file (required)
    --session <id>              Session ID holding the lease (if device is leased)

  artifacts                   Retrieve artifacts metadata placeholder
    --device <id>               Device ID (required)

  baseline capture            Capture baseline manifest for a device at a known-good moment
    --device <id>               Device ID (required)

  baseline verify             Verify device state against baseline, returning structured diff
    --device <id>               Device ID (required)

  baseline reset              Execute full verified reset to baseline state
    --device <id>               Device ID (required)
    --session <id>              Lease session ID (if device is leased)

  baseline show               Show stored baseline manifest for a device
    --device <id>               Device ID (required)

Global Options:
  --json                      Output raw JSON responses
  --auth-file <path>          Path to api-auth.json credential file
  --help, -h                  Display this help message

Examples:
  handyfarm devices list
  handyfarm baseline capture --device 106293738O006649
  handyfarm baseline verify --device 106293738O006649
  handyfarm baseline reset --device 106293738O006649
  handyfarm lease --device 106293738O006649 --ttl 30m
  handyfarm shell --device 106293738O006649 --cmd "getprop ro.build.version.release"
  handyfarm release --device 106293738O006649
`);
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const { positional, flags } = parseArgs(rawArgs);

  if (flags.help || flags.h || positional.length === 0 || positional[0] === 'help') {
    printUsage();
    process.exit(0);
  }

  const auth = loadAuth(flags['auth-file']);
  const primaryCmd = positional[0].toLowerCase();
  const subCmd = positional[1] ? positional[1].toLowerCase() : null;

  // 1. handyfarm devices [list]
  if (primaryCmd === 'devices') {
    const res = await apiRequest('/devices', { method: 'GET' }, auth);
    if (!res.ok) {
      console.error(`Error (${res.status}):`, res.data?.error || res.data);
      process.exit(1);
    }

    if (flags.json) {
      console.log(JSON.stringify(res.data, null, 2));
      return;
    }

    const devices = res.data.devices || [];
    if (devices.length === 0) {
      console.log('No devices currently registered in HandyFarm.');
      return;
    }

    console.log(`\nHandyFarm Devices (${devices.length}):\n`);
    const header = [
      'STATUS'.padEnd(10),
      'DEVICE ID'.padEnd(26),
      'PHYSICAL ID'.padEnd(28),
      'MODEL'.padEnd(16),
      'LEASE STATE'.padEnd(14),
      'LEASED BY'
    ].join(' ');
    console.log(header);
    console.log('-'.repeat(header.length + 15));

    for (const d of devices) {
      const leaseDisplay = d.leaseState || 'available';
      const leasedByDisplay = d.leasedBy ? `${d.leasedBy}` : '-';
      const modelDisplay = (d.customName || d.model || 'Unknown').slice(0, 15);
      console.log([
        (d.status || 'offline').padEnd(10),
        (d.id || '').padEnd(26),
        (d.physicalDeviceId || '').padEnd(28),
        modelDisplay.padEnd(16),
        leaseDisplay.padEnd(14),
        leasedByDisplay
      ].join(' '));
    }
    console.log();
    return;
  }

  // 2. handyfarm lease --device <id> [--ttl 30m] [--session <id>]
  if (primaryCmd === 'lease') {
    const deviceId = flags.device || flags.d || positional[1];
    if (!deviceId) {
      console.error('Error: --device <id> is required to acquire a lease.');
      process.exit(1);
    }

    const ttlMinutes = parseTtlMinutes(flags.ttl);
    const sessionId = flags.session || getDefaultSessionId();

    const res = await apiRequest(`/devices/${encodeURIComponent(deviceId)}/lease`, {
      method: 'POST',
      body: { sessionId, ttlMinutes }
    }, auth);

    if (flags.json) {
      console.log(JSON.stringify(res.data, null, 2));
      process.exit(res.ok ? 0 : 1);
    }

    if (!res.ok) {
      console.error(`\n[Lease Error] (${res.status}): ${res.data?.error || JSON.stringify(res.data)}\n`);
      process.exit(1);
    }

    const lease = res.data.lease;
    const expiresStr = lease?.leaseExpiresAt ? new Date(lease.leaseExpiresAt).toLocaleTimeString() : 'N/A';
    console.log(`\n✓ Lease acquired successfully for device '${deviceId}'`);
    console.log(`  State:      ${lease?.state}`);
    console.log(`  Session:    ${lease?.leasedBy}`);
    console.log(`  Expires At: ${expiresStr} (TTL: ${ttlMinutes}m)\n`);
    return;
  }

  // 3. handyfarm release --device <id> [--session <id>] [--force]
  if (primaryCmd === 'release') {
    const deviceId = flags.device || flags.d || positional[1];
    if (!deviceId) {
      console.error('Error: --device <id> is required to release a lease.');
      process.exit(1);
    }

    const sessionId = flags.session || getDefaultSessionId();
    const force = Boolean(flags.force);

    const res = await apiRequest(`/devices/${encodeURIComponent(deviceId)}/lease`, {
      method: 'DELETE',
      body: { sessionId, force }
    }, auth);

    if (flags.json) {
      console.log(JSON.stringify(res.data, null, 2));
      process.exit(res.ok ? 0 : 1);
    }

    if (!res.ok) {
      console.error(`\n[Release Error] (${res.status}): ${res.data?.error || JSON.stringify(res.data)}\n`);
      process.exit(1);
    }

    console.log(`\n✓ Lease released for device '${deviceId}'`);
    console.log(`  ${res.data.message || 'Device entered cooldown'}\n`);
    return;
  }

  // 4. handyfarm heartbeat --device <id> [--session <id>] [--ttl <mins>]
  if (primaryCmd === 'heartbeat') {
    const deviceId = flags.device || flags.d || positional[1];
    if (!deviceId) {
      console.error('Error: --device <id> is required for heartbeat.');
      process.exit(1);
    }

    const sessionId = flags.session || getDefaultSessionId();
    const extensionMinutes = flags.ttl ? parseTtlMinutes(flags.ttl) : undefined;

    const res = await apiRequest(`/devices/${encodeURIComponent(deviceId)}/heartbeat`, {
      method: 'POST',
      body: { sessionId, extensionMinutes }
    }, auth);

    if (flags.json) {
      console.log(JSON.stringify(res.data, null, 2));
      process.exit(res.ok ? 0 : 1);
    }

    if (!res.ok) {
      console.error(`\n[Heartbeat Error] (${res.status}): ${res.data?.error || JSON.stringify(res.data)}\n`);
      process.exit(1);
    }

    const expiresStr = res.data.leaseExpiresAt ? new Date(res.data.leaseExpiresAt).toLocaleTimeString() : 'renewed';
    console.log(`\n✓ Lease heartbeat renewed for device '${deviceId}'. New expiry: ${expiresStr}\n`);
    return;
  }

  // 5. handyfarm shell --device <id> --cmd "<command>" [--session <id>]
  if (primaryCmd === 'shell') {
    const deviceId = flags.device || flags.d || positional[1];
    const cmd = flags.cmd || flags.command || flags.c;

    if (!deviceId) {
      console.error('Error: --device <id> is required for shell command.');
      process.exit(1);
    }
    if (!cmd) {
      console.error('Error: --cmd "<command>" is required for shell command.');
      process.exit(1);
    }

    const sessionId = flags.session || undefined;

    const res = await apiRequest(`/devices/${encodeURIComponent(deviceId)}/shell`, {
      method: 'POST',
      body: { command: cmd, sessionId }
    }, auth);

    if (flags.json) {
      console.log(JSON.stringify(res.data, null, 2));
      process.exit(res.ok ? 0 : 1);
    }

    if (!res.ok) {
      console.error(`\n[Shell Error] (${res.status}): ${res.data?.error || JSON.stringify(res.data)}\n`);
      process.exit(1);
    }

    process.stdout.write(res.data.output || '');
    if (!res.data.output?.endsWith('\n')) console.log();
    return;
  }

  // 6. handyfarm install --device <id> --apk <path> [--session <id>]
  if (primaryCmd === 'install') {
    const deviceId = flags.device || flags.d || positional[1];
    const apkPath = flags.apk || flags.file || positional[2];

    if (!deviceId) {
      console.error('Error: --device <id> is required for install.');
      process.exit(1);
    }
    if (!apkPath) {
      console.error('Error: --apk <path> is required for install.');
      process.exit(1);
    }

    const resolvedApk = path.resolve(apkPath);
    const sessionId = flags.session || undefined;

    console.log(`Installing ${resolvedApk} onto device ${deviceId}...`);
    const res = await apiRequest(`/devices/${encodeURIComponent(deviceId)}/install`, {
      method: 'POST',
      body: { apkPath: resolvedApk, sessionId }
    }, auth);

    if (flags.json) {
      console.log(JSON.stringify(res.data, null, 2));
      process.exit(res.ok ? 0 : 1);
    }

    if (!res.ok) {
      console.error(`\n[Install Error] (${res.status}): ${res.data?.error || JSON.stringify(res.data)}\n`);
      process.exit(1);
    }

    console.log(`\n✓ ${res.data.message || 'Installation successful'}\n`);
    return;
  }

  // 7. handyfarm artifacts --device <id>
  if (primaryCmd === 'artifacts') {
    const deviceId = flags.device || flags.d || positional[1];
    if (!deviceId) {
      console.error('Error: --device <id> is required for artifacts.');
      process.exit(1);
    }

    const res = await apiRequest(`/devices/${encodeURIComponent(deviceId)}/artifacts`, {
      method: 'GET'
    }, auth);

    console.log(JSON.stringify(res.data, null, 2));
    process.exit(res.ok ? 0 : 1);
  }

  // --- Phase 1: Baseline CLI Commands ---

  const isBaselineCmd = primaryCmd === 'baseline' ||
    (primaryCmd === 'verify' && (flags.against === 'baseline' || positional[1] === 'baseline')) ||
    (primaryCmd === 'reset' && (flags.to === 'baseline' || positional[1] === 'baseline'));

  if (isBaselineCmd) {
    let subAction = positional[1] ? positional[1].toLowerCase() : '';
    if (primaryCmd === 'verify') subAction = 'verify';
    if (primaryCmd === 'reset') subAction = 'reset';
    if (primaryCmd === 'baseline' && !subAction) subAction = positional[2] || 'show';

    const deviceId = flags.device || flags.d || (primaryCmd === 'baseline' ? positional[2] : positional[1]);

    if (!deviceId) {
      console.error('Error: --device <id> is required for baseline operations.');
      process.exit(1);
    }

    // Capture Baseline
    if (subAction === 'capture') {
      console.log(`Capturing baseline manifest for device '${deviceId}'...`);
      const res = await apiRequest(`/devices/${encodeURIComponent(deviceId)}/baseline/capture`, {
        method: 'POST'
      }, auth);

      if (flags.json) {
        console.log(JSON.stringify(res.data, null, 2));
        process.exit(res.ok ? 0 : 1);
      }

      if (!res.ok) {
        console.error(`\n[Baseline Capture Error] (${res.status}): ${res.data?.error || JSON.stringify(res.data)}\n`);
        process.exit(1);
      }

      const m = res.data.manifest;
      console.log(`\n✓ Baseline manifest captured for device '${deviceId}' (${m.physicalDeviceId}):`);
      console.log(`  Captured At:      ${new Date(m.capturedAt).toLocaleString()}`);
      console.log(`  Model / Hardware: ${m.immutable?.model || 'unknown'} (${m.immutable?.screen?.size || 'unknown'})`);
      console.log(`  Packages Count:   ${m.mutable?.installedPackages?.length || 0} packages recorded`);
      console.log(`  Accounts Count:   ${m.mutable?.accounts?.length || 0} user accounts recorded\n`);
      return;
    }

    // Verify against Baseline
    if (subAction === 'verify') {
      console.log(`Verifying device '${deviceId}' against baseline...`);
      const res = await apiRequest(`/devices/${encodeURIComponent(deviceId)}/baseline/verify`, {
        method: 'GET'
      }, auth);

      if (flags.json) {
        console.log(JSON.stringify(res.data, null, 2));
        process.exit(res.ok ? 0 : 1);
      }

      if (!res.ok) {
        console.error(`\n[Baseline Verify Error] (${res.status}): ${res.data?.error || JSON.stringify(res.data)}\n`);
        process.exit(1);
      }

      const v = res.data;
      if (v.clockVerification) {
        const c = v.clockVerification;
        const status = c.bounded ? 'OK (NTP synced)' : 'WARNING: Out of bounds (> ±2000ms or auto_time off)';
        console.log(`  Clock verification: ${c.offsetMs}ms offset [${status}]`);
      }

      if (v.verified && v.diffs.length === 0) {
        console.log(`\n✓ Device '${deviceId}' verified against baseline with 0 drift.\n`);
      } else {
        console.log(`\n⚠ Device '${deviceId}' DRIFT DETECTED: ${v.diffs.length} field(s) drifted:\n`);
        console.log(`  ${'Field'.padEnd(45)} ${'Class'.padEnd(12)} ${'Expected'.padEnd(25)} ${'Actual'.padEnd(25)}`);
        console.log(`  ${'-'.repeat(45)} ${'-'.repeat(12)} ${'-'.repeat(25)} ${'-'.repeat(25)}`);
        for (const d of v.diffs) {
          const expStr = String(d.expected ?? 'null').slice(0, 24);
          const actStr = String(d.actual ?? 'null').slice(0, 24);
          console.log(`  ${d.field.padEnd(45)} ${d.drift_class.padEnd(12)} ${expStr.padEnd(25)} ${actStr.padEnd(25)}`);
        }
        console.log();
      }
      return;
    }

    // Reset to Baseline
    if (subAction === 'reset') {
      const sessionId = flags.session || undefined;
      console.log(`Executing full baseline reset on device '${deviceId}'...`);
      const res = await apiRequest(`/devices/${encodeURIComponent(deviceId)}/baseline/reset`, {
        method: 'POST',
        body: { sessionId }
      }, auth);

      if (flags.json) {
        console.log(JSON.stringify(res.data, null, 2));
        process.exit(res.ok ? 0 : 1);
      }

      if (!res.ok) {
        console.error(`\n[Baseline Reset Error] (${res.status}): ${res.data?.error || JSON.stringify(res.data)}\n`);
        process.exit(1);
      }

      console.log(`\n✓ Full baseline reset executed on device '${deviceId}':`);
      for (const act of (res.data.actions || [])) {
        console.log(`  • ${act}`);
      }

      if (res.data.verification) {
        const v = res.data.verification;
        console.log(`\n  Post-Reset Verification: ${v.verified ? 'PASSED (0 drift)' : `DRIFT REMAINING (${v.diffs.length} diffs)`}\n`);
      } else {
        console.log();
      }
      return;
    }

    // Show Baseline
    if (subAction === 'show' || subAction === 'get') {
      const res = await apiRequest(`/devices/${encodeURIComponent(deviceId)}/baseline`, {
        method: 'GET'
      }, auth);

      if (flags.json) {
        console.log(JSON.stringify(res.data, null, 2));
        process.exit(res.ok ? 0 : 1);
      }

      if (!res.ok) {
        console.error(`\n[Baseline Error] (${res.status}): ${res.data?.error || JSON.stringify(res.data)}\n`);
        process.exit(1);
      }

      console.log(JSON.stringify(res.data.manifest, null, 2));
      return;
    }
  }

  console.error(`Unknown command: '${primaryCmd}'. Run 'handyfarm --help' for usage.`);
  process.exit(1);
}

main().catch(err => {
  console.error('Unexpected CLI error:', err);
  process.exit(1);
});
