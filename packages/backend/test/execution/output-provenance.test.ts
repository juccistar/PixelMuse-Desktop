import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import type { OutputRecord } from '@ecomgen/core';
import { RuntimeStore } from '../../src/runtime/state.js';
import { outputProvenance } from '../../src/execution/snapshot.js';
import { candidateIdFor } from '../../src/execution/context.js';
import { regressionFixtures, file, waitJob, unzip, FAKE_KEY } from '../desktop-regression-helpers.js';
import { editPlanReply, type MockRequestContext } from '../../../../scripts/full-mock-provider.mjs';

const fixtures = regressionFixtures();
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const ORIGINAL = 'ORIGINAL RED CERAMIC CUP PROMPT';
const REVISED = 'REVISED BLUE CERAMIC CUP PROMPT';
type ObservedRequest = { prompt: string; fields: Record<string, unknown>; attachments: Array<{ filename: string; mimeType: string; sha256: string }> };
function observe(request: MockRequestContext): ObservedRequest {
  return {
    // FormData 按协议把字段内换行编码为 CRLF；比较提示词文本时还原换行。
    prompt: String(request.fields.prompt ?? request.json?.prompt).replace(/\r\n/g, '\n'), fields: request.json ?? request.fields,
    attachments: Object.values(request.files).flat().map(image => ({ filename: image.filename, mimeType: image.mimeType, sha256: sha256(image.data) })),
  };
}
async function setup(options: { noReferences?: boolean } = {}) {
  const requests: ObservedRequest[] = [];
  const f = await fixtures.fixture({ mock: {
    replies: { revision: { prompt: REVISED }, 'edit-plan': editPlanReply('confirmation', { prompt: 'EDIT ONLY THE SELECTED BACKGROUND', executionMode: 'MASKED', operation: 'PRECISE_INPAINT', compositePolicy: 'MASK_LOCKED' }) },
    imageForRequest: (request, images) => { requests.push(observe(request)); return images.image; },
  } });
  const truth = await f.backend.invoke('uploadAsset', { projectId: f.project.id, role: 'PRODUCT_TRUTH', file: file(f.bytes, 'truth.png') });
  const referenceBytes = await sharp({ create: { width: 32, height: 24, channels: 4, background: '#2233bb' } }).png().toBuffer();
  const reference = await f.backend.invoke('uploadAsset', { projectId: f.project.id, role: 'STYLE_REFERENCE', file: file(referenceBytes, 'style.png') });
  // 初始分镜是合成夹具；所有生成、重试、编辑与导出均走真实具名命令和持久调度器。
  f.context.repository.saveStoryboard(f.project.id, 'Synthetic studio', 'CONFIRMED', [{
    assetType: 'hero-image', displayName: 'Original label', shotRole: 'HERO', templateVariant: null,
    candidateCount: 1, referencedAssets: options.noReferences ? [] : [reference.id, truth.id], mode: 'CREATIVE', status: 'CONFIRMED',
    promptInstruction: ORIGINAL, compiledPrompt: null, factClaims: [], riskFlags: [], sortOrder: 0,
    imageResolution: '1K', imageAspectRatio: '1:1',
  }]);
  const item = f.context.repository.listStoryboardItems(f.project.id)[0]!;
  const submit = (revision?: string) => f.backend.invoke('createGenerationJobs', {
    projectId: f.project.id, storyboardItemIds: [item.id], ...(revision ? { revision } : {}),
  });
  const outputFor = (jobId: string) => f.context.repository.listOutputs(f.project.id).find(output => output.jobId === jobId)!;
  const generate = async (revision?: string) => { const result = await submit(revision); await waitJob(f.backend, result.jobs[0]!.id); return outputFor(result.jobs[0]!.id); };
  const manifest = async (outputs: OutputRecord[], afterSubmit?: () => void) => {
    const queued = await f.backend.invoke('createExportJob', { projectId: f.project.id, outputIds: outputs.map(output => output.id) });
    afterSubmit?.();
    await waitJob(f.backend, queued.job.id);
    const stored = f.context.repository.getExportByJobId(queued.job.id)!;
    const files = unzip(await f.context.storage.read(stored.storagePath!));
    const result = JSON.parse(files.get('manifest.json')!.toString('utf8'));
    expect(result.storyboard).toHaveLength(outputs.length);
    for (const output of outputs) expect(result.storyboard.find((entry: any) => entry.outputId === output.id)?.sha256).toBe(output.hash);
    return result as { storyboard: Array<Record<string, any>> };
  };
  return { ...f, item, truth, reference, referenceBytes, requests, submit, generate, outputFor, manifest };
}

function expectRequestEvidence(output: OutputRecord, request: ObservedRequest) {
  const evidence = outputProvenance(output.generationSnapshot);
  expect(evidence).not.toBeNull();
  expect(evidence!.finalPrompt).toBe(request.prompt);
  expect(evidence!.attachments.map(({ filename, mimeType, sha256 }) => ({ filename, mimeType, sha256 }))).toEqual(request.attachments);
}

describe('每产物不可变生成证据与实际 ZIP 导出', () => {
  it('原始/改稿生成各保留真实提示词、附件顺序和参数；提交后与导出前后的修改不改写证据', async () => {
    const f = await setup();
    const first = await f.submit();
    // invoke 返回后、调度器认领前，直接修改 owner 行模拟另一个业务操作。
    f.context.repository.updateStoryboardItem(f.item.id, { promptInstruction: 'CHANGED AFTER SUBMISSION', referencedAssets: [], displayName: 'Later label', imageResolution: '4K' });
    await f.backend.invoke('updateAsset', { assetId: f.reference.id, role: 'PACKAGING' });
    f.context.repository.saveProvider({ ...f.context.repository.getProvider(f.provider.id)!, baseUrl: 'http://127.0.0.1:1/v1', encryptedApiKey: f.context.secrets.encrypt('changed-after-submission') });
    await waitJob(f.backend, first.jobs[0]!.id);
    const original = f.outputFor(first.jobs[0]!.id);
    expect(f.requests).toHaveLength(1);
    expectRequestEvidence(original, f.requests[0]!);
    expect(f.requests[0]!.prompt).toContain(ORIGINAL);
    expect(outputProvenance(original.generationSnapshot)!.attachments.map(image => [image.id, image.role, image.handle])).toEqual([
      [f.truth.id, 'PRODUCT_TRUTH', 'P1'], [f.reference.id, 'STYLE_REFERENCE', 'R1'],
    ]);
    expect(original.generationSnapshot?.resolution).toBe('1K');
    expect(outputProvenance(original.generationSnapshot)!.storyboard?.displayName).toBe('Original label');

    f.context.repository.saveProvider({ ...f.context.repository.getProvider(f.provider.id)!, baseUrl: f.server.baseUrl, encryptedApiKey: f.context.secrets.encrypt(FAKE_KEY) });
    f.context.repository.updateStoryboardItem(f.item.id, { promptInstruction: ORIGINAL, referencedAssets: [f.reference.id], imageResolution: '2K', displayName: 'Revision label' });
    const revised = await f.generate('make it blue');
    expect(f.requests).toHaveLength(2);
    expectRequestEvidence(revised, f.requests[1]!);
    expect(f.requests[1]!.prompt).toContain(REVISED);
    expect(outputProvenance(revised.generationSnapshot)!.attachments).toMatchObject([{ id: f.reference.id, role: 'PACKAGING', sha256: sha256(f.referenceBytes) }]);
    expect(revised.generationSnapshot?.resolution).toBe('2K');
    await f.backend.invoke('updateAsset', { assetId: f.reference.id, role: 'LAYOUT_REFERENCE' });
    await f.backend.invoke('updateStoryboardItem', { itemId: f.item.id, imageResolution: '4K' });
    f.context.repository.updateStoryboardItem(f.item.id, { compiledPrompt: 'LATEST UNRELATED STORYBOARD PROMPT', displayName: 'Latest label', referencedAssets: [] });
    const exported = await f.manifest([original, revised], () => {
      f.context.repository.updateStoryboardItem(f.item.id, { compiledPrompt: 'CHANGED AFTER EXPORT SUBMISSION' });
    });
    for (const [index, output] of [original, revised].entries()) {
      const entry = exported.storyboard.find(entry => entry.outputId === output.id)!;
      expect(entry.prompt).toBe(f.requests[index]!.prompt);
      expect(entry.provenance).toEqual({ status: 'AVAILABLE', ...outputProvenance(output.generationSnapshot)! });
      expect(entry.displayName).toBe(index ? 'Revision label' : 'Original label');
      expect(entry.generationSnapshot.resolution).toBe(index ? '2K' : '1K');
      expect(entry.generationSnapshot.size).toBe(f.requests[index]!.fields.size);
      expect(entry.generationSnapshot.quality).toBe(f.requests[index]!.fields.quality);
      expect(entry.generationSnapshot.modelId).toBe(f.requests[index]!.fields.model);
    }
    const publicOutputs = await f.backend.invoke('listOutputs', { projectId: f.project.id });
    expect(publicOutputs.items.find(output => output.id === revised.id)?.revision).toBe('make it blue');
    expect(publicOutputs.items.find(output => output.id === original.id)?.revision).toBeUndefined();
    const publicOne = await f.backend.invoke('getOutput', { outputId: revised.id });
    expect(publicOne.revision).toBe('make it blue');
    for (const value of [publicOutputs, publicOne]) {
      const text = JSON.stringify(value);
      for (const privateValue of ['generationSnapshot', 'provenance', 'encryptedApiKey', 'finalPrompt', FAKE_KEY]) expect(text).not.toContain(privateValue);
    }
    expect(JSON.stringify(exported)).not.toContain('LATEST UNRELATED');
    expect(f.server.state.counts.chat).toBe(1);
  });

  it('完整改稿和生图回执后落盘失败，重试只续本地并保留最初请求证据', async () => {
    const f = await setup();
    const put = vi.spyOn(f.context.storage, 'putOutput').mockRejectedValueOnce(new Error('synthetic local disk failure'));
    try {
      const queued = await f.submit('make it blue');
      const job = queued.jobs[0]!;
      await waitJob(f.backend, job.id, 'FAILED');
      await f.context.scheduler.waitForIdle([job.id]);
      const requests = f.context.requestLedger.summaries(job.id);
      expect(requests).toHaveLength(2);
      expect(requests.every(request => request.state === 'COMPLETED' && request.localState === 'PENDING')).toBe(true);
      const frozen = JSON.stringify(new RuntimeStore((f.context.repository as any).db).get(job.id)!.snapshot);
      f.context.repository.updateStoryboardItem(f.item.id, { promptInstruction: 'LATER PROMPT', compiledPrompt: 'LATER COMPILED', referencedAssets: [], imageResolution: '4K' });
      await f.backend.invoke('updateAsset', { assetId: f.reference.id, role: 'PACKAGING' });
      f.context.repository.saveProvider({ ...f.context.repository.getProvider(f.provider.id)!, baseUrl: 'http://127.0.0.1:1/v1' });
      await f.backend.invoke('retryJob', { jobId: job.id });
      await waitJob(f.backend, job.id);
      const output = f.outputFor(job.id);
      expectRequestEvidence(output, f.requests[0]!);
      expect(f.requests).toHaveLength(1);
      expect(f.server.state.counts.chat).toBe(1);
      expect(f.server.state.counts['image-edit']).toBe(1);
      expect(f.context.requestLedger.summaries(job.id).every(request => request.localState === 'COMMITTED')).toBe(true);
      expect(JSON.stringify(new RuntimeStore((f.context.repository as any).db).get(job.id)!.snapshot)).toBe(frozen);
      const exported = await f.manifest([output]);
      expect(exported.storyboard[0]!.prompt).toBe(f.requests[0]!.prompt);
      expect(exported.storyboard[0]!.generationSnapshot.revision).toBe('make it blue');
    } finally { put.mockRestore(); }
  });

  it('无附件生成记录空输入；缺少或损坏历史证据明确不可用，绝不借用最新提示词或输出私有字段', async () => {
    const f = await setup({ noReferences: true });
    const current = await f.generate();
    expectRequestEvidence(current, f.requests[0]!);
    expect(outputProvenance(current.generationSnapshot)!.attachments).toEqual([]);
    const legacy = f.context.repository.createOutput({ ...current, generationKey: 'synthetic-legacy-output', generationSnapshot: null });
    const incomplete = f.context.repository.createOutput({ ...current, generationKey: 'synthetic-incomplete-output', generationSnapshot: { ...current.generationSnapshot!, provenance: { version: 1, finalPrompt: 'UNTRUSTWORTHY PARTIAL PROMPT' }, apiKey: 'PRIVATE-SNAPSHOT-SECRET' } as any });
    f.context.repository.updateStoryboardItem(f.item.id, { compiledPrompt: 'LATEST PROMPT MUST NEVER FILL OLD OUTPUTS' });
    const exported = await f.manifest([current, legacy, incomplete]);
    for (const output of [legacy, incomplete]) {
      const entry = exported.storyboard.find(entry => entry.outputId === output.id)!;
      expect(entry.prompt).toBeNull();
      expect(entry.provenance).toEqual({ status: 'UNAVAILABLE', reason: 'OUTPUT_EVIDENCE_MISSING' });
      expect(entry.assetType).toBeNull();
    }
    expect(JSON.stringify(exported)).not.toContain('LATEST PROMPT');
    expect(JSON.stringify(exported)).not.toContain('PRIVATE-SNAPSHOT-SECRET');
    expect(JSON.stringify(exported)).not.toContain('UNTRUSTWORTHY PARTIAL PROMPT');
  });

  it('真实蒙版编辑产物使用编辑提示词和实际源图/项目参考/临时参考/Provider蒙版，保留血缘与公开脱敏', async () => {
    const f = await setup();
    const original = await f.generate();
    const session = await f.backend.invoke('createEditSession', { projectId: f.project.id, outputId: original.id });
    const temporaryBytes = await sharp({ create: { width: 32, height: 24, channels: 4, background: '#11bb99' } }).png().toBuffer();
    const temporary = await f.backend.invoke('uploadEditReferenceAsset', { sessionId: session.id, file: file(temporaryBytes, 'temporary.png'), purpose: 'STYLE' });
    const mask = await sharp({ create: { width: 32, height: 24, channels: 4, background: '#ffffff' } }).png().toBuffer();
    const queued = await f.backend.invoke('createEditTurn', {
      sessionId: session.id, message: 'Change the selected background only', editMask: { ...file(mask, 'mask.png'), mimeType: 'image/png' },
      referenceSelections: JSON.stringify([
        { source: 'TEMPORARY', id: temporary.id, purpose: 'STYLE', order: 0 },
        { source: 'PROJECT', id: f.reference.id, purpose: 'LAYOUT', order: 1 },
      ]),
    });
    await waitJob(f.backend, queued.planJobId);
    // PRECISE_INPAINT 按领域规则自动创建冻结的 EDIT_GENERATE 子任务。
    const childId = candidateIdFor(queued.planJobId, 0);
    await waitJob(f.backend, childId);
    const edited = f.outputFor(childId);
    f.context.repository.updateEditTurn(queued.turnId, { plan: { operation: 'SCENE_ADJUST', executionMode: 'MODEL_DIRECTED', prompt: 'LATER EDIT PLAN', compositePolicy: 'PROVIDER_RESULT' } });
    await f.backend.invoke('updateAsset', { assetId: f.reference.id, role: 'PACKAGING' });
    expect(edited.parentOutputId).toBe(original.id);
    expectRequestEvidence(edited, f.requests[1]!);
    const evidence = outputProvenance(edited.generationSnapshot)!;
    expect(evidence.finalPrompt).toBe('EDIT ONLY THE SELECTED BACKGROUND');
    expect(evidence.attachments.map(image => [image.source, image.id, image.role])).toEqual([
      ['OUTPUT', original.id, 'SOURCE'], ['EDIT_REFERENCE', temporary.id, 'STYLE'],
      ['PROJECT_ASSET', f.reference.id, 'LAYOUT'], ['PROVIDER_MASK', undefined, 'MASK'],
    ]);
    expect(evidence.attachments[0]!.sha256).toBe(original.hash);
    f.context.repository.updateStoryboardItem(f.item.id, { compiledPrompt: 'LATEST UNRELATED GENERATION PROMPT' });
    const exported = await f.manifest([original, edited]);
    expect(exported.storyboard.find(entry => entry.outputId === edited.id)!.prompt).toBe(evidence.finalPrompt);
    expect(exported.storyboard.find(entry => entry.outputId === original.id)!.prompt).toBe(f.requests[0]!.prompt);
    const publicSession = await f.backend.invoke('getEditSession', { sessionId: session.id });
    expect(JSON.stringify(publicSession)).not.toContain('generationSnapshot');
    expect(JSON.stringify(publicSession)).not.toContain('provenance');
  });
});
