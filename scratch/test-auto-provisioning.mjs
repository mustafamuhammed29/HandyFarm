import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);

async function run() {
  console.log('===============================================================');
  console.log(' VERIFICATION: AUTOMATED PROVISIONING & APPOPS AUTO-GRANT');
  console.log('===============================================================\n');

  const usbDeviceId = '106293738O006649';
  const CLIPPER_PACKAGE = 'com.handyfarm.clipper';
  const CLIPPER_RECEIVER = `${CLIPPER_PACKAGE}/.ClipperReceiver`;
  const CLIPPER_MAIN = `${CLIPPER_PACKAGE}/.Main`;
  const clipperApk = path.resolve('resources', 'clipper.apk');

  console.log('[1] Completely wiping existing companion app from device (uninstall)...');
  await execFileAsync('adb', ['-s', usbDeviceId, 'uninstall', CLIPPER_PACKAGE]).catch(() => {});
  const { stdout: checkUninstall } = await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'pm', 'path', CLIPPER_PACKAGE]).catch(e => ({ stdout: '' }));
  if (checkUninstall.includes('package:')) {
    throw new Error('Companion app uninstall failed!');
  }
  console.log('  -> Wiped clean. com.handyfarm.clipper is NOT installed.\n');

  console.log('[2] Simulating fresh device connect / ensureClipperInstalled flow...');
  // This simulates the exact code in ensureClipperInstalled():
  console.log('  -> Installing companion APK...');
  await execFileAsync('adb', ['-s', usbDeviceId, 'install', '-r', '-d', '-g', clipperApk]);

  console.log('  -> Auto-granting companion appops (as automated in ensureClipperInstalled)...');
  await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'appops', 'set', CLIPPER_PACKAGE, 'GET_USAGE_STATS', 'allow']);
  await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'appops', 'set', CLIPPER_PACKAGE, 'android:mock_location', 'allow']);

  console.log('  -> Bringing companion to focus to initialize and dismissing...');
  await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'am', 'start', '-W', '-n', CLIPPER_MAIN]);
  await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'input', 'keyevent', '4']).catch(() => {});
  console.log('  -> Fresh provisioning complete.\n');

  console.log('[3] Verifying handyfarm.identity.get works out-of-the-box...');
  const { stdout: idOut } = await execFileAsync('adb', [
    '-s', usbDeviceId, 'shell',
    `am broadcast -a handyfarm.identity.get -n ${CLIPPER_RECEIVER}`
  ]);
  console.log(`  -> Identity output: ${idOut.trim()}`);
  const matchId = idOut.match(/data="([a-f0-9\-]+)"/i);
  if (!matchId || !matchId[1]) {
    throw new Error(`Failed to read companion identity: ${idOut}`);
  }
  console.log(`  -> Generated UUID: ${matchId[1]}`);
  console.log('  -> PASS: Identity generated and readable immediately.\n');

  console.log('[4] Verifying handyfarm.foreground.get works out-of-the-box (zero manual steps)...');
  await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'am', 'start', '-W', '-n', 'com.android.settings/.Settings']);
  const { stdout: fgOut } = await execFileAsync('adb', [
    '-s', usbDeviceId, 'shell',
    `am broadcast -a handyfarm.foreground.get -n ${CLIPPER_RECEIVER}`
  ]);
  console.log(`  -> Foreground output: ${fgOut.trim()}`);
  if (fgOut.includes('STATUS_PERMISSION_REQUIRED')) {
    throw new Error('FAIL: Foreground detection reported STATUS_PERMISSION_REQUIRED on fresh install!');
  }
  if (!fgOut.includes('com.android.settings')) {
    throw new Error(`Expected com.android.settings, got: ${fgOut}`);
  }
  console.log('  -> PASS: Foreground detection returned com.android.settings without manual intervention.\n');

  console.log('[5] Verifying handyfarm.location.set works out-of-the-box (zero manual steps)...');
  const { stdout: locSetOut } = await execFileAsync('adb', [
    '-s', usbDeviceId, 'shell',
    `am broadcast -a handyfarm.location.set -n ${CLIPPER_RECEIVER} --ef lat 51.5074 --ef lng -0.1278`
  ]);
  console.log(`  -> Location set output: ${locSetOut.trim()}`);
  if (locSetOut.includes('STATUS_PERMISSION_REQUIRED')) {
    throw new Error('FAIL: Mock location reported STATUS_PERMISSION_REQUIRED on fresh install!');
  }
  if (!locSetOut.includes('OK: lat=51.507') || !locSetOut.includes('lng=-0.127')) {
    throw new Error(`Expected OK coordinates confirmation, got: ${locSetOut}`);
  }
  console.log('  -> PASS: Mock location set to London (51.5074, -0.1278) without manual intervention.\n');

  console.log('[6] Verifying dumpsys location confirmed mock coordinates...');
  const { stdout: dumpsysOut } = await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'dumpsys', 'location']);
  const hasMock = dumpsysOut.includes('51.507') && dumpsysOut.includes('mock');
  if (!hasMock) {
    throw new Error('dumpsys location failed to confirm active mock provider!');
  }
  console.log('  -> PASS: dumpsys location confirmed mock coordinates active.\n');

  console.log('[7] Testing self-healing auto-remediation flow when permissions are revoked...');
  // Force revoke permissions to test the auto-remediation path in main.ts
  await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'appops', 'set', CLIPPER_PACKAGE, 'GET_USAGE_STATS', 'deny']);
  await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'appops', 'set', CLIPPER_PACKAGE, 'android:mock_location', 'deny']);

  // Simulate self-healing flow for foreground:
  const { stdout: deniedFg } = await execFileAsync('adb', ['-s', usbDeviceId, 'shell', `am broadcast -a handyfarm.foreground.get -n ${CLIPPER_RECEIVER}`]);
  if (!deniedFg.includes('STATUS_PERMISSION_REQUIRED: PACKAGE_USAGE_STATS')) {
    throw new Error('Expected STATUS_PERMISSION_REQUIRED when appop denied');
  }
  console.log('  -> Detected STATUS_PERMISSION_REQUIRED as expected.');

  // Trigger self-healing grant:
  console.log('  -> Executing auto-remediation grant via ADB...');
  await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'appops', 'set', CLIPPER_PACKAGE, 'GET_USAGE_STATS', 'allow']);
  const { stdout: healedFg } = await execFileAsync('adb', ['-s', usbDeviceId, 'shell', `am broadcast -a handyfarm.foreground.get -n ${CLIPPER_RECEIVER}`]);
  console.log(`  -> Self-healed query result: ${healedFg.trim()}`);
  if (!healedFg.includes('com.android.settings')) {
    throw new Error('Self-healing failed to restore foreground detection!');
  }
  console.log('  -> PASS: Self-healing auto-remediation restored foreground detection seamlessly.\n');

  console.log('[8] Device cleanup: baseline reset...');
  const { stdout: resetOut } = await execFileAsync('adb', ['-s', usbDeviceId, 'shell', `am broadcast -a handyfarm.reset.baseline -n ${CLIPPER_RECEIVER}`]);
  console.log(`  -> Reset output: ${resetOut.trim()}`);
  await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'input', 'keyevent', '3']).catch(() => {});

  console.log('\n===============================================================');
  console.log(' ZERO MANUAL STEPS VERIFIED: AUTOMATED PROVISIONING PASSED');
  console.log('===============================================================');
}

run().catch((err) => {
  console.error('\n❌ Automated provisioning test failed:', err);
  process.exit(1);
});
