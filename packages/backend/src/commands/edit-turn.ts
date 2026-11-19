import type { Input } from '@ecomgen/contracts';
import { MAX_GENERATION_REFERENCE_IMAGES } from '@ecomgen/contracts';
import { requestFingerprint } from '@ecomgen/core';
import { ApiError, readImage, type CommandFlow, type CommandScope } from './support.js';
import { editGenerationConfigFor, parseReferenceSelections, validateMaskDimensions } from './editSessions.js';
import { missing, verifyModel } from './helpers.js';
import { readJsonObject } from './input-normalizers.js';
import { assertProjectImageWorkAllowed } from '../execution/image-work-barrier.js';
import { outputImagePlanning } from '../execution/snapshot.js';

export function editTurnCommands(ctx: CommandScope) {
  const { repository: r, storage } = ctx;
  return {
    createEditTurn: function* (input: Input<'createEditTurn'>): CommandFlow<unknown> {
      const session = r.getEditSession(input.sessionId); if (!session) missing('edit session', input.sessionId);
      if (session.status !== 'ACTIVE') throw new ApiError('CONFLICT', '编辑会话已归档。');
      const baseOutputId = input.baseOutputId ?? session.currentOutputId;
      const baseOutput = r.getOutput(baseOutputId);
      if (!baseOutput || baseOutput.projectId !== session.projectId || !r.isOutputInEditSession(session.id, baseOutputId)) throw new ApiError('VALIDATION_ERROR', '基图不属于此编辑分支。');
      const message = input.message.trim(); if (!message) throw new ApiError('VALIDATION_ERROR', '需要填写改图说明。');
      const annotations = readJsonObject(input.annotations, 'annotations');
      const references = parseReferenceSelections(input.referenceSelections);
      const assets = r.listAssets(session.projectId), temporary = r.listEditReferenceAssets(session.id).filter(a => a.expiresAt > ctx.clock() && !a.turnId);
      if (references.some(selection => selection.source === 'PROJECT' ? !assets.some(a => a.id === selection.id) : !temporary.some(a => a.id === selection.id))) throw new ApiError('VALIDATION_ERROR', '参考图不存在、已过期或不属于此会话。');
      if (references.filter(selection => selection.source === 'TEMPORARY' || assets.find(a => a.id === selection.id)?.role !== 'PRODUCT_TRUTH').length > MAX_GENERATION_REFERENCE_IMAGES) throw new ApiError('VALIDATION_ERROR', `最多选择 ${MAX_GENERATION_REFERENCE_IMAGES} 张非商品参考图。`);
      const project = r.getProject(session.projectId); if (!project) missing('project', session.projectId);
      const config = editGenerationConfigFor(r, project, annotations);
      verifyModel(r, config.reasoningProviderId, config.reasoningModelId, 'reasoning'); verifyModel(r, config.imageProviderId, config.imageModelId, 'image');
      const edit = input.editMask ? yield readImage(input.editMask, ctx) : undefined;
      const protect = input.protectMask ? yield readImage(input.protectMask, ctx) : undefined;
      if ((edit && edit.mimetype !== 'image/png') || (protect && protect.mimetype !== 'image/png')) throw new ApiError('VALIDATION_ERROR', '蒙版必须是 PNG。');
      if (edit) yield validateMaskDimensions(baseOutput.storagePath, edit.buffer, storage);
      if (protect) yield validateMaskDimensions(baseOutput.storagePath, protect.buffer, storage);
      const fingerprint = requestFingerprint({ type: 'EDIT_PLAN', projectId: session.projectId, sessionId: session.id, baseOutputId, message, annotations, editMaskHash: edit?.hash ?? null, protectMaskHash: protect?.hash ?? null, referenceSelections: references });
      const existing = r.findJobByFingerprint(session.projectId, fingerprint);
      if (existing) { const turn = r.getEditTurn(String(existing.input.editTurnId)); return { turnId: existing.input.editTurnId, planJobId: existing.id, status: turn?.status ?? 'PLANNING', reused: true }; }
      assertProjectImageWorkAllowed(r, ctx.requestLedger, session.projectId, { imagePlanning: Boolean(outputImagePlanning(baseOutput.generationSnapshot)) });
      const id = ctx.idFactory();
      const editStored = edit ? yield storage.putEditArtifact(session.projectId, session.id, id, 'edit-mask.png', edit.buffer, { signal: ctx.signal }) : undefined;
      const protectStored = protect ? yield storage.putEditArtifact(session.projectId, session.id, id, 'protect-mask.png', protect.buffer, { signal: ctx.signal }) : undefined;
      const current = r.getEditSession(session.id);
      if (!current || current.status !== 'ACTIVE' || !r.getOutput(baseOutputId)) throw new ApiError('CONFLICT', '编辑来源已变更，请刷新。');
      // 文件 I/O 之后重新检查所有可变归属，避免迟到上传发布到已删除的聚合。
      if (references.some(selection => selection.source === 'PROJECT' ? r.getAsset(selection.id)?.projectId !== session.projectId : r.getEditReferenceAsset(selection.id)?.sessionId !== session.id || Boolean(r.getEditReferenceAsset(selection.id)?.turnId))) throw new ApiError('CONFLICT', '参考素材已发生变化。');
      const duplicate = r.findJobByFingerprint(session.projectId, fingerprint);
      if (duplicate) { const turn = r.getEditTurn(String(duplicate.input.editTurnId)); return { turnId: duplicate.input.editTurnId, planJobId: duplicate.id, status: turn?.status ?? 'PLANNING', reused: true }; }
      assertProjectImageWorkAllowed(r, ctx.requestLedger, session.projectId, { imagePlanning: Boolean(outputImagePlanning(baseOutput.generationSnapshot)) });
      const turn = r.createEditTurn({ id, sessionId: session.id, projectId: session.projectId, baseOutputId, status: 'PLANNING', message, annotations: { ...annotations, generationConfig: config }, editMaskPath: editStored?.path ?? null, editMaskHash: editStored?.hash ?? null, protectMaskPath: protectStored?.path ?? null, protectMaskHash: protectStored?.hash ?? null, referenceAssetIds: references.filter(a => a.source === 'PROJECT').map(a => a.id), referenceSelections: references, plan: null, error: null });
      r.attachEditReferenceAssets(session.id, id, references.filter(a => a.source === 'TEMPORARY').map(a => a.id));
      const job = r.createJob({ id: ctx.idFactory(), projectId: session.projectId, storyboardItemId: null, type: 'EDIT_PLAN', input: { editTurnId: turn.id }, providerId: config.reasoningProviderId, modelId: config.reasoningModelId, requestFingerprint: fingerprint });
      ctx.queue(job);
      return { turnId: turn.id, planJobId: job.id, status: turn.status };
    },
  };
}
