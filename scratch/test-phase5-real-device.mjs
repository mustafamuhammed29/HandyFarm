import { spawn, execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const PORT = 9223; // Use distinct port

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchCdpTarget() {
  for (let i = 0; i < 20; i++) {
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
  throw new Error('Could not connect to Electron CDP after 10s');
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

async function main() {
  console.log('===============================================================');
  console.log('   PHASE 5 REAL-DEVICE VERIFICATION: LEASE STATE MACHINE & GUARDS');
  console.log('===============================================================\n');

  console.log('1. Checking ADB attached devices...');
  const adbOut = execSync('adb devices').toString();
  console.log(adbOut.trim());
  if (!adbOut.includes('device\n') && !adbOut.includes('device\r\n')) {
    throw new Error('No online physical device found via ADB!');
  }

  console.log('\n2. Starting live Electron app with remote debugging...');
  const electronProc = spawn('npx', ['electron', '.', `--remote-debugging-port=${PORT}`], {
    cwd: rootDir,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  electronProc.stdout.on('data', (d) => {
    const str = d.toString();
    if (str.includes('[Lease') || str.includes('[POC]') || str.includes('[DeviceStore]')) {
      process.stdout.write(`  [Electron Stdout] ${str}`);
    }
  });

  electronProc.stderr.on('data', (d) => {
    const str = d.toString();
    if (str.includes('Error') || str.includes('Warn')) {
      process.stdout.write(`  [Electron Stderr] ${str}`);
    }
  });

  try {
    const wsUrl = await fetchCdpTarget();
    console.log('✓ Connected to Electron window CDP:', wsUrl);

    const cdp = new CdpClient(wsUrl);
    await cdp.waitOpen();

    // 1. Wait for live UI to render device
    console.log('\n[STEP 1] Waiting for live UI to load connected device...');
    let liveDevice = null;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const devices = await cdp.eval(`window.electronAPI ? window.electronAPI.getDevices() : []`);
      if (devices && devices.length > 0) {
        liveDevice = devices.find(d => d.status === 'device');
        if (liveDevice) break;
      }
    }

    if (!liveDevice) throw new Error('Live device not detected in Electron app!');
    console.log(`✓ Live device detected: ID=${liveDevice.id}, PhysID=${liveDevice.physicalDeviceId}, Initial Lease=${liveDevice.leaseState || 'available'}`);

    const physId = liveDevice.physicalDeviceId || `phys_${liveDevice.serial || liveDevice.id}`;

    // Verify initial badge in UI DOM
    const initialBadge = await cdp.eval(`
      (() => {
        const el = document.querySelector('.lease-badge');
        return el ? { text: el.textContent.trim(), className: el.className } : null;
      })()
    `);
    console.log('Initial UI DOM Lease Badge:', initialBadge);

    // 2. Test Lease Acquisition (TTL: 0.1 min = 6 seconds)
    console.log('\n[STEP 2] Acquiring lease for session "operator-session-alpha" (TTL: 6 seconds)...');
    const acquireRes = await cdp.eval(`
      window.electronAPI.acquireLease('${physId}', 'operator-session-alpha', 0.1)
    `);
    console.log('acquireLease result:', JSON.stringify(acquireRes));
    if (!acquireRes?.success) throw new Error(`acquireLease failed: ${acquireRes?.error}`);

    // Allow UI to process state delta broadcast
    await sleep(400);

    const leasedBadge = await cdp.eval(`
      (() => {
        const el = document.querySelector('.lease-badge');
        return el ? { text: el.textContent.trim(), className: el.className } : null;
      })()
    `);
    console.log('✓ UI DOM Lease Badge after acquisition:', leasedBadge);
    if (!leasedBadge?.className.includes('leased')) {
      throw new Error(`Expected badge class to contain 'leased', got: ${leasedBadge?.className}`);
    }

    // 3. Test Lease Collision / Rejection by another session
    console.log('\n[STEP 3] Testing lease collision rejection from a conflicting session...');
    const conflictRes = await cdp.eval(`
      window.electronAPI.acquireLease('${physId}', 'intruder-session-beta', 15)
    `);
    console.log('Conflicting acquireLease result:', JSON.stringify(conflictRes));
    if (conflictRes?.success) {
      throw new Error('Conflicting session should have been REJECTED, but succeeded!');
    }
    console.log(`✓ Conflicting lease acquisition correctly blocked: "${conflictRes?.error}"`);

    // 4. Test Destructive Action Guard (Block conflicting session)
    console.log('\n[STEP 4] Testing lease guard on destructive actions (send-text, reboot, etc.)...');
    const blockedAction = await cdp.eval(`
      window.electronAPI.sendText('${liveDevice.id}', 'test text', 'intruder-session-beta')
    `);
    console.log('Blocked action result (intruder session):', JSON.stringify(blockedAction));
    if (blockedAction?.success) {
      throw new Error('Destructive action from unauthorized session should have been REJECTED!');
    }
    console.log(`✓ Unauthorized action correctly rejected by lease guard: "${blockedAction?.error}"`);

    // Verify switch-to-wireless is blocked for intruder session
    const blockedWireless = await cdp.eval(`
      window.electronAPI.switchToWireless('${liveDevice.id}', 'intruder-session-beta')
    `);
    console.log('Blocked switchToWireless result:', JSON.stringify(blockedWireless));
    if (blockedWireless?.success) {
      throw new Error('switchToWireless from unauthorized session should have been REJECTED!');
    }
    console.log(`✓ Unauthorized switchToWireless correctly rejected: "${blockedWireless?.error}"`);

    // Verify sync-clipboard (toDevice and fromDevice) is blocked for intruder session
    const blockedClipTo = await cdp.eval(`
      window.electronAPI.syncClipboard('${liveDevice.id}', 'toDevice', 'injected text', 'intruder-session-beta')
    `);
    console.log('Blocked syncClipboard(toDevice) result:', JSON.stringify(blockedClipTo));
    if (blockedClipTo?.success) {
      throw new Error('syncClipboard(toDevice) from unauthorized session should have been REJECTED!');
    }
    console.log(`✓ Unauthorized syncClipboard(toDevice) correctly rejected: "${blockedClipTo?.error}"`);

    const blockedClipFrom = await cdp.eval(`
      window.electronAPI.syncClipboard('${liveDevice.id}', 'fromDevice', '', 'intruder-session-beta')
    `);
    console.log('Blocked syncClipboard(fromDevice) result:', JSON.stringify(blockedClipFrom));
    if (blockedClipFrom?.success) {
      throw new Error('syncClipboard(fromDevice) from unauthorized session should have been REJECTED!');
    }
    console.log(`✓ Unauthorized syncClipboard(fromDevice) correctly rejected: "${blockedClipFrom?.error}"`);

    // Authorized session should pass
    const allowedAction = await cdp.eval(`
      window.electronAPI.sendText('${liveDevice.id}', 'test', 'operator-session-alpha')
    `);
    console.log('Authorized action result (lease holder):', JSON.stringify(allowedAction));
    if (!allowedAction?.success) {
      throw new Error(`Lease holder action failed: ${allowedAction?.error}`);
    }
    console.log('✓ Authorized lease holder action successfully permitted!');

    // 5. Test Heartbeat / Extension
    console.log('\n[STEP 5] Testing lease heartbeat renewal...');
    const hbRes = await cdp.eval(`
      window.electronAPI.heartbeatLease('${physId}', 'operator-session-alpha', 0.1)
    `);
    console.log('heartbeatLease result:', JSON.stringify(hbRes));
    if (!hbRes?.success) throw new Error(`heartbeatLease failed: ${hbRes?.error}`);
    console.log('✓ Lease heartbeat renewal succeeded!');

    // 6. Test TTL Expiration & Automatic Release via Periodic Sweep
    console.log('\n[STEP 6] Letting TTL expire (waiting without heartbeat) to test automatic sweep release...');
    let expiredBadge = null;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      expiredBadge = await cdp.eval(`
        (() => {
          const el = document.querySelector('.lease-badge');
          return el ? { text: el.textContent.trim(), className: el.className } : null;
        })()
      `);
      if (expiredBadge?.className.includes('available')) break;
    }
    console.log('✓ UI DOM Lease Badge after TTL expiration & sweep:', expiredBadge);
    if (!expiredBadge?.className.includes('available')) {
      throw new Error(`Expected badge class to return to 'available', got: ${expiredBadge?.className}`);
    }
    console.log('✓ Device automatically returned to AVAILABLE state without any manual action!');

    // 7. Test Explicit Release with 5-Second Cooldown
    console.log('\n[STEP 7] Testing explicit release lifecycle with 5-second cooling_down grace period...');
    const reAcquire = await cdp.eval(`
      window.electronAPI.acquireLease('${physId}', 'operator-session-gamma', 5)
    `);
    console.log('Re-acquired lease:', JSON.stringify(reAcquire));
    if (!reAcquire?.success) throw new Error(`Re-acquisition failed: ${reAcquire?.error}`);

    await sleep(300);
    console.log('Calling explicit release-lease...');
    const releaseRes = await cdp.eval(`
      window.electronAPI.releaseLease('${physId}', 'operator-session-gamma')
    `);
    console.log('releaseLease result:', JSON.stringify(releaseRes));
    if (!releaseRes?.success) throw new Error(`releaseLease failed: ${releaseRes?.error}`);

    await sleep(400);
    const coolingBadge = await cdp.eval(`
      (() => {
        const el = document.querySelector('.lease-badge');
        return el ? { text: el.textContent.trim(), className: el.className } : null;
      })()
    `);
    console.log('✓ UI DOM Lease Badge during cooling_down period:', coolingBadge);
    if (!coolingBadge?.className.includes('cooling_down')) {
      throw new Error(`Expected badge class to be 'cooling_down', got: ${coolingBadge?.className}`);
    }

    // Verify destructive actions are blocked while cooling down
    const coolingBlocked = await cdp.eval(`
      window.electronAPI.sendText('${liveDevice.id}', 'test', 'operator-session-gamma')
    `);
    console.log('Action attempt during cooldown:', JSON.stringify(coolingBlocked));
    if (coolingBlocked?.success) {
      throw new Error('Action should have been blocked during cooling_down state!');
    }
    console.log(`✓ Cooldown guard correctly blocked action: "${coolingBlocked?.error}"`);

    console.log('Waiting for cooldown to finish and sweep to auto-transition to available...');
    let finalBadge = null;
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      finalBadge = await cdp.eval(`
        (() => {
          const el = document.querySelector('.lease-badge');
          return el ? { text: el.textContent.trim(), className: el.className } : null;
        })()
      `);
      if (finalBadge?.className.includes('available')) break;
    }
    console.log('✓ Final UI DOM Lease Badge after cooldown completion:', finalBadge);
    // 8. Test Idle Fleet Broadcast Silence (Verify no unconditional broadcasts every 2s)
    console.log('\n[STEP 8] Verifying idle-fleet broadcast silence (zero IPC overhead during idle ticks)...');
    console.log('Sampling idle state for 4.5 seconds (spans multiple 2-second sweep intervals)...');
    await sleep(4500);

    const idleUpdatedText = await cdp.eval(`
      (() => {
        const spans = Array.from(document.querySelectorAll('span'));
        const el = spans.find(s => s.textContent.includes('Last updated:'));
        return el ? el.textContent.trim() : null;
      })()
    `);
    console.log('UI Last Updated indicator after 4.5s idle period:', idleUpdatedText);
    const secondsMatch = idleUpdatedText?.match(/Last updated:\s*(\d+)s/);
    const elapsedSeconds = secondsMatch ? parseInt(secondsMatch[1], 10) : 0;
    if (elapsedSeconds < 3) {
      throw new Error(`Idle broadcast overhead detected! UI was updated ${elapsedSeconds}s ago, expected >= 3s without unconditional broadcasts.`);
    }
    console.log(`✓ Idle-fleet broadcast silence confirmed: UI idle time accumulated to ${elapsedSeconds}s without spurious delta broadcasts!`);

    cdp.close();
    console.log('\n===============================================================');
    console.log('   ALL PHASE 5 REAL-DEVICE VERIFICATION TESTS PASSED SUCCESSFULLY!');
    console.log('===============================================================\n');

  } finally {
    try {
      if (process.platform === 'win32' && electronProc.pid) {
        execSync(`taskkill /pid ${electronProc.pid} /T /F`, { stdio: 'ignore' });
      } else {
        electronProc.kill();
      }
    } catch {}
  }
}

main().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('\n❌ VERIFICATION TEST FAILED:', err);
  process.exit(1);
});
