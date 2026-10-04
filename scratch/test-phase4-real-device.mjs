import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const dbModuleUrl = pathToFileURL(path.join(rootDir, 'dist-electron', 'db.js')).href;
const { DeviceStore } = await import(dbModuleUrl);

const testDbPath = path.join(rootDir, 'scratch', 'test_phase4.db');
if (fs.existsSync(testDbPath)) {
  fs.unlinkSync(testDbPath);
}

console.log('=== PHASE 4 REAL PHYSICAL DEVICE VERIFICATION ===');
console.log('Test SQLite DB:', testDbPath);

const store = new DeviceStore(testDbPath);

function runWorker(deviceId, status) {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(rootDir, 'dist-electron', 'deviceWorker.js');
    const child = spawn(process.execPath, [workerPath, deviceId, status], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    });

    let mergedData = {};
    child.on('message', (msg) => {
      if (msg && msg.type === 'DEVICE_DATA') {
        Object.assign(mergedData, msg.data);
        if (mergedData.physicalDeviceId) {
          child.kill();
          resolve(mergedData);
        }
      }
    });

    child.on('exit', () => {
      if (mergedData.physicalDeviceId) resolve(mergedData);
      else reject(new Error(`Worker for ${deviceId} exited without sending physicalDeviceId: ${JSON.stringify(mergedData)}`));
    });

    setTimeout(() => {
      child.kill();
      if (mergedData.physicalDeviceId) resolve(mergedData);
      else reject(new Error(`Timeout waiting for worker ${deviceId}`));
    }, 10000);
  });
}

async function runTest() {
  const usbDeviceId = '106293738O006649';
  console.log(`\n[STEP 1] Testing Worker on Physical USB device: ${usbDeviceId}`);
  const usbData = await runWorker(usbDeviceId, 'device');
  console.log('USB Worker Data received:');
  console.log('  Model:', usbData.model);
  console.log('  Manufacturer:', usbData.manufacturer);
  console.log('  Serial:', usbData.serial);
  console.log('  PhysicalDeviceId:', usbData.physicalDeviceId);
  console.log('  Discovered IP:', usbData.lastKnownIp);

  if (!usbData.physicalDeviceId || !usbData.physicalDeviceId.startsWith('phys_')) {
    throw new Error(`Invalid physicalDeviceId: ${usbData.physicalDeviceId}`);
  }

  // Record USB device in SQLite store
  store.updateDevice(usbDeviceId, usbData);

  // Set user custom metadata
  store.updateDevice(usbDeviceId, {
    customName: 'Farm Unit Alpha - TECNO',
    notes: 'Automated Phase 4 Verification Unit',
    tags: ['rig-1', 'primary-test']
  });
  store.logDeviceAction(usbDeviceId, 'Initial setup via USB');
  store.logDeviceAction(usbDeviceId, 'Verified screen and clipboard');
  store.flushWrites();

  const devAfterUsb = store.getDevice(usbDeviceId);
  console.log('\nRecorded USB Device in Store:');
  console.log('  ID:', devAfterUsb.id);
  console.log('  Custom Name:', devAfterUsb.customName);
  console.log('  Notes:', devAfterUsb.notes);
  console.log('  Tags:', devAfterUsb.tags);
  console.log('  Physical ID:', devAfterUsb.physicalDeviceId);
  console.log('  History count:', devAfterUsb.history?.length);

  const initialMapping = store.getPhysicalMapping(usbData.physicalDeviceId);
  console.log('Initial Physical Mapping:');
  console.log(initialMapping);

  // Step 2: Switch to Wi-Fi
  console.log(`\n[STEP 2] Switching device to Wi-Fi mode...`);
  const targetIp = usbData.lastKnownIp || '172.20.10.2';
  const wifiDeviceId = `${targetIp}:5555`;

  console.log(`  Enabling adb tcpip 5555...`);
  execSync(`adb -s ${usbDeviceId} tcpip 5555`);
  await new Promise(r => setTimeout(r, 2000));

  console.log(`  Connecting adb to ${wifiDeviceId}...`);
  const connectOut = execSync(`adb connect ${wifiDeviceId}`).toString();
  console.log('  Connect output:', connectOut.trim());

  console.log(`\n[STEP 3] Running Worker on Wi-Fi connection: ${wifiDeviceId}`);
  const wifiData = await runWorker(wifiDeviceId, 'device');
  console.log('Wi-Fi Worker Data received:');
  console.log('  Model:', wifiData.model);
  console.log('  Serial:', wifiData.serial);
  console.log('  PhysicalDeviceId:', wifiData.physicalDeviceId);

  if (wifiData.physicalDeviceId !== usbData.physicalDeviceId) {
    throw new Error(`physicalDeviceId mismatch! USB: ${usbData.physicalDeviceId}, WiFi: ${wifiData.physicalDeviceId}`);
  }
  console.log('✓ Hardware-stable physicalDeviceId matches perfectly across USB and Wi-Fi!');

  // Register Wi-Fi in store
  store.updateDevice(wifiDeviceId, wifiData);

  // Simulate deduplication merge when switching from USB to Wi-Fi
  console.log(`\n[STEP 4] Executing Non-Destructive Dedupe Merge: ${usbDeviceId} (losing) -> ${wifiDeviceId} (surviving)`);
  const mergedWifi = store.mergeDevices(wifiDeviceId, usbDeviceId);

  console.log('\nMerged Surviving Wi-Fi Device:');
  console.log('  ID:', mergedWifi.id);
  console.log('  Custom Name:', mergedWifi.customName);
  console.log('  Notes:', mergedWifi.notes);
  console.log('  Tags:', mergedWifi.tags);
  console.log('  Physical ID:', mergedWifi.physicalDeviceId);
  console.log('  History items:');
  for (const h of mergedWifi.history || []) {
    console.log(`    - [${h.timestamp}] ${h.action}`);
  }

  // Assertions
  if (mergedWifi.customName !== 'Farm Unit Alpha - TECNO') {
    throw new Error(`customName was lost or not merged! Got: ${mergedWifi.customName}`);
  }
  if (mergedWifi.notes !== 'Automated Phase 4 Verification Unit') {
    throw new Error(`notes were lost or not merged! Got: ${mergedWifi.notes}`);
  }
  if (!mergedWifi.tags || !mergedWifi.tags.includes('rig-1')) {
    throw new Error(`tags were lost or not merged! Got: ${JSON.stringify(mergedWifi.tags)}`);
  }
  if (!mergedWifi.history || mergedWifi.history.length < 2) {
    throw new Error(`history rows were not re-parented! Got length: ${mergedWifi.history?.length}`);
  }

  // Verify losing row is deleted from SQLite
  const usbRecord = store.getDevice(usbDeviceId);
  if (usbRecord) {
    throw new Error(`Losing USB record ${usbDeviceId} still exists in store after merge!`);
  }
  console.log('✓ Redundant duplicate row successfully removed from store and database');

  // Verify physical mapping
  const wifiMapping = store.getPhysicalMapping(wifiData.physicalDeviceId);
  console.log('\nUpdated Physical Mapping:');
  console.log(wifiMapping);
  if (wifiMapping.currentTransportId !== wifiDeviceId) {
    throw new Error(`currentTransportId should be ${wifiDeviceId}, got ${wifiMapping.currentTransportId}`);
  }
  if (wifiMapping.lastSeenTransportId !== usbDeviceId) {
    throw new Error(`lastSeenTransportId should be ${usbDeviceId}, got ${wifiMapping.lastSeenTransportId}`);
  }
  console.log('✓ Physical mapping properly tracked: physicalDeviceId -> { currentTransportId, lastSeenTransportId, serials[] }');

  // Step 5: Verify Reverse Merge (Wi-Fi -> USB)
  console.log(`\n[STEP 5] Testing Reverse Merge (Wi-Fi -> USB)...`);
  store.logDeviceAction(wifiDeviceId, 'Operated successfully over Wi-Fi');
  store.updateDevice(wifiDeviceId, {
    notes: 'Automated Phase 4 Verification Unit (Verified on Wi-Fi)'
  });
  store.flushWrites();

  // USB re-connects, becomes active
  store.updateDevice(usbDeviceId, { ...usbData, status: 'device' });
  const mergedUsb = store.mergeDevices(usbDeviceId, wifiDeviceId);

  console.log('\nReverse-Merged Surviving USB Device:');
  console.log('  ID:', mergedUsb.id);
  console.log('  Custom Name:', mergedUsb.customName);
  console.log('  Notes:', mergedUsb.notes);
  console.log('  Tags:', mergedUsb.tags);
  console.log('  Physical ID:', mergedUsb.physicalDeviceId);
  console.log('  Total History items:', mergedUsb.history?.length);
  for (const h of mergedUsb.history || []) {
    console.log(`    - [${h.timestamp}] ${h.action}`);
  }

  if (mergedUsb.customName !== 'Farm Unit Alpha - TECNO') {
    throw new Error(`customName lost in reverse merge!`);
  }
  if (mergedUsb.notes !== 'Automated Phase 4 Verification Unit (Verified on Wi-Fi)') {
    throw new Error(`updated notes lost in reverse merge! Got: ${mergedUsb.notes}`);
  }
  if (mergedUsb.history?.length !== 3) {
    throw new Error(`expected 3 history rows, got ${mergedUsb.history?.length}`);
  }

  const finalMapping = store.getPhysicalMapping(usbData.physicalDeviceId);
  console.log('\nFinal Physical Mapping:');
  console.log(finalMapping);
  if (finalMapping.currentTransportId !== usbDeviceId) {
    throw new Error(`currentTransportId should be ${usbDeviceId}, got ${finalMapping.currentTransportId}`);
  }
  if (finalMapping.lastSeenTransportId !== wifiDeviceId) {
    throw new Error(`lastSeenTransportId should be ${wifiDeviceId}, got ${finalMapping.lastSeenTransportId}`);
  }

  // Clean up
  store.close();
  try { execSync(`adb disconnect ${wifiDeviceId}`); } catch {}
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  console.log('\n======================================================');
  console.log('✅ ALL PHASE 4 REAL PHYSICAL DEVICE VERIFICATIONS PASSED!');
  console.log('======================================================');
  process.exit(0);
}

runTest().catch((err) => {
  console.error('\n❌ Test failed with error:', err);
  process.exit(1);
});
