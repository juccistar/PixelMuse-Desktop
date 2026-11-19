import { createServer, type Server, type RequestListener } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { CollectionError, downloadImage, isPublicAddress, parseWebUrl, publicTransportPolicy, sanitizePageUrl, imageReferrer, validateTarget, type ImageTransportPolicy } from './transport.js';

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture(handler: RequestListener) {
  const server = createServer(handler); servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const origin = `http://fixture.test:${port}`;
  const policy: ImageTransportPolicy = { resolve: async () => [{ address: '127.0.0.1', family: 4 }], allow: (address, url) => address === '127.0.0.1' && url.hostname === 'fixture.test', allowPort: () => true };
  return { origin, port, policy };
}
const options = () => ({ signal: new AbortController().signal, cookies: async () => '' });
describe('collection pinned image transport', () => {
  it.each(['0.0.0.0','10.0.0.1','127.1.2.3','169.254.169.254','172.16.0.1','192.168.1.1','100.64.0.1','198.18.0.1','192.0.2.1','203.0.113.1','224.0.0.1','255.255.255.255','::1','::','::ffff:8.8.8.8','fe80::1','fc00::1','2001:db8::1','2001:0db8::1','2002:0808:0808::1','64:ff9b::808:808'])('denies nonpublic address %s', address => expect(isPublicAddress(address)).toBe(false));
  it.each(['8.8.8.8','1.1.1.1','2606:4700:4700::1111','2001:4860:4860::8888'])('allows global address %s', address => expect(isPublicAddress(address)).toBe(true));
  it.each(['file:///etc/passwd','https://user:pass@example.com/a','javascript:alert(1)','https://example.com/\nsecret','https://example.com\\private'])('rejects unsafe URL %s', url => expect(() => parseWebUrl(url)).toThrow(CollectionError));
  it('strips credentials, tracking, signature and fragment from persisted page source', () => {
    expect(sanitizePageUrl('https://shop.example/item?id=123&token=SECRET&X-Amz-Signature=SECRET&utm_source=x#SECRET')).toBe('https://shop.example/item?id=123');
    expect(sanitizePageUrl('https://shop.example/oauth/callback?code=SECRET')).toBe('https://shop.example/');
  });
  it.each([
    '/%61uth/PATH_CREDENTIAL_SECRET', '/%2561uth/PATH_CREDENTIAL_SECRET',
    '/products%2f%61uth%2fPATH_CREDENTIAL_SECRET', '/products%252f%2561uth%252fPATH_CREDENTIAL_SECRET',
    '/products%5cSESSION%5cPATH_CREDENTIAL_SECRET', '/%6fauth/callback/PATH_CREDENTIAL_SECRET',
    '/%63allback/PATH_CREDENTIAL_SECRET', '/login%3fPATH_CREDENTIAL_SECRET',
    '/auth%3bPATH_CREDENTIAL_SECRET', '/%2574oken/PATH_CREDENTIAL_SECRET',
    '/products/cup;jsessionid=PATH_CREDENTIAL_SECRET', '/products/cup%3Bjsessionid%3DPATH_CREDENTIAL_SECRET',
    '/products/cup%253Bjsessionid%253DPATH_CREDENTIAL_SECRET', '/products/cup%25253Bjsessionid%25253DPATH_CREDENTIAL_SECRET',
    '/%E0%A4/PATH_CREDENTIAL_SECRET', `/${'%25'.repeat(170)}PATH_CREDENTIAL_SECRET`,
    `/${'%25'.repeat(1)}${'25'.repeat(9)}61uth/PATH_CREDENTIAL_SECRET`,
  ])('strips encoded or ambiguous authentication path %s', path => {
    expect(sanitizePageUrl(`https://shop.example${path}?id=123&token=QUERY_SECRET#FRAGMENT_SECRET`)).toBe('https://shop.example/');
  });
  it('preserves normal encoded product paths and safe identity parameters', () => {
    expect(sanitizePageUrl('https://shop.example/products/%E6%9D%AF%E5%AD%90?id=123&token=SECRET')).toBe('https://shop.example/products/%E6%9D%AF%E5%AD%90?id=123');
    expect(sanitizePageUrl('https://shop.example/products/authentic-cup?variant=blue')).toBe('https://shop.example/products/authentic-cup?variant=blue');
  });
  it.each([
    ['https://shop.example/products/cup?id=123&token=SECRET#FRAGMENT', 'https://shop.example/image', 'https://shop.example/products/cup?id=123'],
    ['https://shop.example/products/SECRET?token=SECRET', 'https://cdn.example/image', 'https://shop.example/'],
    ['https://shop.example/%2561uth/SECRET?id=123', 'https://shop.example/image', 'https://shop.example/'],
    ['https://shop.example/product', 'http://shop.example/image', undefined],
    ['https://shop.example/product', 'http://cdn.example/image', undefined],
    ['http://shop.example/product', 'https://cdn.example/image', 'http://shop.example/'],
    ['https://user:SECRET@shop.example/product', 'https://shop.example/image', undefined],
    ['https://shop.example/product\r\nInjected:secret', 'https://shop.example/image', undefined],
    ['file:///SECRET', 'https://shop.example/image', undefined],
  ])('limits referrer %s for target %s', (source, target, expected) => {
    expect(imageReferrer(source, new URL(target!))).toBe(expected);
  });
  it('downloads legitimate same-origin images protected by a page referrer', async () => {
    let seen: string | undefined;
    const { origin, policy } = await fixture((req, res) => {
      seen = req.headers.referer;
      const allowed = seen === `${origin}/products/cup?id=123`;
      res.writeHead(allowed ? 200 : 403, { 'content-type': 'image/png' }); res.end(allowed ? 'image' : 'denied');
    });
    await expect(downloadImage(`${origin}/protected.png`, { ...options(), policy })).rejects.toThrow(CollectionError);
    const result = await downloadImage(`${origin}/protected.png`, { ...options(), policy, referrer: `${origin}/products/cup?id=123&token=QUERY_SECRET#FRAGMENT_SECRET` });
    expect(result.buffer.toString()).toBe('image'); expect(seen).toBe(`${origin}/products/cup?id=123`);
  });
  it.each([
    `/products/${'杯'.repeat(18)}`,
    `/${Array(15).fill('a'.repeat(150)).join('/')}`,
    `/${Array(11).fill('杯'.repeat(80)).join('/')}`,
  ])('preserves the complete legitimate page address for protected downloads: %s', async path => {
    let expected = ''; const seen: (string | undefined)[] = [];
    const { origin, policy } = await fixture((req, res) => {
      seen.push(req.headers.referer);
      if (req.headers.referer !== expected) { res.writeHead(403); res.end('denied'); return; }
      if (req.url === '/start') { res.writeHead(302, { location: '/protected.png' }); res.end(); return; }
      res.writeHead(200, { 'content-type': 'image/png' }); res.end('image');
    });
    const raw = `${origin}${path}?id=123&token=QUERY_SECRET#FRAGMENT_SECRET`;
    expected = new URL(`${origin}${path}?id=123`).href;
    const result = await downloadImage(`${origin}/start`, { ...options(), policy, referrer: raw });
    expect(result.buffer.toString()).toBe('image');
    expect(seen).toEqual([expected, expected]);
    expect(sanitizePageUrl(raw)).toBe(expected.length <= 2048 ? expected : `${origin}/`);
  });
  it('uses an origin instead of a partial URL when the serialized Referer exceeds its header bound', async () => {
    let seen: string | undefined;
    const { origin, policy } = await fixture((req, res) => {
      seen = req.headers.referer; res.writeHead(200, { 'content-type': 'image/png' }); res.end('image');
    });
    const raw = `${origin}/${Array(12).fill('杯'.repeat(80)).join('/')}?id=123`;
    expect(new URL(raw).href.length).toBeGreaterThan(8192);
    await downloadImage(`${origin}/image`, { ...options(), policy, referrer: raw });
    expect(seen).toBe(`${origin}/`);
  });
  it('removes matrix session credentials from real HTTP Referer headers', async () => {
    let seen: string | undefined;
    const { origin, policy } = await fixture((req, res) => {
      seen = req.headers.referer; res.writeHead(200, { 'content-type': 'image/png' }); res.end('image');
    });
    await downloadImage(`${origin}/image`, { ...options(), policy, referrer: `${origin}/products/cup%253Bjsessionid%253DSESSION_SECRET?id=123` });
    expect(seen).toBe(`${origin}/`);
  });
  it('recomputes long-page referrers when redirects leave and return to the original origin', async () => {
    const seen: (string | undefined)[] = []; let original = '';
    const foreign = await fixture((req, res) => { seen.push(req.headers.referer); res.writeHead(302, { location: `${original}/image` }); res.end(); });
    const first = await fixture((req, res) => {
      seen.push(req.headers.referer);
      if (req.url === '/start') { res.writeHead(302, { location: `${foreign.origin}/step` }); res.end(); }
      else { res.writeHead(200, { 'content-type': 'image/png' }); res.end('image'); }
    });
    original = first.origin;
    const page = `${original}/${Array(15).fill('a'.repeat(150)).join('/')}?id=123`;
    await downloadImage(`${original}/start`, { ...options(), policy: first.policy, referrer: `${page}&token=QUERY_SECRET#FRAGMENT_SECRET` });
    expect(seen).toEqual([page, `${original}/`, page]);
  });
  it('recomputes referrer for every redirect and strips cross-origin path and secrets', async () => {
    const seen: (string | undefined)[] = [];
    const last = await fixture((req, res) => { seen.push(req.headers.referer); res.writeHead(200, { 'content-type': 'image/png' }); res.end('image'); });
    const first = await fixture((req, res) => {
      seen.push(req.headers.referer);
      res.writeHead(302, { location: req.url === '/start' ? '/same-origin' : `${last.origin}/image` }); res.end();
    });
    await downloadImage(`${first.origin}/start`, { ...options(), policy: first.policy, referrer: `${first.origin}/products/cup?id=123&token=QUERY_SECRET#FRAGMENT_SECRET` });
    expect(seen).toEqual([`${first.origin}/products/cup?id=123`, `${first.origin}/products/cup?id=123`, `${first.origin}/`]);
    expect(JSON.stringify(seen)).not.toMatch(/QUERY_SECRET|FRAGMENT_SECRET/);
  });
  it('omits HTTPS page referrer from HTTP image requests', async () => {
    let seen: string | undefined;
    const { origin, policy } = await fixture((req, res) => { seen = req.headers.referer; res.writeHead(200, { 'content-type': 'image/png' }); res.end('image'); });
    await downloadImage(`${origin}/image`, { ...options(), policy, referrer: 'https://shop.example/products/SECRET?token=SECRET' });
    expect(seen).toBeUndefined();
  });
  it('production rejects local targets, unusual ports and mixed DNS records', async () => {
    await expect(downloadImage('http://127.0.0.1/image', options())).rejects.toThrow('网络地址');
    await expect(validateTarget(new URL('https://example.com:444/image'))).rejects.toThrow('端口');
    await expect(validateTarget(new URL('https://example.com/image'), { ...publicTransportPolicy, resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] })).rejects.toThrow('网络地址');
  });
  it('pins the verified DNS address while keeping the original HTTP host', async () => {
    let host = ''; let resolutions = 0;
    const { origin, policy } = await fixture((req, res) => { host = req.headers.host!; res.writeHead(200, { 'content-type': 'image/png' }); res.end('image-bytes'); });
    policy.resolve = async () => { resolutions++; return [{ address: resolutions === 1 ? '127.0.0.1' : '10.0.0.1', family: 4 }]; };
    const result = await downloadImage(`${origin}/image?signature=EPHEMERAL`, { ...options(), policy });
    expect(result.buffer.toString()).toBe('image-bytes'); expect(resolutions).toBe(1); expect(host).toBe(new URL(origin).host);
  });
  it('revalidates redirects and never forwards previous target cookies', async () => {
    const seen: (string | undefined)[] = []; const queried: string[] = [];
    const next = await fixture((req, res) => { seen.push(req.headers.cookie); expect(req.headers.authorization).toBeUndefined(); res.writeHead(200, { 'content-type': 'image/jpeg' }); res.end('image'); });
    const first = await fixture((req, res) => { seen.push(req.headers.cookie); res.writeHead(302, { location: `${next.origin}/image` }); res.end(); });
    await downloadImage(`${first.origin}/redirect`, { ...options(), policy: first.policy, cookies: async url => { queried.push(url.href); return url.origin === first.origin ? 'first=ONLY_FIRST' : 'second=ONLY_SECOND'; } });
    expect(seen).toEqual(['first=ONLY_FIRST', 'second=ONLY_SECOND']); expect(queried).toEqual([`${first.origin}/redirect`, `${next.origin}/image`]);
    const bad = await fixture((_req, res) => { res.writeHead(302, { location: 'http://10.0.0.1/image' }); res.end(); });
    await expect(downloadImage(`${bad.origin}/redirect`, { ...options(), policy: bad.policy })).rejects.toThrow('网络地址');
  });
  it('bounds chunked bytes, redirect count, encoding, cookie bytes and elapsed time', async () => {
    const { origin, policy } = await fixture((req, res) => {
      if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); return; }
      if (req.url === '/wait') return;
      res.writeHead(200, { 'content-type': 'image/png', ...(req.url === '/gzip' ? { 'content-encoding': 'gzip' } : {}) });
      res.write(Buffer.alloc(500)); res.end(Buffer.alloc(500));
    });
    await expect(downloadImage(`${origin}/big`, { ...options(), policy, maxBytes: 600 })).rejects.toThrow('大小');
    await expect(downloadImage(`${origin}/loop`, { ...options(), policy })).rejects.toThrow('重定向');
    await expect(downloadImage(`${origin}/gzip`, { ...options(), policy })).rejects.toThrow(CollectionError);
    await expect(downloadImage(`${origin}/big`, { ...options(), policy, cookies: async () => 'x'.repeat(16385) })).rejects.toThrow(CollectionError);
    await expect(downloadImage(`${origin}/wait`, { ...options(), policy, timeoutMs: 30 })).rejects.toThrow('取消或超时');
    const controller = new AbortController(); const pending = downloadImage(`${origin}/wait`, { ...options(), policy, signal: controller.signal }); controller.abort();
    await expect(pending).rejects.toThrow('取消或超时');
  });
  it('deadline also covers a stalled DNS resolution', async () => {
    const policy: ImageTransportPolicy = { ...publicTransportPolicy, resolve: () => new Promise(() => {}) };
    await expect(downloadImage('https://unresolved.example/image', { ...options(), policy, timeoutMs: 20 })).rejects.toThrow('取消或超时');
  });
});
