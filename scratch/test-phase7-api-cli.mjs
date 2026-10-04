import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const PORT = 9222;

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchCdpTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      const targets = await res.json();
      const page = targets.find(t => t.type === 'page' && !t.url.startsWith('devtools://'));
      if (page && page.webSocketDebuggerUrl) {
        return page.webSocketDebuggerUrl;
      }
    } catch {}
    await sleep(500);
  }
  throw new Error('Could not connect to Electron CDP after 15s');
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.reqId = 1;
    this.callbacks = new Map();
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && this.callbacks.has(msg.id)) {
        this.callbacks.get(msg.id)(msg);
        this.callbacks.delete(msg.id);
      }
    });
  }

  async waitOpen() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    return new Promise((resolve, reject) => {
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
    });
  }

  send(method, params = {}) {
    const id = this.reqId++;
    return new Promise((resolve) => {
      this.callbacks.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    return res.result?.result?.value;
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

function runCli(args) {
  const cliScript = path.join(rootDir, 'bin', 'handyfarm.js');
  try {
    const stdout = execSync(`node "${cliScript}" ${args}`, {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { status: 0, stdout };
  } catch (err) {
    return {
      status: err.status || 1,
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : err.message
    };
  }
}

async function main() {
  console.log('=====================================================');
  console.log('  PHASE 7 VERIFICATION: LOOPBACK REST API + CLI');
  console.log('=====================================================\n');

  // Verify physical device presence
  const adbDevicesOut = execSync('adb devices', { encoding: 'utf8' });
  console.log('Attached ADB devices:\n' + adbDevicesOut);
  const deviceMatch = adbDevicesOut.match(/([a-zA-Z0-9]+)\s+device\b/);
  if (!deviceMatch) {
    console.error('FAIL: No physical device in "device" state found!');
    process.exit(1);
  }
  const realDeviceId = deviceMatch[1];
  console.log(`✓ Real hardware device identified: ${realDeviceId}\n`);

  // Start real Electron app
  console.log('[STEP 1] Launching HandyFarm Electron application...');
  const electronProc = spawn('npx', ['electron', '.', `--remote-debugging-port=${PORT}`], {
    cwd: rootDir,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  electronProc.stdout.on('data', (d) => {
    const str = d.toString();
    if (str.includes('[API Server]') || str.includes('[Lease') || str.includes('BUILD CANARY')) {
      process.stdout.write(`  [Electron stdout] ${str}`);
    }
  });

  let cdp;
  try {
    const wsUrl = await fetchCdpTarget();
    console.log('✓ Electron app running and connected to CDP:', wsUrl);
    cdp = new CdpClient(wsUrl);
    await cdp.waitOpen();

    // Wait for UI to render device list
    console.log('\n[STEP 2] Waiting for GUI to render device card...');
    let devices = [];
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      devices = await cdp.eval(`window.electronAPI ? window.electronAPI.getDevices() : []`);
      if (devices && devices.some(d => d.id === realDeviceId && d.status === 'device')) {
        break;
      }
    }
    const liveDev = devices.find(d => d.id === realDeviceId);
    if (!liveDev) {
      throw new Error(`Device ${realDeviceId} not found in live GUI!`);
    }
    const physId = liveDev.physicalDeviceId || `phys_${realDeviceId}`;
    console.log(`✓ Device found in running GUI: ID=${realDeviceId}, PhysID=${physId}`);

    // Verify auth file generated in userData
    console.log('\n[STEP 3] Verifying auth token persistence in userData...');
    const authFilePath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'handyfarm', 'api-auth.json');
    if (!fs.existsSync(authFilePath)) {
      throw new Error(`Auth file was not created at expected location: ${authFilePath}`);
    }
    const authRaw = fs.readFileSync(authFilePath, 'utf8');
    const authData = JSON.parse(authRaw);
    console.log('✓ Auth file successfully read:', {
      host: authData.host,
      port: authData.port,
      tokenPrefix: authData.token.slice(0, 8) + '...',
      tokenLength: authData.token.length,
      createdAt: new Date(authData.createdAt).toLocaleTimeString()
    });

    if (authData.host !== '127.0.0.1') {
      throw new Error(`Host must be strictly 127.0.0.1, got: ${authData.host}`);
    }
    if (!authData.token || authData.token.length < 32) {
      throw new Error('Auth token must be high-entropy hex string >= 32 chars');
    }

    const apiBase = `http://${authData.host}:${authData.port}`;

    // Test unauthenticated request (must return HTTP 401)
    console.log('\n[STEP 4] Testing REST API loopback authentication enforcement...');
    const unauthRes = await fetch(`${apiBase}/devices`);
    console.log(`  Unauthenticated GET /devices status: ${unauthRes.status} (Expected: 401)`);
    if (unauthRes.status !== 401) {
      throw new Error(`Unauthenticated request should return 401, got ${unauthRes.status}`);
    }

    const badTokenRes = await fetch(`${apiBase}/devices`, {
      headers: { 'Authorization': 'Bearer bad-invalid-token-12345' }
    });
    console.log(`  Bad token GET /devices status: ${badTokenRes.status} (Expected: 401)`);
    if (badTokenRes.status !== 401) {
      throw new Error(`Bad token request should return 401, got ${badTokenRes.status}`);
    }

    // Test authenticated GET /devices
    const authRes = await fetch(`${apiBase}/devices`, {
      headers: { 'Authorization': `Bearer ${authData.token}` }
    });
    console.log(`  Authenticated GET /devices status: ${authRes.status} (Expected: 200)`);
    if (authRes.status !== 200) {
      throw new Error(`Authenticated request should return 200, got ${authRes.status}`);
    }
    const authJson = await authRes.json();
    console.log(`  Found ${authJson.count} device(s) via REST API. Success: ${authJson.success}`);
    const apiDev = authJson.devices.find(d => d.id === realDeviceId);
    if (!apiDev) {
      throw new Error(`Device ${realDeviceId} missing from REST API response`);
    }
    console.log(`  Device API data: ID=${apiDev.id}, PhysID=${apiDev.physicalDeviceId}, LeaseState=${apiDev.leaseState}`);

    // Test CLI: devices list
    console.log('\n[STEP 5] Testing CLI: handyfarm devices list...');
    const cliList = runCli('devices list');
    console.log('CLI output:\n' + cliList.stdout.trim());
    if (cliList.status !== 0 || !cliList.stdout.includes(realDeviceId)) {
      throw new Error('CLI devices list failed or did not include target hardware device');
    }
    console.log('✓ CLI devices list returned hardware device with lease state.');

    // Check initial GUI DOM lease badge
    console.log('\n[STEP 6] Inspecting initial GUI lease badge in DOM...');
    const initialBadgeText = await cdp.eval(`
      document.querySelector('.lease-badge') ? document.querySelector('.lease-badge').innerText : ''
    `);
    console.log(`  Current GUI badge text: "${initialBadgeText}"`);

    // Test CLI: acquire lease
    console.log('\n[STEP 7] Acquiring lease via CLI for 30m on real device...');
    const testSession = 'test-cli-agent-session';
    const cliLease = runCli(`lease --device ${realDeviceId} --ttl 30m --session ${testSession}`);
    console.log('CLI lease output:\n' + cliLease.stdout.trim());
    if (cliLease.status !== 0) {
      throw new Error(`CLI lease acquisition failed: ${cliLease.stderr}`);
    }
    console.log('✓ Lease acquired via CLI.');

    // Verify live GUI badge updated in real time without reload
    console.log('\n[STEP 8] Confirming lease reflected LIVE in GUI DOM badge (via delta IPC)...');
    let updatedBadgeText = '';
    let badgeClass = '';
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      updatedBadgeText = await cdp.eval(`
        document.querySelector('.lease-badge') ? document.querySelector('.lease-badge').innerText : ''
      `);
      badgeClass = await cdp.eval(`
        document.querySelector('.lease-badge') ? document.querySelector('.lease-badge').className : ''
      `);
      if (updatedBadgeText.includes(testSession) || badgeClass.includes('leased')) {
        break;
      }
    }
    console.log(`  Live GUI badge text: "${updatedBadgeText}"`);
    console.log(`  Live GUI badge class: "${badgeClass}"`);
    if (!badgeClass.includes('leased') || !updatedBadgeText.includes(testSession)) {
      throw new Error(`GUI badge failed to reflect live lease state! Text: "${updatedBadgeText}"`);
    }
    console.log('✓ GUI badge verified live: updated to leased state with session ID!');

    // Test Guard Enforcement: attempt action with CONFLICTING session
    console.log('\n[STEP 9] Attempting guarded actions via REST API with conflicting session...');
    const rogueSession = 'rogue-intruder-session';

    // 9a. Shell command with rogue session
    const rogueShellRes = await fetch(`${apiBase}/devices/${realDeviceId}/shell`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authData.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        command: 'getprop ro.product.model',
        sessionId: rogueSession
      })
    });
    const rogueShellJson = await rogueShellRes.json();
    console.log(`  Rogue shell command HTTP status: ${rogueShellRes.status} (Expected: 403)`);
    console.log(`  Rogue shell response:`, rogueShellJson);
    if (rogueShellRes.status !== 403 || !rogueShellJson.error?.includes('leased by session')) {
      throw new Error('Guarded shell endpoint failed to reject conflicting session with 403!');
    }
    console.log('  ✓ Conflicting shell command correctly rejected by checkDeviceLeaseGuard.');

    // 9b. Install APK with rogue session
    const rogueInstallRes = await fetch(`${apiBase}/devices/${realDeviceId}/install`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authData.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        apkPath: 'dummy.apk',
        sessionId: rogueSession
      })
    });
    const rogueInstallJson = await rogueInstallRes.json();
    console.log(`  Rogue install APK HTTP status: ${rogueInstallRes.status} (Expected: 403)`);
    console.log(`  Rogue install response:`, rogueInstallJson);
    if (rogueInstallRes.status !== 403 || !rogueInstallJson.error?.includes('leased by session')) {
      throw new Error('Guarded install endpoint failed to reject conflicting session with 403!');
    }
    console.log('  ✓ Conflicting install APK correctly rejected by checkDeviceLeaseGuard.');

    // 9c. Lease takeover attempt with rogue session
    const rogueLeaseRes = await fetch(`${apiBase}/devices/${realDeviceId}/lease`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authData.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sessionId: rogueSession,
        ttlMinutes: 10
      })
    });
    const rogueLeaseJson = await rogueLeaseRes.json();
    console.log(`  Rogue lease takeover HTTP status: ${rogueLeaseRes.status} (Expected: 409)`);
    console.log(`  Rogue lease takeover response:`, rogueLeaseJson);
    if (rogueLeaseRes.status !== 409) {
      throw new Error('Conflicting lease takeover should return 409 Conflict');
    }
    console.log('  ✓ Conflicting lease takeover correctly rejected with 409 Conflict.');

    // Test Authorized Action: Execute allowlisted shell command with OWNER session
    console.log('\n[STEP 10] Executing allowlisted shell command with lease owner session...');
    const ownerShellRes = runCli(`shell --device ${realDeviceId} --cmd "getprop ro.product.model" --session ${testSession}`);
    console.log('CLI shell output: ' + ownerShellRes.stdout.trim());
    if (ownerShellRes.status !== 0 || !ownerShellRes.stdout.includes('TECNO')) {
      throw new Error(`Owner shell execution failed: ${ownerShellRes.stderr}`);
    }
    console.log('✓ Allowlisted shell command succeeded for lease owner.');

    // Test Expert Mode Gating: Non-allowlisted command blocked
    console.log('\n[STEP 11] Executing non-allowlisted shell command (Expert Mode gating check)...');
    const blockedCmdRes = runCli(`shell --device ${realDeviceId} --cmd "rm -rf /data/local/tmp" --session ${testSession}`);
    console.log('CLI blocked command output/error: ' + (blockedCmdRes.stderr || blockedCmdRes.stdout).trim());
    if (blockedCmdRes.status === 0 || !(blockedCmdRes.stderr + blockedCmdRes.stdout).includes('Expert Mode is disabled')) {
      throw new Error('Non-allowlisted command should be blocked when Expert Mode is OFF!');
    }
    console.log('✓ Non-allowlisted command blocked by Phase 6 security gating.');

    // Test Artifacts endpoint
    console.log('\n[STEP 12] Testing artifacts endpoint...');
    const artifactsRes = runCli(`artifacts --device ${realDeviceId}`);
    console.log('CLI artifacts output:\n' + artifactsRes.stdout.trim());
    if (artifactsRes.status !== 0 || !artifactsRes.stdout.includes('Artifacts retrieval endpoint placeholder')) {
      throw new Error('Artifacts endpoint failed');
    }
    console.log('✓ Artifacts placeholder endpoint verified.');

    // Test CLI: Release lease
    console.log('\n[STEP 13] Releasing lease via CLI...');
    const cliRelease = runCli(`release --device ${realDeviceId} --session ${testSession}`);
    console.log('CLI release output:\n' + cliRelease.stdout.trim());
    if (cliRelease.status !== 0) {
      throw new Error(`CLI lease release failed: ${cliRelease.stderr}`);
    }
    console.log('✓ Lease released via CLI.');

    // Verify GUI badge enters cooling down
    console.log('\n[STEP 14] Confirming live GUI badge updates to cooling_down...');
    let cooldownBadge = '';
    for (let i = 0; i < 15; i++) {
      await sleep(200);
      cooldownBadge = await cdp.eval(`
        document.querySelector('.lease-badge') ? document.querySelector('.lease-badge').className : ''
      `);
      if (cooldownBadge.includes('cooling_down')) break;
    }
    console.log(`  Live GUI badge class during cooldown: "${cooldownBadge}"`);
    if (!cooldownBadge.includes('cooling_down')) {
      console.warn('  Warning: cooldown was fast or not caught, checking available transition next');
    } else {
      console.log('  ✓ GUI badge immediately reflected cooling_down state.');
    }

    // Wait for 5-second cooldown sweep to return to available
    console.log('\n[STEP 15] Waiting for cooldown period to elapse and auto-return to available...');
    let finalBadge = '';
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      finalBadge = await cdp.eval(`
        document.querySelector('.lease-badge') ? document.querySelector('.lease-badge').className : ''
      `);
      if (finalBadge.includes('available')) break;
    }
    console.log(`  Live GUI badge class after cooldown elapsed: "${finalBadge}"`);
    if (!finalBadge.includes('available')) {
      throw new Error(`GUI badge failed to auto-return to available! Class: "${finalBadge}"`);
    }
    console.log('✓ Cooldown sweep returned device to available state in live GUI!');

    console.log('\n=====================================================');
    console.log('  ALL PHASE 7 VERIFICATIONS PASSED SUCCESSFULLY!');
    console.log('=====================================================\n');

  } finally {
    if (cdp) cdp.close();
    console.log('Terminating test Electron process...');
    electronProc.kill('SIGINT');
    await sleep(1000);
    try {
      execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' });
    } catch {}
  }
}

main().catch(err => {
  console.error('\n❌ VERIFICATION TEST FAILED:', err);
  try {
    execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' });
  } catch {}
  process.exit(1);
});
