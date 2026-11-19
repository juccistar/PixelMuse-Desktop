import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { sanitizeCollectionPageUrl, sanitizeCollectionReferrerUrl } from '@ecomgen/contracts';

/** 与本地素材导入共用 50MiB 容量上限。 */
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
/** 采集失败使用固定消息，不回显认证 URL、Cookie 或远端响应。 */
export class CollectionError extends Error {
  constructor(message = '无法读取此图片，请正常浏览页面或改用本地导入。') { super(message); this.name = 'CollectionError'; }
}
/** URL 与连接地址分别验证，IPv6 仅允许全球单播且排除特殊用途段。 */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6) return false;
  const first = Number.parseInt(address.split(':')[0]!, 16);
  const second = Number.parseInt(address.split(':')[1] || '0', 16);
  return first >= 0x2000 && first < 0x3ffe && first !== 0x2002 &&
    !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
}
/** 只接受普通网页链接，拒绝内嵌凭据和外部协议。 */
export function parseWebUrl(value: string): URL {
  if (value.length > 8192 || /[\u0000- \u007f\\]/.test(value)) throw new CollectionError('链接格式无效，请使用网页 HTTP(S) 链接。');
  let url: URL;
  try { url = new URL(value); } catch { throw new CollectionError('链接格式无效，请使用网页 HTTP(S) 链接。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) throw new CollectionError('链接格式无效，请使用普通网页链接。');
  url.hash = '';
  return url;
}
/** 仅保留常见商品身份参数；签名、认证与跟踪参数绝不持久化。 */
export function sanitizePageUrl(value: string): string {
  try { return sanitizeCollectionPageUrl(value); }
  catch { throw new CollectionError('链接格式无效，请使用普通网页链接。'); }
}
/** 每个目标独立计算保守 Referer；只沿用正常页面来源，不发送认证路径或降级来源。 */
export function imageReferrer(value: string | undefined, target: URL): string | undefined {
  if (!value) return undefined;
  try {
    const source = new URL(sanitizeCollectionReferrerUrl(value));
    if (source.protocol === 'https:' && target.protocol !== 'https:') return undefined;
    return source.origin === target.origin ? source.href : `${source.origin}/`;
  } catch { return undefined; }
}
/** 已验证的连接地址，不能交给后续网络 API 再次解析。 */
export type ResolvedAddress = { address: string; family: number };
/** 策略仅控制目标校验，不能增加请求方法、任意头或本地路径能力。 */
export interface ImageTransportPolicy {
  resolve(host: string): Promise<ResolvedAddress[]>;
  allow(address: string, url: URL): boolean;
  allowPort(url: URL): boolean;
}
/** 生产策略始终拒绝私网；测试策略只能通过独立工厂显式注入。 */
export const publicTransportPolicy: ImageTransportPolicy = {
  resolve: host => lookup(host, { all: true, verbatim: true }),
  allow: address => isPublicAddress(address),
  allowPort: url => !url.port || ['80', '443'].includes(url.port),
};
/** 有界解析并拒绝包含任一非公网答案的主机。 */
export async function validateTarget(url: URL, policy: ImageTransportPolicy = publicTransportPolicy): Promise<ResolvedAddress[]> {
  if (!policy.allowPort(url)) throw new CollectionError('不支持此服务端口。');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await abortable(policy.resolve(host), AbortSignal.timeout(5000));
  if (!addresses.length || addresses.length > 32 || addresses.some(item => !isIP(item.address) || !policy.allow(item.address, url))) throw new CollectionError('此链接指向不允许访问的网络地址。');
  return addresses;
}
/** 单次读取共享截止时间与取消信号，Cookie 由精确目标 URL 查询。 */
export interface ImageDownloadOptions {
  signal: AbortSignal;
  cookies(url: URL): Promise<string>;
  referrer?: string;
  policy?: ImageTransportPolicy;
  maxBytes?: number;
  timeoutMs?: number;
}
/** 每跳重新解析并固定连接地址，逐字节计数，禁止自动解压与认证跨域转发。 */
export async function downloadImage(value: string, options: ImageDownloadOptions): Promise<{ buffer: Buffer; mimeType: string }> {
  const policy = options.policy ?? publicTransportPolicy;
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) controller.abort();
  const timer = setTimeout(abort, options.timeoutMs ?? 20000);
  const maxBytes = Math.min(options.maxBytes ?? MAX_IMAGE_BYTES, MAX_IMAGE_BYTES);
  try {
    let url = parseWebUrl(value);
    for (let redirects = 0; redirects <= 3; redirects++) {
      controller.signal.throwIfAborted();
      // DNS and cookie APIs are not abortable. Race the entire step against the same deadline.
      const { address, cookie } = await abortable(Promise.all([validateTarget(url, policy), options.cookies(url)]).then(([addresses, cookie]) => ({ address: addresses[0]!, cookie })), controller.signal);
      if (cookie.length > 16384 || /[\r\n]/.test(cookie)) throw new CollectionError();
      const referrer = imageReferrer(options.referrer, url);
      const response = await new Promise<{ redirect?: string; buffer?: Buffer; mimeType?: string }>((resolve, reject) => {
        const request = (url.protocol === 'https:' ? https : http).request(url, {
          method: 'GET', agent: false, signal: controller.signal, family: address.family,
          headers: { Accept: 'image/png,image/jpeg,image/webp,image/avif,image/tiff', 'Accept-Encoding': 'identity', ...(cookie ? { Cookie: cookie } : {}), ...(referrer ? { Referer: referrer } : {}) },
          lookup: (_hostname, _opts, callback) => callback(null, address.address, address.family),
        }, res => {
          const status = res.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(status)) {
            const redirect = res.headers.location; res.destroy();
            if (!redirect || redirect.length > 8192) reject(new CollectionError()); else resolve({ redirect });
            return;
          }
          const mimeType = (res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
          if (status !== 200 || !['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/tiff'].includes(mimeType) ||
            (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') || Number(res.headers['content-length'] ?? 0) > maxBytes) {
            res.destroy(); reject(new CollectionError()); return;
          }
          let size = 0; const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) { reject(new CollectionError('图片超过允许的大小。')); res.destroy(); } else chunks.push(chunk); });
          res.on('error', reject); res.on('aborted', () => reject(new CollectionError()));
          res.on('end', () => size ? resolve({ buffer: Buffer.concat(chunks), mimeType }) : reject(new CollectionError()));
        });
        request.on('error', reject); request.end();
      });
      controller.signal.throwIfAborted();
      if (response.redirect) {
        const next = parseWebUrl(new URL(response.redirect, url).href);
        if (url.protocol === 'https:' && next.protocol !== 'https:') throw new CollectionError();
        url = next; continue;
      }
      return { buffer: response.buffer!, mimeType: response.mimeType! };
    }
    throw new CollectionError('图片重定向次数过多。');
  } catch (error) {
    if (error instanceof CollectionError) throw error;
    throw new CollectionError(controller.signal.aborted ? '读取已取消或超时。' : undefined);
  } finally { clearTimeout(timer); options.signal.removeEventListener('abort', abort); }
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let handler: () => void;
  const aborted = new Promise<never>((_resolve, reject) => { handler = () => reject(new CollectionError('读取已取消或超时。')); signal.addEventListener('abort', handler, { once: true }); });
  try { return await Promise.race([promise, aborted]); } finally { signal.removeEventListener('abort', handler!); }
}
