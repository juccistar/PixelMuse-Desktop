import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { seedreamMatches, seedreamLayerMask } from '../packages/backend/src/execution/seedream-layerize.ts';
import { startFullMockProvider } from './full-mock-provider.mjs';

const sharp = createRequire(new URL('../packages/backend/package.json', import.meta.url))('sharp');

test('real default Seedream response matches 商品主体 and refuses the original unrelated semantic name', async () => {
  const mock = await startFullMockProvider({ width: 128, height: 96 });
  try {
    const response = await fetch(`${mock.baseUrl}/images/generations`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'doubao-seedream-5.0-pro-layerize', image: `data:image/png;base64,${mock.images.image.toString('base64')}`, prompt: 'Synthetic product body', layer_decomposition: true }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    const layers = result.data.filter(layer => layer.z_index > 0).map(layer => {
      const [x1, y1, x2, y2] = layer.bounding_box.normalized;
      return { name: layer.name, bbox: { x: x1 / 1000, y: y1 / 1000, width: (x2 - x1) / 1000, height: (y2 - y1) / 1000 } };
    });
    assert.deepEqual(layers.map(layer => layer.name), ['商品主体', '局部组件']);
    const original = { id: 'original', name: 'Synthetic product body', source: 'prompt', bbox: null };
    assert.ok(layers.every(layer => seedreamMatches([original], layer) === null));
    const corrected = { ...original, id: 'corrected', name: '商品主体' };
    assert.equal(seedreamMatches([corrected], layers[0]), corrected);
    assert.equal(seedreamMatches([corrected], layers[1]), null);
    const manual = { id: 'manual', name: 'Synthetic manual region', source: 'manual', bbox: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } };
    assert.equal(seedreamMatches([manual], layers[0]), manual);
    assert.equal(seedreamMatches([{ ...manual, bbox: { x: 0, y: 0, width: 0.1, height: 0.1 } }], layers[0]), null);
    assert.equal(mock.state.counts.seedream, 1);
    assert.equal(mock.state.callbackErrors, 0);
  } finally { await mock.close(); }
});

test('source Seedream mask extraction retains full-frame soft alpha and positions local alpha by bbox', async () => {
  const alpha = Buffer.from([0, 128, 255, 64]);
  const rgba = Buffer.alloc(16);
  for (let i = 0; i < 4; i++) rgba.set([40, 70, 100, alpha[i]], i * 4);
  const png = await sharp(rgba, { raw: { width: 2, height: 2, channels: 4 } }).png().toBuffer();
  assert.deepEqual(await seedreamLayerMask(png, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, 2, 2), alpha);
  const expanded = await seedreamLayerMask(png, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, 4, 4);
  const expected = Buffer.alloc(16);
  expected.set(alpha.subarray(0, 2), 5); expected.set(alpha.subarray(2), 9);
  assert.deepEqual(expanded, expected);
});
