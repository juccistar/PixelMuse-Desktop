import { Type, type SchemaOptions, type Static, type TSchema } from "@sinclair/typebox";

/** 保持领域静态类型并嵌入同源 schema，让每个 IPC 操作可以独立验证。 */
export function schemaRef<T extends TSchema>(schema: T, options?: SchemaOptions) {
  if (!schema.$id) throw new Error("Referenced TypeBox schemas must define $id");
  // IPC 必须可独立校验，嵌入同源 schema，避免依赖 OpenAPI components 注册顺序。
  return Type.Unsafe<Static<T>>({ ...schema, ...options });
}
