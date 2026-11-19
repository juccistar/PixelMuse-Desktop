import assert from 'node:assert/strict';
import test from 'node:test';
import { startFullMockProvider } from './full-mock-provider.mjs';
import { assertNonExecutingProbeRequests } from './e2e-full-business.mjs';
import { FalSegmentationProvider, GroundedSamSegmentationProvider, GiteeSam3SegmentationProvider, discoverProviderModels } from '../packages/providers/dist/index.js';

const adapters = [
  ['fal', FalSegmentationProvider, 'fal', 'POST', 400],
  ['grounded', GroundedSamSegmentationProvider, 'health', 'GET', 200],
  ['gitee', GiteeSam3SegmentationProvider, 'gitee-sam3', 'POST', 422],
];
const fakeKey = 'probe-accounting-synthetic-secret';
async function withMock(run) {
  const mock = await startFullMockProvider({ width: 13, height: 9 });
  const c = { mock, check: (value, label) => assert.ok(value, label), equal: (actual, expected, label) => assert.deepEqual(actual, expected, label) };
  try { await run(mock, c, { baseUrl: mock.baseUrl, apiKey: fakeKey }); }
  finally { await mock.close(); }
}
const post = async (mock, path, body) => {
  const response = await fetch(`${mock.baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await response.arrayBuffer();
  return response.status;
};

for (const [name, Adapter, kind, method, status] of adapters) {
  test(`${name}: actual built adapter probe has no parsed execution input`, () => withMock(async (mock, c, connection) => {
    const before = mock.state.total;
    const result = await new Adapter(connection).probe();
    assert.equal(result.models, null);
    assertNonExecutingProbeRequests(c, before);
    const record = mock.state.records.at(-1);
    assert.equal(record.kind, kind); assert.equal(record.method, method); assert.equal(record.status, status);
    assert.equal(record.hasParsedInput, false); assert.equal(record.validationRejected, method === 'POST');
    assert.equal(mock.state.counts[kind], 1, 'endpoint traffic is still counted');
    assert.ok(!JSON.stringify(mock.control.snapshot()).includes(fakeKey));
  }));

  for (const injected of [false, true]) {
    test(`${name}: real image-bearing adapter request${injected ? ' with injected 400' : ''} fails probe accounting`, () => withMock(async (mock, c, connection) => {
      const requestKind = name === 'grounded' ? 'grounded-sam' : kind;
      if (injected) mock.control.failNext(requestKind, { type: 'http', status: 400 });
      const before = mock.state.total;
      const pending = new Adapter(connection).segment({ imageUrl: `data:image/png;base64,${mock.images.image.toString('base64')}`, textPrompt: 'synthetic product' });
      if (injected) await assert.rejects(pending, error => error.status === 400);
      else assert.ok((await pending).mask.data.length > 0);
      const record = mock.state.records.find(row => row.id === before + 1);
      assert.equal(record.hasParsedInput, true); assert.equal(record.validationRejected, false);
      assert.equal(record.status, injected ? 400 : 200);
      assert.equal(mock.state.counts[requestKind], 1, 'execution requests remain counted even when rejected');
      assert.throws(() => assertNonExecutingProbeRequests(c, before), /no image, model or other execution input/);
    }));
  }
}

test('actual built model discovery is a read-only probe', () => withMock(async (mock, c, connection) => {
  assert.ok((await discoverProviderModels(connection)).models.includes('mock-image'));
  assertNonExecutingProbeRequests(c, 0);
}));

test('model-only validation failure is distinguishable from an empty probe', () => withMock(async (mock, c) => {
  assert.equal(await post(mock, '/images/generations', { model: 'mock-image' }), 400);
  assert.equal(mock.state.records[0].validationRejected, true);
  assert.equal(mock.state.records[0].hasParsedInput, true);
  assert.throws(() => assertNonExecutingProbeRequests(c, 0), /no image, model or other execution input/);
}));

test('an unfamiliar image field still fails empty-input accounting', () => withMock(async (mock, c) => {
  assert.equal(await post(mock, '/fal-ai/sam-3/image', { image: 'synthetic-image-marker' }), 400);
  assert.equal(mock.state.records[0].hasParsedInput, true);
  assert.throws(() => assertNonExecutingProbeRequests(c, 0), /no image, model or other execution input/);
  assert.ok(!JSON.stringify(mock.control.snapshot()).includes('synthetic-image-marker'));
}));

test('injected 400 on an empty request is not natural input validation', () => withMock(async (mock, c) => {
  mock.control.failNext('fal', { type: 'http', status: 400 });
  await new FalSegmentationProvider({ baseUrl: mock.baseUrl, apiKey: fakeKey }).probe();
  assert.equal(mock.state.records[0].hasParsedInput, false);
  assert.equal(mock.state.records[0].validationRejected, false);
  assert.throws(() => assertNonExecutingProbeRequests(c, 0), /not a fault-injected response/);
}));

test('a lost accounting record cannot make the probe assertion pass', () => withMock(async (mock, c) => {
  await new GroundedSamSegmentationProvider({ baseUrl: mock.baseUrl, apiKey: fakeKey }).probe();
  await new GroundedSamSegmentationProvider({ baseUrl: mock.baseUrl, apiKey: fakeKey }).probe();
  mock.state.records.shift();
  assert.throws(() => assertNonExecutingProbeRequests(c, 0), /all manual probe requests/);
}));
