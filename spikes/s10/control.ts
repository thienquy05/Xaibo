// P0-S10-T1 positive control: one deliberate attempt to a reserved test address (RFC 5737) or name (RFC 2606).
// Imported by the spike app (XAIBO_S10_CONTROL) and run directly for the forwarder runtime: control.ts tcp|dns
import { lookup } from 'node:dns';
import { connect } from 'node:net';

export function attempt(kind: string) {
  if (kind === 'tcp') connect(443, '192.0.2.1').on('error', () => {});
  else if (kind === 'dns') lookup('example.invalid', () => {});
}

if (import.meta.main) { attempt(process.argv[2] ?? ''); setTimeout(() => process.exit(0), 1000); }
