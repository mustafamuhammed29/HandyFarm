import { probeMaestro, runMaestroFlow } from '../electron/maestro.ts';

const deviceSerial = '106293738O006649';

async function main() {
  console.log('1. Probing Maestro:');
  const probe = await probeMaestro();
  console.log('Probe result:', probe);
  if (!probe.ok) throw new Error('Maestro probe failed');

  console.log('\n2. Running Maestro flow on device:', deviceSerial);
  const flowContent = `appId: com.android.settings
---
- launchApp
- back
`;

  const result = await runMaestroFlow({
    flowContent,
    name: 'live-maestro-test',
  }, deviceSerial);

  console.log('\n3. Result:');
  console.log('Status:', result.status);
  console.log('Exit code:', result.exitCode);
  console.log('Duration:', result.durationMs, 'ms');
  console.log('Parsed failures:', result.parsedFailures);
  console.log('Stdout:\n', result.stdout);
  console.log('Stderr:\n', result.stderr);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
