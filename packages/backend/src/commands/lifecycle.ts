import { requestFingerprint, type JobRecord } from '@ecomgen/core';
import type { Input } from '@ecomgen/contracts';
import { EXECUTOR_TYPES } from '../runtime/ports.js';
import { ApiError, readImage, type CommandFlow, type CommandScope } from './support.js';
import { assertProjectAssetCapacity, assertProjectAssetHashUnique, ensureModel, ensureProject, missing, parseAssetRole, UUID_PATTERN, writeThumbnail } from './helpers.js';
import { modelResources, patternResources, projectResources, registerEntries, retireEntries, retireOwners } from './resources.js';
import { publicModel } from './models.js';
import { suiteForgeHints, verifyVisionModel } from './suiteForge.js';
import { publicReferenceAsset } from './editSessions.js';

/** 删除聚合前等待本 owner 的执行退出；UNKNOWN 证据不会被通用删除解除。 */
async function quiesce(ctx: CommandScope, jobs: JobRecord[]): Promise<void> {
  for (const job of jobs) if (job.status === 'QUEUED' || job.status === 'RUNNING') ctx.scheduler.cancel(job.id);
  await ctx.scheduler.waitForIdle(jobs.map(job => job.id));
  if (jobs.some(job => ctx.requestLedger.hasUnknown(job.id) || ctx.repository.getJob(job.id)?.status === 'UNKNOWN')) throw new ApiError('EXTERNAL_UNKNOWN', '聚合包含中断的任务，请先重试或结束该任务。');
}
export function lifecycleCommands(ctx: CommandScope) {
  const { repository: r, storage } = ctx;
  return {
    uploadAsset: function* (input: Input<'uploadAsset'>): CommandFlow<unknown> {
      ensureProject(r, input.projectId);
      const role = parseAssetRole(input.kind ?? input.role ?? 'REFERENCE');
      const image = yield readImage(input.file, ctx);
      assertProjectAssetCapacity(r, input.projectId, role); assertProjectAssetHashUnique(r, input.projectId, image.hash);
      const stored = yield storage.putAsset(input.projectId, image.filename, image.buffer, { signal: ctx.signal });
      const dimensions = yield storage.inspectImage(image.buffer, ctx.signal);
      yield writeThumbnail(storage, image.hash, image.buffer);
      ensureProject(r, input.projectId);
      assertProjectAssetCapacity(r, input.projectId, role); assertProjectAssetHashUnique(r, input.projectId, image.hash);
      const asset = r.createAsset({ projectId: input.projectId, role, storagePath: stored.path, hash: stored.hash, originalName: image.filename, mimeType: image.mimetype, byteSize: image.buffer.length, width: dimensions.width, height: dimensions.height });
      registerEntries(ctx, projectResources(ctx, input.projectId).filter(e => e.ref.kind === 'ASSET' && e.ref.id === asset.id));
      return asset;
    },
    deleteAsset: function* (input: Input<'deleteAsset'>): CommandFlow<unknown> {
      const asset = r.getAsset(input.assetId); if (!asset) missing('asset', input.assetId);
      retireEntries(ctx, projectResources(ctx, asset.projectId).filter(e => e.ref.kind === 'ASSET' && e.ref.id === asset.id));
      r.deleteAsset(asset.id); return null;
    },
    deleteProject: function* (input: Input<'deleteProject'>): CommandFlow<unknown> {
      if (!UUID_PATTERN.test(input.projectId)) throw new ApiError('VALIDATION_ERROR', '项目身份无效。');
      let project = r.getProject(input.projectId); if (!project) return null;
      if (!project.archivedAt) throw new ApiError('CONFLICT', '只能永久删除已归档项目。');
      yield quiesce(ctx, r.listJobs(project.id));
      project = r.getProject(input.projectId); if (!project) return null;
      if (!project.archivedAt) throw new ApiError('CONFLICT', '项目已被恢复。');
      const jobs = r.listJobs(project.id);
      if (jobs.some(j => j.status === 'QUEUED' || j.status === 'RUNNING' || j.status === 'UNKNOWN')) throw new ApiError('CONFLICT', '项目仍有未结束任务，请稍后重试。');
      retireEntries(ctx, projectResources(ctx, project.id));
      const owners = new Set([`project:${project.id}`,...jobs.map(j=>`job:${j.id}`),...r.listOutputs(project.id).map(o=>`output:${o.id}`)]);
      for (const job of jobs) { const layer=r.getLayerExportByJobId(job.id), exported=r.getExportByJobId(job.id); if(layer) owners.add(`layer:${layer.id}`); if(exported) owners.add(`export:${exported.id}`); }
      retireOwners(ctx,owners);
      r.deleteArchivedProject(project.id); return null;
    },
    deleteProvider: function* (input: Input<'deleteProvider'>): CommandFlow<unknown> {
      if (!r.getProvider(input.providerId)) missing('provider', input.providerId);
      for (;;) {
        const active = EXECUTOR_TYPES.flatMap(type=>r.listJobsByType(type,2_147_483_647)).filter(j=>j.providerId===input.providerId && (j.status==='QUEUED'||j.status==='RUNNING'));
        if (!active.length) break;
        for (const job of active) ctx.scheduler.cancel(job.id);
        yield ctx.scheduler.waitForIdle(active.map(j=>j.id));
      }
      r.deleteProvider(input.providerId);
      ctx.events.publish({ topic: 'providers' }); ctx.events.publish({ topic: 'projects' }); ctx.events.publish({ topic: 'storyboards' }); return null;
    },
    uploadModelReferenceFace: function* (input: Input<'uploadModelReferenceFace'>): CommandFlow<unknown> {
      ensureModel(r, input.modelId);
      const image = yield readImage(input.file, ctx);
      const stored = yield storage.putModelReferenceFace(input.modelId, image.filename, image.buffer, { signal: ctx.signal });
      const model = ensureModel(r, input.modelId);
      // MODEL_FACE 是当前身份指针；旧版本由 hash 派生引用保留给历史任务。
      const old = modelResources(ctx, model.id).filter(e => e.ref.kind === 'MODEL_FACE');
      if (old.length && old[0]!.hash !== stored.hash) retireEntries(ctx, old);
      const record = r.setModelReferenceFace(model.id, stored.path, stored.hash)!;
      registerEntries(ctx, modelResources(ctx, model.id));
      return publicModel(record, r.listModelPortraits(model.id));
    },
    deleteModelReferenceFace: function* (input: Input<'deleteModelReferenceFace'>): CommandFlow<unknown> {
      const model = ensureModel(r, input.modelId);
      retireEntries(ctx, modelResources(ctx, model.id).filter(e => e.ref.kind === 'MODEL_FACE'));
      r.setModelReferenceFace(model.id, null, null); return null;
    },
    deleteModel: function* (input: Input<'deleteModel'>): CommandFlow<unknown> {
      ensureModel(r, input.modelId);
      yield quiesce(ctx, r.listJobsByType('MODEL_CAST', 2_147_483_647).filter(j => j.input.modelId === input.modelId));
      if (r.listJobsByType('MODEL_CAST',2_147_483_647).some(j=>j.input.modelId===input.modelId && (j.status==='QUEUED'||j.status==='RUNNING'||j.status==='UNKNOWN'))) throw new ApiError('CONFLICT','模特又有活动或未知任务，请稍后重试删除。');
      retireEntries(ctx, modelResources(ctx, input.modelId)); r.deleteModel(input.modelId); return null;
    },
    deleteModelPortrait: function* (input: Input<'deleteModelPortrait'>): CommandFlow<unknown> {
      const portrait = r.getModelPortrait(input.portraitId); if (!portrait) missing('portrait', input.portraitId);
      retireEntries(ctx, modelResources(ctx, portrait.modelId).filter(e => e.ref.id === portrait.id)); r.deleteModelPortrait(portrait.id); return null;
    },
    deletePattern: function* (input: Input<'deletePattern'>): CommandFlow<unknown> {
      const pattern = r.getPattern(input.patternId); if (!pattern) missing('pattern', input.patternId);
      const types = ['PATTERN_EXTRACT','PATTERN_FORGE','PATTERN_DERIVE','PATTERN_VARIANT','PATTERN_TILE_CHECK','PRINT_PACK','COPYWRITE'] as const;
      yield quiesce(ctx, types.flatMap(type => r.listJobsByType(type, 2_147_483_647).filter(j => j.input.patternId === pattern.id)));
      if (types.flatMap(type=>r.listJobsByType(type,2_147_483_647)).some(j=>j.input.patternId===pattern.id && (j.status==='QUEUED'||j.status==='RUNNING'||j.status==='UNKNOWN'))) throw new ApiError('CONFLICT','花型又有活动或未知任务，请稍后重试删除。');
      retireEntries(ctx, patternResources(ctx, pattern.id)); r.deletePattern(pattern.id); return null;
    },
    uploadEditReferenceAsset: function* (input: Input<'uploadEditReferenceAsset'>): CommandFlow<unknown> {
      const session = r.getEditSession(input.sessionId); if (!session) missing('session', input.sessionId);
      const image = yield readImage(input.file, ctx);
      assertProjectAssetHashUnique(r, session.projectId, image.hash);
      if (r.listEditReferenceAssets(session.id).some(a => !a.turnId && a.expiresAt > ctx.clock() && a.hash === image.hash)) throw new ApiError('VALIDATION_ERROR', '相同图片已作为临时参考上传。');
      const stored = yield storage.putEditReferenceAsset(session.projectId, session.id, image.filename, image.buffer, { signal: ctx.signal });
      if (!r.getEditSession(session.id)) missing('session', session.id);
      assertProjectAssetHashUnique(r,session.projectId,image.hash);
      if (r.listEditReferenceAssets(session.id).some(a=>!a.turnId && a.expiresAt>ctx.clock() && a.hash===image.hash)) throw new ApiError('VALIDATION_ERROR','相同图片已作为临时参考上传。');
      const record = r.createEditReferenceAsset({ id: ctx.idFactory(), projectId: session.projectId, sessionId: session.id, turnId: null, storagePath: stored.path, hash: stored.hash, originalName: image.filename, mimeType: image.mimetype, purpose: input.purpose, expiresAt: new Date(Date.parse(ctx.clock()) + 7 * 86400000).toISOString() });
      ctx.resources.register({ ref: { kind: 'EDIT_REFERENCE', id: record.id }, relativePath: stored.path, hash: stored.hash, mimeType: image.mimetype, owners: [`project:${session.projectId}`] });
      return publicReferenceAsset(record);
    },
    deleteEditReferenceAsset: function* (input: Input<'deleteEditReferenceAsset'>): CommandFlow<unknown> {
      const a = r.getEditReferenceAsset(input.referenceAssetId); if (!a || a.sessionId !== input.sessionId) missing('reference', input.referenceAssetId);
      if (a.turnId) throw new ApiError('CONFLICT', '参考图已被编辑回合使用。');
      retireEntries(ctx, [{ ref: { kind: 'EDIT_REFERENCE', id: a.id }, relativePath: a.storagePath, hash: a.hash, mimeType: a.mimeType, owner: `project:${a.projectId}` }]);
      r.deleteEditReferenceAsset(a.id); return null;
    },
    promoteEditReferenceAsset: function* (input: Input<'promoteEditReferenceAsset'>): CommandFlow<unknown> {
      const a = r.getEditReferenceAsset(input.referenceAssetId); if (!a || a.sessionId !== input.sessionId) missing('reference', input.referenceAssetId);
      const role = a.purpose === 'PRODUCT_APPEARANCE' ? 'PRODUCT_TRUTH' : a.purpose === 'PACKAGING' || a.purpose === 'LABEL' ? 'PACKAGING' : a.purpose === 'STYLE' ? 'STYLE_REFERENCE' : 'LAYOUT_REFERENCE';
      assertProjectAssetCapacity(r, a.projectId, role); assertProjectAssetHashUnique(r, a.projectId, a.hash);
      const bytes = yield storage.read(a.storagePath, { signal: ctx.signal });
      const stored = yield storage.putAsset(a.projectId, a.originalName, bytes, { signal: ctx.signal });
      const current = r.getEditReferenceAsset(a.id); if (!current) missing('reference', a.id);
      assertProjectAssetCapacity(r, a.projectId, role); assertProjectAssetHashUnique(r, a.projectId, a.hash);
      const asset = r.createAsset({ projectId: a.projectId, role, storagePath: stored.path, hash: stored.hash, originalName: a.originalName, mimeType: a.mimeType, width: null, height: null });
      // 已用于回合的临时参考仍作为历史输入保留。
      if (!current.turnId) { retireEntries(ctx, [{ ref: { kind: 'EDIT_REFERENCE', id: a.id }, relativePath: a.storagePath, hash: a.hash, mimeType: a.mimeType, owner: `project:${a.projectId}` }]); r.deleteEditReferenceAsset(a.id); }
      return publicReferenceAsset(asset);
    },
    createSuiteForgeJob: function* (input: Input<'createSuiteForgeJob'>): CommandFlow<unknown> {
      verifyVisionModel(r, input.providerId, input.modelId);
      const images = yield Promise.all(input.files.map(file => readImage(file, ctx)));
      const fields = Object.fromEntries(Object.entries(input).filter(([k,v]) => k !== 'files' && v !== undefined).map(([k,v]) => [k,String(v)]));
      const hints = suiteForgeHints(fields);
      const fingerprint = requestFingerprint({ type: 'SUITE_FORGE', providerId: input.providerId, modelId: input.modelId, sourceHashes: images.map((i: {hash:string}) => i.hash), hints, idempotencyKey: input.idempotencyKey ?? null });
      const duplicate = r.findJobByFingerprint(null, fingerprint); if (duplicate) return duplicate;
      const id = ctx.idFactory(), sources = [];
      for (const image of images) {
        const stored = yield storage.putSuiteForgeSource(id, image.filename, image.buffer, { signal: ctx.signal });
        const dimensions = yield storage.inspectImage(image.buffer, ctx.signal);
        sources.push({ storagePath: stored.path, hash: stored.hash, originalName: image.filename, mimeType: image.mimetype, width: dimensions.width, height: dimensions.height });
      }
      const existing = r.findJobByFingerprint(null, fingerprint); if (existing) return existing;
      const job = r.createJob({ id, projectId: null, storyboardItemId: null, type: 'SUITE_FORGE', input: { providerId: input.providerId, modelId: input.modelId, sources, hints }, requestFingerprint: fingerprint, providerId: input.providerId, modelId: input.modelId });
      ctx.queue(job); return job;
    },
  };
}
