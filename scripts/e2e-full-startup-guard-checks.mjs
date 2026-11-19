// Executed only by startup regressions, inside the real browser/Backend PIDs.
import net from 'node:net';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { appendFileSync } from 'node:fs';

export async function verifyNodeGuard() {
  const guard = globalThis.__ecomgenFullGuard;
  if (!guard) throw Error('Cannot probe an unguarded process');
  let denied = 0;
  for (const attempt of [
    () => net.connect({ host: '192.0.2.1', port: 8088 }),
    () => net.connect({ host: '127.0.0.1', port: 1 }),
    () => net.connect('\\\\.\\pipe\\ecomgen-guard-must-deny'),
    () => dns.lookup('example.invalid', () => {}),
    () => dns.promises.resolve4('example.invalid'),
    () => new dns.Resolver().resolve4('example.invalid', () => {}),
    () => new dns.promises.Resolver().resolve4('example.invalid'),
    () => dgram.createSocket('udp4'),
  ]) {
    try { await attempt(); throw Error('Guard accepted a forbidden destination'); }
    catch (error) { if (!String(error).includes('E2E_NETWORK_BLOCKED')) throw error; denied++; }
  }
  const response = await fetch(guard.origins[0] + '/health');
  if (!response.ok) throw Error('Exact local fixture was blocked');
  await response.arrayBuffer();
  const result = { event: 'network-verified', pid: process.pid, type: process.type, token: guard.token, denied, fixture: true };
  appendFileSync(guard.auditFile, JSON.stringify(result) + '\n');
  return result;
}
