const { app, clipboard } = require('electron');
const { Adb } = require('@devicefarmer/adbkit');
const client = Adb.createClient();

app.whenReady().then(async () => {
    const deviceId = '106293738O006649';
    const CLIPPER_PACKAGE = 'com.handyfarm.clipper';
    const CLIPPER_RECEIVER = `${CLIPPER_PACKAGE}/.ClipperReceiver`;
    const CLIPPER_MAIN = `${CLIPPER_PACKAGE}/.Main`;

    console.log("Setting device clipboard via com.handyfarm.clipper...");
    const payload = "Electron-RealDevice-Test-🔥-" + Date.now();
    const b64 = Buffer.from(payload).toString('base64');
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);

    await execFileAsync('adb', ['-s', deviceId, 'shell', `RAW=$(echo ${b64} | base64 -d); am broadcast -a clipper.set -n ${CLIPPER_RECEIVER} --es text "$RAW"`]);
    console.log("Device clipboard set. Now bringing helper to focus and reading...");

    await execFileAsync('adb', ['-s', deviceId, 'shell', 'am', 'start', '-W', '-n', CLIPPER_MAIN]);
    const stream = await client.getDevice(deviceId).shell(`am broadcast -a clipper.get -n ${CLIPPER_RECEIVER}`);
    const output = await new Promise((resolve, reject) => {
        let result = '';
        stream.on('data', chunk => result += chunk.toString());
        stream.on('end', () => resolve(result));
        stream.on('error', reject);
    });
    await execFileAsync('adb', ['-s', deviceId, 'shell', 'input', 'keyevent', '4']);
    
    console.log("Broadcast output:", output.trim());
    const match = output.match(/data="(.*)"/s);
    if (match) {
        clipboard.writeText(match[1]);
        console.log("System clipboard read succeeded! Value:", clipboard.readText());
        console.log("Matches original payload?", clipboard.readText() === payload);
    } else {
        console.log("Match failed. Raw output:", output);
    }
    app.quit();
});
