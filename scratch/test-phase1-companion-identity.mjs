import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { generatePhysicalDeviceId } from '../electron/identity.ts';

const execFileAsync = promisify(execFile);

async function run() {
  console.log('===============================================================');
  console.log(' PHASE 1 VERIFICATION: STABLE COMPANION APP IDENTITY');
  console.log('===============================================================\n');

  const usbDeviceId = '106293738O006649';
  const CLIPPER_PACKAGE = 'com.handyfarm.clipper';
  const CLIPPER_RECEIVER = `${CLIPPER_PACKAGE}/.ClipperReceiver`;
  const ATTACKER_PACKAGE = 'com.attacker.app';
  const ATTACKER_MAIN = `${ATTACKER_PACKAGE}/.MainActivity`;
  const adversaryApk = path.resolve('scratch', 'adversary', 'build', 'adversary.apk');
  const clipperApk = path.resolve('resources', 'clipper.apk');

  console.log('[1] Querying companion UUID via USB transport...');
  const { stdout: out1 } = await execFileAsync('adb', ['-s', usbDeviceId, 'shell', `am broadcast -a handyfarm.identity.get -n ${CLIPPER_RECEIVER}`]);
  const match1 = out1.match(/data="([a-f0-9\-]+)"/i);
  if (!match1 || !match1[1]) {
    throw new Error(`Failed to query UUID over USB! Output: ${out1}`);
  }
  const usbUuid = match1[1];
  console.log(`  -> USB UUID: ${usbUuid}`);
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(usbUuid)) {
    throw new Error(`Invalid UUID format: ${usbUuid}`);
  }
  console.log('  -> PASS: Valid UUID format confirmed.\n');

  console.log('[2] Verifying UUID persistence across app update (reinstall without uninstall)...');
  await execFileAsync('adb', ['-s', usbDeviceId, 'install', '-r', clipperApk]);
  const { stdout: out2 } = await execFileAsync('adb', ['-s', usbDeviceId, 'shell', `am broadcast -a handyfarm.identity.get -n ${CLIPPER_RECEIVER}`]);
  const match2 = out2.match(/data="([a-f0-9\-]+)"/i);
  const updatedUuid = match2 ? match2[1] : null;
  console.log(`  -> UUID after app update: ${updatedUuid}`);
  if (updatedUuid !== usbUuid) {
    throw new Error(`UUID changed across update! Expected "${usbUuid}", got "${updatedUuid}"`);
  }
  console.log('  -> PASS: UUID strictly persisted across app update.\n');

  console.log('[3] Verifying UUID persistence across USB <-> Wi-Fi transport switch...');
  // Discover device IP on wlan0
  const { stdout: ipOut } = await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'ip -f inet addr show wlan0']);
  const ipMatch = ipOut.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
  if (!ipMatch) {
    throw new Error(`Could not find device Wi-Fi IP in output: ${ipOut}`);
  }
  const deviceIp = ipMatch[1];
  const wifiTarget = `${deviceIp}:5555`;
  console.log(`  -> Found device IP: ${deviceIp}`);

  // Switch to tcpip and connect
  await execFileAsync('adb', ['-s', usbDeviceId, 'tcpip', '5555']);
  await new Promise(r => setTimeout(r, 1000));
  await execFileAsync('adb', ['connect', wifiTarget]);
  await new Promise(r => setTimeout(r, 1000));

  try {
    const { stdout: outWifi } = await execFileAsync('adb', ['-s', wifiTarget, 'shell', `am broadcast -a handyfarm.identity.get -n ${CLIPPER_RECEIVER}`]);
    const matchWifi = outWifi.match(/data="([a-f0-9\-]+)"/i);
    const wifiUuid = matchWifi ? matchWifi[1] : null;
    console.log(`  -> Wi-Fi UUID: ${wifiUuid}`);
    if (wifiUuid !== usbUuid) {
      throw new Error(`Wi-Fi UUID mismatch! USB: "${usbUuid}", Wi-Fi: "${wifiUuid}"`);
    }
    console.log('  -> PASS: Companion UUID is identical across USB and Wi-Fi transports.\n');
  } finally {
    await execFileAsync('adb', ['disconnect', wifiTarget]).catch(() => {});
  }

  console.log('[4] Verifying identity fallback logic in generatePhysicalDeviceId...');
  // Test case A: hardware serial is valid -> uses hardware serial
  const idNormal = generatePhysicalDeviceId({
    bootSerial: '106293738O006649',
    serial: '106293738O006649',
    companionUuid: usbUuid
  });
  console.log(`  -> With valid hardware serial: ${idNormal}`);
  if (idNormal !== 'phys_106293738O006649') {
    throw new Error(`Expected phys_106293738O006649, got ${idNormal}`);
  }

  // Test case B: hardware serial is missing or suspect -> falls back to companionUuid
  const idFallbackMissing = generatePhysicalDeviceId({
    bootSerial: '',
    serial: 'unknown',
    companionUuid: usbUuid
  });
  console.log(`  -> With suspect/missing serial: ${idFallbackMissing}`);
  if (idFallbackMissing !== `phys_app_${usbUuid}`) {
    throw new Error(`Expected phys_app_${usbUuid}, got ${idFallbackMissing}`);
  }

  // Test case C: suspect generic serial (e.g. 0123456789ABCDEF) -> falls back to companionUuid
  const idFallbackGeneric = generatePhysicalDeviceId({
    bootSerial: '0123456789ABCDEF',
    serial: '0123456789ABCDEF',
    companionUuid: usbUuid
  });
  console.log(`  -> With generic suspect serial 0123456789ABCDEF: ${idFallbackGeneric}`);
  if (idFallbackGeneric !== `phys_app_${usbUuid}`) {
    throw new Error(`Expected phys_app_${usbUuid}, got ${idFallbackGeneric}`);
  }
  console.log('  -> PASS: generatePhysicalDeviceId correctly prioritizes and falls back to companionUuid.\n');

  console.log('[5] Adversarial Verification: unprivileged app cannot read companion UUID...');
  await execFileAsync('adb', ['-s', usbDeviceId, 'uninstall', ATTACKER_PACKAGE]).catch(() => {});
  await execFileAsync('adb', ['-s', usbDeviceId, 'install', '-r', adversaryApk]);
  await execFileAsync('adb', ['-s', usbDeviceId, 'logcat', '-c']);
  await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'am', 'start', '-W', '-n', ATTACKER_MAIN]);
  await new Promise(r => setTimeout(r, 2000));

  const { stdout: logcatClipper } = await execFileAsync('adb', ['-s', usbDeviceId, 'logcat', '-d', '-s', 'HandyFarmClipper']);
  const { stdout: logcatAdversary } = await execFileAsync('adb', ['-s', usbDeviceId, 'logcat', '-d', '-s', 'AdversaryTest']);

  console.log('  -> Adversary logcat:\n' + logcatAdversary.trim().split('\n').map(l => '     ' + l).join('\n'));
  console.log('  -> Clipper logcat:\n' + logcatClipper.trim().split('\n').map(l => '     ' + l).join('\n'));

  if (!logcatAdversary.includes('identity.get result: code=0, data=ERROR: Unauthorized sender')) {
    throw new Error('FAILED: Adversary was not rejected when attempting identity.get!');
  }
  if (!logcatClipper.includes('Blocked unauthorized broadcast intent=Intent { act=handyfarm.identity.get')) {
    throw new Error('FAILED: Clipper did not log blocked unauthorized identity broadcast!');
  }
  console.log('  -> PASS: Adversarial identity query was blocked and rejected.\n');

  await execFileAsync('adb', ['-s', usbDeviceId, 'uninstall', ATTACKER_PACKAGE]).catch(() => {});
  console.log('===============================================================');
  console.log(' PHASE 1 COMPLETED SUCCESSFULLY: ALL CHECKS PASSED');
  console.log('===============================================================');
}

run().catch((err) => {
  console.error('\n❌ Phase 1 test failed:', err);
  process.exit(1);
});
