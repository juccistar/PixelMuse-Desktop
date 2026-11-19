import type { Static, TSchema } from '@sinclair/typebox';
import type { EcomRepository, DesktopHistoryRepository, LocalAssetStore, SecretBox, SuiteCatalog, JobRecord } from '@ecomgen/core';
import type { ChangeEvent, Input, Operation, Output, ResourceRef } from '@ecomgen/contracts';
import type { ExternalRequestScope, RequestDescriptor, ResponseReceipt } from '@ecomgen/domain';
import type { FrozenJobSnapshot, JobRuntimeRecord, RuntimeStore } from './state.js';

/** 所有命令共享 Backend 唯一仓库与连接；事务回调禁止返回 Promise。 */
export interface CommandContext {
  repository: EcomRepository;
  /** 当前桌面历史只读 API；原始快照与路径不能直接返回 Renderer。 */
  history: DesktopHistoryRepository;
  storage: LocalAssetStore;
  secrets: SecretBox;
  catalog: SuiteCatalog;
  scheduler: SchedulerPort;
  events: EventPort;
  requestLedger: RequestLedgerPort;
  resources: ResourceRegistryPort;
  clock: () => string;
  idFactory: () => string;
  signal: AbortSignal;
  transaction<T>(callback: () => T): T;
  /** 仅限用户显式重试已存在意图时使用的项目屏障范围。 */
  interruptionRetry?: {jobId:string;cohort:readonly string[]};
}
export type CommandHandler<K extends Operation> = (context: CommandContext, input: Input<K>) => Output<K> | Promise<Output<K>>;
export type CommandHandlers = { [K in Operation]?: CommandHandler<K> };
/** C 返回具名处理器；未注册命令会明确失败，不能回退至路径分派。 */
export type RegisterCommands = (context: CommandContext) => CommandHandlers;

export interface EventPort { publish(event: ChangeEvent): void }
export interface SchedulerPort {
  /** 更新认领上限，不中断已运行任务。 */
  setConcurrency(value: number): void;
  /** 仅唤醒已冻结、已提交的同一 SQLite 队列。 */
  enqueue(jobId: string): void;
  /** 在创建 Job 及全部伴随记录的同一同步事务内冻结。 */
  freeze(jobId: string, snapshot: FrozenJobSnapshot): void;
  cancel(jobId: string): JobRecord;
  /** Provider/项目删除必须先取消并等待执行退出，再删领域记录。 */
  waitForIdle(jobIds: readonly string[]): Promise<void>;
  retry(jobId: string): JobRecord;
  resolveInterruptions(input:{jobId:string;action:'RETRY'|'END'}|{projectId:string;action:'RETRY'|'END'}|{jobIds:readonly string[];action:'RETRY'|'END'}):{items:Array<{jobId:string;status:'RETRIED'|'ENDED'|'SKIPPED'|'FAILED';reason:string|null}>};
  localRecovery(jobId: string): { available: boolean; reason: string };
  recoverLocally(jobId: string): JobRecord;
  actions(jobId: string): {cancel:{available:boolean;reason:string|null};retry:{available:boolean;reason:string|null};end:{available:boolean;reason:string|null}};
}
export interface RequestLedgerPort {
  forJob(jobId: string, signal: AbortSignal, assertCurrent?: () => void): ExternalRequestScope;
  hasUnknown(jobId: string): boolean;
  summaries(jobId: string): Array<{ requestKey: string; state: 'IN_FLIGHT' | 'COMPLETED' | 'UNKNOWN'; localState: 'PENDING' | 'COMMITTED' }>;
}
export interface ResourceRegistryPort {
  register(input: { ref: ResourceRef; relativePath: string; mimeType: string; hash: string; owners: string[] }): void;
  resolve(ref: ResourceRef): Promise<{ path: string; mimeType: string; hash: string }>;
  retain(ref: ResourceRef, owner: string): void;
  release(ref: ResourceRef, owner: string): void;
  scheduleCleanup(ref: ResourceRef): void;
}

/** D 执行器只在本地异步处理；最终领域行和运行终态由同步结算统一提交。 */
export interface ExecutionContext extends CommandContext {
  job: JobRecord;
  snapshot: FrozenJobSnapshot;
  external: ExternalRequestScope;
  attempt: number;
  assertCurrent(): void;
  progress(value: number, detail?: Record<string, unknown>): void;
  /** 输出、槽位和后续 Job 创建在同一事务中提交；每次均校验当前 attempt。 */
  checkpoint<T>(callback: () => T): T;
}
export type JobTerminalStatus = 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN';
export interface DomainExecutor {
  snapshotSchema: TSchema;
  execute(context: ExecutionContext): Promise<void>;
  /** 调用时已有同步 SQLite 事务；必须保持成功产物和未知槽位，不得 await。 */
  settle?(context: CommandContext, job: JobRecord, status: JobTerminalStatus, runtime: JobRuntimeRecord): void;
  /** 显式重试需在事务内处理 Turn/Slot/Step 等关联，返回同一或新 Job。 */
  retry?(context: CommandContext, job: JobRecord, runtime: JobRuntimeRecord): JobRecord;
  /** 只读检查，供界面展示真实重试能力。 */
  checkRetry?(context: CommandContext, job: JobRecord, runtime: JobRuntimeRecord): void;
}
export const EXECUTOR_TYPES = ['PLAN', 'COPYWRITE', 'GENERATE', 'EXPORT', 'EDIT_PLAN', 'EDIT_GENERATE', 'LAYER_PLAN', 'LAYER_EXPORT', 'SUITE_FORGE', 'MODEL_CAST', 'PATTERN_EXTRACT', 'PATTERN_FORGE', 'PATTERN_DERIVE', 'PATTERN_VARIANT', 'PATTERN_TILE_CHECK', 'PRINT_PACK', 'PATTERN_DRAFT_GENERATE', 'PATTERN_DRAFT_EDIT', 'PATTERN_DRAFT_CUTOUT', 'PATTERN_DRAFT_PROCESS'] as const;
export type ExecutorType = typeof EXECUTOR_TYPES[number];
export type ExecutorMap = { [K in ExecutorType]: DomainExecutor };
/** 阶段二 D 必须提供完整映射；不存在 EXPORT 兜底。 */
export type RegisterExecutors = (context: CommandContext) => ExecutorMap;
export type { FrozenJobSnapshot, JobRuntimeRecord, RuntimeStore, ExternalRequestScope, RequestDescriptor, ResponseReceipt };
