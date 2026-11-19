/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { EXTRACTION_SCRIPT, extractPageImages } from './extractor.js';

afterEach(() => { document.head.innerHTML = ''; document.body.innerHTML = ''; });
function loaded(src: string, width = 900, height = 600) {
  const img = document.createElement('img'); img.src = src;
  Object.defineProperties(img, { complete: { value: true }, currentSrc: { value: src }, naturalWidth: { value: width }, naturalHeight: { value: height } });
  document.body.append(img); return img;
}
describe('fixed collection DOM extractor', () => {
  it('reads loaded currentSrc, lazy/srcset and Product metadata without copying page text', () => {
    document.head.innerHTML = '<title>商品页面</title><meta property="og:image" content="https://cdn.example/share.png">';
    const img = loaded('https://cdn.example/current.png'); img.setAttribute('data-src', 'https://cdn.example/lazy.png'); img.setAttribute('srcset', 'https://cdn.example/a.png 1x, https://cdn.example/b.png 2x'); img.alt = 'PRIVATE_PAGE_TEXT';
    loaded('https://cdn.example/icon.png', 16, 16);
    const script = document.createElement('script'); script.type = 'application/ld+json'; script.textContent = JSON.stringify({ '@graph': [{ '@type': 'Product', name: 'PRIVATE_PRODUCT_DESCRIPTION', image: ['https://cdn.example/product.png', { contentUrl: 'https://cdn.example/detail.jpg' }] }] }); document.head.append(script);
    const result = extractPageImages();
    expect(result.images.map(image => image.url)).toEqual(['https://cdn.example/current.png','https://cdn.example/lazy.png','https://cdn.example/a.png','https://cdn.example/b.png','https://cdn.example/share.png','https://cdn.example/product.png','https://cdn.example/detail.jpg']);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_PAGE_TEXT|PRIVATE_PRODUCT_DESCRIPTION/);
    expect(result.images[0]).toMatchObject({ width: 900, height: 600, label: '页面已加载图片' });
  });
  it('deduplicates, excludes credentials/protocols, bounds candidates and ignores oversized JSON', () => {
    for (const url of ['https://cdn.example/a.png','https://cdn.example/a.png','file:///secret.png','data:image/png;base64,AAAA','https://user:{{PASSWORD_bvlbuttm}}@cdn.example/x.png']) loaded(url);
    const script = document.createElement('script'); script.type = 'application/ld+json'; script.textContent = ' '.repeat(70000); document.head.append(script);
    for (let index = 0; index < 120; index++) loaded(`https://cdn.example/${index}.png`);
    const result = extractPageImages(); expect(result.images).toHaveLength(80);
    expect(result.images.filter(image => image.url === 'https://cdn.example/a.png')).toHaveLength(1);
    expect(result.images.every(image => image.url.startsWith('https://cdn.example/'))).toBe(true);
  });
  it('executes the exact fixed script and handles malformed metadata', () => {
    loaded('https://cdn.example/image.png');
    document.head.innerHTML = '<script type="application/ld+json">{broken}</script>';
    const result = (0, eval)(EXTRACTION_SCRIPT);
    expect(result).toEqual(extractPageImages());
    expect(EXTRACTION_SCRIPT).not.toContain('require(');
  });
});
