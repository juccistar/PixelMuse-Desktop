import { Type, type Static } from '@sinclair/typebox';
import type { DesktopApi } from './index.js';
import type { ResourceRef } from './resources.js';
import type { WorkspaceInput, WorkspaceOperation, WorkspaceOutput } from './workspace.js';
import type { CollectionInput, CollectionOperation, CollectionOutput } from './collection.js';
import type { ApplicationInput, ApplicationOperation, ApplicationOutput } from './application.js';

/** 原生文件选择输入只允许选项，不接收本地路径。 */
export const PickFilesSchema = Type.Object({ multiple: Type.Optional(Type.Boolean()), maxFiles: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })) }, { additionalProperties: false });
export type PickFilesOptions = Static<typeof PickFilesSchema>;
export const ClipboardTextSchema = Type.String({ maxLength: 65536 });
/** 仅保存用户在画布/模板编辑器生成的有界文件，不接收路径。 */
export const GeneratedFileSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 240, pattern: '^[^\\\\/:*?"<>|\\x00-\\x1f]+$' }),
  mimeType: Type.Union(['image/png', 'image/vnd.adobe.photoshop', 'application/zip', 'application/json'].map(value => Type.Literal(value))),
  base64: Type.String({ minLength: 4, maxLength: 89478488, pattern: '^[A-Za-z0-9+/]*={0,2}$' }),
}, { additionalProperties: false });
export type GeneratedFile = Static<typeof GeneratedFileSchema>;
export interface NativeDesktopApi extends DesktopApi {
  application<K extends ApplicationOperation>(operation: K, input: ApplicationInput<K>): Promise<ApplicationOutput<K>>;
  workspace<K extends WorkspaceOperation>(operation: K, input: WorkspaceInput<K>): Promise<WorkspaceOutput<K>>;
  collection<K extends CollectionOperation>(operation: K, input: CollectionInput<K>): Promise<CollectionOutput<K>>;
  saveArtifact(ref: ResourceRef, suggestedName?: string): Promise<boolean>;
  readClipboardText(): Promise<string>;
  writeClipboardText(text: string): Promise<void>;
  saveGeneratedFile(file: GeneratedFile): Promise<boolean>;
}
