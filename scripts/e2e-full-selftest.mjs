import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, poll, unzip } from './e2e-full-harness.mjs';
import { initializePsdPixels, verifyPsd, verifyMaskedPixels, redact } from './e2e-full-support.mjs';
import { scenarios, completionSummary } from './e2e-full-registry.mjs';

const requireApp = createRequire(join(root, 'apps/desktop/package.json'));
const requireBackend = createRequire(join(root, 'packages/backend/package.json'));
const inventory = JSON.parse(await readFile(join(root, 'migration-discovery/original-job-inventory.json'), 'utf8'));

test('resolved Node polling never treats an unresolved Promise as a passing state', async () => {
  let calls = 0;
  const value = await poll(async () => { await new Promise(resolve => setImmediate(resolve)); return { status: ++calls === 3 ? 'ready' : 'pending' }; }, value => value.status === 'ready', { timeout: 3000 });
  assert.equal(calls, 3); assert.equal(value.status, 'ready');
});
test('polling times out for a persistently wrong resolved state', async () => {
  await assert.rejects(poll(async () => ({ status: 'pending' }), value => value.status === 'ready', { timeout: 10 }), /Timed out/);
});
test('blocked scenarios and missing successful JobTypes cannot count as completion', () => {
  const rows = scenarios.map(scenario => ({ id: scenario.id, status: 'passed', assertions: 1, jobs: [], verifiedBranches: [] }));
  const initial = completionSummary(rows, inventory);
  assert.equal(initial.complete, false); assert.equal(initial.missingJobTypes.length, 21);
  rows[0].jobs = inventory.kinds.map(type => ({ type, status: 'SUCCEEDED' }));
  rows[0].verifiedBranches = ['COPYWRITE:LISTING'];
  assert.equal(completionSummary(rows, inventory).complete, true);
  rows.at(-1).status = 'blocked'; assert.equal(completionSummary(rows, inventory).complete, false);
  rows.at(-1).status = 'passed'; rows[0].jobs[0].status = 'UNKNOWN';
  assert.ok(completionSummary(rows, inventory).missingJobTypes.includes('PLAN'));
});
test('ZIP reader checks all stored/deflated bytes and rejects CRC tampering and traversal', () => {
  const { zipSync, strToU8 } = requireApp('fflate');
  const original = zipSync({ 'manifest.json': strToU8('{"selected":["one","two"]}'), 'images/source.png': Uint8Array.from([1, 2, 3, 4]) });
  const files = unzip(Buffer.from(original)); assert.equal(files.size, 2); assert.deepEqual([...files.get('images/source.png')], [1, 2, 3, 4]);
  const corrupted = Buffer.from(original); const central = corrupted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); corrupted[central + 16] ^= 1;
  assert.throws(() => unzip(corrupted));
  assert.throws(() => unzip(Buffer.from(zipSync({ '../outside': strToU8('unsafe') }))));
});
test('PSD verification decodes editable RGBA layers rather than accepting the signature', () => {
  const module = requireApp('ag-psd'); initializePsdPixels(module);
  const { writePsdBuffer, readPsd } = module;
  const data = new Uint8ClampedArray([90, 120, 150, 255, 90, 120, 150, 128, 0, 0, 0, 0, 90, 120, 150, 255]);
  const imageData = { width: 2, height: 2, data };
  const bytes = writePsdBuffer({ width: 2, height: 2, imageData, children: [{ name: 'Synthetic editable subject', left: 0, top: 0, imageData }] });
  const result = verifyPsd(readPsd, bytes, ['Synthetic editable subject']);
  assert.equal(result.layers.length, 1); assert.equal(result.visiblePixels, 3);
  assert.throws(() => verifyPsd(readPsd, Buffer.from('8BPS')));
});
test('pixel verifier proves zero/soft/solid mask alpha and refuses changed source RGB', async () => {
  const sharp = requireBackend('sharp');
  const source = await sharp(Buffer.from([30, 60, 90, 255, 30, 60, 90, 255, 30, 60, 90, 255]), { raw: { width: 3, height: 1, channels: 4 } }).png().toBuffer();
  const mask = await sharp(Buffer.from([0, 128, 255]), { raw: { width: 3, height: 1, channels: 1 } }).png().toBuffer();
  const layer = await sharp(Buffer.from([0, 0, 0, 0, 30, 60, 90, 128, 30, 60, 90, 255]), { raw: { width: 3, height: 1, channels: 4 } }).png().toBuffer();
  const result = await verifyMaskedPixels(sharp, source, layer, mask); assert.equal(result.soft, 1); assert.equal(result.transparent, 1);
  const wrong = await sharp(layer).modulate({ brightness: 2 }).png().toBuffer();
  await assert.rejects(verifyMaskedPixels(sharp, source, wrong, mask));
});
test('artifact redaction removes synthetic keys and bearer tokens', () => {
  const encoded = redact({ key: 'only-this-test', message: 'Bearer test-access-token' }, ['only-this-test']);
  assert.ok(!encoded.includes('only-this-test')); assert.ok(!encoded.includes('test-access-token'));
});
test('network guard permits only the exact fixture socket and denies TCP, DNS and UDP escapes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ecomgen-full-guard-test-'));
  let received = 0;
  const server = createServer((_request, response) => { received++; response.end('local only'); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const code = `import {installNetworkGuard} from ${JSON.stringify(pathToFileURL(join(root, 'scripts/e2e-full-network.mjs')).href)};
      import net from 'node:net'; import dns from 'node:dns'; import dgram from 'node:dgram';
      installNetworkGuard({origins:[process.argv[1]],auditFile:process.argv[2]});
      if(await (await fetch(process.argv[1])).text()!=='local only')throw Error('allowed fixture failed');
      let denied=0;for(const attempt of [()=>fetch('http://192.0.2.1:8088/'),()=>net.connect({host:'127.0.0.1',port:1}),()=>dns.promises.resolve4('example.invalid'),()=>dgram.createSocket('udp4')]){try{await attempt();}catch(error){if(String(error).includes('E2E_NETWORK_BLOCKED')||String(error.cause).includes('E2E_NETWORK_BLOCKED'))denied++;else throw error;}}
      if(denied!==4)throw Error('network escape accepted');`;
    await new Promise((resolve, reject) => {
      const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.ECOMGEN_E2E_GUARD_ORIGINS;
      const child = spawn(process.execPath, ['--input-type=module', '-e', code, origin, join(directory, 'audit.jsonl')], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
      const timeout = setTimeout(() => { child.kill(); reject(Error('Guard selftest timed out')); }, 10000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', status => { clearTimeout(timeout); status === 0 ? resolve() : reject(Error(stderr || `Guard child exited ${status}`)); });
    });
    assert.equal(received, 1, 'only local fixture request reached a server');
    const audit = (await readFile(join(directory, 'audit.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(audit.filter(row => row.event === 'blocked').length, 4);
  } finally { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
});
