const { app, clipboard } = require('electron');
const { Adb } = require('@devicefarmer/adbkit');
const client = Adb.createClient();

app.whenReady().then(async () => {
    const deviceId = '106293738O006649';
    console.log("Setting device clipboard...");
    await client.shell(deviceId, `am broadcast -a clipper.set -e text "field-test-clipboard-check-927"`);
    
    await new Promise(r => setTimeout(r, 1000));
    
    console.log("Reading clipboard via IPC logic...");
    const stream = await client.shell(deviceId, 'am broadcast -a clipper.get');
    const output = await new Promise((resolve, reject) => {
        let result = '';
        stream.on('data', chunk => result += chunk.toString());
        stream.on('end', () => resolve(result));
        stream.on('error', reject);
    });
    
    const match = output.match(/data="(.*)"/s);
    if (match) {
        clipboard.writeText(match[1]);
        console.log("System clipboard is now:", clipboard.readText());
    } else {
        console.log("Match failed. Raw output:", output);
    }
    app.quit();
});
