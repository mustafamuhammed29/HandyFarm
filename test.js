import { execFileSync } from 'child_process';
const deviceId = '106293738O006649';

const text = 'test "quoted" & more $5 (USD)';
// Strip: backtick, ;, &, |
let sanitized = text.replace(/[`;&|]/g, '');
// Escape: $, (, ), ", \
sanitized = sanitized.replace(/([$()"\\])/g, '\\$1');

console.log('Sending sanitized:', sanitized);

try {
  // Using execFileSync to perfectly mimic passing exactly the string without host shell mangling
  const stdout = execFileSync('adb', ['-s', deviceId, 'shell', `input text "${sanitized}"`]);
  console.log('Success!', stdout.toString());
} catch (e) {
  console.error('Failed:', e.message);
}
