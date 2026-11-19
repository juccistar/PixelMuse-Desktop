import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { inflateRawSync, crc32 } from 'node:zlib';
import { join } from 'node:path';

export class Blocked extends Error { constructor(message) { super(message); this.name = 'Blocked'; } }
export const hash = value => createHash('sha256').update(value).digest('hex');
export const items = value => Array.isArray(value) ? value : value?.items ?? [];
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Poll in Node; the asynchronous query is resolved before the predicate is evaluated. */
export async function poll(query, accept, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await query();
    if (await accept(last)) return last;
    await delay(80);
  }
  throw Error(`Timed out waiting for ${label}; last state: ${JSON.stringify(last)}`);
}

/** ZIP integrity includes central/local agreement, CRC, file set and uncompressed bytes. */
export function unzip(bytes) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'ZIP end record');
  assert.equal(bytes.readUInt16LE(end + 4), 0, 'single-disk ZIP');
  const count = bytes.readUInt16LE(end + 10);
  assert.notEqual(count, 0xffff, 'ZIP64 requires a reviewed reader');
  const files = new Map();
  let cursor = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const method = bytes.readUInt16LE(cursor + 10), size = bytes.readUInt32LE(cursor + 20);
    const rawSize = bytes.readUInt32LE(cursor + 24), nameLength = bytes.readUInt16LE(cursor + 28);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    assert.ok(!name.includes('..') && !name.startsWith('/') && !name.includes('\\'), 'safe ZIP name');
    assert.ok(!files.has(name), 'no duplicate ZIP entries');
    const local = bytes.readUInt32LE(cursor + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    assert.equal(bytes.readUInt16LE(local + 8), method);
    assert.equal(bytes.subarray(local + 30, local + 30 + bytes.readUInt16LE(local + 26)).toString('utf8'), name);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    assert.ok(start + size <= bytes.length);
    const compressed = bytes.subarray(start, start + size);
    assert.ok(method === 0 || method === 8, 'supported ZIP compression');
    const content = method === 8 ? inflateRawSync(compressed) : compressed;
    assert.equal(content.length, rawSize);
    assert.equal(crc32(content), bytes.readUInt32LE(cursor + 16), `ZIP CRC: ${name}`);
    if (!name.endsWith('/')) files.set(name, content);
    cursor += 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
  }
  assert.equal(cursor, bytes.readUInt32LE(end + 16) + bytes.readUInt32LE(end + 12));
  return files;
}

export async function pixels(sharp, bytes) {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.ok(info.width > 0 && info.height > 0 && data.length === info.width * info.height * 4);
  return { data, width: info.width, height: info.height, hash: hash(bytes) };
}

export async function verifyMaskedPixels(sharp, sourceBytes, layerBytes, maskBytes) {
  const source = await pixels(sharp, sourceBytes), layer = await pixels(sharp, layerBytes);
  const mask = await sharp(maskBytes).resize(source.width, source.height).removeAlpha().greyscale().raw().toBuffer();
  assert.equal(layer.width, source.width); assert.equal(layer.height, source.height);
  let transparent = 0, soft = 0, nonzero = 0;
  for (let index = 0; index < source.width * source.height; index++) {
    const offset = index * 4;
    const expected = Math.round(source.data[offset + 3] * mask[index] / 255);
    assert.ok(Math.abs(layer.data[offset + 3] - expected) <= 1, `mask alpha pixel ${index}`);
    if (expected > 0) { assert.deepEqual(layer.data.subarray(offset, offset + 3), source.data.subarray(offset, offset + 3)); nonzero++; }
    if (expected === 0) transparent++;
    if (expected > 0 && expected < 255) soft++;
  }
  assert.ok(transparent && nonzero && soft, 'fixture proves empty, solid/visible and soft-alpha pixels');
  return { transparent, nonzero, soft, width: source.width, height: source.height };
}

export function initializePsdPixels(module) {
  // ag-psd still allocates ImageData in raw mode. A typed RGBA allocator avoids a native canvas dependency.
  module.initializeCanvas(() => { throw Error('Acceptance PSD decoding requires raw ImageData, not canvas rendering'); },
    (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }));
}

export function verifyPsd(readPsd, bytes, expectedNames = []) {
  const psd = readPsd(bytes, { useImageData: true, skipCompositeImageData: true, skipThumbnail: true });
  const leaves = [];
  const walk = layers => { for (const layer of layers ?? []) { if (layer.children) walk(layer.children); else leaves.push(layer); } };
  walk(psd.children);
  assert.ok(psd.width > 0 && psd.height > 0 && leaves.length > 0, 'PSD decodes dimensions and editable layers');
  for (const name of expectedNames) assert.ok(leaves.some(layer => layer.name === name), `PSD layer name ${name}`);
  let visiblePixels = 0;
  for (const layer of leaves) {
    assert.ok(Number.isFinite(layer.left) && Number.isFinite(layer.top));
    assert.ok(layer.imageData?.data?.length, 'PSD layer RGBA data was actually read');
    assert.equal(layer.imageData.data.length, layer.imageData.width * layer.imageData.height * 4);
    for (let offset = 3; offset < layer.imageData.data.length; offset += 4) if (layer.imageData.data[offset]) visiblePixels++;
  }
  assert.ok(visiblePixels, 'PSD is not empty');
  return { width: psd.width, height: psd.height, layers: leaves.map(layer => ({ name: layer.name, left: layer.left, top: layer.top, width: layer.imageData.width, height: layer.imageData.height, hidden: Boolean(layer.hidden), pixelHash: hash(layer.imageData.data) })), visiblePixels };
}

export async function canvasProbe(page, ref) {
  return page.evaluate(async ref => {
    const image = new Image();
    // Explicit anonymous mode verifies the restricted protocol's CORS behavior as well.
    image.crossOrigin = 'anonymous';
    image.src = window.ecomgen.resourceUrl(ref);
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const before = Array.from(context.getImageData(0, 0, 1, 1).data);
    context.fillStyle = '#eb2879'; context.fillRect(0, 0, 1, 1);
    const after = Array.from(context.getImageData(0, 0, 1, 1).data);
    const url = canvas.toDataURL('image/png');
    if (!url.startsWith('data:image/png;base64,') || after[0] !== 235 || after[1] !== 40) throw Error('Canvas write/read failed');
    return { width: canvas.width, height: canvas.height, before, after, encodedBytes: url.length };
  }, ref);
}

export async function screenshot(page, filename) {
  if (page && !page.isClosed()) await page.screenshot({ path: filename, fullPage: true, timeout: 8000 });
}

export function redact(value, secrets = []) {
  let text = typeof value === 'string' ? value : JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item);
  for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]');
  return text.replace(/Bearer\s+[^\s"']+/g, 'Bearer [REDACTED]');
}

export async function evidence(artifacts, name, value, secrets = []) {
  const filename = join(artifacts, `${name}.json`);
  await writeFile(filename, redact(value, secrets));
  return filename;
}

export async function readJson(filename) { return JSON.parse(await readFile(filename, 'utf8')); }
