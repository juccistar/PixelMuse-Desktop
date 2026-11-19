import { randomBytes, timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import net, { type Socket } from 'node:net';
import { parseWebUrl, validateTarget, type ImageTransportPolicy } from './transport.js';

const MAX_CONNECTIONS = 64;
const MAX_REQUESTS = 32;
const MAX_UPLOAD = 16 * 1024 * 1024;
const MAX_TRANSFER = 100 * 1024 * 1024;
const MAX_LIFETIME = 5 * 60 * 1000;
const REALM = 'PixelMuse collection';

/** 单次临时浏览会话的认证代理，不提供业务 HTTP API，也不解密 TLS。 */
export interface CollectionBrowserProxy {
  port: number;
  username: string;
  password: string;
  close(): Promise<void>;
}
function forwardedHeaders(message: IncomingMessage): OutgoingHttpHeaders {
  const headers = { ...message.headers };
  const removed = ['connection', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade', ...(message.headers.connection ?? '').split(',').map(v => v.trim().toLowerCase())];
  for (const name of removed) delete headers[name];
  return headers;
}

/** 所有上游连接只使用本次校验的 IP，禁止 Node 或 Chromium 再次解析目标。 */
export async function createCollectionBrowserProxy(policy: ImageTransportPolicy): Promise<CollectionBrowserProxy> {
  const username = randomBytes(24).toString('hex');
  const password = randomBytes(32).toString('hex');
  const authorization = Buffer.from(`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`);
  const sockets = new Set<Socket>();
  const requests = new Set<http.ClientRequest>();
  let closed = false;
  let active = 0;
  let closing: Promise<void> | undefined;
  const authenticated = (request: IncomingMessage) => {
    const supplied = Buffer.from(request.headers['proxy-authorization'] ?? '');
    return supplied.length === authorization.length && timingSafeEqual(supplied, authorization);
  };
  const watch = (socket: Socket) => {
    sockets.add(socket);
    const deadline = setTimeout(() => socket.destroy(), MAX_LIFETIME);
    deadline.unref();
    socket.on('error', () => {});
    socket.once('close', () => { clearTimeout(deadline); sockets.delete(socket); });
    socket.setTimeout(30000, () => socket.destroy());
  };
  const server = http.createServer({ maxHeaderSize: 32768, headersTimeout: 10000, requestTimeout: 60000, keepAliveTimeout: 5000 }, (request, response) => {
    if (!authenticated(request)) {
      response.writeHead(407, { 'Proxy-Authenticate': `Basic realm="${REALM}"`, 'Content-Length': '0' }); response.end(); return;
    }
    if (closed || active >= MAX_REQUESTS) { response.writeHead(503); response.end(); return; }
    active++;
    let finished = false;
    let upstream: http.ClientRequest | undefined;
    const finish = () => { if (!finished) { finished = true; active--; } };
    const fail = () => { upstream?.destroy(); if (!response.headersSent) { response.writeHead(502); response.end(); } else response.destroy(); };
    response.once('close', () => { finish(); upstream?.destroy(); });
    request.once('aborted', fail);
    request.once('error', fail);
    void (async () => {
      // HTTPS must use CONNECT so Chromium retains certificate validation and TLS end to end.
      const target = parseWebUrl(request.url ?? '');
      if (target.protocol !== 'http:' || !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(request.method ?? '')) throw new Error();
      const [address] = await validateTarget(target, policy);
      if (closed || response.destroyed || !address) throw new Error();
      const headers = forwardedHeaders(request);
      headers.host = target.host;
      upstream = http.request(target, {
        method: request.method, headers, agent: false, family: address.family,
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      }, remote => {
        if (Number(remote.headers['content-length'] ?? 0) > MAX_TRANSFER) { remote.destroy(); fail(); return; }
        response.writeHead(remote.statusCode ?? 502, forwardedHeaders(remote));
        let received = 0;
        remote.on('data', (chunk: Buffer) => { received += chunk.length; if (received > MAX_TRANSFER) { remote.destroy(); fail(); } });
        remote.once('error', fail);
        remote.once('aborted', fail);
        remote.pipe(response);
      });
      requests.add(upstream);
      upstream.once('close', () => requests.delete(upstream!));
      upstream.once('error', fail);
      upstream.setTimeout(30000, fail);
      const deadline = setTimeout(fail, 60000);
      upstream.once('close', () => clearTimeout(deadline));
      let sent = 0;
      request.on('data', (chunk: Buffer) => { sent += chunk.length; if (sent > MAX_UPLOAD) { fail(); request.destroy(); } });
      if (Number(request.headers['content-length'] ?? 0) > MAX_UPLOAD) { fail(); return; }
      request.pipe(upstream);
    })().catch(fail);
  });
  server.on('connection', socket => {
    if (closed || sockets.size >= MAX_CONNECTIONS) { socket.destroy(); return; }
    watch(socket);
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.on('connect', (request, client, head) => {
    if (!authenticated(request)) { client.end(`HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="${REALM}"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`); return; }
    if (closed || active >= MAX_REQUESTS) { client.destroy(); return; }
    active++;
    let remote: Socket | undefined;
    client.once('close', () => { active--; remote?.destroy(); });
    void (async () => {
      // A CONNECT authority is never a URL, path or credential-bearing string.
      const authority = request.url ?? '';
      if (!/^(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):[0-9]{1,5}$/.test(authority)) throw new Error();
      const target = parseWebUrl(`https://${authority}/`);
      const [address] = await validateTarget(target, policy);
      if (closed || client.destroyed || !address) throw new Error();
      remote = net.connect({ host: address.address, family: address.family, port: Number(target.port || 443) });
      watch(remote);
      remote.once('error', () => client.destroy());
      remote.once('close', () => client.destroy());
      remote.once('connect', () => {
        if (closed || client.destroyed) { remote!.destroy(); return; }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        let transferred = head.length;
        const count = (chunk: Buffer) => { transferred += chunk.length; if (transferred > MAX_TRANSFER) { client.destroy(); remote!.destroy(); } };
        client.on('data', count); remote!.on('data', count);
        if (head.length) remote!.write(head);
        client.pipe(remote!); remote!.pipe(client);
      });
    })().catch(() => client.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  return {
    port: (server.address() as net.AddressInfo).port, username, password,
    close: () => {
      if (closing) return closing;
      closed = true;
      for (const request of requests) request.destroy();
      for (const socket of sockets) socket.destroy();
      closing = new Promise<void>(resolve => server.close(() => resolve()));
      return closing;
    },
  };
}
