import { Type, type Static } from '@sinclair/typebox';

const uuid = Type.String({ format: 'uuid' });
const target = Type.String({ minLength: 1, maxLength: 200 });
const project = { projectId: uuid };
const contents = {
  adoptions: Type.Array(Type.Object({ targetId: target, outputId: uuid }, { additionalProperties: false }), { maxItems: 1000 }),
  detailOrder: Type.Array(target, { maxItems: 1000, uniqueItems: true }),
};
/** 采用和详情排序是项目级业务状态，独立于临时下载勾选。 */
export const ProjectWorkbenchSchema = Type.Object({ ...project, revision: Type.Integer({ minimum: 0 }), ...contents, updatedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]) }, { additionalProperties: false });
export type ProjectWorkbench = Static<typeof ProjectWorkbenchSchema>;
const ExportRecord = Type.Object({ id: uuid, projectId: uuid, jobId: uuid, status: Type.String(), createdAt: Type.String(), updatedAt: Type.String(), outputIds: Type.Array(uuid), longImage: Type.Boolean(), downloadUrl: Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false });
/** 全量原子保存采用与顺序，revision 防止多个窗口互相覆盖。 */
export const projectWorkbenchOperations = {
  getProjectWorkbench: { input: Type.Object(project, { additionalProperties: false }), output: ProjectWorkbenchSchema },
  saveProjectWorkbench: { input: Type.Object({ ...project, expectedRevision: Type.Integer({ minimum: 0 }), ...contents }, { additionalProperties: false }), output: ProjectWorkbenchSchema },
  listProjectExports: { input: Type.Object(project, { additionalProperties: false }), output: Type.Object({ items: Type.Array(ExportRecord) }, { additionalProperties: false }) },
} as const;
