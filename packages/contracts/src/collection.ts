import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { ByteImportSchema } from './resources.js';

/** 清洗持久来源；超出契约长度时明确退回站点，不截断真实地址。 */
export function sanitizeCollectionPageUrl(value: string): string {
  return sanitizeCollectionUrl(value, 2048);
}
/** 清洗临时 Referer；保留正常页面路径，序列化头最多 8192 字节。 */
export function sanitizeCollectionReferrerUrl(value: string): string {
  return sanitizeCollectionUrl(value, 8192);
}
function sanitizeCollectionUrl(value: string, maxSerializedLength: number): string {
  if (value.length > 8192 || /[\u0000- \u007f\\]/.test(value)) throw new TypeError('来源页面地址无效。');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) throw new TypeError('来源页面地址无效。');
  const query = new URLSearchParams();
  for (const key of ['id', 'itemId', 'item_id', 'product_id', 'sku', 'skuId', 'variant']) {
    const item = url.searchParams.get(key);
    if (item && /^[A-Za-z0-9_-]{1,64}$/.test(item)) query.set(key, item);
  }
  url.search = query.toString(); url.hash = '';
  let path = url.pathname;
  let safe = false;
  // The bounded input can expand at most ninefold when URL serializes Unicode.
  // Decode before measuring segments, but inspect credentials at every representation.
  for (let depth = 0; depth <= 8; depth++) {
    if (path.length > 8192 * 9 || /[\u0000-\u001f\u007f]/.test(path) ||
      /[/\\](?:token|oauth|callback|login|auth|session)(?:[/\\;?#]|$)/i.test(path) ||
      /[;?&#](?:jsessionid|sessionid|session_id|phpsessid|sid|token|access_token|refresh_token|auth|authorization|session)(?:=|[/\\;?#]|$)/i.test(path)) break;
    if (!path.includes('%')) {
      safe = path.split(/[/\\]/).every(part => Array.from(part).length <= 160);
      break;
    }
    if (depth === 8) break;
    try { path = decodeURIComponent(path); } catch { break; }
  }
  if (!safe || url.href.length > maxSerializedLength) { url.pathname = '/'; url.search = ''; }
  if (url.href.length > maxSerializedLength) throw new TypeError('来源页面地址无效。');
  return url.href;
}

const object = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const Id = Type.String({ minLength: 1, maxLength: 160, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$' });
const Url = Type.String({ minLength: 1, maxLength: 8192 });
const Session = object({ collectionId: Id });
const Selection = object({ collectionId: Id, revision: Type.Integer({ minimum: 0 }), candidateId: Id });
const define = <I extends TSchema, O extends TSchema>(input: I, output: O) => ({ input, output });
/** 公开来源仅含清洗后的商品页地址，不包含图片认证地址或浏览器状态。 */
export const CollectionSourceSchema = object({
  platform: Type.String({ minLength: 1, maxLength: 80 }), pageUrl: Type.String({ minLength: 1, maxLength: 2048 }),
  title: Type.String({ maxLength: 240 }), collectedAt: Type.String({ format: 'date-time' }),
});
/** 候选身份绑定页面版本，远程图片地址只在主进程内短期保存。 */
export const CollectionSnapshotSchema = object({
  collectionId: Id, revision: Type.Integer({ minimum: 0 }), state: Type.Union([Type.Literal('OPEN'), Type.Literal('CLOSED')]),
  page: Type.Optional(object({ url: Type.String({ maxLength: 2048 }), title: Type.String({ maxLength: 240 }), platform: Type.String({ maxLength: 80 }) })),
  candidates: Type.Array(object({ candidateId: Id, width: Type.Integer({ minimum: 0, maximum: 100000 }), height: Type.Integer({ minimum: 0, maximum: 100000 }), label: Type.String({ maxLength: 160 }) }), { maxItems: 80 }),
  error: Type.Optional(Type.String({ maxLength: 240 })),
});
const Preview = object({ dataUrl: Type.String({ maxLength: 2097152, pattern: '^data:image/(?:png|jpeg);base64,[A-Za-z0-9+/]*={0,2}$' }) });
const Imported = object({ assetId: Id, status: Type.Union([Type.Literal('IMPORTED'), Type.Literal('ALREADY_PRESENT')]) });
const Sources = object({ items: Type.Array(object({ ...CollectionSourceSchema.properties, assetId: Id })) });
/** 工作台原生采集白名单；不开放脚本、路径、角色或任意请求头。 */
export const collectionOperations = {
  open: define(object({ projectId: Id, url: Url }), CollectionSnapshotSchema),
  status: define(Session, CollectionSnapshotSchema), refresh: define(Session, CollectionSnapshotSchema),
  preview: define(Selection, Preview), import: define(Selection, Imported),
  close: define(Session, Type.Null()), clearSession: define(Session, Type.Null()),
  addImage: define(object({ collectionId: Id, url: Url }), CollectionSnapshotSchema),
  sources: define(object({ projectId: Id }), Sources),
} as const;
/** 仅 main 可调用的有界图片解码/导入；取消使用一次请求身份，防止迟到写入。 */
export const collectionHostOperations = {
  'host.previewCollectionImage': define(object({ file: ByteImportSchema }), Preview),
  'host.importCollectedAsset': define(object({ requestId: Id, projectId: Id, file: ByteImportSchema, source: CollectionSourceSchema }), Imported),
  'host.cancelCollectionImport': define(object({ requestId: Id }), Type.Null()),
  'host.collectionSources': define(object({ projectId: Id }), Sources),
} as const;
export type CollectionSnapshot = Static<typeof CollectionSnapshotSchema>;
export type CollectionSource = Static<typeof CollectionSourceSchema>;
export type CollectionOperation = keyof typeof collectionOperations;
export type CollectionInput<K extends CollectionOperation> = Static<(typeof collectionOperations)[K]['input']>;
export type CollectionOutput<K extends CollectionOperation> = Static<(typeof collectionOperations)[K]['output']>;
export type CollectionHostOperation = keyof typeof collectionHostOperations;
export type CollectionHostInput<K extends CollectionHostOperation> = Static<(typeof collectionHostOperations)[K]['input']>;
export type CollectionHostOutput<K extends CollectionHostOperation> = Static<(typeof collectionHostOperations)[K]['output']>;
