import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { MockRequestContext } from '../../../../scripts/full-mock-provider.mjs';
import { file, regressionFixtures, waitJob } from '../desktop-regression-helpers.js';

const fixtures = regressionFixtures();
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const LOCK = 'Dark studio with directional light';
const blueprint = {
  version: 1 as const, suiteId: 'suite-test', suiteName: '测试套图', suiteVersion: 'v1', styleLock: LOCK,
  shots: [
    { shotId: 'main-a', purpose: 'MAIN' as const, displayName: '主体', intent: '展示主体', promptTemplate: 'Show {product}' },
    { shotId: 'main-b', purpose: 'MAIN' as const, displayName: '细节', intent: '展示细节', promptTemplate: 'Show details of {product}' },
    { shotId: 'sku', purpose: 'SKU' as const, displayName: '规格', intent: '展示规格', promptTemplate: 'Show {product}' },
  ],
};

async function setup() {
  const plans: MockRequestContext[] = [];
  const images: MockRequestContext[] = [];
  const revisions: MockRequestContext[] = [];
  const f = await fixtures.fixture({ mock: {
    replyForRequest: request => {
      if (request.workflow === 'revision') { revisions.push(request); return { prompt: 'Preserve P1 and use R1 lighting. Revised background.' }; }
      if (request.json?.response_format?.json_schema?.name !== 'ecomgen_visual_storyboard') return undefined;
      plans.push(request);
      const payload = request.payload;
      const refs = payload.assets.filter((asset: any) => asset.kind === 'REFERENCE').map((asset: any) => asset.handle);
      return {
        campaignStyleLock: payload.productImageBatch.campaignStyleLock ?? LOCK,
        items: payload.productImageBatch.targets.map((target: any, index: number) => {
          const product = target.productHandles[0];
          const reference = refs[0];
          return { displayName: `画面${index + 1}`, intent: `展示角度${index + 1}`, referenceIntent: reference ? `${reference}光线` : '统一风格',
            referencedAssets: [product, ...(reference ? [reference] : [])], mode: payload.defaultMode,
            promptInstruction: `Preserve ${product} identity. ${reference ? `Use ${reference} lighting.` : ''} Composition ${index + 1}.`, factClaims: [], riskFlags: [] };
        }),
      };
    },
    imageForRequest: (request, available) => { images.push(request); return available.image; },
  } });
  const truth = await f.backend.invoke('uploadAsset', { projectId: f.project.id, role: 'PRODUCT_TRUTH', file: file(f.bytes, 'truth.png') });
  const referenceBytes = await sharp({ create: { width: 32, height: 24, channels: 4, background: '#667788' } }).png().toBuffer();
  const reference = await f.backend.invoke('uploadAsset', { projectId: f.project.id, role: 'STYLE_REFERENCE', file: file(referenceBytes, 'reference.png') });
  const save = async (config: any, skus: any[] = []) => f.backend.invoke('saveProjectImagePlanning', { projectId: f.project.id, expectedRevision: 0, config, skus, imageGroups: [] });
  return { ...f, truth, reference, referenceBytes, plans, images, revisions, save };
}

function fileHashes(request: MockRequestContext): string[] {
  return Object.values(request.files).flat().map(part => hash(part.data)).sort();
}

describe('参考图驱动规划真实执行', () => {
  it('不支持视觉的推理模型在请求前拒绝', async () => {
    const f = await setup();
    const provider = await f.backend.invoke('createProvider', { name: 'Text only', baseUrl: f.server.baseUrl, reasoningProtocol: 'openai', apiKey: 'fake-key', models: [{ id: 'text-only', supportsVision: false, supportsThinking: false, supportsTools: false, supportsStructuredOutput: true }] });
    await f.backend.invoke('updateProject', { projectId: f.project.id, reasoningModel: { providerId: provider.id, modelId: 'text-only' } });
    const saved = await f.save({ mainCount: 1, detailCount: 0, skuImagesPerGroup: 1, shareImages: false });
    await expect(f.backend.invoke('createProductImagePlanningJob', { projectId: f.project.id, expectedRevision: saved.planning.revision })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(f.server.state.counts.chat).toBe(0);
  });

  it('六画面两候选复用每画面提示词及实际附件，十二个独立请求', async () => {
    const f = await setup();
    await f.backend.invoke('updateProject', { projectId: f.project.id, candidatesPerType: 2, imageAspectRatio: '4:5', imageResolution: '2K' });
    const saved = await f.save({ mainCount: 6, detailCount: 0, skuImagesPerGroup: 1, shareImages: false });
    const plan = await f.backend.invoke('createProductImagePlanningJob', { projectId: f.project.id, expectedRevision: saved.planning.revision });
    await waitJob(f.backend, plan.id);
    expect(f.plans).toHaveLength(1);
    const request = f.plans[0]!;
    expect(request.payload).toMatchObject({ planningVersion: 2, imageAspectRatio: '4:5', imageResolution: '2K' });
    expect(JSON.stringify(request.json)).not.toMatch(/candidateCount|candidatesPerType|allowedTemplateIds|categoryTips|read_ecom_template/);
    const content = JSON.stringify(request.json?.messages);
    expect(content).toContain('data:image/png;base64');
    expect(request.payload.visionAttachments.map((a: any) => a.handle)).toEqual(['P1', 'R1']);
    const board = await f.backend.invoke('getStoryboard', { projectId: f.project.id });
    expect(board.items).toHaveLength(6);
    expect(new Set(board.items.map(item => item.promptInstruction)).size).toBe(6);
    expect(board.items.every(item => item.assetType === 'model-direct:v1' && item.planningSource?.kind === 'MODEL_DIRECT' && item.candidateCount === 2)).toBe(true);
    expect(f.images).toHaveLength(0);
    await f.backend.invoke('confirmStoryboard', { projectId: f.project.id, version: board.storyboard!.version });
    const submitted = await f.backend.invoke('createGenerationJobs', { projectId: f.project.id, storyboardItemIds: board.items.map(item => item.id) });
    expect(submitted.jobs).toHaveLength(12);
    for (const job of submitted.jobs) await waitJob(f.backend, job.id);
    expect(f.images).toHaveLength(12);
    for (const item of board.items) {
      const jobs = submitted.jobs.filter(job => job.storyboardItemId === item.id);
      expect(jobs).toHaveLength(2);
      const outputs = f.context.repository.listOutputs(f.project.id).filter(output => jobs.some(job => job.id === output.jobId));
      expect(outputs).toHaveLength(2);
      const requests = f.images.filter(request => String(request.fields.prompt ?? request.json?.prompt).includes(item.promptInstruction));
      expect(requests).toHaveLength(2);
      expect(requests[0]!.fields.prompt ?? requests[0]!.json?.prompt).toEqual(requests[1]!.fields.prompt ?? requests[1]!.json?.prompt);
      expect(fileHashes(requests[0]!)).toEqual(fileHashes(requests[1]!));
      expect(fileHashes(requests[0]!)).toEqual([hash(f.bytes), hash(f.referenceBytes)].sort());
      expect(requests.every(request => Boolean(request.idempotencyKey))).toBe(true);
      expect(new Set(requests.map(request => request.idempotencyKey)).size).toBe(2);
    }
  });

  it('SKU按显式商品图隔离规划与生图附件', async () => {
    const f = await setup();
    const bytes = await sharp({ create: { width: 32, height: 24, channels: 4, background: '#2266bb' } }).png().toBuffer();
    const second = await f.backend.invoke('uploadAsset', { projectId: f.project.id, role: 'PRODUCT_TRUTH', file: file(bytes, 'second.png') });
    const skus = [f.truth.id, second.id].map((id, i) => ({ id: randomUUID(), name: `规格${i}`, code: `SKU${i}`, attributes: [], productAssetIds: [id], included: true }));
    const saved = await f.save({ mainCount: 0, detailCount: 0, skuImagesPerGroup: 1, shareImages: false }, skus);
    const plan = await f.backend.invoke('createProductImagePlanningJob', { projectId: f.project.id, expectedRevision: saved.planning.revision });
    await waitJob(f.backend, plan.id);
    expect(f.plans).toHaveLength(2);
    for (const request of f.plans) {
      const products = request.payload.assets.filter((asset: any) => asset.kind === 'PRODUCT');
      expect(products).toHaveLength(1);
      expect(request.payload.productImageBatch.targets[0].productHandles).toEqual([products[0].handle]);
    }
    const board = await f.backend.invoke('getStoryboard', { projectId: f.project.id });
    await f.backend.invoke('confirmStoryboard', { projectId: f.project.id, version: board.storyboard!.version });
    const jobs = await f.backend.invoke('createGenerationJobs', { projectId: f.project.id, storyboardItemIds: board.items.map(item => item.id) });
    for (const job of jobs.jobs) await waitJob(f.backend, job.id);
    expect(f.images.map(fileHashes)).toEqual(expect.arrayContaining([[hash(f.bytes), hash(f.referenceBytes)].sort(), [hash(bytes), hash(f.referenceBytes)].sort()]));
  });

  it('套图数量来自镜头，SKU展开保持镜头身份且不循环映射', async () => {
    const f = await setup();
    const skus = [0, 1].map(i => ({ id: randomUUID(), name: `规格${i}`, code: null, attributes: [], productAssetIds: [f.truth.id], included: true }));
    await expect(f.save({ mainCount: 3, detailCount: 0, skuImagesPerGroup: 1, shareImages: false, suiteBlueprint: blueprint }, skus)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const saved = await f.save({ mainCount: 2, detailCount: 0, skuImagesPerGroup: 1, shareImages: false, suiteBlueprint: blueprint }, skus);
    const plan = await f.backend.invoke('createProductImagePlanningJob', { projectId: f.project.id, expectedRevision: saved.planning.revision });
    await waitJob(f.backend, plan.id);
    const board = await f.backend.invoke('getStoryboard', { projectId: f.project.id });
    expect(board.items).toHaveLength(4);
    const sources = board.items.map(item => item.planningSource);
    expect(sources.map(source => source?.kind === 'SUITE' ? source.shotId : null)).toEqual(['main-a', 'main-b', 'sku', 'sku']);
    expect(board.items.map(item => item.assetType)).toEqual(['suite-test::main-a', 'suite-test::main-b', 'suite-test::sku', 'suite-test::sku']);
    expect(f.plans.every(request => !JSON.stringify(request.json).includes('allowedTemplateIds'))).toBe(true);
    expect(f.plans.flatMap(request => request.payload.suiteBlueprint.shots.map((shot: any) => shot.shotId))).toEqual(['main-a', 'main-b', 'sku', 'sku']);
  });

  it('修订一次后同批两个候选共享提示词和附件', async () => {
    const f = await setup();
    const saved = await f.save({ mainCount: 1, detailCount: 0, skuImagesPerGroup: 1, shareImages: false });
    const plan = await f.backend.invoke('createProductImagePlanningJob', { projectId: f.project.id, expectedRevision: saved.planning.revision });
    await waitJob(f.backend, plan.id);
    const board = await f.backend.invoke('getStoryboard', { projectId: f.project.id });
    await f.backend.invoke('confirmStoryboard', { projectId: f.project.id, version: board.storyboard!.version });
    const result = await f.backend.invoke('createGenerationJobs', { projectId: f.project.id, storyboardItemIds: [board.items[0]!.id], revision: '调整背景', regenerationKey: randomUUID(), generationConfig: { candidateCount: 2 } });
    for (const job of result.jobs) await waitJob(f.backend, job.id);
    expect(f.revisions).toHaveLength(1);
    expect(f.images).toHaveLength(2);
    expect(f.images[0]!.fields.prompt).toBe(f.images[1]!.fields.prompt);
    expect(fileHashes(f.images[0]!)).toEqual(fileHashes(f.images[1]!));
  });

  it('共享修订断线不启动任何候选，重启后仍等待用户重试原任务', async () => {
    const f = await setup();
    const saved = await f.save({ mainCount: 1, detailCount: 0, skuImagesPerGroup: 1, shareImages: false });
    const plan = await f.backend.invoke('createProductImagePlanningJob', { projectId: f.project.id, expectedRevision: saved.planning.revision });
    await waitJob(f.backend, plan.id);
    const board = await f.backend.invoke('getStoryboard', { projectId: f.project.id });
    await f.backend.invoke('confirmStoryboard', { projectId: f.project.id, version: board.storyboard!.version });
    f.server.control.failNext('chat', { type: 'drop' });
    const submitted = await f.backend.invoke('createGenerationJobs', { projectId: f.project.id, storyboardItemIds: [board.items[0]!.id], revision: '调整背景', regenerationKey: randomUUID(), generationConfig: { candidateCount: 2 } });
    const owner = submitted.jobs[0]!;
    const dependent = submitted.jobs[1]!;
    await waitJob(f.backend, owner.id, 'UNKNOWN');
    await waitJob(f.backend, dependent.id, 'FAILED');
    expect(f.images).toHaveLength(0);
    expect(f.context.repository.getGenerationPrompt(owner.id)).toBeUndefined();
    await f.backend.close();
    const reopened = await fixtures.open(f.options);
    expect((await reopened.backend.invoke('getJob', { jobId: owner.id })).status).toBe('UNKNOWN');
    expect(f.images).toHaveLength(0);
    const recovery = await reopened.backend.invoke('resolveJobInterruptions', { jobId: owner.id, action: 'RETRY' });
    expect(recovery.items[0]!.status).toBe('RETRIED');
    await waitJob(reopened.backend, owner.id);
    await reopened.backend.invoke('retryJob', { jobId: dependent.id });
    await waitJob(reopened.backend, dependent.id);
    expect(f.revisions).toHaveLength(1);
    expect(f.images).toHaveLength(2);
    expect(f.images[0]!.fields.prompt).toEqual(f.images[1]!.fields.prompt);
    expect(reopened.context.repository.getGenerationPrompt(owner.id)?.prompt).toContain('Revised background');
  });

  it('两个商品分别规划，显式生成时单商品失败不覆盖另一商品成功', async () => {
    const f = await setup();
    const other = await f.backend.invoke('createProject', { name: '第二商品', productDescription: '第二商品事实', verifiedFacts: ['第二商品事实'], reasoningProviderId: f.provider.id, reasoningModelId: 'mock-reasoner', imageProviderId: f.provider.id, imageModelId: 'gpt-image-1', defaultMode: 'CREATIVE', promptLanguage: 'ENGLISH', candidatesPerType: 1 });
    const otherBytes = await sharp({ create: { width: 32, height: 24, channels: 4, background: '#1122aa' } }).png().toBuffer();
    await f.backend.invoke('uploadAsset', { projectId: other.id, role: 'PRODUCT_TRUTH', file: file(otherBytes, 'other.png') });
    const batch = await f.backend.invoke('createSuitePlanningBatch', { regenerationKey: randomUUID(), suiteBlueprint: { ...blueprint, shots: blueprint.shots.slice(0, 1) }, projectIds: [f.project.id, other.id] });
    expect(batch.entries.every(entry => entry.planJobId)).toBe(true);
    for (const entry of batch.entries) await waitJob(f.backend, entry.planJobId!);
    expect(f.plans).toHaveLength(2);
    expect(new Set(f.plans.map(request => request.payload.projectName))).toEqual(new Set([f.project.name, other.name]));
    expect(f.plans.find(request => request.payload.projectName === other.name)?.payload.verifiedFacts).toEqual(['第二商品事实']);
    expect(f.images).toHaveLength(0);
    f.server.control.addFault({ kind: 'image-edit', at: 1, fault: { type: 'http', status: 400 } });
    const started = await f.backend.invoke('generateSuitePlanningBatch', { batchId: batch.id });
    const jobs = started.entries.flatMap(entry => entry.generationJobIds);
    expect(jobs).toHaveLength(2);
    const settled = await Promise.all(jobs.map(async id => {
      try { return await waitJob(f.backend, id); } catch { return await f.backend.invoke('getJob', { jobId: id }); }
    }));
    expect(settled.map(job => job.status).sort()).toEqual(['FAILED', 'SUCCEEDED']);
    const succeeded = settled.find(job => job.status === 'SUCCEEDED')!;
    expect(f.context.repository.listOutputs(succeeded.projectId!).some(output => output.jobId === succeeded.id)).toBe(true);
    const loaded = await f.backend.invoke('getSuitePlanningBatch', { batchId: batch.id });
    expect(loaded.entries.reduce((sum, entry) => sum + entry.generationCompleted, 0)).toBe(1);
    expect(loaded.entries.some(entry => Boolean(entry.error))).toBe(true);
  });

  it('批次显式重试同画面两个中断候选，只恢复原任务和原候选身份', async () => {
    const f = await setup();
    await f.backend.invoke('updateProject', { projectId: f.project.id, candidatesPerType: 2 });
    const batch = await f.backend.invoke('createSuitePlanningBatch', { regenerationKey: randomUUID(), suiteBlueprint: { ...blueprint, shots: blueprint.shots.slice(0, 1) }, projectIds: [f.project.id] });
    await waitJob(f.backend, batch.entries[0]!.planJobId!);
    f.server.control.addFault({ kind: 'image-edit', at: 1, fault: { type: 'drop' } });
    f.server.control.addFault({ kind: 'image-edit', at: 2, fault: { type: 'drop' } });
    const started = await f.backend.invoke('generateSuitePlanningBatch', { batchId: batch.id });
    const ids = started.entries[0]!.generationJobIds;
    for (const id of ids) await waitJob(f.backend, id, 'UNKNOWN');
    expect(f.images).toHaveLength(0);
    const retried = await f.backend.invoke('retrySuitePlanningBatch', { batchId: batch.id });
    expect(retried.entries[0]!.generationJobIds).toEqual(ids);
    expect(retried.entries[0]!.error).toBeUndefined();
    for (const id of ids) await waitJob(f.backend, id);
    expect(f.images).toHaveLength(2);
    expect(f.context.repository.listOutputs(f.project.id).map(output => output.candidateIndex).sort()).toEqual([1, 2]);
    expect(f.plans).toHaveLength(1);
  });

  it('跨项目批次部分预检失败保留成功，重启只读取且显式触发生图', async () => {
    const f = await setup();
    const other = await f.backend.invoke('createProject', { name: '缺图商品', reasoningProviderId: f.provider.id, reasoningModelId: 'mock-reasoner', imageProviderId: f.provider.id, imageModelId: 'gpt-image-1', defaultMode: 'CREATIVE', promptLanguage: 'ENGLISH', candidatesPerType: 1 });
    const batch = await f.backend.invoke('createSuitePlanningBatch', { regenerationKey: randomUUID(), suiteBlueprint: { ...blueprint, shots: blueprint.shots.slice(0, 2) }, projectIds: [f.project.id, other.id] });
    const first = batch.entries.find(entry => entry.projectId === f.project.id)!;
    expect(first.planJobId).toBeDefined();
    await waitJob(f.backend, first.planJobId!);
    expect(batch.entries.find(entry => entry.projectId === other.id)?.error).toBeTruthy();
    expect(f.images).toHaveLength(0);
    await f.backend.close();
    const reopened = await fixtures.open(f.options);
    const loaded = await reopened.backend.invoke('getSuitePlanningBatch', { batchId: batch.id });
    expect(loaded.phase).toBe('PLANNING');
    expect(loaded.entries.find(entry => entry.projectId === f.project.id)?.planStatus).toBe('SUCCEEDED');
    expect(loaded.entries.find(entry => entry.projectId === other.id)?.error).toBeTruthy();
    expect(f.images).toHaveLength(0);
    const started = await reopened.backend.invoke('generateSuitePlanningBatch', { batchId: batch.id });
    const jobs = started.entries.find(entry => entry.projectId === f.project.id)!.generationJobIds;
    expect(jobs).toHaveLength(2);
    for (const id of jobs) await waitJob(reopened.backend, id);
    expect(f.images).toHaveLength(2);
    expect((await reopened.backend.invoke('getSuitePlanningBatch', { batchId: batch.id })).entries.find(entry => entry.projectId === other.id)?.generationJobIds).toEqual([]);
  });
});
