import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';

// 使用 Backend 的已安装 sharp，不增加验收脚本自己的依赖或运行目录。
const sharp = createRequire(new URL('../packages/backend/package.json', import.meta.url))('sharp');
const MAX_PIXELS = 4_000_000;

/** 生成有颜色变化、透明边界和局部前景的合法非正方形验收图片。 */
export async function createFullMockImages(options = {}) {
  const width = options.width ?? 48, height = options.height ?? 32;
  checkSize(width, height);
  const rgba = Buffer.alloc(width * height * 4), gray = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * width + x;
    rgba.set([(x * 13 + y * 3) % 256, (y * 17 + 40) % 256, (x * 7 + 70) % 256, 255], p * 4);
    gray[p] = x >= Math.floor(width / 4) && x < Math.ceil(width * 3 / 4) && y >= Math.floor(height / 4) && y < Math.ceil(height * 3 / 4) ? 255 : 0;
  }
  const image = options.image ? await normalizePng(options.image) : await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const metadata = await sharp(image).metadata();
  const w = metadata.width, h = metadata.height;
  const mask = options.mask
    ? await sharp(await normalizePng(options.mask)).resize(w, h, { fit: 'fill', kernel: 'nearest' }).flatten({ background: '#000000' }).greyscale().png().toBuffer()
    : await sharp(gray, { raw: { width, height, channels: 1 } }).resize(w, h, { fit: 'fill', kernel: 'nearest' }).png().toBuffer();
  const maskRaw = await sharp(mask).removeAlpha().greyscale().raw().toBuffer();
  const source = await sharp(image).ensureAlpha().raw().toBuffer();
  const foreground = Buffer.from(source);
  for (let i = 0; i < maskRaw.length; i++) foreground[i * 4 + 3] = Math.round(source[i * 4 + 3] * maskRaw[i] / 255);
  const alpha = options.alpha ? await normalizePng(options.alpha, w, h) : await sharp(foreground, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
  const emptyMask = await sharp({ create: { width: w, height: h, channels: 3, background: '#000000' } }).png().toBuffer();
  const background = options.background ? await normalizePng(options.background, w, h) : await sharp({ create: { width: w, height: h, channels: 4, background: { r: 29, g: 36, b: 44, alpha: 1 } } }).png().toBuffer();
  return { image, mask, alpha, background, emptyMask, width: w, height: h };
}

export function checkSize(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > MAX_PIXELS) throw new RangeError('Mock fixture dimensions exceed the 4 million pixel limit');
}

export async function normalizePng(bytes, width, height) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 20 * 1024 * 1024) throw new RangeError('Mock image must be a bounded byte buffer');
  let pipeline = sharp(Buffer.from(bytes), { limitInputPixels: MAX_PIXELS, animated: false });
  const metadata = await pipeline.metadata();
  checkSize(metadata.width, metadata.height);
  if (width !== undefined && height !== undefined) pipeline = pipeline.resize(width, height, { fit: 'fill', kernel: 'nearest' });
  return pipeline.ensureAlpha().png().toBuffer();
}

/** Gitee 的 size 是 [width,height]；counts 按列扫描并使用带符号五位差分编码。 */
export async function giteeMask(mask) {
  const { data, info } = await sharp(mask).flatten({ background: '#000000' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const runs = [];
  let bit = 0, count = 0;
  for (let x = 0; x < info.width; x++) for (let y = 0; y < info.height; y++) {
    const value = data[y * info.width + x] >= 128 ? 1 : 0;
    if (value === bit) count++;
    else { runs.push(count); count = 1; bit = value; }
  }
  runs.push(count);
  const encoded = [];
  for (let i = 0; i < runs.length; i++) {
    let value = runs[i] - (i > 2 ? runs[i - 2] : 0);
    let more;
    do {
      let code = value & 31;
      value >>= 5;
      more = (code & 16) !== 0 ? value !== -1 : value !== 0;
      if (more) code |= 32;
      encoded.push(code + 48);
    } while (more);
  }
  return { encoding: 'rle', size: [info.width, info.height], counts: gzipSync(Buffer.from(encoded)).toString('base64') };
}

export async function resizedPng(bytes, width, height) {
  checkSize(width, height);
  return sharp(bytes).resize(width, height, { fit: 'fill', kernel: 'nearest' }).png().toBuffer();
}

export async function inputDimensions(context) {
  const body = context.json ?? {};
  const candidate = context.files.image?.[0]?.data ?? context.files['image[]']?.[0]?.data;
  const value = body.image_url ?? body.image;
  let data = candidate;
  if (!data && typeof value === 'string' && /^data:image\/[\w.+-]+;base64,/.test(value)) data = Buffer.from(value.slice(value.indexOf(',') + 1), 'base64');
  if (!data && value && typeof value === 'object' && typeof value.data === 'string') data = Buffer.from(value.data, 'base64');
  if (!data) {
    const part = (body.contents ?? []).flatMap(content => content.parts ?? []).find(entry => entry.inlineData?.data || entry.inline_data?.data);
    const inline = part?.inlineData ?? part?.inline_data;
    if (inline?.data) data = Buffer.from(inline.data, 'base64');
  }
  if (!data) return null; // 绝不拉取请求中出现的 URL。
  const metadata = await sharp(data, { limitInputPixels: MAX_PIXELS }).metadata();
  checkSize(metadata.width, metadata.height);
  return { width: metadata.width, height: metadata.height };
}
