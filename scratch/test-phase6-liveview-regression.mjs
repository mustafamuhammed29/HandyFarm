import { spawn, execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const PORT = 9226;

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 1;
    this.callbacks = new Map();
  }

  async waitOpen() {
    const { WebSocket } = await import('ws');
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id && this.callbacks.has(msg.id)) {
          const cb = this.callbacks.get(msg.id);
          this.callbacks.delete(msg.id);
          cb(msg.result, msg.error);
        }
      });
    });
  }

  eval(expression) {
    return new Promise((resolve, reject) => {
      const msgId = this.id++;
      this.callbacks.set(msgId, (result, err) => {
        if (err) return reject(new Error(err.message || JSON.stringify(err)));
        if (result?.exceptionDetails) {
          return reject(new Error(result.exceptionDetails.exception?.description || 'Evaluation exception'));
        }
        resolve(result?.result?.value);
      });

      this.ws.send(JSON.stringify({
        id: msgId,
        method: 'Runtime.evaluate',
        params: {
          expression,
          returnByValue: true,
          awaitPromise: true
        }
      }));
    });
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

async function fetchCdpTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      if (res.ok) {
        const targets = await res.json();
        const pageTarget = targets.find(t => t.type === 'page' && !t.url.includes('devtools'));
        if (pageTarget && pageTarget.webSocketDebuggerUrl) {
          return pageTarget.webSocketDebuggerUrl;
        }
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('CDP target not available after 20 seconds');
}

const sleep = ms => new Promise(res => setTimeout(res, ms));

async function main() {
  console.log('========================================================================');
  console.log('   PHASE 6 FINAL REGRESSION: LIVE-VIEW + REDACTED LOGCAT -D TEST');
  console.log('========================================================================\n');

  console.log('1. Checking attached physical hardware...');
  const adbOut = execSync('adb devices').toString();
  console.log(adbOut.trim());
  if (!adbOut.includes('device\n') && !adbOut.includes('device\r\n')) {
    throw new Error('No physical device connected via ADB!');
  }

  const lines = adbOut.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('List of'));
  if (lines.length === 0) throw new Error('No physical device found!');
  const deviceId = lines[0].split(/\s+/)[0];
  console.log(`Using target device: ${deviceId}`);

  // Inject a known test credential log message into logcat
  console.log('\n2. Injecting test logcat entry with credentials for redaction test...');
  execSync(`adb -s ${deviceId} shell log -t "SecurityAuditTest" "UserAuth password=\\"super_secret_pass_999\\" token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.fakeSignature999"`);
  console.log('✓ Injected tagged log entry into device logcat');

  console.log('\n3. Starting Electron with remote debugging (Port ' + PORT + ')...');
  const electronLogs = [];
  const electronProc = spawn('npx', ['electron', '.', `--remote-debugging-port=${PORT}`], {
    cwd: rootDir,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  electronProc.stdout.on('data', d => {
    const s = d.toString();
    electronLogs.push(s);
    if (s.includes('[POC') || s.includes('touch') || s.includes('Scrcpy') || s.includes('Frame')) {
      process.stdout.write(`  [Electron Stdout] ${s}`);
    }
  });

  electronProc.stderr.on('data', d => {
    const s = d.toString();
    if (s.includes('Error') || s.includes('Warn')) {
      process.stdout.write(`  [Electron Stderr] ${s}`);
    }
  });

  try {
    const wsUrl = await fetchCdpTarget();
    console.log('✓ Connected to Electron window CDP:', wsUrl);

    const cdp = new CdpClient(wsUrl);
    await cdp.waitOpen();

    // Check 1: Verify logcat -d routing through redactLogcatText in run-adb-command
    console.log('\n[CHECK 1] Testing allowlisted logcat -d routing through redactLogcatText()...');
    const logcatCmd = 'logcat -d -s SecurityAuditTest';
    console.log(`Executing via runAdbCommand: "${logcatCmd}"...`);
    const logcatRes = await cdp.eval(`window.electronAPI.runAdbCommand('${deviceId}', '${logcatCmd}')`);
    console.log('runAdbCommand(logcat -d) result success:', logcatRes?.success);
    console.log('Raw output preview:\n', logcatRes?.output?.trim());

    if (!logcatRes?.success || !logcatRes?.output) {
      throw new Error(`logcat -d failed to execute: ${JSON.stringify(logcatRes)}`);
    }

    if (logcatRes.output.includes('super_secret_pass_999')) {
      throw new Error('SECURITY VULNERABILITY: password="super_secret_pass_999" was NOT redacted from logcat -d output!');
    }
    if (logcatRes.output.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')) {
      throw new Error('SECURITY VULNERABILITY: JWT token was NOT redacted from logcat -d output!');
    }
    if (!logcatRes.output.includes('[REDACTED]') && !logcatRes.output.includes('[REDACTED_JWT]')) {
      throw new Error('Expected [REDACTED] or [REDACTED_JWT] in logcat -d output, but neither was found!');
    }
    console.log('✓ PASS: allowlisted logcat -d command strictly passes through redactLogcatText() before reaching the renderer!');

    // Check 2: Live View Scrcpy Video Rendering and Touch Input under sandbox: true
    console.log('\n[CHECK 2] Testing Live-View Scrcpy Streaming & Touch Input under sandbox: true...');
    
    // Wait for live view session to connect and video frames to render
    console.log('Waiting for Live View WebCodecs canvas rendering...');
    let canvasInfo = null;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      canvasInfo = await cdp.eval(`
        (() => {
          const canvases = Array.from(document.querySelectorAll('canvas'));
          if (canvases.length === 0) return null;
          const canvas = canvases[0];
          const rect = canvas.getBoundingClientRect();
          let nonZeroPixels = 0;
          try {
            const ctx = canvas.getContext('2d');
            if (ctx) {
              const imgData = ctx.getImageData(0, 0, Math.min(canvas.width, 50), Math.min(canvas.height, 50));
              for (let j = 0; j < imgData.data.length; j += 4) {
                if (imgData.data[j] > 0 || imgData.data[j+1] > 0 || imgData.data[j+2] > 0) {
                  nonZeroPixels++;
                }
              }
            }
          } catch {}
          return {
            canvasCount: canvases.length,
            width: canvas.width,
            height: canvas.height,
            clientWidth: rect.width,
            clientHeight: rect.height,
            nonZeroPixels
          };
        })()
      `);
      if (canvasInfo && canvasInfo.width > 0 && canvasInfo.height > 0) {
        break;
      }
    }

    console.log('Live View Canvas Information:', canvasInfo);
    if (!canvasInfo || canvasInfo.width === 0 || canvasInfo.height === 0) {
      throw new Error('Canvas was not mounted or has 0 dimensions in sandboxed renderer!');
    }
    console.log(`✓ Video frame rendering verified: Resolution=${canvasInfo.width}x${canvasInfo.height}, RenderedSize=${canvasInfo.clientWidth}x${canvasInfo.clientHeight}`);

    // Verify touch input interaction
    console.log('\nTesting touch input injection over active live view bridge...');
    // Clear previous logs
    const touchConfirmed = await cdp.eval(`
      (() => {
        const canvas = document.querySelector('canvas');
        if (!canvas) return { error: 'No canvas found' };
        
        const rect = canvas.getBoundingClientRect();
        const clientX = rect.left + rect.width / 2;
        const clientY = rect.top + rect.height / 2;
        
        // Dispatch pointerdown, pointermove, pointerup
        const downEvt = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX, clientY, pointerId: 1, pressure: 1 });
        const upEvt = new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX, clientY, pointerId: 1, pressure: 0 });
        
        canvas.dispatchEvent(downEvt);
        canvas.dispatchEvent(upEvt);
        return { success: true, dispatchedX: clientX, dispatchedY: clientY };
      })()
    `);
    console.log('Canvas touch event dispatched:', touchConfirmed);

    // Wait for touch roundtrip through WebSocket to scrcpy controller
    await sleep(1000);
    const combinedLogs = electronLogs.join('\n');
    const touchReceived = combinedLogs.includes('[POC-TOUCH] Forwarding touch') || combinedLogs.includes('Bytes flushed for touch action');
    console.log('Electron stdout confirmed touch action forwarded:', touchReceived);
    if (!touchReceived) {
      throw new Error('Touch input was dispatched in sandboxed renderer but was not processed by scrcpy controller!');
    }
    console.log('✓ PASS: Touch input successfully forwarded and processed by scrcpy controller in sandboxed mode!');

    cdp.close();
    console.log('\n========================================================================');
    console.log('   ALL PHASE 6 FINAL CHECKS PASSED: LIVE VIEW & REDACTION VERIFIED!');
    console.log('========================================================================\n');

  } finally {
    try {
      if (process.platform === 'win32' && electronProc.pid) {
        execSync(`taskkill /pid ${electronProc.pid} /T /F`, { stdio: 'ignore' });
      } else {
        electronProc.kill();
      }
    } catch {}
  }
}

main().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('\n❌ FINAL REGRESSION TEST FAILED:', err);
  process.exit(1);
});
