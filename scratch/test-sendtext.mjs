import { execFileSync } from 'child_process';

const deviceId = '106293738O006649';
const text = 'مرحبا "بالجميع" و \'أهلا\'';
const b64 = Buffer.from(text, 'utf-8').toString('base64');

console.log('Testing text with quotes:', text);
const broadcastCmd = `RAW=$(echo ${b64} | base64 -d); am broadcast -a clipper.set -n com.handyfarm.clipper/.ClipperReceiver --es text "$RAW"`;
const res1 = execFileSync('adb', ['-s', deviceId, 'shell', broadcastCmd], { encoding: 'utf-8' });
console.log('Broadcast:', res1.trim());

const res2 = execFileSync('adb', ['-s', deviceId, 'shell', 'input', 'keyevent', '279'], { encoding: 'utf-8' });
console.log('Paste keyevent output:', res2.trim());

// Dump UI
const dumpRes = execFileSync('adb', ['-s', deviceId, 'shell', 'uiautomator dump /sdcard/dump.xml && cat /sdcard/dump.xml'], { encoding: 'utf-8' });
const match = dumpRes.match(/<node[^>]*text="([^"]*)"[^>]*resource-id="com\.android\.settings\.intelligence:id\/text_search"/);
console.log('Found in search field:', match ? match[1] : 'not found');
