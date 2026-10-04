import { spawn, execSync } from 'child_process';
import path from 'path';
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
  console.log('=== PHASE 4 LIVE ELECTRON APP VERIFICATION ===');
  console.log('Starting Electron with live ADB tracker and UI rendering...');

  // Disconnect any stale Wi-Fi connections before test start
  try { execSync('adb disconnect 172.20.10.2:5555'); } catch {}

  const electronProc = spawn('npx', ['electron', '.', `--remote-debugging-port=${PORT}`], {
    cwd: rootDir,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  electronProc.stdout.on('data', (d) => {
    const str = d.toString();
    if (str.includes('[Startup]') || str.includes('[Tracker') || str.includes('[Dedupe') || str.includes('[DeviceStore]') || str.includes('Device added:')) {
      process.stdout.write(`  [Electron Stdout] ${str}`);
    }
  });

  electronProc.stderr.on('data', (d) => {
    // process.stderr.write(d.toString());
  });

  try {
    const wsUrl = await fetchCdpTarget();
    console.log('\n✓ Connected to Electron window CDP:', wsUrl);

    const cdp = new CdpClient(wsUrl);
    await cdp.waitOpen();

    // 1. Wait for live UI to render device tile
    console.log('\n[STEP 1] Waiting for live UI to render initial USB device tile...');
    let initialDevices = [];
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      initialDevices = await cdp.eval(`window.electronAPI ? window.electronAPI.getDevices() : []`);
      if (initialDevices && initialDevices.length > 0 && initialDevices.some(d => d.status === 'device')) {
        break;
      }
    }

    console.log('Live App Devices:', JSON.stringify(initialDevices, null, 2));
    const usbDev = initialDevices.find(d => d.status === 'device');
    if (!usbDev) throw new Error('No physical USB device found in live Electron app!');
    console.log(`✓ USB device detected in running app: ID=${usbDev.id}, serial=${usbDev.serial}, physId=${usbDev.physicalDeviceId}`);

    // Check rendered tile count in DOM
    const initialTileCount = await cdp.eval(`document.querySelectorAll('.thumb-card').length`);
    console.log(`Rendered .thumb-card elements in live DOM: ${initialTileCount}`);
    if (initialTileCount !== 1) {
      throw new Error(`Expected exactly 1 rendered tile, found ${initialTileCount}`);
    }

    // 2. Set custom metadata on device through the live app
    console.log('\n[STEP 2] Setting custom name, notes, and tags in live app...');
    await cdp.eval(`
      window.electronAPI.updateDeviceData('${usbDev.id}', {
        customName: 'Live Farm Node Alpha',
        notes: 'Verified live in Electron UI without test script',
        tags: ['live-verified', 'farm-unit-1']
      })
    `);
    await sleep(1000);

    // Verify DOM shows custom name
    const liveCustomName = await cdp.eval(`
      (function() {
        const titleEl = document.querySelector('.thumb-card div[style*="font-weight: 600"]') || document.querySelector('.thumb-card');
        return titleEl ? titleEl.textContent : '';
      })()
    `);
    console.log(`Live DOM Tile Title: "${liveCustomName}"`);
    if (!liveCustomName.includes('Live Farm Node Alpha')) {
      throw new Error(`DOM does not display updated customName! Got: "${liveCustomName}"`);
    }
    console.log('✓ Custom name, notes, and tags visibly rendered in running UI');

    // 3. Switch device to Wi-Fi while live ADB tracker is running
    console.log('\n[STEP 3] Switching device to Wi-Fi (adb tcpip 5555 + adb connect)...');
    const targetIp = usbDev.lastKnownIp || '172.20.10.2';
    const wifiId = `${targetIp}:5555`;

    execSync(`adb -s ${usbDev.id} tcpip 5555`);
    await sleep(2000);

    console.log(`Connecting adb connect ${wifiId} while Electron live tracker is listening...`);
    const connOut = execSync(`adb connect ${wifiId}`).toString();
    console.log(`adb connect output: ${connOut.trim()}`);

    // Monitor live DOM every 100ms for 3 seconds to verify NO duplicate tiles ever appear
    console.log('\n[STEP 4] Monitoring live UI tile count over 3 seconds during Wi-Fi transition...');
    const tileCounts = [];
    const maxObservations = 30; // 3 seconds
    let duplicateDetected = false;

    for (let i = 0; i < maxObservations; i++) {
      await sleep(100);
      const count = await cdp.eval(`document.querySelectorAll('.thumb-card').length`);
      tileCounts.push(count);
      if (count > 1) {
        duplicateDetected = true;
        console.warn(`⚠️ DUPLICATE TILE DETECTED at frame ${i} (count=${count})!`);
      }
    }

    console.log('Tile counts recorded during transition (sampled @ 10Hz):', tileCounts.join(' '));
    if (duplicateDetected) {
      throw new Error('FAIL: Multiple tiles briefly appeared on screen during USB->Wi-Fi switch!');
    }
    console.log('✓ Zero duplicate tiles observed during live transition (strictly 1 tile at all times)!');

    // Inspect surviving device state in live app
    const devicesAfterWifi = await cdp.eval(`window.electronAPI.getDevices()`);
    console.log('\nLive Devices after Wi-Fi transition:', JSON.stringify(devicesAfterWifi, null, 2));

    const survivingWifiDev = devicesAfterWifi.find(d => d.id === wifiId);
    if (!survivingWifiDev) {
      throw new Error(`Surviving device ${wifiId} not found in live app devices!`);
    }
    if (survivingWifiDev.customName !== 'Live Farm Node Alpha') {
      throw new Error(`customName not merged into surviving Wi-Fi tile! Got: "${survivingWifiDev.customName}"`);
    }
    if (survivingWifiDev.notes !== 'Verified live in Electron UI without test script') {
      throw new Error(`notes not merged into surviving Wi-Fi tile! Got: "${survivingWifiDev.notes}"`);
    }
    if (!survivingWifiDev.tags || !survivingWifiDev.tags.includes('live-verified')) {
      throw new Error(`tags not merged into surviving Wi-Fi tile! Got: ${JSON.stringify(survivingWifiDev.tags)}`);
    }
    console.log('✓ Surviving Wi-Fi device retains customName, notes, and tags in live app state!');

    // Verify live DOM on surviving tile
    const wifiDomTitle = await cdp.eval(`
      (function() {
        const titleEl = document.querySelector('.thumb-card div[style*="font-weight: 600"]') || document.querySelector('.thumb-card');
        return titleEl ? titleEl.textContent : '';
      })()
    `);
    console.log(`Live DOM Tile Title after Wi-Fi switch: "${wifiDomTitle}"`);
    if (!wifiDomTitle.includes('Live Farm Node Alpha')) {
      throw new Error(`DOM does not display merged customName on Wi-Fi tile!`);
    }

    // 4. Reverse transition: Switch back to USB
    console.log('\n[STEP 5] Reverse transition: Disconnecting Wi-Fi to return to USB transport...');
    execSync(`adb disconnect ${wifiId}`);
    await sleep(2000);

    const tileCountsReverse = [];
    let reverseDuplicate = false;
    for (let i = 0; i < 30; i++) {
      await sleep(100);
      const count = await cdp.eval(`document.querySelectorAll('.thumb-card').length`);
      tileCountsReverse.push(count);
      if (count > 1) {
        reverseDuplicate = true;
      }
    }

    console.log('Tile counts recorded during reverse transition (sampled @ 10Hz):', tileCountsReverse.join(' '));
    if (reverseDuplicate) {
      throw new Error('FAIL: Multiple tiles briefly appeared on screen during reverse switch!');
    }

    const finalDevices = await cdp.eval(`window.electronAPI.getDevices()`);
    console.log('\nLive Devices after returning to USB:', JSON.stringify(finalDevices, null, 2));

    const survivingUsb = finalDevices.find(d => d.id === usbDev.id);
    if (!survivingUsb) {
      throw new Error(`USB device ${usbDev.id} not found after reverse transition!`);
    }
    if (survivingUsb.customName !== 'Live Farm Node Alpha') {
      throw new Error(`customName lost after reverse transition! Got: "${survivingUsb.customName}"`);
    }
    if (survivingUsb.notes !== 'Verified live in Electron UI without test script') {
      throw new Error(`notes lost after reverse transition! Got: "${survivingUsb.notes}"`);
    }

    const finalDomTitle = await cdp.eval(`
      (function() {
        const titleEl = document.querySelector('.thumb-card div[style*="font-weight: 600"]') || document.querySelector('.thumb-card');
        return titleEl ? titleEl.textContent : '';
      })()
    `);
    console.log(`Final Live DOM Tile Title: "${finalDomTitle}"`);
    if (!finalDomTitle.includes('Live Farm Node Alpha')) {
      throw new Error(`DOM does not display customName after reverse transition!`);
    }

    cdp.close();
    console.log('\n================================================================');
    console.log('✅ ALL LIVE ELECTRON APP VERIFICATIONS PASSED WITH ZERO FLICKER!');
    console.log('================================================================');
  } finally {
    try { execSync('adb disconnect 172.20.10.2:5555'); } catch {}
    electronProc.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error('\n❌ Live Verification Failed:', err);
  process.exit(1);
});
