import { execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
import { sendTextToDevice, isAsciiOnly, determineTextRoute } from '../electron/textInput.ts';

const execFileAsync = promisify(execFile);
const deviceId = '106293738O006649';
const CLIPPER_RECEIVER = 'com.handyfarm.clipper/.ClipperReceiver';

async function runLiveVerification() {
  console.log('=== HANDYFARM LIVE TEXT INPUT VERIFICATION ===');
  console.log(`Target device: ${deviceId}`);

  // 1. Confirm failure on the raw old approach with Arabic text
  console.log('\n[1] Reproducing today\'s failure with raw "adb shell input text":');
  const arabicText = 'مرحبا بك في هاندي فارم';
  try {
    const b64 = Buffer.from(arabicText, 'utf-8').toString('base64');
    execFileSync('adb', [
      '-s', deviceId, 'shell',
      `RAW=$(echo ${b64} | base64 -d); input text "$RAW"`
    ], { encoding: 'utf-8' });
    console.log('UNEXPECTED: Raw input text succeeded?');
  } catch (err) {
    console.log('CONFIRMED: Old raw "input text" threw expected platform error:');
    const stderr = err.stderr || err.stdout || err.message;
    console.log(stderr.trim().split('\n').slice(0, 5).join('\n'));
  }

  // 2. Prepare focused input field on device (open Settings Search)
  console.log('\n[2] Ensuring input field has focus on device:');
  execFileSync('adb', ['-s', deviceId, 'shell', 'am', 'start', '-a', 'android.settings.APP_SEARCH_SETTINGS'], { encoding: 'utf-8' });
  // Wait briefly for UI to render
  await new Promise(r => setTimeout(r, 600));

  // Clear any existing text by selecting all and backspacing or tapping clear
  execFileSync('adb', ['-s', deviceId, 'shell', 'input keyevent 29 && input keyevent --longpress 67'], { encoding: 'utf-8' });

  // 3. Test Pure ASCII text through sendTextToDevice
  console.log('\n[3] Testing Pure ASCII text through sendTextToDevice:');
  const asciiText = 'HandyFarm_Pure_ASCII_Test';
  const asciiResult = await sendTextToDevice({
    deviceId,
    text: asciiText,
    ensureClipperInstalled: async (id) => {
      console.log(`[Mock/Live] ensureClipperInstalled verified for ${id}`);
    },
    execShell: async (_id, cmd) => {
      console.log(`  -> Executing: ${cmd}`);
      return await execFileAsync('adb', ['-s', deviceId, 'shell', cmd]);
    },
    logAction: (_id, action) => console.log(`  -> Logged: ${action}`),
    clipperReceiver: CLIPPER_RECEIVER
  });
  console.log('ASCII Result:', JSON.stringify(asciiResult));

  // 4. Test Arabic text through sendTextToDevice
  console.log('\n[4] Testing Arabic text through sendTextToDevice:');
  const arabicTestPayload = 'مرحبا_بالعالم_العربي_2026';
  const arabicResult = await sendTextToDevice({
    deviceId,
    text: arabicTestPayload,
    ensureClipperInstalled: async (id) => {
      console.log(`  -> ensureClipperInstalled checked for ${id}`);
    },
    execShell: async (_id, cmd) => {
      console.log(`  -> Executing: ${cmd}`);
      return await execFileAsync('adb', ['-s', deviceId, 'shell', cmd]);
    },
    logAction: (_id, action) => console.log(`  -> Logged: ${action}`),
    clipperReceiver: CLIPPER_RECEIVER
  });
  console.log('Arabic Result:', JSON.stringify(arabicResult));

  // 5. Inspect UI hierarchy to verify the text was pasted into the focused field
  console.log('\n[5] Verifying on-screen field content via UI Automator:');
  const dump = execFileSync('adb', ['-s', deviceId, 'shell', 'uiautomator dump /sdcard/dump.xml && cat /sdcard/dump.xml'], { encoding: 'utf-8' });
  const textMatches = dump.match(/<node[^>]*text="([^"]*)"[^>]*resource-id="com\.android\.settings\.intelligence:id\/text_search"/);
  if (textMatches) {
    console.log(`Observed text in AutoCompleteTextView: "${textMatches[1]}"`);
  } else {
    // Try other attribute order
    const altMatches = dump.match(/resource-id="com\.android\.settings\.intelligence:id\/text_search"[^>]*text="([^"]*)"/);
    console.log(`Observed text in AutoCompleteTextView (alt): "${altMatches ? altMatches[1] : 'not matched'}"`);
  }

  console.log('\n=== VERIFICATION COMPLETE ===');
}

runLiveVerification().catch(err => {
  console.error('Live verification failed:', err);
  process.exit(1);
});
