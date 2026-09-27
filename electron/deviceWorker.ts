import { Adb } from '@devicefarmer/adbkit';
import * as deviceDb from 'stf-device-db';

const client = Adb.createClient();

const deviceId = process.argv[2];
let status = process.argv[3];

async function updateDeviceData() {
  if (status !== 'device') {
    // If not authorized or offline, we just send what we have
    process.send?.({
      type: 'DEVICE_DATA',
      data: { status }
    });
    return;
  }

  try {
    const properties = await client.getProperties(deviceId);
    
    // Attempt to extract useful info
    const model = properties['ro.product.model'];
    const manufacturer = properties['ro.product.manufacturer'];
    const serial = properties['ro.serialno'] || deviceId;
    
    let deviceName = model;
    let image = null;

    // Use stf-device-db if possible
    try {
        const dbEntry = (deviceDb as any)[model];
        if (dbEntry) {
            deviceName = dbEntry.name;
        }
    } catch (e) {
        console.error('Failed to lookup device in stf-device-db', e);
    }

    process.send?.({
      type: 'DEVICE_DATA',
      data: {
        status,
        model,
        manufacturer,
        serial,
        name: deviceName,
        customName: undefined, // will be merged in main
      }
    });

  } catch (err) {
    console.error(`Worker for ${deviceId} failed to fetch properties:`, err);
    process.send?.({
      type: 'DEVICE_DATA',
      data: { status: 'error' }
    });
  }
}

// Periodic Screenshot
let screenshotInterval: NodeJS.Timeout | null = null;

async function takeScreenshot() {
  if (status !== 'device') return;
  try {
    const stream = await client.screencap(deviceId);
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      const buffer = Buffer.concat(chunks);
      process.send?.({
        type: 'DEVICE_DATA',
        data: { thumbnail: 'data:image/png;base64,' + buffer.toString('base64') }
      });
    });
  } catch (e) {
    // console.error(`Failed to capture screen for ${deviceId}`, e);
  }
}

// Initial fetch
updateDeviceData();
setTimeout(takeScreenshot, 2000);

// Listen for status changes from main process
process.on('message', (msg: any) => {
  if (msg.type === 'STATUS_CHANGE') {
    status = msg.status;
    updateDeviceData();
    if (status === 'device' && !screenshotInterval) {
        screenshotInterval = setInterval(takeScreenshot, 10000); // 10 seconds
    } else if (status !== 'device' && screenshotInterval) {
        clearInterval(screenshotInterval);
        screenshotInterval = null;
    }
  }
});

// Setup interval for screenshots if already connected
if (status === 'device') {
    screenshotInterval = setInterval(takeScreenshot, 10000);
}

// Keep worker alive
setInterval(() => {}, 1000 * 60 * 60);
