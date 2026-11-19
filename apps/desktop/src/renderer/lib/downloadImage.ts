import { saveResource } from './resource';
/** 单图/JSON/ZIP 均交由 main 解析资源并显示系统保存对话框。 */
export async function downloadOriginal(url: string, filename: string): Promise<void> {
  await saveResource(url, filename);
}
const UNSAFE_FILENAME = /[\\/:*?"<>|\x00-\x1f]/g;
const MAX_FILENAME_LENGTH = 240;
/** 共享规格标签可能很长；保留扩展名并按完整字符满足原生保存上限。 */
export function outputFileName(output: { id: string; mimeType?: string | null }, displayName: string): string {
  const label = (displayName.trim() || output.id).replace(UNSAFE_FILENAME, ' ').trim() || output.id;
  const extension = output.mimeType === 'image/jpeg' ? 'jpg' : output.mimeType === 'image/webp' ? 'webp' : 'png';
  const budget = MAX_FILENAME_LENGTH - extension.length - 1;
  let base = '';
  for (const character of label) {
    if (base.length + character.length > budget) break;
    base += character;
  }
  return `${base.trimEnd()}.${extension}`;
}
