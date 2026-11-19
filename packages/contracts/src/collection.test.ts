import { describe, expect, it } from 'vitest';
import { sanitizeCollectionPageUrl, sanitizeCollectionReferrerUrl } from './collection.js';

const origin = 'https://shop.example';
const sanitizers = [sanitizeCollectionPageUrl, sanitizeCollectionReferrerUrl];
const credentialPaths = ['/products/cup;jsessionid=SESSION_CREDENTIAL_SECRET', '/products/cup;JSESSIONID=SESSION_CREDENTIAL_SECRET', '/products/cup;session_id=SESSION_CREDENTIAL_SECRET', '/products/cup;PHPSESSID=SESSION_CREDENTIAL_SECRET'];

describe('bounded collection URL cleanup', () => {
  it.each(credentialPaths.flatMap(path => Array.from({ length: 11 }, (_, depth) => {
    let encoded = path;
    for (let level = 0; level < depth; level++) encoded = encodeURIComponent(encoded);
    return { depth, path: encoded.startsWith('/') ? encoded : `/${encoded}` };
  })))('removes path credentials at encoding depth $depth: $path', ({ path }) => {
    for (const sanitize of sanitizers) expect(sanitize(`${origin}${path}?id=123&token=QUERY_SECRET#FRAGMENT_SECRET`)).toBe(`${origin}/`);
  });

  it.each([18, 160])('measures Unicode product segments after decoding (%i characters)', length => {
    const raw = `${origin}/products/${'杯'.repeat(length)}?id=123&variant=blue&token=SECRET#SECRET`;
    const expected = new URL(`${origin}/products/${'杯'.repeat(length)}?id=123&variant=blue`).href;
    for (const sanitize of sanitizers) {
      expect(sanitize(raw)).toBe(expected);
      expect(sanitize(new URL(raw).href)).toBe(expected);
    }
  });

  it('applies the decoded segment bound and preserves harmless matrix parameters', () => {
    for (const sanitize of sanitizers) {
      expect(sanitize(`${origin}/products/${'杯'.repeat(161)}?id=123`)).toBe(`${origin}/`);
      expect(sanitize(`${origin}/products/cup;color=blue?sku=CUP-123&item_id=123`)).toBe(`${origin}/products/cup;color=blue?item_id=123&sku=CUP-123`);
    }
  });

  it('uses origin for oversized provenance while preserving a bounded complete Referer', () => {
    const raw = `${origin}/${Array(15).fill('a'.repeat(150)).join('/')}?id=123`;
    expect(raw.length).toBeGreaterThan(2048);
    expect(sanitizeCollectionPageUrl(raw)).toBe(`${origin}/`);
    expect(sanitizeCollectionReferrerUrl(raw)).toBe(raw);
  });

  it('bounds serialized Referer bytes independently of decoded segment length', () => {
    const withinBound = `${origin}/${Array(11).fill('杯'.repeat(80)).join('/')}?id=123`;
    const beyondBound = `${origin}/${Array(12).fill('杯'.repeat(80)).join('/')}?id=123`;
    expect(new URL(withinBound).href.length).toBeLessThanOrEqual(8192);
    expect(new URL(beyondBound).href.length).toBeGreaterThan(8192);
    expect(sanitizeCollectionReferrerUrl(withinBound)).toBe(new URL(withinBound).href);
    expect(sanitizeCollectionReferrerUrl(beyondBound)).toBe(`${origin}/`);
    expect(sanitizeCollectionPageUrl(withinBound)).toBe(`${origin}/`);
  });

  it('never truncates an oversized authority into a different address', () => {
    const raw = `https://${'a'.repeat(2050)}.example/products/cup`;
    expect(() => sanitizeCollectionPageUrl(raw)).toThrow(TypeError);
  });

  it.each([`https://shop.example/${'a'.repeat(8192)}`, 'https://user:secret@shop.example/product', 'https://shop.example/product\r\nInjected:secret'])('rejects invalid or unbounded input', raw => {
    for (const sanitize of sanitizers) expect(() => sanitize(raw)).toThrow(TypeError);
  });
});
