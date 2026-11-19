// Electron utilityProcess does not reliably honor Node --require/--import.
// Keep its real parentPort and execute the original production Backend after the guard.
import './e2e-full-network.mjs';
import { pathToFileURL } from 'node:url';

if (!globalThis.__ecomgenFullGuard || !process.env.ECOMGEN_E2E_GUARD_UTILITY_ENTRY) {
  throw new Error('E2E utility startup guard or original entry is missing');
}
await import(pathToFileURL(process.env.ECOMGEN_E2E_GUARD_UTILITY_ENTRY).href);
if (process.env.ECOMGEN_E2E_GUARD_SELFTEST === '1') {
  const { verifyNodeGuard } = await import('./e2e-full-startup-guard-checks.mjs');
  await verifyNodeGuard();
}
