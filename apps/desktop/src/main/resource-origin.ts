/** 返回受信资源请求的 CORS origin；undefined 表示拒绝。 */
export function resourceRequestOrigin(origin: string | null, devOrigin?: string): string | undefined {
  if (origin === null || origin === 'null') return 'null';
  // Electron 的 file 页面以 file:// 发送匿名图片请求；不能把带主机或路径的 file URL 也归一化放行。
  if (origin === 'file://') return origin;
  if (!devOrigin || origin !== devOrigin) return undefined;
  try {
    const url = new URL(devOrigin);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin === devOrigin) return origin;
  } catch { /* 非法配置不能扩大资源访问范围。 */ }
  return undefined;
}
