import { Type, type Static } from '@sinclair/typebox';
import { GeneratedFileSchema } from './native.js';

const Empty = Type.Object({}, { additionalProperties: false });
/** 原生只读目录显示与异步迁移进度，不授予 renderer 文件访问权。 */
export const WorkspaceStatusSchema = Type.Object({
  directory: Type.String(), configured: Type.Boolean(),
  state: Type.Union(['READY', 'COPYING', 'VERIFYING', 'RESTARTING', 'FAILED'].map(value => Type.Literal(value))),
  copiedFiles: Type.Integer({ minimum: 0 }), totalFiles: Type.Integer({ minimum: 0 }),
  copiedBytes: Type.Integer({ minimum: 0 }), totalBytes: Type.Integer({ minimum: 0 }),
  error: Type.Optional(Type.String()),
}, { additionalProperties: false });
export type WorkspaceStatus = Static<typeof WorkspaceStatusSchema>;
/** 目录只能由主进程原生选择器提供。 */
export const workspaceOperations = {
  status: { input: Empty, output: WorkspaceStatusSchema },
  choose: { input: Empty, output: Type.Object({ canceled: Type.Boolean(), status: WorkspaceStatusSchema }, { additionalProperties: false }) },
  migration: { input: Empty, output: WorkspaceStatusSchema },
  cancel: { input: Empty, output: WorkspaceStatusSchema },
  openFolder: { input: Empty, output: Type.Null() },
} as const;
export type WorkspaceOperation = keyof typeof workspaceOperations;
export type WorkspaceInput<K extends WorkspaceOperation> = Static<(typeof workspaceOperations)[K]['input']>;
export type WorkspaceOutput<K extends WorkspaceOperation> = Static<(typeof workspaceOperations)[K]['output']>;
/** 宿主控制单独分派，不经过业务 DTO 的绝对路径投影。 */
export const workspaceHostOperations = {
  'host.workspaceStatus': { input: Empty, output: WorkspaceStatusSchema },
  'host.workspaceChoose': { input: Type.Object({ directory: Type.String({ minLength: 1, maxLength: 32767 }) }, { additionalProperties: false }), output: WorkspaceStatusSchema },
  'host.workspaceCancel': { input: Empty, output: WorkspaceStatusSchema },
  'host.archiveGeneratedFile': { input: GeneratedFileSchema, output: Type.Null() },
} as const;
