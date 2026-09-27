const { app } = require('electron');
const { Adb } = require('@devicefarmer/adbkit');
const client = Adb.createClient();

app.whenReady().then(async () => {
    try {
        console.log("Calling am broadcast locally...");
        const stream = await client.getDevice('106293738O006649').shell('am broadcast -a clipper.get');
        console.log("Stream obtained");
        const AdbUtil = require('@devicefarmer/adbkit').Adb.util;
        const output = await AdbUtil.readAll(stream);
        console.log("OUTPUT:", output.toString());
    } catch(e) {
        console.error("ERROR:", e);
    }
    app.quit();
});
