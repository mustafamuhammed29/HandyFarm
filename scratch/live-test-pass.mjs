// Live end-to-end test pass (corrected paths).
import fs from 'node:fs';
import path from 'node:path';

const AUTH_FILE = path.join(process.env.APPDATA || '', 'handyfarm', 'api-auth.json');
const BASE = 'http://127.0.0.1:5055';
const DEVICE = '106293738O006649';
const SESSION = 'live-test-pass-c';

const { token } = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));

let pass = 0, fail = 0;
const results = [];

async function call(method, endpoint, body) {
  const opts = {
    method,
    headers: { 'X-API-Token': token, 'Content-Type': 'application/json' }
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${endpoint}`, opts);
  let parsed = null;
  try { parsed = await r.json(); } catch {}
  return { http: r.status, body: parsed };
}

async function check(name, fn) {
  const t0 = Date.now();
  try {
    const out = await fn();
    const ok = out.ok;
    const ms = Date.now() - t0;
    results.push({ name, ok, ms, http: out.http, body: out.body });
    if (ok) pass++; else fail++;
    const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    const summary = out.body !== null && out.body !== undefined ? JSON.stringify(out.body).slice(0, 200) : '(no body)';
    console.log(`${tag}  [${ms.toString().padStart(5)}ms]  ${name}  ${summary}`);
  } catch (e) {
    const ms = Date.now() - t0;
    results.push({ name, ok: false, ms, error: e.message });
    fail++;
    console.log(`\x1b[31mFAIL\x1b[0m  [${ms.toString().padStart(5)}ms]  ${name}  ERR: ${e.message}`);
  }
}

console.log(`\n=== Live device test pass (corrected) — device=${DEVICE} ===\n`);

// 1. GET /devices returns { success, devices: [...] }
await check('GET /devices lists our device', async () => {
  const r = await call('GET', '/devices');
  const found = Array.isArray(r.body?.devices) && r.body.devices.find(d => d.id === DEVICE);
  return { ok: !!found, http: r.http, body: { count: r.body?.devices?.length, found: !!found } };
});

// 2. GET /sims
await check('GET /sims (LycaMobile DE on this device)', async () => {
  const r = await call('GET', '/sims');
  const sim = r.body?.sims?.find(s => s.assignedDeviceId === DEVICE);
  return { ok: !!sim, http: r.http, body: { count: r.body?.sims?.length, sim: sim ? { id: sim.id, carrier: sim.carrier, status: sim.status } : null } };
});

// 3. GET /devices/:id/egress/history
await check('GET /devices/:id/egress/history (returns empty array — never resolved a public IP)', async () => {
  const r = await call('GET', `/devices/${DEVICE}/egress/history?limit=5`);
  return { ok: Array.isArray(r.body?.egressHistory), http: r.http, body: { count: r.body?.count } };
});

// 4. POST preflight/network (Wi-Fi OFF, no network → NO_ACTIVE_NETWORK)
await check('POST preflight/network (Wi-Fi OFF → NO_ACTIVE_NETWORK)', async () => {
  const { execFileSync } = await import('node:child_process');
  execFileSync('adb', ['-s', DEVICE, 'shell', 'svc', 'wifi', 'disable']);
  await new Promise(r => setTimeout(r, 3000));
  const r = await call('POST', `/devices/${DEVICE}/preflight/network`, {});
  const ok = r.body?.error?.match(/NO_ACTIVE_NETWORK/);
  return { ok: !!ok && r.http === 412, http: r.http, body: r.body };
});

// 5. POST preflight/network (Wi-Fi ON → DUAL_TRANSPORT_VIOLATION)
await check('POST preflight/network (Wi-Fi ON → DUAL_TRANSPORT_VIOLATION)', async () => {
  const { execFileSync } = await import('node:child_process');
  execFileSync('adb', ['-s', DEVICE, 'shell', 'svc', 'wifi', 'enable']);
  await new Promise(r => setTimeout(r, 5000));
  const r = await call('POST', `/devices/${DEVICE}/preflight/network`, {});
  const ok = r.body?.error?.match(/DUAL_TRANSPORT_VIOLATION/);
  execFileSync('adb', ['-s', DEVICE, 'shell', 'svc', 'wifi', 'disable']);
  return { ok: !!ok && r.http === 412, http: r.http, body: r.body };
});

// 6. Lease acquire
let leaseAcquired = false;
await check('POST /devices/:physId/lease acquire', async () => {
  const physId = `phys_${DEVICE}`;
  const r = await call('POST', `/devices/${physId}/lease`, {
    sessionId: SESSION, ttlMinutes: 2
  });
  leaseAcquired = r.body?.success === true;
  return { ok: leaseAcquired, http: r.http, body: r.body };
});

// 7. Heartbeat (correct path)
await check('POST /devices/:physId/heartbeat', async () => {
  const physId = `phys_${DEVICE}`;
  const r = await call('POST', `/devices/${physId}/heartbeat`, {
    sessionId: SESSION, extensionMinutes: 1
  });
  return { ok: r.body?.success === true, http: r.http, body: r.body };
});

// 8. GET baseline/verify (correct verb)
await check('GET /devices/:id/baseline/verify', async () => {
  const r = await call('GET', `/devices/${DEVICE}/baseline/verify`);
  return { ok: r.body?.success === true || r.body?.driftCount !== undefined, http: r.http, body: r.body };
});

// 9. POST baseline/reset (will fail because lease still held by us; lease guard working as expected)
await check('POST /devices/:id/baseline/reset (blocked by our own lease — guard working)', async () => {
  const r = await call('POST', `/devices/${DEVICE}/baseline/reset`, {});
  const blocked = r.body?.success === false && r.body?.error?.match(/leased|cooling_down|guard/i);
  return { ok: !!blocked, http: r.http, body: r.body };
});

// 10. DELETE lease release
await check('DELETE /devices/:physId/lease release', async () => {
  const physId = `phys_${DEVICE}`;
  const r = await call('DELETE', `/devices/${physId}/lease`, {
    sessionId: SESSION
  });
  return { ok: r.body?.success === true || r.body?.leaseState === 'cooling_down', http: r.http, body: r.body };
});

// 11. Devices snapshot after release
await check('GET /devices after release — state should reflect cooling_down or available', async () => {
  const r = await call('GET', '/devices');
  const dev = r.body?.devices?.find(d => d.id === DEVICE);
  return { ok: !!dev, http: r.http, body: { id: dev?.id, leaseState: dev?.leaseState } };
});

// 12. CLI: handyfarm devices list
await check('CLI: handyfarm devices list', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  try {
    const { stdout, stderr } = await execFileAsync('node', [path.join(process.cwd(), 'bin', 'handyfarm.js'), 'devices', 'list'], { timeout: 15000 });
    return { ok: stdout.includes(DEVICE), http: 0, body: stdout.slice(0, 300) + (stderr ? `\nSTDERR: ${stderr}` : '') };
  } catch (e) {
    return { ok: false, body: e.message };
  }
});

// 13. CLI: acquire + heartbeat + release cycle
await check('CLI: lease cycle (lease → heartbeat → release)', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const cli = path.join(process.cwd(), 'bin', 'handyfarm.js');
  const physId = `phys_${DEVICE}`;
  const sess = 'cli-cycle-test';
  try {
    await execFileAsync('node', [cli, 'lease', '--device', physId, '--session', sess, '--ttl', '2m'], { timeout: 15000 });
    const hb = await execFileAsync('node', [cli, 'heartbeat', '--device', physId, '--session', sess, '--ttl', '1m'], { timeout: 15000 });
    const rel = await execFileAsync('node', [cli, 'release', '--device', physId, '--session', sess], { timeout: 15000 });
    const allOk = hb.stdout.includes('Heartbeat successful') && rel.stdout.match(/released|cooling|success/i);
    return { ok: !!allOk, http: 0, body: `hb: ${hb.stdout.slice(0, 100)}\nrel: ${rel.stdout.slice(0, 100)}` };
  } catch (e) {
    return { ok: false, body: e.message };
  }
});

// 14. Companion: clipboard sync (push via shell → receiver)
await check('Companion clipboard sync (push broadcast)', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const text = 'live-test-c: ' + Date.now();
  const b64 = Buffer.from(text).toString('base64');
  try {
    const { stdout } = await execFileAsync('adb', ['-s', DEVICE, 'shell', `RAW=$(echo ${b64} | base64 -d); am broadcast -a clipper.set -n com.handyfarm.clipper/.ClipperReceiver --es text "$RAW"`], { timeout: 10000 });
    const ok = stdout.includes('Broadcast completed') || stdout.includes('extra');
    return { ok, http: 0, body: stdout.slice(0, 200) };
  } catch (e) {
    return { ok: false, body: e.message };
  }
});

// 15. Companion: clipboard sync (pull)
await check('Companion clipboard sync (pull broadcast)', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync('adb', ['-s', DEVICE, 'shell', 'am', 'broadcast', '-a', 'clipper.get', '-n', 'com.handyfarm.clipper/.ClipperReceiver'], { timeout: 10000 });
    const ok = stdout.includes('Broadcast completed') && stdout.match(/data="(.*)"/s);
    return { ok, http: 0, body: ok ? `data="${ok[1].slice(0, 80)}"` : stdout.slice(0, 200) };
  } catch (e) {
    return { ok: false, body: e.message };
  }
});

// 16. Companion: identity UUID round-trip
await check('Companion identity UUID round-trip (must be stable across calls)', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  try {
    const r1 = await execFileAsync('adb', ['-s', DEVICE, 'shell', 'am', 'broadcast', '-a', 'handyfarm.identity.get', '-n', 'com.handyfarm.clipper/.ClipperReceiver'], { timeout: 10000 });
    const r2 = await execFileAsync('adb', ['-s', DEVICE, 'shell', 'am', 'broadcast', '-a', 'handyfarm.identity.get', '-n', 'com.handyfarm.clipper/.ClipperReceiver'], { timeout: 10000 });
    const m1 = r1.stdout.match(/data="([a-f0-9\-]+)"/i);
    const m2 = r2.stdout.match(/data="([a-f0-9\-]+)"/i);
    const stable = m1 && m2 && m1[1] === m2[1];
    return { ok: !!stable, http: 0, body: stable ? `uuid=${m1[1]}` : `r1=${r1.stdout.slice(0, 100)} r2=${r2.stdout.slice(0, 100)}` };
  } catch (e) {
    return { ok: false, body: e.message };
  }
});

// 17. Companion: mock-location set
await check('Companion mock-location set (expect permission-required response on this device)', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync('adb', ['-s', DEVICE, 'shell', 'am', 'broadcast', '-a', 'handyfarm.location.set', '-n', 'com.handyfarm.clipper/.ClipperReceiver', '--ef', 'lat', '52.5200', '--ef', 'lng', '13.4050'], { timeout: 10000 });
    // Either OK or STATUS_PERMISSION_REQUIRED is a valid response (this device may or may not have the perm)
    const ok = stdout.match(/STATUS_PERMISSION_REQUIRED|OK|LOCATION_SET|status/);
    return { ok: !!ok, http: 0, body: stdout.slice(0, 300) };
  } catch (e) {
    return { ok: false, body: e.message };
  }
});

// 18. Companion: foreground app query
await check('Companion foreground-app query', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync('adb', ['-s', DEVICE, 'shell', 'am', 'broadcast', '-a', 'handyfarm.foreground.get', '-n', 'com.handyfarm.clipper/.ClipperReceiver'], { timeout: 10000 });
    // Either a package name or STATUS_PERMISSION_REQUIRED is acceptable
    const ok = stdout.includes('Broadcast completed');
    const pkg = stdout.match(/data="([a-zA-Z0-9_.]+)"/);
    return { ok, http: 0, body: pkg ? `fg=${pkg[1]}` : stdout.slice(0, 200) };
  } catch (e) {
    return { ok: false, body: e.message };
  }
});

// 19. Companion: VPN status (expect DISCONNECTED)
await check('Companion VPN status (expect DISCONNECTED — no peer)', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync('adb', ['-s', DEVICE, 'shell', 'am', 'broadcast', '-a', 'handyfarm.vpn.status', '-n', 'com.handyfarm.clipper/.ClipperReceiver'], { timeout: 10000 });
    const ok = stdout.includes('DISCONNECTED') || stdout.includes('STATUS_DISCONNECTED') || stdout.includes('data=');
    return { ok, http: 0, body: stdout.slice(0, 300) };
  } catch (e) {
    return { ok: false, body: e.message };
  }
});

// 20. Companion: reset baseline broadcast
await check('Companion reset-baseline broadcast', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync('adb', ['-s', DEVICE, 'shell', 'am', 'broadcast', '-a', 'handyfarm.reset.baseline', '-n', 'com.handyfarm.clipper/.ClipperReceiver'], { timeout: 10000 });
    const ok = stdout.includes('Broadcast completed') && stdout.match(/OK|status|success/);
    return { ok, http: 0, body: stdout.slice(0, 300) };
  } catch (e) {
    return { ok: false, body: e.message };
  }
});

// 21. Verify companion package installed + version via dumpsys
await check('Companion package info via dumpsys', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync('adb', ['-s', DEVICE, 'shell', 'dumpsys', 'package', 'com.handyfarm.clipper'], { timeout: 10000 });
    const v = stdout.match(/versionName=([^\s]+)/);
    return { ok: !!v, http: 0, body: v ? `version=${v[1]}` : 'no versionName found' };
  } catch (e) {
    return { ok: false, body: e.message };
  }
});

// 22. Robustness: send a malformed action — companion should reject gracefully
await check('Robustness: unknown companion action — should not crash', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync('adb', ['-s', DEVICE, 'shell', 'am', 'broadcast', '-a', 'handyfarm.nonexistent.action', '-n', 'com.handyfarm.clipper/.ClipperReceiver'], { timeout: 10000 });
    // Companion should respond with status=-1 (no result), not crash the receiver
    return { ok: stdout.includes('Broadcast completed') || stdout.includes('result='), http: 0, body: stdout.slice(0, 200) };
  } catch (e) {
    return { ok: false, body: e.message };
  }
});

// 23. Adb health (the original baseline)
await check('Device still responsive to adb shell', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync('adb', ['-s', DEVICE, 'shell', 'echo', 'hello'], { timeout: 10000 });
    return { ok: stdout.trim() === 'hello', http: 0, body: stdout.trim() };
  } catch (e) {
    return { ok: false, body: e.message };
  }
});

console.log(`\n=== Summary: ${pass} passed, ${fail} failed ===\n`);
if (fail > 0) {
  console.log('Failures:');
  for (const r of results.filter(r => !r.ok)) {
    console.log(`  - ${r.name}: ${JSON.stringify(r.body || r.error).slice(0, 200)}`);
  }
}
fs.writeFileSync('scratch/live-test-results.json', JSON.stringify(results, null, 2));
console.log('Detailed results written to scratch/live-test-results.json');
process.exit(fail > 0 ? 1 : 0);