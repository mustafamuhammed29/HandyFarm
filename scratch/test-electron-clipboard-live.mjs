import { spawn, execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const PORT = 9225;

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
  console.log(' LIVE ELECTRON INTEGRATION TEST: FIRST-PARTY CLIPPER IPC');
  console.log('===============================================================\n');

  const deviceId = '106293738O006649';
  console.log('1. Checking physical test device...');
  const adbOut = execSync(`adb devices`).toString();
  if (!adbOut.includes(deviceId)) {
    throw new Error(`Device ${deviceId} not found online!`);
  }
  console.log(`✓ Device ${deviceId} detected.\n`);

  console.log('2. Starting live Electron app with CDP on port ' + PORT + '...');
  const electronProc = spawn('npx', ['electron', '.', `--remote-debugging-port=${PORT}`], {
    cwd: rootDir,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  electronProc.stdout.on('data', (d) => {
    const str = d.toString();
    if (str.includes('[Clipper]') || str.includes('[IPC]') || str.includes('clipboard')) {
      process.stdout.write(`  [Electron] ${str}`);
    }
  });

  electronProc.stderr.on('data', (d) => {
    const str = d.toString();
    if (str.includes('Clipper') || str.includes('Error')) {
      process.stdout.write(`  [Electron Error] ${str}`);
    }
  });

  try {
    const wsUrl = await fetchCdpTarget();
    console.log('✓ Connected to Electron window CDP:', wsUrl);

    const cdp = new CdpClient(wsUrl);
    await cdp.waitOpen();
    await cdp.send('Runtime.enable');

    console.log('\n3. Waiting for UI initialization...');
    await sleep(2500);

    // Acquire lease for device first if needed
    console.log('4. Acquiring lease for device...');
    const leaseRes = await cdp.eval(`
      window.electronAPI.acquireLease('${deviceId}', 'e2e-clipboard-tester', 30000)
    `);
    console.log('  -> Lease acquire result:', JSON.stringify(leaseRes));
    const sessionId = leaseRes?.sessionId;

    console.log('\n5. Invoking syncClipboard (toDevice) with unique payload...');
    const payload = `HandyFarm-E2E-Token-${Date.now()}`;
    const syncToResult = await cdp.eval(`
      window.electronAPI.syncClipboard('${deviceId}', 'toDevice', '${payload}', '${sessionId}')
    `);
    console.log('  -> syncClipboard(toDevice) result:', JSON.stringify(syncToResult));
    if (!syncToResult?.success) {
      throw new Error(`syncClipboard toDevice failed: ${syncToResult?.error}`);
    }
    console.log('✓ syncClipboard(toDevice) succeeded!');

    console.log('\n6. Invoking syncClipboard (fromDevice)...');
    const syncFromResult = await cdp.eval(`
      window.electronAPI.syncClipboard('${deviceId}', 'fromDevice', '', '${sessionId}')
    `);
    console.log('  -> syncClipboard(fromDevice) result:', JSON.stringify(syncFromResult));
    if (!syncFromResult?.success) {
      throw new Error(`syncClipboard fromDevice failed: ${syncFromResult?.error}`);
    }
    console.log(`  -> Retrieved text from device: "${syncFromResult?.text}"`);
    if (syncFromResult?.text !== payload) {
      throw new Error(`Text mismatch! Expected: "${payload}", Got: "${syncFromResult?.text}"`);
    }
    console.log('✓ syncClipboard(fromDevice) matched expected payload with 100% fidelity!');

    console.log('\n7. Releasing lease...');
    await cdp.eval(`window.electronAPI.releaseLease('${deviceId}', '${sessionId}')`);

    cdp.close();
    console.log('\n===============================================================');
    console.log(' LIVE ELECTRON CLIPPER IPC INTEGRATION TEST PASSED!');
    console.log('===============================================================');
  } finally {
    electronProc.kill();
    try {
      execSync(`taskkill /F /PID ${electronProc.pid} /T`);
    } catch {}
  }
}

main().catch((err) => {
  console.error('\n❌ Live Electron test failed:', err);
  process.exit(1);
});
