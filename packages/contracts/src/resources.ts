import { Type, type Static } from '@sinclair/typebox';
import { ImageByteImportSchema } from '@ecomgen/domain';
const Id = Type.String({ minLength: 1, maxLength: 160, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$' });
const ref = <K extends string>(kind: K) => Type.Object({ kind: Type.Literal(kind), id: Id }, { additionalProperties: false });
const indexed = <K extends string>(kind: K) => Type.Object({ kind: Type.Literal(kind), id: Id, index: Type.Integer({ minimum: 0, maximum: 255 }) }, { additionalProperties: false });
/** 资源引用只携带业务身份，不允许任意路径或 URL。 */
export const ResourceRefSchema = Type.Union([
  ref('ASSET'), ref('OUTPUT'), ref('EDIT_REFERENCE'), ref('EDIT_MASK'), ref('PROTECT_MASK'),
  ref('LAYER_PSD'), indexed('LAYER_FILE'), ref('MODEL_FACE'), ref('PORTRAIT'), ref('PATTERN'),
  indexed('PRINT_PACK_FILE'), ref('DRAFT_MEDIA'), ref('DRAFT_CANDIDATE'), ref('THUMBNAIL'), ref('EXPORT'), ref('SUITE_SOURCE'),
]);
export type ResourceRef = Static<typeof ResourceRefSchema>;
/** 资源协议 URL 的唯一编码；main 解码后仍按联合 schema 验证。 */
export function resourceUrlFor(ref:ResourceRef):string { return `ecomgen-resource://${ref.kind}/${ref.id}${'index' in ref?'/'+ref.index:''}`; }
export function resourceRefFromUrl(value:string):ResourceRef {
  const matched=/^ecomgen-resource:\/\/([A-Z_]+)\/([A-Za-z0-9][A-Za-z0-9_-]{0,159})(?:\/(0|[1-9][0-9]{0,2}))?$/.exec(value);
  if(!matched)throw new Error('Invalid resource URL');
  const kind=matched[1]!,id=matched[2]!,index=matched[3]===undefined?undefined:Number(matched[3]);
  const plainKinds=['ASSET','OUTPUT','EDIT_REFERENCE','EDIT_MASK','PROTECT_MASK','LAYER_PSD','MODEL_FACE','PORTRAIT','PATTERN','DRAFT_MEDIA','DRAFT_CANDIDATE','THUMBNAIL','EXPORT','SUITE_SOURCE'];
  if(index===undefined&&plainKinds.includes(kind))return {kind,id} as ResourceRef;
  if(index!==undefined&&index<=255&&['LAYER_FILE','PRINT_PACK_FILE'].includes(kind))return {kind,id,index} as ResourceRef;
  throw new Error('Invalid resource URL');
}
export const ResourceHandleSchema = Type.Object({ ref: ResourceRefSchema, name: Type.Optional(Type.String({ maxLength: 240 })), mimeType: Type.Optional(Type.String({ maxLength: 120 })) }, { additionalProperties: false });
export type ResourceHandle = Static<typeof ResourceHandleSchema>;
/** 与领域任务共用字节结构；64MiB 是传输上限，普通文件入口另限 50MiB。 */
export const ByteImportSchema = ImageByteImportSchema;
export type ByteImport = Static<typeof ByteImportSchema>;
export const ImportResultSchema = Type.Object({ resource: ResourceRefSchema, hash: Type.String({ pattern: '^[a-f0-9]{64}$' }), size: Type.Integer({ minimum: 1, maximum: 67108864 }) }, { additionalProperties: false });
export type ImportResult = Static<typeof ImportResultSchema>;
