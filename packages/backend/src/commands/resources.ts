import { createHash } from 'node:crypto';
import { resourceUrlFor, resourceRefFromUrl, type ResourceRef } from '@ecomgen/contracts';
import sharp from 'sharp';
const thumbnailFlights = new WeakMap<object,Map<string,Promise<void>>>();
import type { JobRecord, SqliteDatabase } from '@ecomgen/core';
import { Value } from '@sinclair/typebox/value';
import { ResourcePayloadSchema, type ResourcePayload } from '../runtime/resources.js';
import type { CommandContext, FrozenJobSnapshot } from '../runtime/ports.js';
import { BackendError } from '../validation.js';

type Entry = { ref: ResourceRef; relativePath: string; hash: string; mimeType: string; owner: string };
const mimeTypes = new Map([
  ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp'],
  ['avif', 'image/avif'], ['tif', 'image/tiff'], ['tiff', 'image/tiff'],
  ['psd', 'image/vnd.adobe.photoshop'], ['zip', 'application/zip'], ['json', 'application/json'],
]);
const mime = (path: string) => mimeTypes.get(path.toLowerCase().split('.').pop() ?? '') ?? 'application/octet-stream';
const key = (ref: ResourceRef) => JSON.stringify(ref);
function entry(ref: ResourceRef, path: string | null | undefined, hash: string | null | undefined, owner: string, mimeType?: string): Entry | undefined {
  return path && hash ? { ref, relativePath: path, hash, owner, mimeType: mimeType ?? mime(path) } : undefined;
}
function defined<T>(value: T | undefined): value is T { return value !== undefined; }

/** 收集领域真实文件引用，不扫描磁盘，也不按项目 ID 猜旧平铺路径。 */
export function projectResources(context: CommandContext, projectId: string): Entry[] {
  const r = context.repository;
  const result: Array<Entry | undefined> = [
    ...r.listAssets(projectId).map(a => entry({ kind: 'ASSET', id: a.id }, a.storagePath, a.hash, `project:${projectId}`, a.mimeType)),
    ...r.listOutputs(projectId).map(o => entry({ kind: 'OUTPUT', id: o.id }, o.storagePath, o.hash, `project:${projectId}`)),
  ];
  for (const job of r.listJobs(projectId)) {
    const layer = r.getLayerExportByJobId(job.id);
    if (layer?.layerFiles) for (const [index, file] of layer.layerFiles.entries()) result.push(entry({ kind: 'LAYER_FILE', id: layer.id, index }, file.storagePath, file.hash, `project:${projectId}`));
    if (job.input.editTurnId && typeof job.input.editTurnId === 'string') {
      const turn = r.getEditTurn(job.input.editTurnId);
      if (turn) {
        result.push(entry({ kind: 'EDIT_MASK', id: turn.id }, turn.editMaskPath, turn.editMaskHash, `project:${projectId}`, 'image/png'));
        result.push(entry({ kind: 'PROTECT_MASK', id: turn.id }, turn.protectMaskPath, turn.protectMaskHash, `project:${projectId}`, 'image/png'));
        for (const a of r.listEditReferenceAssets(turn.sessionId)) result.push(entry({ kind: 'EDIT_REFERENCE', id: a.id }, a.storagePath, a.hash, `project:${projectId}`, a.mimeType));
      }
    }
  }
  return result.filter(defined);
}
export function draftResources(context: CommandContext, draftId: string): Entry[] {
  const r = context.repository;
  return [
    ...r.listDraftMedia(draftId).map(a => entry({ kind: 'DRAFT_MEDIA', id: a.id }, a.storagePath, a.fileHash, `draft:${draftId}`, a.mimeType)),
    ...r.listDraftCandidates(draftId).map(a => entry({ kind: 'DRAFT_CANDIDATE', id: a.id }, a.storagePath, a.fileHash, `draft:${draftId}`, a.mimeType)),
  ].filter(defined);
}
export function modelResources(context: CommandContext, modelId: string): Entry[] {
  const r = context.repository, model = r.getModel(modelId);
  return [entry({ kind: 'MODEL_FACE', id: `${modelId}-${model?.referenceFaceHash}` }, model?.referenceFacePath, model?.referenceFaceHash, `model:${modelId}`), ...r.listModelPortraits(modelId).map(a => entry({ kind: 'PORTRAIT', id: a.id }, a.storagePath, a.hash, `model:${modelId}`))].filter(defined);
}
export function patternResources(context: CommandContext, patternId: string): Entry[] {
  const r = context.repository, pattern = r.getPattern(patternId);
  const result = [entry({ kind: 'PATTERN', id: patternId }, pattern?.storagePath, pattern?.fileHash, `pattern:${patternId}`, 'image/png')];
  for (const pack of r.listPrintPacks(patternId)) for (const [index, file] of (pack.files ?? []).entries()) result.push(entry({ kind: 'PRINT_PACK_FILE', id: pack.id, index }, file.storagePath, file.hash, `pattern:${patternId}`));
  return result.filter(defined);
}
export function registerEntries(context: CommandContext, entries: Entry[]): void {
  for (const e of entries) context.resources.register({ ref: e.ref, relativePath: e.relativePath, hash: e.hash, mimeType: e.mimeType, owners: [e.owner] });
}
export function retireEntries(context: CommandContext, entries: Entry[]): void {
  registerEntries(context, entries);
  for (const e of entries) {
    context.resources.release(e.ref, e.owner);
    try { context.resources.scheduleCleanup(e.ref); } catch (error) {
      // 历史和运行意图仍有引用时保留源文件；不以物理删除绕过引用屏障。
      if (!(error instanceof BackendError) || error.code !== 'RESOURCE_IN_USE') throw error;
    }
  }
}
/** 永久删除聚合时释放确切属于该聚合的 owner，跨聚合引用和共享缩略图继续保留。 */
export function retireOwners(context: CommandContext, owners: ReadonlySet<string>): void {
  const db = (context.repository as unknown as {db:SqliteDatabase}).db;
  for (const row of db.prepare('SELECT payload FROM desktop_resources').all() as {payload:string}[]) {
    let record: unknown; try { record=JSON.parse(row.payload); } catch { throw new BackendError('INVALID_RUNTIME','资源登记数据无效。'); }
    if (!Value.Check(ResourcePayloadSchema,record)) throw new BackendError('INVALID_RUNTIME','资源登记数据无效。');
    const resource=record as ResourcePayload;
    const release=resource.owners.filter(owner=>owners.has(owner)); if (!release.length) continue;
    for (const owner of release) context.resources.release(resource.ref,owner);
    try { context.resources.scheduleCleanup(resource.ref); } catch(error) { if (!(error instanceof BackendError) || error.code!=='RESOURCE_IN_USE') throw error; }
  }
}

/** 不确定结果仍保留输入资源，并且成功槽位不可经补偿更换源图。 */
export function registerJobResources(context: CommandContext, job: JobRecord): FrozenJobSnapshot['resources'] {
  const r = context.repository, i = job.input;
  const entries: Entry[] = job.projectId ? projectResources(context, job.projectId) : [];
  if (typeof i.draftId === 'string') entries.push(...draftResources(context, i.draftId));
  if (job.type === 'MODEL_CAST' && typeof i.modelId === 'string') entries.push(...modelResources(context, i.modelId));
  if (typeof i.patternId === 'string') entries.push(...patternResources(context, i.patternId));
  if (typeof i.sourcePath === 'string' && typeof i.sourceHash === 'string') entries.push({ ref: { kind: 'SUITE_SOURCE', id: `${job.id}-source` }, relativePath: i.sourcePath, hash: i.sourceHash, mimeType: mime(i.sourcePath), owner: `job:${job.id}` });
  if (Array.isArray(i.sources)) for (const [index, source] of i.sources.entries()) {
    const s = source as Record<string, unknown>;
    if (typeof s.storagePath === 'string' && typeof s.hash === 'string') entries.push({ ref: { kind: 'SUITE_SOURCE', id: `${job.id}-${index}` }, relativePath: s.storagePath, hash: s.hash, mimeType: String(s.mimeType ?? mime(s.storagePath)), owner: `job:${job.id}` });
  }
  registerEntries(context, entries);
  return [...new Map(entries.map(e => [key(e.ref), { ref: e.ref, hash: e.hash }])).values()];
}

/** 文件命令只返回受限身份；actual bytes/hash 在后台验证并登记。 */
export async function resourceHandle(context: CommandContext, ref: ResourceRef, verify = true) {
  const r = context.repository;
  let path: string | null | undefined, hash: string | null | undefined, mimeType: string | undefined, owner = `${ref.kind}:${ref.id}`;
  switch (ref.kind) {
    case 'ASSET': { const a = r.getAsset(ref.id); path = a?.storagePath; hash = a?.hash; mimeType = a?.mimeType; if (a) owner = `project:${a.projectId}`; break; }
    case 'OUTPUT': { const a = r.getOutput(ref.id); path = a?.storagePath; hash = a?.hash; if (a) owner = `project:${a.projectId}`; break; }
    case 'PATTERN': { const a = r.getPattern(ref.id); path = a?.storagePath; hash = a?.fileHash; owner = `pattern:${ref.id}`; break; }
    case 'MODEL_FACE': { const modelId = ref.id.slice(0,36), a = r.getModel(modelId); if (a?.referenceFaceHash && (ref.id === modelId || ref.id === `${modelId}-${a.referenceFaceHash}`)) { path = a.referenceFacePath; hash = a.referenceFaceHash; ref = {kind:'MODEL_FACE',id:`${modelId}-${hash}`}; owner = `model:${modelId}`; } break; }
    case 'PORTRAIT': { const a = r.getModelPortrait(ref.id); path = a?.storagePath; hash = a?.hash; if (a) owner = `model:${a.modelId}`; break; }
    case 'EDIT_REFERENCE': { const a = r.getEditReferenceAsset(ref.id); path = a?.storagePath; hash = a?.hash; mimeType = a?.mimeType; if (a) owner = `project:${a.projectId}`; break; }
    case 'EDIT_MASK': case 'PROTECT_MASK': { const a = r.getEditTurn(ref.id); path = ref.kind === 'EDIT_MASK' ? a?.editMaskPath : a?.protectMaskPath; hash = ref.kind === 'EDIT_MASK' ? a?.editMaskHash : a?.protectMaskHash; if (a) owner = `project:${a.projectId}`; break; }
    case 'DRAFT_MEDIA': { const a = r.getDraftMedia(ref.id); path = a?.storagePath; hash = a?.fileHash; mimeType = a?.mimeType; if (a) owner = `draft:${a.draftId}`; break; }
    case 'DRAFT_CANDIDATE': { const a = r.getDraftCandidate(ref.id); path = a?.storagePath; hash = a?.fileHash; mimeType = a?.mimeType; if (a) owner = `draft:${a.draftId}`; break; }
    case 'EXPORT': { const a = r.getExport(ref.id); if (a?.status === 'SUCCEEDED') path = a.storagePath; if (a) owner = `project:${a.projectId}`; break; }
    case 'LAYER_PSD': case 'LAYER_FILE': { const a = r.getLayerExport(ref.id); if (a?.status === 'SUCCEEDED') { const file = ref.kind === 'LAYER_FILE' ? a.layerFiles?.[ref.index] : undefined; path = ref.kind === 'LAYER_PSD' ? a.psdStoragePath : file?.storagePath; hash = file?.hash; owner = `project:${a.projectId}`; } break; }
    case 'PRINT_PACK_FILE': { const a = r.getPrintPack(ref.id); const file = a?.status === 'SUCCEEDED' ? a.files?.[ref.index] : undefined; path = file?.storagePath; hash = file?.hash; mimeType = file ? mime(file.storagePath) : undefined; if (a) owner = `pattern:${a.patternId}`; break; }
    case 'THUMBNAIL': {
      if (!/^[a-f0-9]{64}$/.test(ref.id)) throw new BackendError('VALIDATION_ERROR', '缩略图身份无效。');
      path = context.storage.thumbnailPath(ref.id); mimeType = 'image/webp'; owner = `thumbnail:${ref.id}`;
      if (!(await context.storage.exists(path))) {
        let flights = thumbnailFlights.get(context.storage); if (!flights) { flights = new Map(); thumbnailFlights.set(context.storage,flights); }
        const id = ref.id;
        if (!flights.has(id)) flights.set(id,(async () => {
          const source = r.findImageSourcePath(id); if (!source) throw new BackendError('NOT_FOUND','缩略图源文件不存在。');
          const bytes = await context.storage.read(source,{signal:context.signal,maxBytes:64*1024*1024});
          if (createHash('sha256').update(bytes).digest('hex') !== id) throw new BackendError('RESOURCE_CHANGED','缩略图源文件已变更。');
          const thumbnail = await sharp(bytes,{limitInputPixels:100_000_000}).rotate().resize({width:512,height:512,fit:'inside',withoutEnlargement:true}).webp({quality:78}).toBuffer();
          await context.storage.putThumbnail(id,thumbnail);
        })().finally(() => flights!.delete(id)));
        await flights.get(id);
      }
      break;
    }
    case 'SUITE_SOURCE': { const resolved = await context.resources.resolve(ref); return { ref, mimeType: resolved.mimeType }; }
  }
  if (!path || !(await context.storage.exists(path))) throw new BackendError('NOT_FOUND', '文件不存在或尚未生成。');
  if (!hash) { const digest = createHash('sha256'); for await (const chunk of context.storage.stream(path, { signal: context.signal })) digest.update(chunk); hash = digest.digest('hex'); }
  context.transaction(() => context.resources.register({ ref, relativePath: path!, hash: hash!, mimeType: mimeType ?? mime(path!), owners: [owner] }));
  if (verify) await context.resources.resolve(ref);
  return { ref, mimeType: mimeType ?? mime(path) };
}

/** 查询发布前准备协议引用，覆盖历史文件与按 hash 惰性生成的缩略图。 */
export async function preparePublicResources(context: CommandContext, result: unknown): Promise<void> {
  const urls = new Set<string>();
  const collect = (value: unknown) => { if (typeof value === 'string' && value.startsWith('ecomgen-resource://')) urls.add(value); else if (Array.isArray(value)) value.forEach(collect); else if (value && typeof value === 'object') Object.values(value).forEach(collect); };
  collect(result);
  for (const url of urls) {
    try { await resourceHandle(context,resourceRefFromUrl(url),false); } catch (error) {
      // 仍返回领域行，使缺文件的历史记录可见；协议读取会给出明确 NOT_FOUND。
      if (!(error instanceof BackendError) || error.code !== 'NOT_FOUND') throw error;
    }
  }
}
