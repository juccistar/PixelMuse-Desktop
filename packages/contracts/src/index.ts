import { Type, type Static, type TSchema } from '@sinclair/typebox';
import './formats.js';
export { registerContractFormats } from './formats.js';
import { businessOperations, HealthSchema } from './catalog.js';
import * as S from './business-schemas.js';
import { inputSchema, publicSchema } from './public-schema.js';
import { workspaceHostOperations } from './workspace.js';
import { collectionHostOperations } from './collection.js';
import { updateMaintenanceHostOperations } from './host-update-maintenance.js';
export * from './workspace.js';
export * from './collection.js';
import { ByteImportSchema, ResourceRefSchema, ResourceHandleSchema, type ByteImport, type ResourceRef } from './resources.js';
export * from './resources.js';
export * from './native.js';
export * from './application.js';
export * from './settings.js';
export * from './usage.js';
import { applicationSettingsOperations } from './settings.js';
import { usageOperations } from './usage.js';
import { projectWorkbenchOperations } from './project-workbench.js';
import { taskHistoryOperations } from './task-history.js';
export * from './project-workbench.js';
import { productImagePlanningOperations } from './product-image-planning.js';
export * from './product-image-planning.js';
import { suitePlanningOperations } from './suite-planning.js';
export * from './suite-planning.js';
export * from './error-transport.js';
import type { AppError } from './error-transport.js';
import type { PickFilesOptions } from './native.js';
export * from './public-schema.js';
export * from './dto-schemas.js';
export * from './history-dto.js';
export * from './business-inputs.js';
export * from '@ecomgen/domain';
export { HealthSchema };
const Empty = Type.Object({}, { additionalProperties: false });
const Id = Type.String({ minLength: 1, maxLength: 160, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$' });
const define = <I extends TSchema,O extends TSchema>(input:I,output:O)=>({input:inputSchema(input),output});
export const JobSchema = publicSchema(S.HistoryJob);
export const ProjectSchema = publicSchema(S.Project);
export const AssetSchema = publicSchema(S.Asset);
export const ProviderSchema = publicSchema(S.ProviderConfig);
export const StoryboardSchema = publicSchema(S.Storyboard);
export const OutputSchema = publicSchema(S.Output);
export type Job = Static<typeof JobSchema>;
export type Project = Static<typeof ProjectSchema>;
export type Asset = Static<typeof AssetSchema>;
export type Provider = Static<typeof ProviderSchema>;
export type Storyboard = Static<typeof StoryboardSchema>;
export type OutputDTO = Static<typeof OutputSchema>;
export type Health = Static<typeof HealthSchema>;
const JobAction = Type.Object({available:Type.Boolean(),reason:Type.Union([Type.String(),Type.Null()])},{additionalProperties:false});
const InterruptionAction = Type.Union([Type.Literal('RETRY'),Type.Literal('END')]);
const extraOperations = {
  listJobs: define(Type.Object({projectId:Type.Optional(Type.Union([Id,Type.Null()])),type:Type.Optional(S.Job.properties.type),limit:Type.Optional(Type.Integer({minimum:1,maximum:500}))},{additionalProperties:false}),Type.Object({items:Type.Array(JobSchema)},{additionalProperties:false})),
  listOutputs: define(Type.Object({projectId:Id},{additionalProperties:false}),Type.Object({items:Type.Array(OutputSchema)},{additionalProperties:false})),
  getOutput: define(Type.Object({outputId:Id},{additionalProperties:false}),OutputSchema),
  getJobRequests: define(Type.Object({jobId:Id},{additionalProperties:false}),Type.Object({items:Type.Array(Type.Object({requestKey:Type.String(),state:Type.Union(['IN_FLIGHT','COMPLETED','UNKNOWN'].map(value=>Type.Literal(value))),localState:Type.Union([Type.Literal('PENDING'),Type.Literal('COMMITTED')])},{additionalProperties:false}))},{additionalProperties:false})),
  getJobRecovery: define(Type.Object({jobId:Id},{additionalProperties:false}),Type.Object({canRecover:Type.Boolean(),recoveryReason:Type.String()},{additionalProperties:false})),
  recoverJobLocally: define(Type.Object({jobId:Id},{additionalProperties:false}),JobSchema),
  getJobActions: define(Type.Object({jobId:Id},{additionalProperties:false}),Type.Object({cancel:JobAction,retry:JobAction,end:JobAction},{additionalProperties:false})),
  resolveJobInterruptions: define(Type.Union([Type.Object({jobId:Id,action:InterruptionAction},{additionalProperties:false}),Type.Object({projectId:Id,action:InterruptionAction},{additionalProperties:false})]),Type.Object({items:Type.Array(Type.Object({jobId:Id,status:Type.Union([Type.Literal('RETRIED'),Type.Literal('ENDED'),Type.Literal('SKIPPED'),Type.Literal('FAILED')]),reason:Type.Union([Type.String(),Type.Null()])},{additionalProperties:false}))},{additionalProperties:false})),
  getResource: define(Type.Object({ref:ResourceRefSchema},{additionalProperties:false}),ResourceHandleSchema),
} as const;
/** 唯一命名 IPC 白名单；所有输入先校验、await 处理器、再校验输出。 */
export const operations = Object.fromEntries(Object.entries({...businessOperations,...extraOperations,...applicationSettingsOperations,...usageOperations,...productImagePlanningOperations,...suitePlanningOperations,...projectWorkbenchOperations,...taskHistoryOperations}).map(([name,value])=>[name,{input:inputSchema(value.input),output:value.output}])) as typeof businessOperations & typeof extraOperations & typeof applicationSettingsOperations & typeof usageOperations & typeof productImagePlanningOperations & typeof suitePlanningOperations & typeof projectWorkbenchOperations & typeof taskHistoryOperations;
export type Operation = keyof typeof operations;
export type Input<K extends Operation> = Static<(typeof operations)[K]['input']>;
export type Output<K extends Operation> = Static<(typeof operations)[K]['output']>;
export const ChangeEventSchema=Type.Object({
 topic:Type.Union(['projects','assets','providers','searchSources','storyboards','outputs','jobs','editSessions','models','patterns','drafts','pipelines','catalog','library','resources','settings','usage'].map(value=>Type.Literal(value))),
 projectId:Type.Optional(Id),aggregateId:Type.Optional(Id),revision:Type.Optional(Type.Integer({minimum:0})),
},{additionalProperties:false});
export type ChangeEvent=Static<typeof ChangeEventSchema>;
export type RpcResponse={id:string;ok:true;data:unknown}|{id:string;ok:false;error:AppError};
/** 仅受信任主进程可提供目录和 safeStorage 解封的主密钥。 */
export interface BackendOptions {dataDir:string;masterKey:string;version:string}
export const hostOperations={
 ...workspaceHostOperations,
 ...collectionHostOperations,
 ...updateMaintenanceHostOperations,
 'host.resolveResource':define(Type.Object({ref:ResourceRefSchema},{additionalProperties:false}),Type.Object({path:Type.String({minLength:1}),mimeType:Type.String(),hash:Type.String()},{additionalProperties:false})),
} as const;
export type HostOperation=keyof typeof hostOperations;
export type HostInput<K extends HostOperation>=Static<(typeof hostOperations)[K]['input']>;
export type HostOutput<K extends HostOperation>=Static<(typeof hostOperations)[K]['output']>;
/** 文件选择和保存由 main 的原生对话框执行；preload 不开放任意路径能力。 */
export interface DesktopApi {
 invoke<K extends Operation>(operation:K,input:Input<K>):Promise<Output<K>>;
 pickFiles(options?:PickFilesOptions):Promise<ByteImport[]>;
 saveArtifact(ref:ResourceRef,suggestedName?:string):Promise<boolean>;
 resourceUrl(ref:ResourceRef):string;
 onChanged(listener:(event:ChangeEvent)=>void):()=>void;
 onBackendStatus(listener:(status:'ready'|'disconnected')=>void):()=>void;
}
