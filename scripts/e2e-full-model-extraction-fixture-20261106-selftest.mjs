import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { startFullMockProvider } from './full-mock-provider.mjs';
import { modelFaceRef, withExtractionMask, verifyExtractionPixels } from './e2e-full-patterns.mjs';
import { sha256 } from './e2e-full-harness.mjs';

const sharp = createRequire(new URL('../packages/backend/package.json', import.meta.url))('sharp');
const context = mock => ({ mock, sharp, check: assert.ok, equal: assert.deepEqual, async evidence() {} });

test('model face consumes the content identity published by the DTO', async () => {
  const id = `12345678-1234-1234-1234-123456789abc-${'a'.repeat(64)}`;
  assert.deepEqual(await modelFaceRef({ id: 'model-only-alias', referenceFaceUrl: `ecomgen-resource://MODEL_FACE/${id}` }), { kind: 'MODEL_FACE', id });
  await assert.rejects(modelFaceRef({ id }), /no published resource URL/);
  await assert.rejects(modelFaceRef({ referenceFaceUrl: 'ecomgen-resource://PATTERN/another-identity' }), /does not identify a model face/);
});

test('actual fal fixture serves the scoped mask and restores the original bytes', async () => {
  const mock = await startFullMockProvider({ width: 48, height: 32, imageMode: 'url' });
  const original = mock.images.mask, originalHash = sha256(original);
  const c = context(mock);
  try {
    await withExtractionMask(c, async fixture => {
      assert.notEqual(sha256(mock.images.mask), originalHash);
      const response = await fetch(`${mock.origin}/fal-ai/sam-3/image`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image_url: `data:image/png;base64,${mock.images.image.toString('base64')}`, prompt: 'synthetic motif' }) });
      assert.equal(response.status, 200);
      const reply = await response.json();
      const maskResponse = await fetch(reply.masks[0].url);
      assert.equal(maskResponse.status, 200);
      const served = Buffer.from(await maskResponse.arrayBuffer());
      const gray = await sharp(served).greyscale().removeAlpha().raw().toBuffer();
      assert.deepEqual(gray, fixture.gray, 'the protocol service reads the replaced shared mask');
      assert.deepEqual([reply.masks[0].width, reply.masks[0].height], [48, 32]);
      assert.equal(mock.state.counts.fal, 1);
      assert.equal(mock.state.callbackErrors, 0);
      assert.equal(sha256(mock.images.mask), fixture.maskHash);
      const rgba = Buffer.from(fixture.source.data);
      for (let i = 0; i < fixture.gray.length; i++) rgba[i * 4 + 3] = Math.round(rgba[i * 4 + 3] * fixture.gray[i] / 255);
      const bytes = await sharp(rgba, { raw: { width: 48, height: 32, channels: 4 } }).png().toBuffer();
      const cropped = await sharp(bytes).trim().png().toBuffer();
      const actual = { bytes: cropped, ...await sharp(cropped).ensureAlpha().raw().toBuffer({ resolveWithObject: true }) };
      await verifyExtractionPixels(c, actual, fixture);
      const changedAlpha = Buffer.from(actual.data); changedAlpha[3] = 0;
      await assert.rejects(verifyExtractionPixels(c, { ...actual, data: changedAlpha }, fixture), /cropped alpha/);
      const changedRgb = Buffer.from(actual.data); changedRgb[0] ^= 255;
      await assert.rejects(verifyExtractionPixels(c, { ...actual, data: changedRgb }, fixture), /original source/);
    });
    assert.equal(mock.images.mask, original);
    assert.equal(sha256(mock.images.mask), originalHash);
  } finally { await mock.close(); }
});

test('scoped mask restores reference and hash when the scenario fails', async () => {
  const mock = await startFullMockProvider({ width: 48, height: 32 });
  const original = mock.images.mask, originalHash = sha256(original);
  try {
    await assert.rejects(withExtractionMask(context(mock), async () => { throw Error('deliberate extraction assertion failure'); }), /deliberate extraction assertion failure/);
    assert.equal(mock.images.mask, original);
    assert.equal(sha256(mock.images.mask), originalHash);
  } finally { await mock.close(); }
});
