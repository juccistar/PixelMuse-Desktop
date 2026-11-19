import { resourceRefFromUrl, resourceUrlFor, type ResourceRef } from '@ecomgen/contracts';

/** canvas 和图片元素只读取受管资源协议；不解释任意 URL 或本地路径。 */
export function restrictedResourceUrl(value: string): string {
  return resourceUrlFor(resourceRefFromUrl(value));
}
export async function readResource(value: string): Promise<Response> {
  const response = await fetch(restrictedResourceUrl(value), { credentials: 'omit', redirect: 'error' });
  if (!response.ok) throw new Error('资源无法读取，请刷新后重试');
  return response;
}
export async function saveResource(value: string | ResourceRef, suggestedName?: string): Promise<boolean> {
  const ref = typeof value === 'string' ? resourceRefFromUrl(value) : value;
  return suggestedName === undefined ? window.ecomgen.saveArtifact(ref) : window.ecomgen.saveArtifact(ref, suggestedName);
}
export async function saveGeneratedBlob(blob: Blob, name: string): Promise<boolean> {
  if (!blob.size || blob.size > 64 * 1024 * 1024) throw new Error('导出文件必须非空且不能超过 64 MiB');
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); reader.onerror = () => reject(new Error('无法读取导出文件'));
    reader.onload = () => resolve(String(reader.result).split(',')[1]!); reader.readAsDataURL(blob);
  });
  if (!['image/png', 'image/vnd.adobe.photoshop', 'application/zip', 'application/json'].includes(blob.type)) throw new Error('此类型不能从编辑器导出');
  return window.ecomgen.saveGeneratedFile({ name, mimeType: blob.type as 'image/png' | 'image/vnd.adobe.photoshop' | 'application/zip' | 'application/json', base64 });
}
