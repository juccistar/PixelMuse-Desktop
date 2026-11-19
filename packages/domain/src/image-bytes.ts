import { Type, type Static } from '@sinclair/typebox';

/** 字节传输的单图上限；普通文件入口仍另按已发布桌面的 50MiB 业务上限校验。 */
export const MAX_IMAGE_TRANSPORT_BYTES = 64 * 1024 * 1024;
/** 纯图片字节契约，供领域任务和 IPC 共用；不接受路径或旧 multipart 字符串。 */
export const ImageByteImportSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 240, pattern: '^[^\\\\/:*?"<>|\\x00-\\x1f]+$' }),
  mimeType: Type.Union(['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/tiff'].map(value => Type.Literal(value))),
  // 单次字符扫描不按四字符分组递归；规范 padding、长度和真实字节数由解码边界校验。
  base64: Type.String({ minLength: 4, maxLength: Math.ceil(MAX_IMAGE_TRANSPORT_BYTES / 3) * 4, pattern: '^[A-Za-z0-9+/]*={0,2}$' }),
}, { additionalProperties: false });
export type ImageByteImport = Static<typeof ImageByteImportSchema>;

/** 蒙版必须保持 PNG；一般图片扩展格式不能放宽编辑与保护蒙版的业务规则。 */
export const PngImageByteImportSchema = Type.Object({
  ...ImageByteImportSchema.properties,
  mimeType: Type.Literal('image/png'),
}, { additionalProperties: false });
