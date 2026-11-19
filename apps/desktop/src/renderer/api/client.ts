import { ByteImportSchema, decodePublicErrorMessage, publicErrorDisplayMessage, type ByteImport, type Input, type Operation, type Output } from '@ecomgen/contracts';
import { Value } from '@sinclair/typebox/value';
import { imageTypeFromHeader } from '../../shared/image-types';
import { ApiError } from './errors';

/** 所有业务查询和提交直接使用契约中的命名 IPC。 */
export async function invoke<K extends Operation>(operation: K, input: Input<K>): Promise<Output<K>> {
  try { return await window.ecomgen.invoke(operation, input); }
  catch (error) {
    if (error instanceof ApiError) throw error;
    const value = error as { code?: unknown; message?: unknown } | null;
    const message = typeof value?.message === 'string' ? value.message : '本地后台操作失败';
    const transported = decodePublicErrorMessage(message);
    throw new ApiError(transported ?? {
      code: typeof value?.code === 'string' ? value.code : 'UNKNOWN',
      message: publicErrorDisplayMessage(message),
    });
  }
}
/** 先校验容量再读取；实际文件头识别保留 PNG/JPEG/WebP/AVIF/TIFF，后台继续严格解码。 */
export async function fileInput(file: Blob, name = file instanceof File ? file.name : 'canvas.png'): Promise<ByteImport> {
  const maxBytes = (file instanceof File ? 50 : 64) * 1024 * 1024;
  if (file.size === 0 || file.size > maxBytes) throw new ApiError({ code: 'INVALID_FILE', message: `图片必须非空，且不能超过 ${maxBytes / 1024 / 1024} MiB` });
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('无法读取图片'));
    reader.onload = () => resolve(String(reader.result).split(',')[1]!);
    reader.readAsDataURL(file);
  });
  const header = Uint8Array.from(atob(base64.slice(0, 88)), char => char.charCodeAt(0));
  const mimeType = imageTypeFromHeader(header);
  if (!mimeType) throw new ApiError({ code: 'UNSUPPORTED_IMAGE', message: '支持 PNG、JPEG、WebP、AVIF 和 TIFF 图片，请检查实际文件内容' });
  const input = { name, mimeType, base64 };
  if (!Value.Check(ByteImportSchema, input)) throw new ApiError({ code: 'CONTRACT_MISMATCH', message: '当前后台导入契约尚未接纳此图片格式或文件名，请更新本地应用' });
  return input;
}
/** 编辑与保护蒙版沿用契约中更严格的 PNG 字节类型。 */
export async function pngInput(file: Blob, name: string): Promise<NonNullable<Input<'createEditTurn'>['editMask']>> {
  const input = await fileInput(file, name);
  if (input.mimeType !== 'image/png') throw new ApiError({ code: 'INVALID_MASK', message: '编辑和保护蒙版必须是 PNG' });
  return { ...input, mimeType: 'image/png' };
}
