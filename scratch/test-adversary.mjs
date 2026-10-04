import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);

async function run() {
  console.log('===============================================================');
  console.log(' ADVERSARIAL TEST: VERIFYING RECEIVER SENDER PROTECTION');
  console.log('===============================================================\n');

  const deviceId = '106293738O006649';
  const adversaryApk = path.resolve('scratch', 'adversary', 'build', 'adversary.apk');
  const CLIPPER_PACKAGE = 'com.handyfarm.clipper';
  const CLIPPER_RECEIVER = `${CLIPPER_PACKAGE}/.ClipperReceiver`;
  const CLIPPER_MAIN = `${CLIPPER_PACKAGE}/.Main`;
  const ATTACKER_PACKAGE = 'com.attacker.app';
  const ATTACKER_MAIN = `${ATTACKER_PACKAGE}/.MainActivity`;

  console.log(`[1] Verifying device ${deviceId} and Clipper installation...`);
  const { stdout: clipperCheck } = await execFileAsync('adb', ['-s', deviceId, 'shell', 'pm', 'path', CLIPPER_PACKAGE]);
  if (!clipperCheck.includes('package:')) {
    throw new Error('com.handyfarm.clipper is not installed on device!');
  }
  console.log('  -> Clipper is installed and active.\n');

  console.log('[2] Setting initial legitimate clipboard content...');
  const initialText = `GENUINE_CLIPBOARD_UNTOUCHED_${Date.now()}`;
  const b64 = Buffer.from(initialText).toString('base64');
  await execFileAsync('adb', [
    '-s', deviceId, 'shell',
    `RAW=$(echo ${b64} | base64 -d); am broadcast -a clipper.set -n ${CLIPPER_RECEIVER} --es text "$RAW"`
  ]);

  // Read back to confirm initial state
  await execFileAsync('adb', ['-s', deviceId, 'shell', 'am', 'start', '-W', '-n', CLIPPER_MAIN]);
  const { stdout: getInit } = await execFileAsync('adb', ['-s', deviceId, 'shell', `am broadcast -a clipper.get -n ${CLIPPER_RECEIVER}`]);
  await execFileAsync('adb', ['-s', deviceId, 'shell', 'input', 'keyevent', '4']);
  const matchInit = getInit.match(/data="(.*)"/s);
  if (!matchInit || matchInit[1] !== initialText) {
    throw new Error(`Failed to initialize clipboard! Got: ${getInit}`);
  }
  console.log(`  -> Clipboard securely initialized to: "${initialText}"\n`);

  console.log('[3] Installing throwaway adversary APK (com.attacker.app)...');
  await execFileAsync('adb', ['-s', deviceId, 'uninstall', ATTACKER_PACKAGE]).catch(() => {});
  const { stdout: installOut } = await execFileAsync('adb', ['-s', deviceId, 'install', '-r', adversaryApk]);
  console.log(`  -> adb install: ${installOut.trim()}\n`);

  console.log('[4] Clearing device logcat...');
  await execFileAsync('adb', ['-s', deviceId, 'logcat', '-c']);

  console.log('[5] Launching adversary app on device (runs as unprivileged UID)...');
  const { stdout: launchOut } = await execFileAsync('adb', ['-s', deviceId, 'shell', 'am', 'start', '-W', '-n', ATTACKER_MAIN]);
  console.log(`  -> am start output: ${launchOut.trim()}`);

  console.log('  -> Waiting for adversary broadcasts to be processed...');
  await new Promise(r => setTimeout(r, 2000));

  console.log('\n[6] Inspecting logcat outputs from ClipperReceiver and Adversary...');
  const { stdout: logcatClipper } = await execFileAsync('adb', ['-s', deviceId, 'logcat', '-d', '-s', 'HandyFarmClipper']);
  const { stdout: logcatAdversary } = await execFileAsync('adb', ['-s', deviceId, 'logcat', '-d', '-s', 'AdversaryTest']);

  console.log('--- [HandyFarmClipper Logcat] ---');
  console.log(logcatClipper.trim() || '(empty)');
  console.log('--- [AdversaryTest Logcat] ---');
  console.log(logcatAdversary.trim() || '(empty)');
  console.log('--------------------------------\n');

  // Verify rejection logs
  if (!logcatClipper.includes('Blocked unauthorized broadcast')) {
    throw new Error('FAILED: HandyFarmClipper logcat did not contain "Blocked unauthorized broadcast"!');
  }
  console.log('✓ PASS: ClipperReceiver actively logged "Blocked unauthorized broadcast"!');

  if (!logcatAdversary.includes('ERROR: Unauthorized sender')) {
    throw new Error('FAILED: Adversary did not receive "ERROR: Unauthorized sender" result!');
  }
  console.log('✓ PASS: Adversary received "ERROR: Unauthorized sender" error response!');

  console.log('\n[7] Verifying system clipboard integrity...');
  await execFileAsync('adb', ['-s', deviceId, 'shell', 'am', 'start', '-W', '-n', CLIPPER_MAIN]);
  const { stdout: getFinal } = await execFileAsync('adb', ['-s', deviceId, 'shell', `am broadcast -a clipper.get -n ${CLIPPER_RECEIVER}`]);
  await execFileAsync('adb', ['-s', deviceId, 'shell', 'input', 'keyevent', '4']);
  const matchFinal = getFinal.match(/data="(.*)"/s);
  const finalClip = matchFinal ? matchFinal[1] : null;

  console.log(`  -> Clipboard content after attack: "${finalClip}"`);
  if (finalClip === 'MALICIOUS_OVERWRITE_ATTACK') {
    throw new Error('CRITICAL SECURITY FAILURE: Clipboard was modified by unauthorized app!');
  }
  if (finalClip !== initialText) {
    throw new Error(`Clipboard corrupted! Expected "${initialText}", got "${finalClip}"`);
  }
  console.log('✓ PASS: Clipboard content was completely UNTOUCHED by the adversary attack!\n');

  console.log('[8] Uninstalling adversary APK...');
  await execFileAsync('adb', ['-s', deviceId, 'uninstall', ATTACKER_PACKAGE]);
  console.log('✓ Adversary app uninstalled cleanly.\n');

  console.log('===============================================================');
  console.log(' ADVERSARIAL RECEIVER PROTECTION TEST: 100% PASSED');
  console.log(' Non-shell, third-party apps CANNOT spoof clipper.set/get.');
  console.log('===============================================================');
}

run().catch((err) => {
  console.error('\n❌ ADVERSARIAL TEST FAILED:', err);
  process.exit(1);
});
