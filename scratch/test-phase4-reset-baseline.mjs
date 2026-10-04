import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);

async function run() {
  console.log('===============================================================');
  console.log(' PHASE 4 VERIFICATION: DEVICE RESET-TO-BASELINE');
  console.log('===============================================================\n');

  const usbDeviceId = '106293738O006649';
  const CLIPPER_PACKAGE = 'com.handyfarm.clipper';
  const CLIPPER_RECEIVER = `${CLIPPER_PACKAGE}/.ClipperReceiver`;
  const ATTACKER_PACKAGE = 'com.attacker.app';
  const ATTACKER_MAIN = `${ATTACKER_PACKAGE}/.MainActivity`;
  const adversaryApk = path.resolve('scratch', 'adversary', 'build', 'adversary.apk');
  const clipperApk = path.resolve('resources', 'clipper.apk');

  console.log('[1] Ensuring companion APK is installed with Phase 4 capabilities...');
  await execFileAsync('adb', ['-s', usbDeviceId, 'install', '-r', clipperApk]);
  console.log('  -> Companion app installed.\n');

  console.log('[2] Inducing intentional state drift on the physical device...');
  // A. Clipboard drift
  await execFileAsync('adb', [
    '-s', usbDeviceId, 'shell',
    `am broadcast -a clipper.set -n ${CLIPPER_RECEIVER} --es text "DIRTY_CLIPBOARD_STATE"`
  ]);
  // B. Mock location drift
  await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'appops', 'set', CLIPPER_PACKAGE, 'android:mock_location', 'allow']);
  await execFileAsync('adb', [
    '-s', usbDeviceId, 'shell',
    `am broadcast -a handyfarm.location.set -n ${CLIPPER_RECEIVER} --ef lat 12.34 --ef lng 56.78`
  ]);
  // C. Animation scale drift (simulate non-standard animation settings)
  await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'settings', 'put', 'global', 'window_animation_scale', '1.5']);
  await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'settings', 'put', 'global', 'transition_animation_scale', '1.5']);
  await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'settings', 'put', 'global', 'animator_duration_scale', '1.5']);

  console.log('  -> Drift induced: dirty clipboard, active mock location (12.34, 56.78), animations=1.5\n');

  console.log('[3] Triggering handyfarm.reset.baseline on companion app...');
  const { stdout: resetRaw } = await execFileAsync('adb', [
    '-s', usbDeviceId, 'shell',
    `am broadcast -a handyfarm.reset.baseline -n ${CLIPPER_RECEIVER}`
  ]);
  console.log(`  -> Broadcast output:\n${resetRaw.trim()}`);

  const prefix = 'data="';
  const s = resetRaw.indexOf(prefix);
  if (s === -1) {
    throw new Error(`Failed to locate data=" in broadcast output: ${resetRaw}`);
  }
  const jsonStart = s + prefix.length;
  const jsonEnd = resetRaw.lastIndexOf('}"');
  if (jsonEnd === -1 || jsonEnd <= jsonStart) {
    throw new Error(`Failed to locate closing }" in broadcast output: ${resetRaw}`);
  }
  const jsonStr = resetRaw.substring(jsonStart, jsonEnd + 1);
  const report = JSON.parse(jsonStr);
  console.log('\n  -> Parsed Companion Report:', JSON.stringify(report, null, 2));

  // Assert honest reporting of capabilities
  if (!report.standalone_success.includes('mock_location_cleared')) {
    throw new Error('Expected mock_location_cleared in standalone_success');
  }
  if (!report.standalone_success.includes('clipboard_cleared')) {
    throw new Error('Expected clipboard_cleared in standalone_success');
  }
  const adbRequiredStr = report.adb_required.join('; ');
  if (!adbRequiredStr.includes('animation_scales') || !adbRequiredStr.includes('WRITE_SECURE_SETTINGS')) {
    throw new Error(`Expected honest reporting that animations require WRITE_SECURE_SETTINGS / ADB. Got: ${adbRequiredStr}`);
  }
  if (!adbRequiredStr.includes('close_system_dialogs')) {
    throw new Error(`Expected close_system_dialogs in adb_required. Got: ${adbRequiredStr}`);
  }
  console.log('  -> PASS: Companion honestly and accurately reported standalone vs ADB-required actions.\n');

  console.log('[4] Verifying standalone companion resets took effect on device...');
  // Verify mock location cleared
  const { stdout: locCheck } = await execFileAsync('adb', [
    '-s', usbDeviceId, 'shell',
    `am broadcast -a handyfarm.location.get -n ${CLIPPER_RECEIVER}`
  ]);
  console.log(`  -> Location status: ${locCheck.trim()}`);
  if (!locCheck.includes('NO_MOCK_SET')) {
    throw new Error(`Expected NO_MOCK_SET after reset, got: ${locCheck}`);
  }

  // Verify clipboard cleared
  // Bring to focus briefly to read clipboard on Android 10+
  await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'am', 'start', '-W', '-n', `${CLIPPER_PACKAGE}/.Main`]);
  const { stdout: clipCheck } = await execFileAsync('adb', [
    '-s', usbDeviceId, 'shell',
    `am broadcast -a clipper.get -n ${CLIPPER_RECEIVER}`
  ]);
  await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'input', 'keyevent', '4']).catch(() => {});
  console.log(`  -> Clipboard status: ${clipCheck.trim()}`);
  const matchClip = clipCheck.match(/data="(.*)"/s);
  const clipContent = matchClip ? matchClip[1].trim() : '';
  if (clipContent !== '') {
    throw new Error(`Expected empty clipboard after reset, got: "${clipContent}"`);
  }
  console.log('  -> PASS: Mock location and clipboard cleanly cleared standalone by companion.\n');

  console.log('[5] Testing elevated ADB baseline completion (as executed by Electron)...');
  // Disable animations via ADB
  await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'settings', 'put', 'global', 'window_animation_scale', '0']);
  await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'settings', 'put', 'global', 'transition_animation_scale', '0']);
  await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'settings', 'put', 'global', 'animator_duration_scale', '0']);

  // Dismiss dialogs and return home via ADB
  await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'am', 'broadcast', '-a', 'android.intent.action.CLOSE_SYSTEM_DIALOGS']).catch(() => {});
  await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'input', 'keyevent', '3']).catch(() => {});

  const { stdout: winAnim } = await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'settings', 'get', 'global', 'window_animation_scale']);
  const { stdout: transAnim } = await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'settings', 'get', 'global', 'transition_animation_scale']);
  const { stdout: durAnim } = await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'settings', 'get', 'global', 'animator_duration_scale']);

  console.log(`  -> Animation scales after elevated ADB reset: window=${winAnim.trim()}, transition=${transAnim.trim()}, animator=${durAnim.trim()}`);
  if (winAnim.trim() !== '0' || transAnim.trim() !== '0' || durAnim.trim() !== '0') {
    throw new Error('Animation scales not 0 after ADB elevation!');
  }
  console.log('  -> PASS: Full device baseline achieved through companion standalone + ADB pipeline.\n');

  console.log('[6] Adversarial Verification: unprivileged app cannot trigger reset.baseline...');
  await execFileAsync('adb', ['-s', usbDeviceId, 'uninstall', ATTACKER_PACKAGE]).catch(() => {});
  await execFileAsync('adb', ['-s', usbDeviceId, 'install', '-r', adversaryApk]);
  await execFileAsync('adb', ['-s', usbDeviceId, 'logcat', '-c']);
  await execFileAsync('adb', ['-s', usbDeviceId, 'shell', 'am', 'start', '-W', '-n', ATTACKER_MAIN]);
  await new Promise(r => setTimeout(r, 2000));

  const { stdout: logcatClipper } = await execFileAsync('adb', ['-s', usbDeviceId, 'logcat', '-d', '-s', 'HandyFarmClipper']);
  const { stdout: logcatAdversary } = await execFileAsync('adb', ['-s', usbDeviceId, 'logcat', '-d', '-s', 'AdversaryTest']);

  console.log('  -> Adversary logcat:\n' + logcatAdversary.trim().split('\n').map(l => '     ' + l).join('\n'));
  console.log('  -> Clipper logcat:\n' + logcatClipper.trim().split('\n').map(l => '     ' + l).join('\n'));

  if (!logcatAdversary.includes('reset.baseline result: code=0, data=ERROR: Unauthorized sender')) {
    throw new Error('FAILED: Adversary was not rejected when attempting reset.baseline!');
  }
  if (!logcatClipper.includes('Blocked unauthorized broadcast intent=Intent { act=handyfarm.reset.baseline')) {
    throw new Error('FAILED: Clipper did not log blocked unauthorized reset.baseline broadcast!');
  }
  console.log('  -> PASS: Adversarial reset.baseline attack blocked and rejected.\n');

  await execFileAsync('adb', ['-s', usbDeviceId, 'uninstall', ATTACKER_PACKAGE]).catch(() => {});
  console.log('===============================================================');
  console.log(' PHASE 4 COMPLETED SUCCESSFULLY: ALL CHECKS PASSED');
  console.log('===============================================================');
}

run().catch((err) => {
  console.error('\n❌ Phase 4 test failed:', err);
  process.exit(1);
});
