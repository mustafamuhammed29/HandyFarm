import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);

async function run() {
  console.log('===============================================================');
  console.log(' PHASE 2 VERIFICATION: FOREGROUND APP DETECTION');
  console.log('===============================================================\n');

  const usbDeviceId = '106293738O006649';
  const CLIPPER_PACKAGE = 'com.handyfarm.clipper';
  const CLIPPER_RECEIVER = `${CLIPPER_PACKAGE}/.ClipperReceiver`;
  const ATTACKER_PACKAGE = 'com.attacker.app';
  const ATTACKER_MAIN = `${ATTACKER_PACKAGE}/.MainActivity`;
  const adversaryApk = path.resolve('scratch', 'adversary', 'build', 'adversary.apk');
  const clipperApk = path.resolve('resources', 'clipper.apk');

  console.log('[1] Ensuring clipper APK is installed with Phase 2 capabilities...');
  await execFileAsync('adb', ['-s', usbDeviceId, 'install', '-r', clipperApk]);
  console.log('  -> Installed successfully.\n');

  console.log('[2] Testing graceful failure when PACKAGE_USAGE_STATS is NOT granted...');
  // Revoke usage stats permission
  await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'appops', 'set', CLIPPER_PACKAGE, 'GET_USAGE_STATS', 'deny']);
  const { stdout: ungrantedOut } = await execFileAsync('adb', ['-s', usbDeviceId, 'shell', `am broadcast -a handyfarm.foreground.get -n ${CLIPPER_RECEIVER}`]);
  console.log(`  -> Broadcast response (without permission): ${ungrantedOut.trim()}`);
  if (!ungrantedOut.includes('STATUS_PERMISSION_REQUIRED: PACKAGE_USAGE_STATS')) {
    throw new Error(`Expected STATUS_PERMISSION_REQUIRED, got: ${ungrantedOut}`);
  }
  console.log('  -> PASS: Gracefully returned clear permission status without failing silently.\n');

  console.log('[3] Granting PACKAGE_USAGE_STATS to companion app...');
  await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'appops', 'set', CLIPPER_PACKAGE, 'GET_USAGE_STATS', 'allow']);
  console.log('  -> App-op permission granted.\n');

  console.log('[4] Testing foreground detection for Settings app (com.android.settings)...');
  await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'input', 'keyevent', '224']).catch(() => {});
  await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'input', 'keyevent', '82']).catch(() => {});
  await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'am', 'start', '-W', '-n', 'com.android.settings/.Settings']);

  const { stdout: fg1Out } = await execFileAsync('adb', ['-s', usbDeviceId, 'shell', `am broadcast -a handyfarm.foreground.get -n ${CLIPPER_RECEIVER}`]);
  console.log(`  -> Broadcast response: ${fg1Out.trim()}`);
  const matchFg1 = fg1Out.match(/data="([^"]+)"/s);
  const detectedPkg1 = matchFg1 ? matchFg1[1].trim() : null;
  console.log(`  -> Detected foreground package: "${detectedPkg1}"`);
  if (detectedPkg1 !== 'com.android.settings') {
    throw new Error(`Expected "com.android.settings", got "${detectedPkg1}"`);
  }
  console.log('  -> PASS: Settings app correctly identified as foreground!\n');

  console.log('[5] Testing foreground detection for Chrome app (com.android.chrome)...');
  await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'am', 'start', '-W', '-n', 'com.android.chrome/com.google.android.apps.chrome.Main']);

  const { stdout: fg2Out } = await execFileAsync('adb', ['-s', usbDeviceId, 'shell', `am broadcast -a handyfarm.foreground.get -n ${CLIPPER_RECEIVER}`]);
  console.log(`  -> Broadcast response: ${fg2Out.trim()}`);
  const matchFg2 = fg2Out.match(/data="([^"]+)"/s);
  const detectedPkg2 = matchFg2 ? matchFg2[1].trim() : null;
  console.log(`  -> Detected foreground package: "${detectedPkg2}"`);
  if (detectedPkg2 !== 'com.android.chrome') {
    throw new Error(`Expected "com.android.chrome", got "${detectedPkg2}"`);
  }
  console.log('  -> PASS: Chrome app correctly identified as foreground!\n');

  // Dismiss Chrome
  await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'input', 'keyevent', '4']).catch(() => {});

  console.log('[6] Adversarial Verification: unprivileged app cannot read foreground app...');
  await execFileAsync('adb', ['-s', usbDeviceId, 'uninstall', ATTACKER_PACKAGE]).catch(() => {});
  await execFileAsync('adb', ['-s', usbDeviceId, 'install', '-r', adversaryApk]);
  await execFileAsync('adb', ['-s', usbDeviceId, 'logcat', '-c']);
  await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'am', 'start', '-W', '-n', ATTACKER_MAIN]);
  await new Promise(r => setTimeout(r, 2000));

  const { stdout: logcatClipper } = await execFileAsync('adb', ['-s', usbDeviceId, 'logcat', '-d', '-s', 'HandyFarmClipper']);
  const { stdout: logcatAdversary } = await execFileAsync('adb', ['-s', usbDeviceId, 'logcat', '-d', '-s', 'AdversaryTest']);

  console.log('  -> Adversary logcat:\n' + logcatAdversary.trim().split('\n').map(l => '     ' + l).join('\n'));
  console.log('  -> Clipper logcat:\n' + logcatClipper.trim().split('\n').map(l => '     ' + l).join('\n'));

  if (!logcatAdversary.includes('foreground.get result: code=0, data=ERROR: Unauthorized sender')) {
    throw new Error('FAILED: Adversary was not rejected when attempting foreground.get!');
  }
  if (!logcatClipper.includes('Blocked unauthorized broadcast intent=Intent { act=handyfarm.foreground.get')) {
    throw new Error('FAILED: Clipper did not log blocked unauthorized foreground broadcast!');
  }
  console.log('  -> PASS: Adversarial foreground app query was blocked and rejected.\n');

  await execFileAsync('adb', ['-s', usbDeviceId, 'uninstall', ATTACKER_PACKAGE]).catch(() => {});
  console.log('===============================================================');
  console.log(' PHASE 2 COMPLETED SUCCESSFULLY: ALL CHECKS PASSED');
  console.log('===============================================================');
}

run().catch((err) => {
  console.error('\n❌ Phase 2 test failed:', err);
  process.exit(1);
});
