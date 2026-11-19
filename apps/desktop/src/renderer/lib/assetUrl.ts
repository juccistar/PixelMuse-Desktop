import { resourceUrlFor } from '@ecomgen/contracts';
export function assetPreviewUrl(asset: { id: string; url?: string | null }): string {
  return resourceUrlFor({ kind: 'ASSET', id: asset.id });
}
export function outputPreviewUrl(output: { id: string; url?: string | null }): string {
  return resourceUrlFor({ kind: 'OUTPUT', id: output.id });
}
/** 缩略图使用内容 hash，由后台验证受管资源归属。 */
export function outputThumbnailUrl(output: { hash?: string | null }): string | null {
  return output.hash ? resourceUrlFor({ kind: 'THUMBNAIL', id: output.hash }) : null;
}
