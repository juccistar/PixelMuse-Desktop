import { createHash } from 'node:crypto';
import type { Static, TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { operations, resourceUrlFor, type ByteImport, type Operation, type ResourceRef } from '@ecomgen/contracts';
import type { JobRecord } from '@ecomgen/core';
import type { CommandContext, FrozenJobSnapshot } from '../runtime/ports.js';
import { BackendError, decodeByteImport, check, assertPublicOutput } from '../validation.js';
import { createExecutionSnapshot, outputImagePlanning } from '../execution/snapshot.js';
import { publicJob } from '../business.js';
import { publicTaskError } from '../public-task-error.js';
import { registerJobResources, projectResources, modelResources, patternResources, draftResources, registerEntries, retireEntries, preparePublicResources } from './resources.js';

/** 领域错误不携带 transport 状态；旧参数位置只用于迁入的纯校验函数。 */
export class ApiError extends BackendError {
  constructor(code: string, message: string, _details?: unknown) { super(code, message); }
}
export type CommandFlow<T> = Generator<unknown, T, any>;
export interface CommandScope extends CommandContext {
  queue(jobs: JobRecord | readonly JobRecord[]): void;
  cancel(id: string): JobRecord;
}
export function parseBody<T extends TSchema>(schema: T, value: unknown, _options?: unknown): Static<T> {
  if (!Value.Check(schema, value)) throw new BackendError('VALIDATION_ERROR', '业务参数无效。');
  return value as Static<T>;
}
export function bodyOf<T extends object, K extends keyof T>(input: T, keys: readonly K[]): Omit<T, K> {
  return Object.fromEntries(Object.entries(input).filter(([key]) => !keys.includes(key as K))) as Omit<T, K>;
}
export async function readImage(file: ByteImport | undefined, context: Pick<CommandContext, 'storage' | 'signal'>) {
  if (!file) throw new BackendError('VALIDATION_ERROR', '需要选择图片文件。');
  const buffer = decodeByteImport(file);
  // 保留已发布桌面的 50MiB 文件入口；画布有自己的 64MiB 契约上限。
  if (buffer.length > 50 * 1024 * 1024) throw new BackendError('VALIDATION_ERROR', '图片不能超过 50MiB。');
  try { await context.storage.inspectImage(buffer, context.signal); }
  catch {
    context.signal.throwIfAborted();
    throw new BackendError('INVALID_IMAGE', '图片内容损坏或超过像素上限。');
  }
  return { buffer, filename: file.name, mimetype: file.mimeType, hash: createHash('sha256').update(buffer).digest('hex') };
}
export async function readImageInput(command: object, context: Pick<CommandContext, 'storage' | 'signal'>) {
  const { file, ...rest } = command as { file?: ByteImport } & Record<string, unknown>;
  const fields: Record<string, string | undefined> = Object.fromEntries(Object.entries(rest).map(([key, value]) => [key, value === undefined ? undefined : typeof value === 'string' ? value : JSON.stringify(value)]));
  const upload = file ? await readImage(file, context) : undefined;
  return { upload, fields };
}
export async function readSingleImageInput(command: object, label: string, context: Pick<CommandContext, 'storage' | 'signal'>) {
  const result = await readImageInput(command, context);
  if (!result.upload) throw new BackendError('VALIDATION_ERROR', `缺少 ${label}。`);
  return { ...result, upload: result.upload };
}

/** 按公开 schema 投影，Record 中也清除路径/凭据；不返回任意仓储字段。 */
export function projectPublic(schema: TSchema, value: unknown): any {
  if (value === undefined || value === null) return value;
  if (schema.allOf) return Object.assign({}, ...(schema.allOf as TSchema[]).map(s => projectPublic(s, value)));
  if (schema.anyOf) {
    const variants = schema.anyOf as TSchema[];
    const selected = variants.find(s => Value.Check(s, value)) ?? variants.find(s => s.type === (Array.isArray(value) ? 'array' : typeof value) || (s.properties && typeof value === 'object'));
    return projectPublic(selected ?? schema.anyOf[0], value);
  }
  if (Array.isArray(value)) return value.map(entry => projectPublic(schema.items ?? {}, entry));
  if (typeof value !== 'object') return value;
  const row = value as Record<string, any>;
  if ('type' in row && 'retryable' in row && 'requestFingerprint' in row) return projectPublicWithoutJob(schema, { ...publicJob(row as JobRecord), ...(typeof row.reused === 'boolean' ? { reused: row.reused } : {}) });
  return projectPublicWithoutJob(schema, row);
}
const privateName = /^(?:apiKey|encryptedKey|encryptedApiKey|masterKey|storagePath|psdStoragePath|editMaskPath|protectMaskPath|referenceFacePath|privateSnapshot|providerSnapshot|generationSnapshot|input|inputJson|bodyBase64|encryptedReceipt|sealedCredential|authorization)$/i;
function projectPublicWithoutJob(schema: TSchema, row: Record<string, any>): any {
  const result: Record<string, unknown> = {};
  const isOutput = Boolean(schema.properties?.revision && schema.properties?.storyboardItemId && schema.properties?.jobId && schema.properties?.hash);
  for (const [key, value] of Object.entries(row)) {
    if (privateName.test(key) || value === undefined || (isOutput && (key === 'revision' || key === 'imagePlanning'))) continue;
    const child = schema.properties?.[key] ?? (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : undefined);
    if (schema.properties && !child) continue;
    // 仓储中的空模型引用投影为可选字段缺省，不能把 null 填进只接受字符串的 DTO。
    if (value === null && child && !(schema.required as string[] | undefined)?.includes(key) && !Value.Check(child, null)) continue;
    if (key === 'error' && value && child?.type !== 'string') { result[key] = publicTaskError(value, row.status); continue; }
    result[key] = projectPublic(child ?? {}, value);
  }
  // 只从已持久化的生成快照提取公开说明，忽略其它来源的同名字段。
  if (isOutput && typeof row.generationSnapshot?.revision === 'string') result.revision = row.generationSnapshot.revision;
  if (isOutput && schema.properties?.imagePlanning) {
    const context = outputImagePlanning(row.generationSnapshot);
    if (context) result.imagePlanning = projectPublic(schema.properties.imagePlanning, context);
  }
  if (schema.properties?.url && !result.url && row.id) {
    const kind = row.role && row.projectId ? 'ASSET' : row.storyboardItemId && row.jobId ? 'OUTPUT' : undefined;
    if (kind) result.url = resourceUrlFor({ kind, id: row.id });
  }
  if (schema.properties?.downloadUrl && row.storagePath && row.id) result.downloadUrl = resourceUrlFor({ kind: 'EXPORT', id: row.id });
  return result;
}

/** 每段同步领域写入和 freeze 同事务；遇到文件 I/O 先提交，绝不跨 await 持有 SQLite。 */
export async function runCommandFlow(context: CommandContext, operation: Operation, input: unknown, factory: (scope: CommandScope) => (input: any) => CommandFlow<unknown>): Promise<unknown> {
  const pending = new Map<string, JobRecord>();
  const created = new Set<string>();
  const queued = new Set<string>();
  const scope: CommandScope = { ...context, queue(jobs) { for (const job of Array.isArray(jobs) ? jobs : [jobs]) if (created.has(job.id)) pending.set(job.id, job); }, cancel(id) { return context.scheduler.cancel(id); } };
  scope.repository = new Proxy(context.repository, { get(target, key, receiver) {
    if (key === 'createJob') return (...args: Parameters<typeof target.createJob>) => { const job = target.createJob(...args); created.add(job.id); return job; };
    const value = Reflect.get(target, key, receiver);
    if (typeof value === 'function' && ['createAsset','createPattern','createDraftMedia','createDraftCandidate'].includes(String(key))) return (...args: unknown[]) => {
      const record = value.apply(target,args);
      const entries = key === 'createAsset' ? projectResources(context,record.projectId) : key === 'createPattern' ? patternResources(context,record.id) : draftResources(context,record.draftId);
      registerEntries(context,entries);
      return record;
    };
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const initial = input as Record<string, any>;
  const projectId = initial.projectId ?? (initial.assetId ? context.repository.getAsset(initial.assetId)?.projectId : undefined) ?? (initial.sessionId ? context.repository.getEditSession(initial.sessionId)?.projectId : undefined);
  const known = [
    ...(projectId ? projectResources(context, projectId) : []),
    ...(initial.draftId ? draftResources(context, initial.draftId) : []),
    ...(initial.modelId && !initial.providerId ? modelResources(context, initial.modelId) : []),
    ...(initial.patternId ? patternResources(context, initial.patternId) : []),
  ];
  const oldStorage = context.storage;
  scope.storage = new Proxy(oldStorage, { get(target, property) {
    if (property === 'delete') return async (path: string) => {
      const entries = known.filter(e => e.relativePath === path);
      if (!entries.length) throw new BackendError('UNREGISTERED_CLEANUP', '文件缺少可验证的领域引用。');
      context.transaction(() => retireEntries(context, entries));
    };
    if (['deleteDraft','deleteModel','deletePattern','deleteProject'].includes(String(property))) return async (_id: string) => { context.transaction(() => retireEntries(context, known)); };
    if (property === 'putThumbnail') return async (hash: string, bytes: Buffer) => {
      const result = await target.putThumbnail(hash, bytes);
      context.transaction(() => context.resources.register({ref:{kind:'THUMBNAIL',id:hash},relativePath:target.thumbnailPath(hash),hash:createHash('sha256').update(bytes).digest('hex'),mimeType:'image/webp',owners:[`thumbnail:${hash}`]}));
      return result;
    };
    const value = Reflect.get(target, property);
    if (typeof value === 'function' && String(property).startsWith('put')) return async (...args: unknown[]) => {
      const stored = await value.apply(target,args);
      if (stored && typeof stored.path === 'string' && typeof stored.hash === 'string') {
        const ref: ResourceRef = {kind:'SUITE_SOURCE',id:`stage-${context.idFactory()}`};
        context.transaction(() => { context.resources.register({ref,relativePath:stored.path,hash:stored.hash,mimeType:'application/octet-stream',owners:[]}); context.resources.scheduleCleanup(ref); });
      }
      return stored;
    };
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const flow = factory(scope)(input);
  let value: unknown;
  let failed = false;
  for (;;) {
    context.signal.throwIfAborted();
    const step = context.transaction(() => {
      let current = failed ? flow.throw(value) : flow.next(value);
      // queue/events/cancel are synchronous effects; keep their continuation in the same transaction.
      while (!current.done && !(current.value && typeof (current.value as PromiseLike<unknown>).then === 'function')) current = flow.next(current.value);
      for (const job of pending.values()) {
        const resources = registerJobResources(context, job);
        const snapshotContext = job.type === 'PLAN' || job.type === 'SUITE_FORGE' ? context : { ...context, catalog: new Proxy(context.catalog,{get(target,key){if(key === 'listSuites') return () => []; const value=Reflect.get(target,key);return typeof value === 'function' ? value.bind(target) : value;}}) };
        // 非规划任务只冻结其显式套图分镜，避免每个本地槽位复制完整目录。
        const snapshot: FrozenJobSnapshot = createExecutionSnapshot(snapshotContext, job, resources);
        context.scheduler.freeze(job.id, snapshot);
        queued.add(job.id);
      }
      pending.clear();
      if (current.done) {
        const result = current.value && typeof current.value === 'object' && !Array.isArray(current.value) ? { ...current.value as object } as Record<string, unknown> : current.value;
        if (result && typeof result === 'object' && operations[operation].output && JSON.stringify(operations[operation].output).includes('"reused"') && !Object.hasOwn(result, 'reused')) (result as Record<string, unknown>).reused = created.size === 0;
        const projected = projectPublic(operations[operation].output, result);
        check(operations[operation].output,projected,true); assertPublicOutput(projected);
        return { done: true, value: projected };
      }
      return { done: false, value: current.value };
    });
    for (const id of queued) context.scheduler.enqueue(id);
    queued.clear();
    if (step.done) {
      const topic = operation.includes('Draft') ? 'drafts' : operation.includes('Pattern') || operation.includes('PrintPack') ? 'patterns' : operation.includes('Model') ? 'models' : operation.includes('Suite') || operation.includes('Template') ? 'catalog' : operation.includes('Edit') ? 'editSessions' : 'projects';
      if (!/^(?:get|list|download)/.test(operation)) context.events.publish({ topic, ...(typeof (input as any)?.projectId === 'string' ? { projectId: (input as any).projectId } : {}) });
      return step.value;
    }
    try { value = await step.value; failed = false; } catch (error) { value = error; failed = true; }
  }
}
