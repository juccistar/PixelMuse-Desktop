import http, { type Server } from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCollectionBrowserProxy, type CollectionBrowserProxy } from './browser-proxy.js';
import type { ImageTransportPolicy } from './transport.js';

let origin: Server;
let proxy: CollectionBrowserProxy;
let port: number;
let hits: Array<{ url?: string; headers: http.IncomingHttpHeaders; body: string }>;
let policy: ImageTransportPolicy;
const auth = () => `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}`;
async function request(url: string, options: { auth?: string; method?: string; body?: string } = {}) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const outgoing = http.request({ host: '127.0.0.1', port: proxy.port, method: options.method ?? 'GET', path: url, agent: false,
      headers: { 'Proxy-Authorization': options.auth ?? auth(), ...(options.body ? { 'Content-Length': Buffer.byteLength(options.body) } : {}) },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString(), headers: response.headers }));
      response.once('error', reject);
    });
    outgoing.once('error', reject); outgoing.end(options.body);
  });
}
beforeEach(async () => {
  hits = [];
  origin = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      hits.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://10.0.0.1/private' }); res.end(); }
      else res.end('pinned origin');
    });
  });
  origin.listen(0, '127.0.0.1'); await once(origin, 'listening'); port = (origin.address() as net.AddressInfo).port;
  policy = {
    resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    allow: (address, target) => address === '127.0.0.1' && target.hostname === 'shop.example.test' && target.port === String(port),
    allowPort: target => target.port === String(port),
  };
  proxy = await createCollectionBrowserProxy(policy);
});
afterEach(async () => {
  await proxy.close(); origin.closeAllConnections(); await new Promise<void>(resolve => origin.close(() => resolve()));
});

describe('authenticated per-session pinned browser forward proxy', () => {
  it('requires authentication before resolving or contacting the target', async () => {
    const response = await request(`http://shop.example.test:${port}/private`, { auth: 'Basic wrong' });
    expect(response.status).toBe(407); expect(hits).toEqual([]);
    expect(response.headers['proxy-authenticate']).toBe('Basic realm="PixelMuse collection"');
  });
  it('pins HTTP to the validated IP while preserving Host and login form body, without forwarding proxy credentials', async () => {
    const response = await request(`http://shop.example.test:${port}/login`, { method: 'POST', body: 'username=demo&password=fixture' });
    expect(response).toMatchObject({ status: 200, body: 'pinned origin' });
    expect(hits).toHaveLength(1); expect(hits[0]).toMatchObject({ url: '/login', body: 'username=demo&password=fixture', headers: { host: `shop.example.test:${port}` } });
    expect(hits[0]!.headers).not.toHaveProperty('proxy-authorization');
  });
  it('leaves redirects to Chromium and independently blocks the subsequent private target', async () => {
    const redirected = await request(`http://shop.example.test:${port}/redirect`);
    expect(redirected.status).toBe(302); expect(redirected.headers.location).toBe('http://10.0.0.1/private');
    expect((await request(redirected.headers.location!)).status).toBe(502); expect(hits).toHaveLength(1);
  });
  it('rejects mixed private answers and rebinding at the actual connection boundary', async () => {
    policy.resolve = async () => [{ address: '127.0.0.1', family: 4 }, { address: '10.0.0.1', family: 4 }];
    expect((await request(`http://shop.example.test:${port}/mixed`)).status).toBe(502);
    policy.resolve = async () => [{ address: '10.0.0.1', family: 4 }];
    expect((await request(`http://shop.example.test:${port}/changed`)).status).toBe(502); expect(hits).toEqual([]);
  });
  it('rejects non-web protocols, embedded credentials and unsupported destination ports', async () => {
    for (const target of [`ftp://shop.example.test:${port}/`, `http://user:secret@shop.example.test:${port}/`, 'http://shop.example.test:1234/']) {
      expect((await request(target)).status).toBe(502);
    }
    expect(hits).toEqual([]);
  });
  it('pins CONNECT without inspecting TLS bytes and destroys the tunnel when the session closes', async () => {
    const socket = net.connect(proxy.port, '127.0.0.1'); await once(socket, 'connect');
    socket.write(`CONNECT shop.example.test:${port} HTTP/1.1\r\nHost: shop.example.test:${port}\r\nProxy-Authorization: ${auth()}\r\n\r\n`);
    const [connected] = await once(socket, 'data'); expect(String(connected)).toContain('200 Connection Established');
    // The production proxy remains opaque; an HTTP fixture inside CONNECT verifies byte fidelity.
    socket.write(`GET /inside-tunnel HTTP/1.1\r\nHost: shop.example.test:${port}\r\n\r\n`);
    const [response] = await once(socket, 'data'); expect(String(response)).toContain('pinned origin');
    const ended = once(socket, 'close'); await proxy.close(); await ended;
    expect(hits[0]!.url).toBe('/inside-tunnel');
    await expect(new Promise<void>((resolve, reject) => { const next = net.connect(proxy.port, '127.0.0.1'); next.once('error', reject); next.once('connect', () => { next.destroy(); resolve(); }); })).rejects.toThrow();
  });
});
