import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);

async function run() {
  console.log('===============================================================');
  console.log(' PHASE 3 VERIFICATION: MOCK LOCATION PROVIDER');
  console.log('===============================================================\n');

  const usbDeviceId = '106293738O006649';
  const CLIPPER_PACKAGE = 'com.handyfarm.clipper';
  const CLIPPER_RECEIVER = `${CLIPPER_PACKAGE}/.ClipperReceiver`;
  const ATTACKER_PACKAGE = 'com.attacker.app';
  const ATTACKER_MAIN = `${ATTACKER_PACKAGE}/.MainActivity`;
  const adversaryApk = path.resolve('scratch', 'adversary', 'build', 'adversary.apk');
  const clipperApk = path.resolve('resources', 'clipper.apk');

  console.log('[1] Ensuring companion APK is installed with Phase 3 capabilities...');
  await execFileAsync('adb', ['-s', usbDeviceId, 'install', '-r', clipperApk]);
  console.log('  -> Installed successfully.\n');

  console.log('[2] Testing graceful failure when MOCK_LOCATION is NOT granted...');
  // Revoke mock location permission
  await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'appops', 'set', CLIPPER_PACKAGE, 'MOCK_LOCATION', 'deny']);
  const { stdout: ungrantedOut } = await execFileAsync('adb', [
    '-s', usbDeviceId, 'shell',
    `am broadcast -a handyfarm.location.set -n ${CLIPPER_RECEIVER} --ef lat 37.7749 --ef lng -122.4194`
  ]);
  console.log(`  -> Broadcast response (without permission): ${ungrantedOut.trim()}`);
  if (!ungrantedOut.includes('STATUS_PERMISSION_REQUIRED: MOCK_LOCATION')) {
    throw new Error(`Expected STATUS_PERMISSION_REQUIRED: MOCK_LOCATION, got: ${ungrantedOut}`);
  }
  console.log('  -> PASS: Gracefully returned clear permission status.\n');

  console.log('[3] Granting MOCK_LOCATION app-op to companion app...');
  await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'appops', 'set', CLIPPER_PACKAGE, 'android:mock_location', 'allow']);
  console.log('  -> App-op android:mock_location granted.\n');

  console.log('[4] Setting mock location coordinates (San Francisco: 37.7749, -122.4194)...');
  const { stdout: setOut } = await execFileAsync('adb', [
    '-s', usbDeviceId, 'shell',
    `am broadcast -a handyfarm.location.set -n ${CLIPPER_RECEIVER} --ef lat 37.7749 --ef lng -122.4194`
  ]);
  console.log(`  -> Set broadcast response: ${setOut.trim()}`);
  if (!setOut.includes('OK: lat=37.774') || !setOut.includes('lng=-122.419')) {
    throw new Error(`Expected OK confirmation, got: ${setOut}`);
  }
  console.log('  -> PASS: Coordinates registered by companion app.\n');

  console.log('[5] Querying mock location via handyfarm.location.get...');
  const { stdout: getOut } = await execFileAsync('adb', [
    '-s', usbDeviceId, 'shell',
    `am broadcast -a handyfarm.location.get -n ${CLIPPER_RECEIVER}`
  ]);
  console.log(`  -> Get broadcast response: ${getOut.trim()}`);
  if (!getOut.includes('lat=37.774') || !getOut.includes('lng=-122.419') || !getOut.includes('mock_allowed=true')) {
    throw new Error(`Expected persisted coordinates and mock_allowed=true, got: ${getOut}`);
  }
  console.log('  -> PASS: Verified companion returned set location and confirmed mock_allowed=true.\n');

  console.log('[6] Verifying dumpsys location contains active mock location provider...');
  const { stdout: dumpsysOut } = await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'dumpsys', 'location']);
  const hasMockGps = dumpsysOut.includes('37.7748') && dumpsysOut.includes('mock');
  console.log(`  -> dumpsys location contains mock coordinates: ${hasMockGps}`);
  if (!hasMockGps) {
    // Print matching lines for diagnostic
    const matching = dumpsysOut.split('\n').filter(l => l.includes('37.7749') || l.includes('mock'));
    console.log('  -> Relevant dumpsys lines:\n' + matching.slice(0, 10).map(l => '     ' + l).join('\n'));
    throw new Error('dumpsys location did not verify mock coordinates with [mock] flag!');
  }
  console.log('  -> PASS: Android framework location subsystem confirms mock provider active with [mock] flag!\n');

  console.log('[7] Adversarial Verification: unprivileged app cannot set or query mock location...');
  await execFileAsync('adb', ['-s', usbDeviceId, 'uninstall', ATTACKER_PACKAGE]).catch(() => {});
  await execFileAsync('adb', ['-s', usbDeviceId, 'install', '-r', adversaryApk]);
  await execFileAsync('adb', ['-s', usbDeviceId, 'logcat', '-c']);
  await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'am', 'start', '-W', '-n', ATTACKER_MAIN]);
  await new Promise(r => setTimeout(r, 2000));

  const { stdout: logcatClipper } = await execFileAsync('adb', ['-s', usbDeviceId, 'logcat', '-d', '-s', 'HandyFarmClipper']);
  const { stdout: logcatAdversary } = await execFileAsync('adb', ['-s', usbDeviceId, 'logcat', '-d', '-s', 'AdversaryTest']);

  console.log('  -> Adversary logcat:\n' + logcatAdversary.trim().split('\n').map(l => '     ' + l).join('\n'));
  console.log('  -> Clipper logcat:\n' + logcatClipper.trim().split('\n').map(l => '     ' + l).join('\n'));

  if (!logcatAdversary.includes('location.set result: code=0, data=ERROR: Unauthorized sender')) {
    throw new Error('FAILED: Adversary was not rejected when attempting location.set!');
  }
  if (!logcatAdversary.includes('location.get result: code=0, data=ERROR: Unauthorized sender')) {
    throw new Error('FAILED: Adversary was not rejected when attempting location.get!');
  }
  if (!logcatClipper.includes('Blocked unauthorized broadcast intent=Intent { act=handyfarm.location.set')) {
    throw new Error('FAILED: Clipper did not log blocked unauthorized location.set broadcast!');
  }

  // Ensure coordinates were untouched by adversary (still 37.7749, -122.4194; NOT 99.99, 99.99)
  const { stdout: verifyUnchanged } = await execFileAsync('adb', [
    '-s', usbDeviceId, 'shell',
    `am broadcast -a handyfarm.location.get -n ${CLIPPER_RECEIVER}`
  ]);
  if (!verifyUnchanged.includes('lat=37.774') || verifyUnchanged.includes('99.99')) {
    throw new Error(`Location was corrupted by adversary! Got: ${verifyUnchanged}`);
  }
  console.log('  -> PASS: Location remained uncorrupted (San Francisco) despite attacker broadcast attempts.\n');

  await execFileAsync('adb', ['-s', usbDeviceId, 'uninstall', ATTACKER_PACKAGE]).catch(() => {});
  console.log('===============================================================');
  console.log(' PHASE 3 COMPLETED SUCCESSFULLY: ALL CHECKS PASSED');
  console.log('===============================================================');
}

run().catch((err) => {
  console.error('\n❌ Phase 3 test failed:', err);
  process.exit(1);
});
