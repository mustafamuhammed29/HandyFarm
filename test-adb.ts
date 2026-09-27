import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const AdbKit = require('@devicefarmer/adbkit');

const client = AdbKit.Adb.createClient();
const deviceId = '106293738O006649';

async function test() {
  const text = 'test "quoted" & more $5 (USD)';
  
  let sanitized = text.replace(/[`;&|]/g, '');
  sanitized = sanitized.replace(/([$()"\\])/g, '\\$1');
  
  console.log('Sending sanitized:', sanitized);
  
  try {
    const stream = await client.shell(deviceId, `input text "${sanitized}"`);
    const output = await AdbKit.Adb.util.readAll(stream);
    console.log('Output:', output.toString());
  } catch (e) {
    console.error('Error:', e);
  }
}

test();
