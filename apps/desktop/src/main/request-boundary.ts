import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseResourceRequest } from './native-files.js';
/** file 页面仍不能读取安装目录以外的文件；网络只开放显式开发服务器。 */
export function rendererRequestAllowed(value: string, rendererDirectory: string, devOrigin?: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'ecomgen-resource:') { parseResourceRequest(value); return true; }
    if (url.protocol === 'data:' || url.protocol === 'blob:' || value === 'about:blank') return true;
    if (devOrigin && (url.origin === devOrigin || url.origin === devOrigin.replace(/^http/, 'ws'))) return true;
    if (url.protocol !== 'file:' || url.host || url.search || url.hash) return false;
    const path = fileURLToPath(url); const within = relative(rendererDirectory, path);
    return within !== '' && within !== '..' && !within.startsWith('../') && !within.startsWith('..\\') && !isAbsolute(within);
  } catch { return false; }
}
