/** 固定 DOM 提取结果仅在主进程消费，不向网页提供应用接口。 */
export interface ExtractedPage { url: string; title: string; images: { url: string; width: number; height: number; label: string }[] }
/** 在隔离 world 执行；只读取有界 DOM 与商品结构化元数据。 */
export function extractPageImages(): ExtractedPage {
  const images: ExtractedPage['images'] = [];
  const seen = new Set<string>();
  const add = (value: unknown, width: number, height: number, label: string) => {
    if (images.length >= 80 || typeof value !== 'string' || !value.trim() || value.length > 8192) return;
    try {
      const url = new URL(value, document.baseURI);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || seen.has(url.href)) return;
      seen.add(url.href);
      images.push({ url: url.href, width: Math.min(100000, Math.max(0, Math.floor(width) || 0)), height: Math.min(100000, Math.max(0, Math.floor(height) || 0)), label });
    } catch { /* 非图片地址直接忽略。 */ }
  };
  const loadedImages = document.images;
  for (let index = 0; index < Math.min(loadedImages.length, 400); index++) {
    const img = loadedImages[index]!;
    if (img.complete && img.naturalWidth >= 80 && img.naturalHeight >= 80) add(img.currentSrc || img.src, img.naturalWidth, img.naturalHeight, '页面已加载图片');
    if (img.naturalWidth >= 80 || img.width >= 80) {
      const lazy = img.getAttribute('data-src') || img.getAttribute('data-original');
      if (lazy) add(lazy, 0, 0, '页面提供的图片链接');
      for (const part of (img.getAttribute('srcset') || '').slice(0, 16384).split(',').slice(0, 8)) add(part.trim().split(/\s+/)[0], 0, 0, '页面提供的图片链接');
    }
  }
  const metas = document.getElementsByTagName('meta');
  let shareImages = 0;
  for (let index = 0; index < Math.min(metas.length, 128) && shareImages < 8; index++) {
    const meta = metas[index]!;
    if (meta.getAttribute('property') === 'og:image' || meta.getAttribute('name') === 'twitter:image') { add(meta.getAttribute('content'), 0, 0, '页面分享图片'); shareImages++; }
  }
  let nodes = 0;
  const walk = (value: unknown, depth: number, product = false) => {
    if (++nodes > 200 || depth > 6 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const v of value.slice(0, 40)) walk(v, depth + 1, product); return; }
    const row = value as Record<string, unknown>;
    const type = row['@type'];
    const isProduct = product || type === 'Product' || (Array.isArray(type) && type.includes('Product'));
    if (isProduct) {
      const raw = row.image;
      for (const image of (Array.isArray(raw) ? raw : [raw]).slice(0, 40)) {
        if (typeof image === 'string') add(image, 0, 0, '商品结构化图片链接');
        else if (image && typeof image === 'object') add((image as Record<string, unknown>).url || (image as Record<string, unknown>).contentUrl, 0, 0, '商品结构化图片链接');
      }
    }
    for (const key of ['@graph', 'mainEntity', 'itemListElement', 'item']) if (row[key]) walk(row[key], depth + 1, isProduct);
  };
  const scripts = document.scripts;
  let metadataScripts = 0;
  for (let index = 0; index < Math.min(scripts.length, 256) && metadataScripts < 8; index++) {
    const script = scripts[index]!;
    if (script.type !== 'application/ld+json') continue;
    metadataScripts++;
    const text = script.textContent || '';
    if (text.length > 65536) continue;
    try { walk(JSON.parse(text), 0); } catch { /* 元数据损坏不妨碍已加载图片。 */ }
  }
  return { url: location.href.slice(0, 8192), title: document.title.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240), images };
}
/** 固定脚本不插入任何 URL 或网页字符串。 */
export const EXTRACTION_SCRIPT = `(${extractPageImages.toString()})()`;
