import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifacts = await mkdtemp(join(root, '.cache/e2e-full/lifecycle-sol-independent-privacy-'));
process.env.ECOMGEN_E2E_ARTIFACTS = artifacts;
// Intercept only diagnostic evidence writes in a unique copy. The production
// diagnostic implementation, redaction, and input collection run unchanged.
const copy = join(root, 'scripts/e2e-full-lifecycle-sol-independent-20261106-7f21-memory-harness.mjs');
const current = await readFile(join(root, 'scripts/e2e-full-harness.mjs'), 'utf8');
assert.ok(current.includes('writeFile, readdir'));
const source = current.replace('writeFile, readdir', 'writeFile as originalWriteFile, readdir') + '\nconst writeFile = (filename, ...args) => filename.includes("lifecycle-privacy-probe-") ? (globalThis.__solCapturedDiagnostic = String(args[0]), Promise.resolve()) : originalWriteFile(filename, ...args);\n';
await writeFile(copy, source);
let c;
const report = { status: 'failed', artifacts, method: 'Current diagnostics with only its evidence sink intercepted in memory; no canary values persisted' };
try {
  const { makeContext } = await import(pathToFileURL(copy));
  c = await makeContext();
  const unknownKey = randomUUID(), privateSnapshot = randomUUID(), bearer = randomUUID(), auditToken = randomUUID();
  await mkdir(join(c.userData, 'logs'), { recursive: true });
  await writeFile(join(c.userData, 'logs/main.log'), 'api_key=' + unknownKey + '\n');
  await writeFile(join(c.fixture, 'network-audit.jsonl'), JSON.stringify({ event: 'test-marker', token: auditToken }) + '\n');
  await c.lifecycleDiagnostics('privacy-probe', { diagnostics: () => ({ launcherPid: 123, stderr: JSON.stringify({ api_key: unknownKey, responseBody: privateSnapshot, knownKey: c.fakeKey, authorization: 'Bearer ' + bearer }) }) }, Error('Synthetic private snapshot ' + privateSnapshot));
  const captured = globalThis.__solCapturedDiagnostic;
  assert.equal(typeof captured, 'string');
  report.knownFixtureKeyRemoved = !captured.includes(c.fakeKey);
  report.bearerRemoved = !captured.includes(bearer);
  report.auditTokenRemoved = !captured.includes(auditToken);
  report.unknownKeyWouldBePersisted = captured.includes(unknownKey);
  report.privateSnapshotWouldBePersisted = captured.includes(privateSnapshot);
  report.noDiagnosticFilePersisted = !(await readdir(artifacts)).some(name => name.startsWith('lifecycle-privacy-probe-'));
  assert.ok(report.knownFixtureKeyRemoved && report.bearerRemoved && report.auditTokenRemoved && report.noDiagnosticFilePersisted);
  report.status = 'completed';
  report.privacyRequirement = report.unknownKeyWouldBePersisted || report.privateSnapshotWouldBePersisted ? 'not-guaranteed' : 'passed';
} catch (error) { report.error = error.message; }
finally {
  delete globalThis.__solCapturedDiagnostic;
  report.cleanup = c ? await c.cleanup() : [];
  await rm(copy, { force: true });
  await writeFile(join(artifacts, 'privacy-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  process.exitCode = report.status === 'completed' && !report.cleanup.length ? 0 : 1;
}
