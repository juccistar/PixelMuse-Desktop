import { Type, type Static, type TSchema } from '@sinclair/typebox';
const privateKeys = new Set(['storagePath','psdStoragePath','editMaskPath','protectMaskPath','referenceFacePath','encryptedKey','encryptedApiKey','input','inputJson','generationSnapshot','providerSnapshot','privateSnapshot','receipt','bodyBase64','sealedCredential']);
type PrivateKey = 'storagePath'|'psdStoragePath'|'editMaskPath'|'protectMaskPath'|'referenceFacePath'|'encryptedKey'|'encryptedApiKey'|'input'|'inputJson'|'generationSnapshot'|'providerSnapshot'|'privateSnapshot'|'receipt'|'bodyBase64'|'sealedCredential';
export type PublicDTO<T> = T extends readonly (infer U)[] ? PublicDTO<U>[] : T extends object ? { [K in keyof T as K extends PrivateKey ? never : K]: PublicDTO<T[K]> } : T;
/** 从领域同源结构派生公开投影，私有存储/执行证据永不进入 DTO。 */
export function publicSchema<T extends TSchema>(source: T) {
  return Type.Unsafe<PublicDTO<Static<T>>>(project(source));
}
function project(schema: TSchema): TSchema {
  let result: TSchema = { ...schema };
  delete result.$id;
  if (schema.allOf) {
    const children = (schema.allOf as TSchema[]).map(project);
    if (children.every(child => child.type === 'object' && child.properties)) {
      result = Type.Object(Object.assign({}, ...children.map(child => child.properties)), { additionalProperties: false });
    } else result.allOf = children;
  }
  if (schema.anyOf) result.anyOf = (schema.anyOf as TSchema[]).map(project);
  if (schema.items) result.items = Array.isArray(schema.items) ? schema.items.map(project) : project(schema.items);
  if (schema.properties) {
    result.properties = Object.fromEntries(Object.entries(schema.properties as Record<string,TSchema>).filter(([key]) => !privateKeys.has(key)).map(([key,value]) => [key,/^(?:url|thumbUrl|thumbnailUrl|previewUrl|downloadUrl|psdDownloadUrl|referenceFaceUrl)$/.test(key)?resourceUrl(project(value)):project(value)]));
    if (schema.required) result.required = (schema.required as string[]).filter(key => !privateKeys.has(key));
    result.additionalProperties = false;
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') result.additionalProperties = project(schema.additionalProperties);
  return result;
}
function resourceUrl(schema:TSchema):TSchema {
  if(schema.type==='string')return {...schema,maxLength:512,pattern:'^ecomgen-resource://(?:ASSET|OUTPUT|EDIT_REFERENCE|EDIT_MASK|PROTECT_MASK|LAYER_PSD|LAYER_FILE|MODEL_FACE|PORTRAIT|PATTERN|PRINT_PACK_FILE|DRAFT_MEDIA|DRAFT_CANDIDATE|THUMBNAIL|EXPORT|SUITE_SOURCE)/[A-Za-z0-9][A-Za-z0-9_-]{0,159}(?:/(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5]))?$'};
  if(schema.anyOf)return {...schema,anyOf:(schema.anyOf as TSchema[]).map(resourceUrl)};
  return schema;
}
/** 输入对象嵌套关闭，拒绝未声明字段；Record 仍保留原领域自由字段语义。 */
export function inputSchema<T extends TSchema>(schema: T): T {
  const result: TSchema = { ...schema };
  if (schema.allOf) {
    const children = (schema.allOf as TSchema[]).map(inputSchema);
    if (children.every(child => child.type === 'object' && child.properties)) {
      return Type.Object(Object.assign({}, ...children.map(child => child.properties)), { additionalProperties: false }) as unknown as T;
    }
  }
  if (schema.properties) {
    result.properties = Object.fromEntries(Object.entries(schema.properties as Record<string,TSchema>).map(([key,value])=>[key,inputSchema(value)]));
    result.additionalProperties = false;
  }
  for (const key of ['allOf','anyOf','oneOf'] as const) if (schema[key]) result[key] = (schema[key] as TSchema[]).map(inputSchema);
  if (schema.items) result.items = Array.isArray(schema.items) ? schema.items.map(inputSchema) : inputSchema(schema.items);
  return result as T;
}
