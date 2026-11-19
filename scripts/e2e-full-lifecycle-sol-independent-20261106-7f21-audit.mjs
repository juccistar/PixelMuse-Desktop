import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root, makeContext } from './e2e-full-harness.mjs';
const base = join(root, '.cache/e2e-full');
const artifacts = await mkdtemp(join(base, 'lifecycle-sol-independent-audit-'));
process.env.ECOMGEN_E2E_ARTIFACTS = artifacts;
const dirs = [
  'lifecycle-sol-independent-mixed-kQ5Vwr',
  'lifecycle-sol-independent-controlled-nFUZCb',
  'lifecycle-sol-independent-controlled-VaZMcK',
  'lifecycle-sol-independent-cleanup-one-wyhBqV',
  'lifecycle-sol-independent-cleanup-many-yvhWnl',
  'lifecycle-sol-independent-shutdown-one-33x1d2',
  'lifecycle-sol-independent-shutdown-many-aSthet',
  'lifecycle-sol-independent-privacy-ELnHrK',
  'lifecycle-cdx-diagnostics-XuhZ2w',
];
const report = { artifacts, status: 'failed', directories: dirs, jsonFiles: 0, forbiddenFiles: [], forbiddenFields: [], secretMatches: 0, livePidMatches: [], sharedFilesUnchanged: false };
const pids = new Set();
const c = await makeContext();
const inspect = (value, filename) => {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:encryptedApiKey|masterKey|snapshot_json|input_json|rawResponse|responseBody|apiKey|api_key|receiptBody)$/i.test(key)) report.forbiddenFields.push({ filename, key });
    if (['pid', 'childPid', 'backendPid', 'browserPid', 'launcherPid'].includes(key) && Number.isSafeInteger(child) && child > 0) pids.add(child);
    inspect(child, filename);
  }
};
try {
  for (const dir of dirs) for (const name of await readdir(join(base, dir))) {
    if (/\.(?:sqlite|db|enc|cpuprofile)$/i.test(name) || /^(?:stderr|stdout)[-.]/i.test(name) || /^receipts?\.(?:json|jsonl|bin)$/i.test(name)) report.forbiddenFiles.push(join(dir, name));
    if (!/\.(?:json|jsonl|log)$/i.test(name)) continue;
    const text = await readFile(join(base, dir, name), 'utf8');
    if (text.includes(c.fakeKey) || text.includes('e2e-full-synthetic-v2-key') || /Bearer\s+(?!\[REDACTED\])[^\s"']+/i.test(text)) report.secretMatches++;
    if (name.endsWith('.json')) { inspect(JSON.parse(text), join(dir, name)); report.jsonFiles++; }
  }
  for (const pid of pids) {
    try { process.kill(pid, 0); report.livePidMatches.push(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  const original = JSON.parse(await readFile(join(base, dirs[0], 'independent-result.json'), 'utf8')).hashesBefore;
  const current = Object.fromEntries(await Promise.all(Object.keys(original).map(async path => [path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')])));
  report.sharedFilesUnchanged = JSON.stringify(original) === JSON.stringify(current);
  report.verifiedOwnedPids = pids.size;
  assert.deepEqual(report.forbiddenFiles, []); assert.deepEqual(report.forbiddenFields, []);
  assert.equal(report.secretMatches, 0); assert.deepEqual(report.livePidMatches, []); assert.equal(report.sharedFilesUnchanged, true);
  report.status = 'passed';
} catch (error) { report.error = error.message; }
finally {
  report.cleanup = await c.cleanup();
  await writeFile(join(artifacts, 'audit-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  process.exitCode = report.status === 'passed' && !report.cleanup.length ? 0 : 1;
}
