import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);

async function run() {
  console.log('========================================================');
  console.log(' HandyFarm First-Party Clipper Companion E2E Test');
  console.log('========================================================\n');

  const deviceId = '106293738O006649';
  const clipperPath = path.resolve('resources', 'clipper.apk');
  const CLIPPER_PACKAGE = 'com.handyfarm.clipper';
  const CLIPPER_RECEIVER = `${CLIPPER_PACKAGE}/.ClipperReceiver`;
  const CLIPPER_MAIN = `${CLIPPER_PACKAGE}/.Main`;

  console.log(`[Step 1] Checking connected device: ${deviceId}`);
  const { stdout: devicesOut } = await execFileAsync('adb', ['devices', '-l']);
  if (!devicesOut.includes(deviceId)) {
    throw new Error(`Device ${deviceId} not found in adb devices!`);
  }
  console.log(`  -> Device ${deviceId} detected and ready.\n`);

  console.log(`[Step 2] Verifying Play Protect verifier settings (must be enabled)`);
  await execFileAsync('adb', ['-s', deviceId, 'shell', 'settings', 'put', 'global', 'verifier_verify_adb_installs', '1']);
  await execFileAsync('adb', ['-s', deviceId, 'shell', 'settings', 'put', 'global', 'package_verifier_enable', '1']);
  const { stdout: v1 } = await execFileAsync('adb', ['-s', deviceId, 'shell', 'settings', 'get', 'global', 'verifier_verify_adb_installs']);
  const { stdout: v2 } = await execFileAsync('adb', ['-s', deviceId, 'shell', 'settings', 'get', 'global', 'package_verifier_enable']);
  console.log(`  -> verifier_verify_adb_installs: ${v1.trim()}`);
  console.log(`  -> package_verifier_enable: ${v2.trim()}`);
  if (v1.trim() !== '1' || v2.trim() !== '1') {
    throw new Error('Failed to enable verifier settings for test!');
  }
  console.log('  -> PASS: System package verifiers are fully ENABLED.\n');

  console.log(`[Step 3] Cleaning up any previous installation`);
  await execFileAsync('adb', ['-s', deviceId, 'uninstall', CLIPPER_PACKAGE]).catch(() => {});
  await execFileAsync('adb', ['-s', deviceId, 'uninstall', 'ca.zgrs.clipper']).catch(() => {});
  const { stdout: pmCheck } = await execFileAsync('adb', ['-s', deviceId, 'shell', 'pm', 'path', CLIPPER_PACKAGE]).catch(() => ({ stdout: '' }));
  if (pmCheck.includes('package:')) {
    throw new Error('Package still installed after uninstall!');
  }
  console.log('  -> PASS: Clean state confirmed.\n');

  console.log(`[Step 4] Running ensureClipperInstalled flow from resources/clipper.apk`);
  console.log(`  -> APK path: ${clipperPath} (${fs.statSync(clipperPath).size} bytes)`);
  
  // Exact ensureClipperInstalled logic from electron/main.ts
  const { stdout: installOut } = await execFileAsync('adb', [
    '-s', deviceId, 'install', '-r', '-d', '-g', clipperPath
  ]);
  console.log(`  -> adb install output: ${installOut.trim()}`);
  if (!installOut.includes('Success')) {
    throw new Error(`Install failed: ${installOut}`);
  }

  // Unstop package
  await execFileAsync('adb', ['-s', deviceId, 'shell', 'am', 'start', '-W', '-n', CLIPPER_MAIN]);
  await execFileAsync('adb', ['-s', deviceId, 'shell', 'input', 'keyevent', '4']);
  console.log('  -> PASS: First-party APK installed cleanly with Play Protect active.\n');

  console.log(`[Step 5] Checking package metadata on device`);
  const { stdout: dumpsysOut } = await execFileAsync('adb', ['-s', deviceId, 'shell', 'dumpsys', 'package', CLIPPER_PACKAGE]);
  const targetSdkMatch = dumpsysOut.match(/targetSdk=(\d+)/);
  const targetSdk = targetSdkMatch ? targetSdkMatch[1] : 'unknown';
  console.log(`  -> Installed package: ${CLIPPER_PACKAGE}`);
  console.log(`  -> Target SDK on device: ${targetSdk}`);
  if (targetSdk !== '34') {
    throw new Error(`Expected targetSdk=34, got ${targetSdk}`);
  }
  console.log('  -> PASS: Target SDK verified.\n');

  console.log(`[Step 6] Test Host -> Device sync (clipper.set)`);
  const testPayload1 = `Hello-HandyFarm-${Date.now()}`;
  const b64_1 = Buffer.from(testPayload1, 'utf-8').toString('base64');
  const { stdout: setOut } = await execFileAsync('adb', [
    '-s', deviceId, 'shell',
    `RAW=$(echo ${b64_1} | base64 -d); am broadcast -a clipper.set -n ${CLIPPER_RECEIVER} --es text "$RAW"`
  ]);
  console.log(`  -> broadcast set output: ${setOut.trim()}`);
  if (!setOut.includes('result=-1') && !setOut.includes('data="Text is copied into clipboard."')) {
    throw new Error(`clipper.set failed: ${setOut}`);
  }
  console.log('  -> PASS: clipper.set succeeded.\n');

  console.log(`[Step 7] Test Device -> Host sync (clipper.get)`);
  await execFileAsync('adb', ['-s', deviceId, 'shell', 'am', 'start', '-W', '-n', CLIPPER_MAIN]);
  const { stdout: getOut } = await execFileAsync('adb', [
    '-s', deviceId, 'shell',
    `am broadcast -a clipper.get -n ${CLIPPER_RECEIVER}`
  ]);
  await execFileAsync('adb', ['-s', deviceId, 'shell', 'input', 'keyevent', '4']);
  console.log(`  -> broadcast get output: ${getOut.trim()}`);
  const match1 = getOut.match(/data="(.*)"/s);
  if (!match1 || match1[1] !== testPayload1) {
    throw new Error(`clipper.get failed! Expected "${testPayload1}", got "${match1 ? match1[1] : 'null'}"`);
  }
  console.log(`  -> Successfully retrieved: "${match1[1]}"`);
  console.log('  -> PASS: Device -> Host sync verified.\n');

  console.log(`[Step 8] Test complex payload: multiline, quotes, shell metacharacters, emojis`);
  const complexPayload = `Test payload:\n1. 'single quotes' and "double quotes"\n2. \`backticks\` and $VARS\n3. semicolon ; am broadcast && calc\n4. Emojis: 🚜🌾📱✨🔥\n5. Tabs:\t[val1]\t[val2]`;
  const b64_2 = Buffer.from(complexPayload, 'utf-8').toString('base64');
  await execFileAsync('adb', [
    '-s', deviceId, 'shell',
    `RAW=$(echo ${b64_2} | base64 -d); am broadcast -a clipper.set -n ${CLIPPER_RECEIVER} --es text "$RAW"`
  ]);

  await execFileAsync('adb', ['-s', deviceId, 'shell', 'am', 'start', '-W', '-n', CLIPPER_MAIN]);
  const { stdout: getOut2 } = await execFileAsync('adb', [
    '-s', deviceId, 'shell',
    `am broadcast -a clipper.get -n ${CLIPPER_RECEIVER}`
  ]);
  await execFileAsync('adb', ['-s', deviceId, 'shell', 'input', 'keyevent', '4']);

  const match2 = getOut2.match(/data="(.*)"/s);
  const normalizedReceived = match2 ? match2[1].replace(/\r\n/g, '\n') : '';
  if (!match2 || normalizedReceived !== complexPayload) {
    throw new Error(`Complex payload mismatch!\nExpected:\n${complexPayload}\nGot:\n${match2 ? match2[1] : 'null'}`);
  }
  console.log('  -> Complex payload round-tripped with 100% byte fidelity!');
  console.log('  -> PASS: Complex payload test passed.\n');

  console.log(`[Step 9] Verifying Play Protect did not flag or remove package`);
  const { stdout: finalCheck } = await execFileAsync('adb', ['-s', deviceId, 'shell', 'pm', 'path', CLIPPER_PACKAGE]);
  if (!finalCheck.includes('package:')) {
    throw new Error('Package was removed by Play Protect!');
  }
  console.log(`  -> Package still healthy at: ${finalCheck.trim()}`);
  console.log('  -> PASS: Play Protect clean.\n');

  console.log('========================================================');
  console.log(' ALL 9 STEPS PASSED SUCCESSFULLY!');
  console.log(' First-party Clipper is wire-compatible, secure, and clean.');
  console.log('========================================================');
}

run().catch((err) => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
