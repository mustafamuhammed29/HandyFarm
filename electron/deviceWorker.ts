import adbkit from '@devicefarmer/adbkit';
import deviceDbPkg from 'stf-device-db';
import { generatePhysicalDeviceId } from './identity.js';

const Adb = (adbkit as any).Adb || (adbkit as any).default?.Adb || (adbkit as any).default || adbkit;
const deviceDb = (deviceDbPkg as any).default || deviceDbPkg;

const client = Adb.createClient();

const deviceId = process.argv[2];
let status = process.argv[3];

// Helper: read a single getprop value via raw adb shell
async function getShellProp(prop: string): Promise<string> {
  const stream = await client.getDevice(deviceId).shell(`getprop ${prop}`);
  const chunks: Buffer[] = [];
  return new Promise((resolve) => {
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString().trim()));
    stream.on('error', () => resolve(''));
  });
}

// Helper: run a shell command and return trimmed output
async function getShellOutput(cmd: string): Promise<string> {
  const stream = await client.getDevice(deviceId).shell(cmd);
  const chunks: Buffer[] = [];
  return new Promise((resolve) => {
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString().trim()));
    stream.on('error', () => resolve(''));
  });
}

async function updateDeviceData() {
  if (status !== 'device') {
    // If not authorized or offline, send minimal status without overwriting valid serials
    process.send?.({
      type: 'DEVICE_DATA',
      data: {
        status,
        serial: deviceId.includes(':') ? undefined : deviceId
      }
    });
    return;
  }

  try {
    let model = '';
    let manufacturer = '';
    let serial = '';
    let bootSerial = '';
    let productDevice = '';
    let buildFingerprint = '';

    // --- Attempt 1: adbkit getProperties() with timing ---
    const t0 = Date.now();
    try {
      const properties = await Promise.race([
        client.getDevice(deviceId).getProperties(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('getProperties timeout after 8000ms')), 8000)
        )
      ]) as Record<string, string>;
      const elapsed = Date.now() - t0;
      console.log(`[Worker ${deviceId}] getProperties() succeeded in ${elapsed}ms`);
      model            = properties['ro.product.model']        || '';
      manufacturer     = properties['ro.product.manufacturer'] || '';
      serial           = properties['ro.serialno']             || '';
      bootSerial       = properties['ro.boot.serialno']        || '';
      productDevice    = properties['ro.product.device']       || '';
      buildFingerprint = properties['ro.build.fingerprint']    || '';
    } catch (propErr: any) {
      const elapsed = Date.now() - t0;
      console.warn(`[Worker ${deviceId}] getProperties() FAILED after ${elapsed}ms — error: ${propErr?.message || propErr}`);
      console.log(`[Worker ${deviceId}] Falling back to individual shell getprop calls...`);

      // --- Attempt 2: individual shell getprop calls ---
      try {
        [model, manufacturer, serial, bootSerial, productDevice, buildFingerprint] = await Promise.all([
          getShellProp('ro.product.model'),
          getShellProp('ro.product.manufacturer'),
          getShellProp('ro.serialno'),
          getShellProp('ro.boot.serialno'),
          getShellProp('ro.product.device'),
          getShellProp('ro.build.fingerprint'),
        ]);
        console.log(`[Worker ${deviceId}] Shell fallback succeeded: model=${model}, manufacturer=${manufacturer}, serial=${serial}, bootSerial=${bootSerial}`);
      } catch (shellErr: any) {
        console.error(`[Worker ${deviceId}] Shell fallback also FAILED: ${shellErr?.message || shellErr}`);
      }
    }

    // Final fallbacks
    model        = model        || 'Unknown';
    manufacturer = manufacturer || 'Unknown';
    serial       = serial       || (deviceId.includes(':') ? '' : deviceId);

    // Query companion app UUID if hardware serials are empty or suspect
    let companionUuid: string | undefined = undefined;
    const isSuspectVal = (s?: string) => !s || s.trim().toLowerCase() === 'unknown' || s.trim().toLowerCase() === '0123456789abcdef' || s.trim().length < 3;
    if (isSuspectVal(bootSerial) && isSuspectVal(serial)) {
      try {
        const out = await getShellOutput('am broadcast -a handyfarm.identity.get -n com.handyfarm.clipper/.ClipperReceiver');
        const m = out.match(/data="([a-f0-9\-]+)"/i);
        if (m && m[1]) {
          companionUuid = m[1];
          console.log(`[Worker ${deviceId}] Retrieved companion identity UUID: ${companionUuid}`);
        }
      } catch {}
    }

    // Compute stable hardware physicalDeviceId
    const physicalDeviceId = generatePhysicalDeviceId({
      bootSerial,
      serial: serial || undefined,
      productDevice,
      buildFingerprint,
      companionUuid,
    });

    // Detect IP address
    let lastKnownIp: string | undefined = undefined;
    if (deviceId.includes(':')) {
      lastKnownIp = deviceId.split(':')[0];
    } else {
      try {
        const routeOut = await getShellOutput('ip route');
        const m = routeOut.match(/src\s+(\d+\.\d+\.\d+\.\d+)/);
        if (m && m[1]) {
          lastKnownIp = m[1];
        }
      } catch {}
    }

    let deviceName = model;
    // Use stf-device-db if possible
    try {
      const dbEntry = (deviceDb as any)[model];
      if (dbEntry) {
        deviceName = dbEntry.name;
      }
    } catch (e) {
      console.error('Failed to lookup device in stf-device-db', e);
    }

    console.log(`[Worker ${deviceId}] Sending DEVICE_DATA: model=${model}, serial=${serial}, physicalId=${physicalDeviceId}, status=${status}`);
    process.send?.({
      type: 'DEVICE_DATA',
      data: {
        status,
        model,
        manufacturer,
        serial: serial || undefined,
        physicalDeviceId,
        lastKnownIp,
        name: deviceName,
      }
    });

  } catch (err: any) {
    console.error(`[Worker ${deviceId}] Critically failed: ${err?.message || err}`);
    process.send?.({
      type: 'DEVICE_DATA',
      data: { status: 'error', serial: deviceId }
    });
  }
}

// Periodic Screenshot
let screenshotInterval: NodeJS.Timeout | null = null;

async function takeScreenshot() {
  if (status !== 'device') return;
  try {
    const stream = await client.getDevice(deviceId).screencap();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      const buffer = Buffer.concat(chunks);
      process.send?.({
        type: 'SCREENSHOT_FRAME',
        buffer
      });
    });
  } catch (e) {
    // console.error(`Failed to capture screen for ${deviceId}`, e);
  }
}

// Initial fetch
updateDeviceData();
setTimeout(takeScreenshot, 2000);

let batteryInterval: NodeJS.Timeout | null = null;
async function checkBattery() {
  if (status !== 'device') return;
  try {
    const stream = await client.getDevice(deviceId).shell('dumpsys battery');
    const buffer = await Adb.util.readAll(stream);
    const output = buffer.toString();
    
    const levelMatch = output.match(/level:\s*(\d+)/);
    const acMatch = output.match(/AC powered:\s*(true|false)/);
    const usbMatch = output.match(/USB powered:\s*(true|false)/);
    const wirelessMatch = output.match(/Wireless powered:\s*(true|false)/);
    const statusMatch = output.match(/status:\s*(\d+)/);
    
    if (levelMatch) {
      const level = parseInt(levelMatch[1], 10);
      const isCharging = (acMatch && acMatch[1] === 'true') || 
                         (usbMatch && usbMatch[1] === 'true') || 
                         (wirelessMatch && wirelessMatch[1] === 'true') ||
                         (statusMatch && (statusMatch[1] === '2' || statusMatch[1] === '5'));
                         
      process.send?.({
        type: 'DEVICE_DATA',
        data: { battery: { level, charging: !!isCharging } }
      });
    }
  } catch (e) {
    // ignore
  }
}

checkBattery();

let currentIntervalMs = parseInt(process.argv[4] || '10000', 10);

// Listen for status changes from main process
process.on('message', (msg: any) => {
  if (msg.type === 'STATUS_CHANGE') {
    status = msg.status;
    updateDeviceData();
    if (status === 'device') {
      if (!screenshotInterval) screenshotInterval = setInterval(takeScreenshot, currentIntervalMs);
      if (!batteryInterval) batteryInterval = setInterval(checkBattery, 60000);
      checkBattery();
    } else {
      if (screenshotInterval) { clearInterval(screenshotInterval); screenshotInterval = null; }
      if (batteryInterval) { clearInterval(batteryInterval); batteryInterval = null; }
    }
  } else if (msg.type === 'UPDATE_SCREENCAP_INTERVAL') {
    currentIntervalMs = msg.interval;
    if (screenshotInterval) {
      clearInterval(screenshotInterval);
      screenshotInterval = setInterval(takeScreenshot, currentIntervalMs);
    }
  } else if (msg.type === 'PAUSE_SCREENCAP') {
    if (screenshotInterval) {
      clearInterval(screenshotInterval);
      screenshotInterval = null;
    }
  } else if (msg.type === 'RESUME_SCREENCAP') {
    if (status === 'device' && !screenshotInterval) {
      screenshotInterval = setInterval(takeScreenshot, currentIntervalMs);
    }
  }
});

// Setup interval for screenshots if already connected
if (status === 'device') {
    screenshotInterval = setInterval(takeScreenshot, currentIntervalMs);
    batteryInterval = setInterval(checkBattery, 60000);
}

// Keep worker alive
setInterval(() => {}, 1000 * 60 * 60);
