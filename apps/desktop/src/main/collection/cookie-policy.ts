import { getDomain } from 'tldts';

/** Chromium 的 schemeful site 使用 PSL 可注册域，独立托管站点也保留私有后缀隔离。 */
export function isSchemefulSameSite(page: URL, target: URL): boolean {
  if (page.protocol !== target.protocol) return false;
  // PSL 会去掉末尾点，但 Chromium 的站点身份仍区分完全限定域名。
  if (page.hostname.endsWith('.') !== target.hostname.endsWith('.')) return false;
  const site = (url: URL) => getDomain(url.hostname, { allowPrivateDomains: true }) ?? url.hostname;
  return site(page) === site(target);
}
