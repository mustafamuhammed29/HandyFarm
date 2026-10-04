import { execFile } from 'child_process';
import { promisify } from 'util';
import { captureDeviceManifest, verifyDeviceAgainstBaseline } from '../electron/baseline.ts';

const execFileAsync = promisify(execFile);

async function main() {
  const deviceId = '106293738O006649';
  console.log(`[1] Capturing baseline manifest for physical device ${deviceId}...`);
  
  const manifest = await captureDeviceManifest(deviceId, `phys_${deviceId}`, (args) => execFileAsync('adb', args));
  console.log('\n--- Captured Manifest Summary ---');
  console.log('Device ID:       ', manifest.deviceId);
  console.log('Physical ID:     ', manifest.physicalDeviceId);
  console.log('Captured At:     ', new Date(manifest.capturedAt).toISOString());
  console.log('Model:           ', manifest.immutable.model);
  console.log('Screen:          ', manifest.immutable.screen);
  console.log('GLES:            ', manifest.immutable.gpuRenderer);
  console.log('SELinux:         ', manifest.immutable.selinuxMode);
  console.log('Verified Boot:   ', manifest.immutable.verifiedBootState);
  console.log('Play Services:   ', manifest.immutable.playServicesVersion);
  console.log('Sensors Count:   ', manifest.immutable.sensorList?.length || 0);
  console.log('Packages Count:  ', manifest.mutable.installedPackages?.length || 0);
  console.log('Accounts:        ', manifest.mutable.accounts);
  console.log('Locale / TZ:     ', manifest.mutable.locale, '/', manifest.mutable.timezone);
  console.log('Animation Scales:', manifest.mutable.animationScales);

  console.log('\n[2] Running verify against baseline on unchanged live hardware...');
  const verifyRes = await verifyDeviceAgainstBaseline(deviceId, manifest, (args) => execFileAsync('adb', args));
  console.log('Verified:        ', verifyRes.verified);
  console.log('Diff Count:      ', verifyRes.diffs.length);
  console.log('Clock Offset:    ', `${verifyRes.clockVerification?.offsetMs}ms (bounded: ${verifyRes.clockVerification?.bounded})`);

  console.log('\n[3] Simulating drift by injecting an unapproved package into comparison...');
  const modifiedManifest = JSON.parse(JSON.stringify(manifest));
  // Remove an app from baseline so current device state looks like it has an unapproved app
  if (modifiedManifest.mutable.installedPackages.length > 0) {
    const unapproved = modifiedManifest.mutable.installedPackages.pop();
    console.log(`Simulated baseline excluding: ${unapproved.packageName}`);
    const driftRes = await verifyDeviceAgainstBaseline(deviceId, modifiedManifest, (args) => execFileAsync('adb', args));
    console.log('Verified:        ', driftRes.verified);
    console.log('Diffs Detected:  ', JSON.stringify(driftRes.diffs, null, 2));
  }
}

main().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
