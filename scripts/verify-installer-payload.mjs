import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

// Maintained from the historical comparator; only the temporary extraction tree
// created below is removed. The installer and inspected application stay intact.
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node scripts/verify-installer-payload.mjs <installer> <win-unpacked> <new-report.json> [--seven-zip <7za executable>]\nSet PIXELMUSE_7ZA or put 7za on PATH when --seven-zip is omitted. Extracts and compares bytes; never executes the installer.');
  process.exit(0);
}
const [installerArg, unpackedArg, reportArg, option, binary] = args;
assert.ok(installerArg && unpackedArg && reportArg, 'Pass installer, unpacked directory and a fresh report path');
assert.ok(args.length === 3 || (args.length === 5 && option === '--seven-zip' && binary), 'Unsupported option');
const installer = resolve(installerArg), unpacked = resolve(unpackedArg), report = resolve(reportArg);
const canonical = path => process.platform === 'win32' ? path.toLowerCase() : path;
assert.ok(!canonical(report).startsWith(canonical(dirname(installer) + sep)), 'Report must be outside the inspected release directory');
assert.ok(!canonical(report).startsWith(canonical(unpacked + sep)), 'Report must be outside the unpacked application directory');
await assert.rejects(access(report), error => error.code === 'ENOENT', 'Report must not already exist');
const sevenZip = binary || process.env.PIXELMUSE_7ZA || '7za';
function archive(options) {
  const run = spawnSync(sevenZip, options, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120000, windowsHide: true });
  assert.equal(run.status, 0, run.error ? `${run.error.message}; configure --seven-zip or PIXELMUSE_7ZA` : `${run.stderr}\n${run.stdout?.slice(-1500)}`);
  return run.stdout;
}
async function hash(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
async function files(directory, prefix = '') {
  const result = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), 'No links in inspected payload');
    const name = prefix + entry.name;
    if (entry.isDirectory()) for (const [key, value] of await files(join(directory, entry.name), `${name}/`)) { assert.ok(!result.has(key), 'Duplicate payload path'); result.set(key, value); }
    else if (entry.isFile()) { const key = name.toLowerCase(); assert.ok(!result.has(key), 'Duplicate payload path'); result.set(key, { name, path: join(directory, entry.name) }); }
    else assert.fail('Unexpected non-regular payload entry');
  }
  return result;
}
const listing = archive(['l', '-slt', installer]);
const members = listing.split('----------\r\n')[1] ?? listing.split('----------\n')[1];
assert.ok(members, 'Embedded application archive must be readable');
assert.ok(!/^(?:Symbolic Link|Hard Link) = /m.test(members), 'No archive links');
const paths = [...members.matchAll(/^Path = (.+)\r?$/gm)].map(match => match[1].trim().replaceAll('\\', '/'));
assert.ok(paths.length > 0 && paths.length < 100000, 'Bounded application archive');
for (const path of paths) assert.ok(!/^(?:\/|[a-z]:)|(?:^|\/)\.\.(?:\/|$)/i.test(path) && !path.includes(':'), `Unsafe archive path ${path}`);
const expandedBytes = [...members.matchAll(/^Size = (\d+)\r?$/gm)].reduce((sum, match) => sum + Number(match[1]), 0);
assert.ok(expandedBytes > 0 && expandedBytes <= 2 * 1024 ** 3, 'Application archive capacity limit');
const temporary = await mkdtemp(join(tmpdir(), 'pixelmuse-installer-inspect-'));
try {
  archive(['x', installer, `-o${temporary}`, '-y', '-bd']);
  const expected = await files(unpacked), actual = await files(temporary);
  const runtimeExtras = [...expected.keys()].filter(key => !actual.has(key));
  assert.ok(runtimeExtras.every(key => key === 'debug.log'), `Unexpected unpacked-only files: ${runtimeExtras.join(', ')}`);
  // Chromium appends to this root log during EXE acceptance. Record both bytes
  // separately; every other file, including nested logs, must match exactly.
  const runtimeLogs = [];
  if (expected.has('debug.log') || actual.has('debug.log')) {
    runtimeLogs.push({ path: 'debug.log', unpackedSha256: expected.has('debug.log') ? await hash(expected.get('debug.log').path) : null, installerSha256: actual.has('debug.log') ? await hash(actual.get('debug.log').path) : null });
    expected.delete('debug.log'); actual.delete('debug.log');
  }
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort(), 'Embedded payload file set equals unpacked application');
  const matched = [];
  for (const [key, entry] of expected) {
    const expectedHash = await hash(entry.path), actualHash = await hash(actual.get(key).path);
    assert.equal(actualHash, expectedHash, `Payload bytes differ: ${entry.name}`);
    if (/\.exe$|resources\/app\.asar$|\.node$|builtin-suites\.db$/i.test(entry.name)) matched.push({ path: entry.name, sha256: expectedHash });
  }
  const result = { status: 'passed', scope: 'embedded-application-payload-byte-comparison', installer, installerSha256: await hash(installer), unpacked, files: expected.size, expandedBytes, runtimeExtras, runtimeLogs, matched, limit: 'Root Chromium debug.log is recorded separately, excluded from immutable application comparison. No installer execution, installed-path launch, registry, upgrade or uninstall validation' };
  await writeFile(report, JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ status: result.status, files: result.files, installerSha256: result.installerSha256, report }, null, 2));
} finally { await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
