import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { SqliteDatabase } from '@ecomgen/core';
import { defaultReplyForRequest, editPlanReply, type MockRequestContext } from '../../../../scripts/full-mock-provider.mjs';
import { RuntimeStore } from '../../src/runtime/state.js';
import { file, regressionFixtures, waitJob } from '../desktop-regression-helpers.js';

const fixtures = regressionFixtures();
type Fixture = Awaited<ReturnType<typeof fixtures.fixture>>;
const runtimeStore = (f: Fixture) => new RuntimeStore((f.context.repository as unknown as { db: SqliteDatabase }).db);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function setup(options: { beforeEditReply?: (request: MockRequestContext) => Promise<void>; automatic?: boolean } = {}) {
  const f = await fixtures.fixture({ mock: {
    replyForRequest: async request => {
      if (request.workflow === 'edit-plan') {
        await options.beforeEditReply?.(request);
        return editPlanReply(options.automatic ? 'no-confirmation' : 'confirmation');
      }
      // 使用请求中的真实模板、数量和素材 handle；默认 revision 0 也执行正式规划链。
      if (request.workflow === 'storyboard') return defaultReplyForRequest(request);
      return undefined;
    },
  } });
  await f.backend.invoke('uploadAsset', { projectId: f.project.id, role: 'PRODUCT_TRUTH', file: file(f.bytes) });
  return f;
}

/** 仅构造迁移前的历史成图；待测命令、取消、重试和 UNKNOWN 全部走真实 Backend。 */
async function legacyOutput(f: Fixture, projectId = f.project.id) {
  const project = f.context.repository.getProject(projectId)!;
  f.context.repository.saveStoryboard(projectId, 'Neutral studio', 'CONFIRMED', [{
    assetType: 'hero-image', displayName: '旧成图', shotRole: 'HERO', templateVariant: null,
    candidateCount: 1, referencedAssets: [], mode: 'CREATIVE', status: 'CONFIRMED',
    promptInstruction: 'Preserve the exact product identity and photograph it in a neutral studio.',
    compiledPrompt: null, factClaims: [], riskFlags: [], sortOrder: 0,
    imageProviderId: project.imageProviderId, imageModelId: project.imageModelId,
    imageResolution: '1K', imageAspectRatio: '1:1',
  }]);
  const item = f.context.repository.listStoryboardItems(projectId)[0]!;
  const job = f.context.repository.createJob({ id: randomUUID(), projectId, storyboardItemId: item.id, type: 'GENERATE', input: {}, status: 'SUCCEEDED' });
  const stored = await f.context.storage.putOutput(projectId, f.bytes, 'png', job.id);
  const output = f.context.repository.createOutput({ projectId, storyboardItemId: item.id, jobId: job.id, candidateIndex: 1,
    generationSnapshot: null, storagePath: stored.path, hash: stored.hash, width: 32, height: 24, generationKey: job.id });
  const session = await f.backend.invoke('createEditSession', { projectId, outputId: output.id });
  return { item, output, session };
}

async function enableDirectory(f: Fixture, projectId = f.project.id) {
  return f.backend.invoke('saveProjectImagePlanning', { projectId, expectedRevision: 0,
    config: { mainCount: 2, detailCount: 0, skuImagesPerGroup: 1, shareImages: false }, skus: [], imageGroups: [] });
}

async function unknownPlan(f: Fixture, expectedRevision = 0) {
  f.server.control.failNext('chat', { type: 'drop' });
  const job = await f.backend.invoke('createProductImagePlanningJob', { projectId: f.project.id, expectedRevision, regenerationKey: randomUUID() });
  await waitJob(f.backend, job.id, 'UNKNOWN');
  await f.context.scheduler.waitForIdle([job.id]);
  expect(f.context.requestLedger.summaries(job.id)).toEqual([expect.objectContaining({ state: 'UNKNOWN' })]);
  expect(f.context.requestLedger.hasUnknown(job.id)).toBe(true);
  return job;
}

async function cancelledBeforeSend(f: Fixture, type: 'PLAN' | 'GENERATE' | 'EDIT_PLAN' | 'EDIT_GENERATE') {
  let jobId: string;
  if (type === 'PLAN') {
    jobId = (await f.backend.invoke('createProductImagePlanningJob', { projectId: f.project.id, expectedRevision: 0, regenerationKey: randomUUID() })).id;
  } else {
    const source = await legacyOutput(f);
    if (type === 'GENERATE') {
      jobId = (await f.backend.invoke('createGenerationJobs', { projectId: f.project.id, storyboardItemIds: [source.item.id] })).jobs[0]!.id;
    } else {
      const turn = await f.backend.invoke('createEditTurn', { sessionId: source.session.id, message: '只调整背景光线，保留商品外观。' });
      jobId = turn.planJobId;
      if (type === 'EDIT_GENERATE') {
        await waitJob(f.backend, turn.planJobId);
        await f.context.scheduler.waitForIdle([turn.planJobId]);
        expect((await f.backend.invoke('getEditTurn', { turnId: turn.turnId })).status).toBe('AWAITING_CONFIRMATION');
        jobId = (await f.backend.invoke('approveEditTurn', { turnId: turn.turnId })).job.id;
      }
    }
  }
  await f.backend.invoke('cancelJob', { jobId });
  await waitJob(f.backend, jobId, 'CANCELLED');
  await f.context.scheduler.waitForIdle([jobId]);
  expect(f.context.requestLedger.summaries(jobId)).toEqual([]);
  expect(runtimeStore(f).get(jobId)).toMatchObject({ attempt: 0, phase: 'SETTLED' });
  return f.context.repository.getJob(jobId)!;
}

async function otherProject(f: Fixture) {
  return f.backend.invoke('createProject', { name: '无关项目', defaultMode: 'CREATIVE', candidatesPerType: 1,
    reasoningProviderId: f.provider.id, reasoningModelId: 'mock-reasoner', imageProviderId: f.provider.id, imageModelId: 'gpt-image-1' });
}

describe('项目图片规划的付费请求屏障', () => {
  it('编辑回合公开恢复任务，结束旧中断不覆盖已接管的编辑任务', async () => {
    const f = await setup(); const { session } = await legacyOutput(f);
    f.server.control.failNext('chat', { type: 'drop' });
    const pending = await f.backend.invoke('createEditTurn', { sessionId: session.id, message: '调整背景' });
    await waitJob(f.backend, pending.planJobId, 'UNKNOWN'); await f.context.scheduler.waitForIdle([pending.planJobId]);
    expect((await f.backend.invoke('getEditTurn', { turnId: pending.turnId })).recoveryJobId).toBe(pending.planJobId);
    expect((await f.backend.invoke('getEditSession', { sessionId: session.id })).turns.find(turn => turn.id === pending.turnId)?.recoveryJobId).toBe(pending.planJobId);
    const next = f.context.repository.createJob({ id: randomUUID(), projectId: f.project.id, storyboardItemId: null, type: 'EDIT_GENERATE', status: 'RUNNING', input: { editTurnId: pending.turnId } });
    f.context.repository.updateEditTurn(pending.turnId, { status: 'GENERATING' });
    const before = f.server.state.total;
    expect((await f.backend.invoke('resolveJobInterruptions', { jobId: pending.planJobId, action: 'END' })).items[0]?.status).toBe('ENDED');
    expect((await f.backend.invoke('getEditTurn', { turnId: pending.turnId })).status).toBe('GENERATING');
    expect(f.context.repository.getJob(next.id)?.status).toBe('RUNNING'); expect(f.server.state.total).toBe(before);
  });
  it('普通项目同画面已有活动生成时不能重试旧中断', async () => {
    const f = await setup(); const { item } = await legacyOutput(f);
    f.server.control.failNext('image-generation', { type: 'drop' });
    const pending = await f.backend.invoke('createGenerationJobs', { projectId: f.project.id, storyboardItemIds: [item.id], generationBatchId: randomUUID() });
    const job = pending.jobs[0]!; await waitJob(f.backend, job.id, 'UNKNOWN'); await f.context.scheduler.waitForIdle([job.id]);
    const next = f.context.repository.createJob({ id: randomUUID(), projectId: f.project.id, storyboardItemId: item.id, type: 'GENERATE', status: 'RUNNING', input: {}, requestFingerprint: randomUUID() });
    const before = f.server.state.total;
    expect((await f.backend.invoke('getJobActions', { jobId: job.id })).retry).toMatchObject({ available: false, reason: expect.stringContaining('画面') });
    expect((await f.backend.invoke('resolveJobInterruptions', { jobId: job.id, action: 'RETRY' })).items[0]?.status).toBe('FAILED');
    expect(f.context.repository.getJob(job.id)?.status).toBe('UNKNOWN'); expect(f.context.repository.getJob(next.id)?.status).toBe('RUNNING'); expect(f.server.state.total).toBe(before);
  });
  it.each(['已有成图', '尚无成图', '另有活动任务'] as const)('结束中断后按实际候选同步画面状态：%s', async scenario => {
    const f = await setup(); const source = await legacyOutput(f);
    let item = source.item;
    if (scenario === '尚无成图') {
      const board = f.context.repository.saveStoryboard(f.project.id, 'Neutral studio', 'CONFIRMED', [{ ...item, displayName: '未成图画面' }]);
      item = f.context.repository.listStoryboardItems(f.project.id).find(row => row.storyboardVersion === board.version)!;
    }
    f.server.control.failNext('image-generation', { type: 'drop' });
    const pending = await f.backend.invoke('createGenerationJobs', { projectId: f.project.id, storyboardItemIds: [item.id], regenerationKey: randomUUID() });
    const job = pending.jobs[0]!; await waitJob(f.backend, job.id, 'UNKNOWN'); await f.context.scheduler.waitForIdle([job.id]);
    expect(f.context.repository.getStoryboardItem(item.id)?.status).toBe('GENERATING');
    const next = scenario === '另有活动任务' ? f.context.repository.createJob({ id: randomUUID(), projectId: f.project.id, storyboardItemId: item.id, type: 'GENERATE', status: 'RUNNING', input: {}, requestFingerprint: randomUUID() }) : null;
    const outputs = f.context.repository.listOutputs(f.project.id), before = f.server.state.total;
    expect((await f.backend.invoke('resolveJobInterruptions', { jobId: job.id, action: 'END' })).items[0]?.status).toBe('ENDED');
    expect(f.context.repository.getStoryboardItem(item.id)?.status).toBe(scenario === '另有活动任务' ? 'GENERATING' : scenario === '已有成图' ? 'GENERATED' : 'CONFIRMED');
    if (next) expect(f.context.repository.getJob(next.id)?.status).toBe('RUNNING');
    expect(f.context.repository.listOutputs(f.project.id)).toEqual(outputs);
    expect(f.server.state.total).toBe(before);
  });
  it.each(['PLAN', 'GENERATE', 'EDIT_PLAN', 'EDIT_GENERATE'] as const)('发送前取消的 %s 不能在同项目另一请求 UNKNOWN 后安全重试', async type => {
    const f = await setup();
    const cancelled = await cancelledBeforeSend(f, type);
    // PLAN 自己的冻结输入就启用了 revision 0；其它类型模拟取消后启用目录。
    const revision = type === 'PLAN' ? 0 : (await enableDirectory(f)).planning.revision;
    const uncertain = await unknownPlan(f, revision);
    expect(uncertain.id).not.toBe(cancelled.id);
    const before = runtimeStore(f).get(cancelled.id);
    const jobs = f.context.repository.listJobs(f.project.id);
    const counts = f.server.control.snapshot().counts;
    const enqueue = vi.spyOn(f.context.scheduler, 'enqueue');
    try {
      await expect(f.backend.invoke('retryJob', { jobId: cancelled.id })).rejects.toMatchObject({ code: 'EXTERNAL_UNKNOWN' });
      await f.context.scheduler.waitForIdle([cancelled.id]);
      expect(enqueue).not.toHaveBeenCalled();
      expect(f.context.repository.getJob(cancelled.id)).toEqual(cancelled);
      expect(runtimeStore(f).get(cancelled.id)).toEqual(before);
      expect(f.context.repository.listJobs(f.project.id)).toEqual(jobs);
      expect(f.context.requestLedger.summaries(cancelled.id)).toEqual([]);
      expect(f.server.state.counts).toEqual(counts);
    } finally { enqueue.mockRestore(); }
  });

  it('revision 0 的同一取消意图在无其它工作时仍可显式恢复并只发送一次', async () => {
    const f = await setup();
    const cancelled = await cancelledBeforeSend(f, 'PLAN');
    expect(f.context.repository.getProjectImagePlanning(f.project.id)).toBeUndefined();
    const frozen = runtimeStore(f).get(cancelled.id)!.snapshot;
    expect(frozen.input.productImagePlanning).toMatchObject({ state: { revision: 0 } });
    expect((await f.backend.invoke('retryJob', { jobId: cancelled.id })).id).toBe(cancelled.id);
    await waitJob(f.backend, cancelled.id);
    expect(runtimeStore(f).get(cancelled.id)!.snapshot).toEqual(frozen);
    expect(f.server.state.counts.chat).toBe(1);
    expect(f.context.repository.listStoryboardItems(f.project.id)).toEqual([expect.objectContaining({ imagePlanning: expect.objectContaining({ sourceRevision: 0 }) })]);
  });

  it('revision 0 的另一排队 PLAN 同样阻止恢复，拒绝不改变两个冻结任务', async () => {
    const f = await setup();
    const cancelled = await cancelledBeforeSend(f, 'PLAN');
    const other = await f.backend.invoke('createProductImagePlanningJob', { projectId: f.project.id, expectedRevision: 0, regenerationKey: randomUUID() });
    const before = runtimeStore(f).get(cancelled.id);
    await expect(f.backend.invoke('retryJob', { jobId: cancelled.id })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(runtimeStore(f).get(cancelled.id)).toEqual(before);
    expect(f.context.repository.getJob(cancelled.id)).toEqual(cancelled);
    await f.backend.invoke('cancelJob', { jobId: other.id });
    await waitJob(f.backend, other.id, 'CANCELLED');
    expect(f.server.state.counts.chat).toBe(0);
  });

  it.each(['saved-directory', 'default-plan'] as const)('%s 启用的项目不能从无快照旧成图另建 EDIT_PLAN 绕过 UNKNOWN', async activation => {
    const f = await setup();
    const source = await legacyOutput(f);
    expect(source.output.generationSnapshot).toBeNull();
    const revision = activation === 'saved-directory' ? (await enableDirectory(f)).planning.revision : 0;
    await unknownPlan(f, revision);
    if (activation === 'default-plan') expect(f.context.repository.getProjectImagePlanning(f.project.id)).toBeUndefined();
    expect(f.context.repository.listStoryboardItems(f.project.id).every(item => !item.imagePlanning)).toBe(true);
    const jobs = f.context.repository.listJobs(f.project.id);
    const counts = f.server.control.snapshot().counts;
    await expect(f.backend.invoke('createEditTurn', { sessionId: source.session.id, message: '将背景换成灰色。' })).rejects.toMatchObject({ code: 'EXTERNAL_UNKNOWN' });
    expect(f.context.repository.listEditTurns(source.session.id)).toEqual([]);
    expect(f.context.repository.listJobs(f.project.id)).toEqual(jobs);
    expect(f.server.state.counts).toEqual(counts);
  });

  it('蒙版真实落盘期间启用默认规划并产生 UNKNOWN，最后事务仍拒绝发布编辑轮次', async () => {
    const f = await setup();
    const source = await legacyOutput(f);
    const entered = deferred(), release = deferred();
    const original = f.context.storage.putEditArtifact.bind(f.context.storage);
    const put = vi.spyOn(f.context.storage, 'putEditArtifact').mockImplementationOnce(async (...args) => {
      const stored = await original(...args);
      entered.resolve();
      await release.promise;
      return stored;
    });
    const pending = f.backend.invoke('createEditTurn', { sessionId: source.session.id, message: '仅修改指定背景区域。', editMask: file(f.bytes, 'mask.png') });
    try {
      await entered.promise;
      await unknownPlan(f);
      const jobs = f.context.repository.listJobs(f.project.id);
      const counts = f.server.control.snapshot().counts;
      const rejected = expect(pending).rejects.toMatchObject({ code: 'EXTERNAL_UNKNOWN' });
      release.resolve();
      await rejected;
      expect(f.context.repository.listEditTurns(source.session.id)).toEqual([]);
      expect(f.context.repository.listJobs(f.project.id)).toEqual(jobs);
      expect(f.server.state.counts).toEqual(counts);
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
      put.mockRestore();
    }
  });

  it.each(['AWAITING_CONFIRMATION', 'PLAN_READY'] as const)('%s 的编辑在同项目默认规划 UNKNOWN 后不能创建 EDIT_GENERATE', async status => {
    const f = await setup();
    const source = await legacyOutput(f);
    const created = await f.backend.invoke('createEditTurn', { sessionId: source.session.id, message: '调整背景光线。' });
    await waitJob(f.backend, created.planJobId);
    await f.context.scheduler.waitForIdle([created.planJobId]);
    expect(f.context.repository.getEditTurn(created.turnId)?.status).toBe('AWAITING_CONFIRMATION');
    // PLAN_READY 是兼容旧轮次的另一个可批准状态；请求账本仍由实际 PLAN 执行创建。
    if (status === 'PLAN_READY') f.context.repository.updateEditTurn(created.turnId, { status });
    await unknownPlan(f);
    expect(f.context.repository.getProjectImagePlanning(f.project.id)).toBeUndefined();
    const turn = f.context.repository.getEditTurn(created.turnId);
    const jobs = f.context.repository.listJobs(f.project.id);
    const counts = f.server.control.snapshot().counts;
    const enqueue = vi.spyOn(f.context.scheduler, 'enqueue');
    try {
      await expect(f.backend.invoke('approveEditTurn', { turnId: created.turnId })).rejects.toMatchObject({ code: 'EXTERNAL_UNKNOWN' });
      expect(enqueue).not.toHaveBeenCalled();
      expect(f.context.repository.getEditTurn(created.turnId)).toEqual(turn);
      expect(f.context.repository.listJobs(f.project.id)).toEqual(jobs);
      expect(jobs.some(job => job.type === 'EDIT_GENERATE')).toBe(false);
      expect(f.server.state.counts).toEqual(counts);
    } finally { enqueue.mockRestore(); }
  });

  it('同一既有编辑及批准意图在另一请求 UNKNOWN 后仍可查询重用，不重新付费', async () => {
    const f = await setup();
    const source = await legacyOutput(f);
    await enableDirectory(f);
    const input = { sessionId: source.session.id, baseOutputId: source.output.id, message: '调整背景光线。' };
    const created = await f.backend.invoke('createEditTurn', input);
    await waitJob(f.backend, created.planJobId);
    await f.context.scheduler.waitForIdle([created.planJobId]);
    const approved = await f.backend.invoke('approveEditTurn', { turnId: created.turnId });
    await waitJob(f.backend, approved.job.id);
    await f.context.scheduler.waitForIdle([approved.job.id]);
    await unknownPlan(f, 1);
    const jobs = f.context.repository.listJobs(f.project.id);
    const counts = f.server.control.snapshot().counts;
    expect(await f.backend.invoke('createEditTurn', input)).toMatchObject({ turnId: created.turnId, planJobId: created.planJobId, reused: true });
    expect(await f.backend.invoke('approveEditTurn', { turnId: created.turnId })).toMatchObject({ job: { id: approved.job.id, status: 'SUCCEEDED' } });
    expect(f.context.repository.listJobs(f.project.id)).toEqual(jobs);
    expect(f.server.state.counts).toEqual(counts);
  });

  it('项目屏障不阻挡无关项目的安全重试及编辑生成', async () => {
    const f = await setup();
    const other = await otherProject(f);
    const source = await legacyOutput(f, other.id);
    const cancelled = await f.backend.invoke('createEditTurn', { sessionId: source.session.id, message: '无关项目调整背景。' });
    await f.backend.invoke('cancelJob', { jobId: cancelled.planJobId });
    await waitJob(f.backend, cancelled.planJobId, 'CANCELLED');
    await f.context.scheduler.waitForIdle([cancelled.planJobId]);
    await enableDirectory(f, other.id);
    await unknownPlan(f);
    const counts = f.server.control.snapshot().counts;
    await f.backend.invoke('retryJob', { jobId: cancelled.planJobId });
    await waitJob(f.backend, cancelled.planJobId);
    await f.context.scheduler.waitForIdle([cancelled.planJobId]);
    const approved = await f.backend.invoke('approveEditTurn', { turnId: cancelled.turnId });
    await waitJob(f.backend, approved.job.id);
    expect(f.server.state.counts.chat).toBe(counts.chat + 1);
    expect(f.server.state.counts['image-edit']).toBe(counts['image-edit'] + 1);
    expect(f.context.repository.listOutputs(other.id)).toHaveLength(2);
    expect(f.context.repository.listJobs(f.project.id)).toEqual([expect.objectContaining({ status: 'UNKNOWN' })]);
  });

  it('未启用产品图片规划的旧项目保留原编辑与恢复行为', async () => {
    const f = await setup();
    const source = await legacyOutput(f);
    const cancelled = await f.backend.invoke('createEditTurn', { sessionId: source.session.id, message: '旧项目恢复编辑。' });
    await f.backend.invoke('cancelJob', { jobId: cancelled.planJobId });
    await waitJob(f.backend, cancelled.planJobId, 'CANCELLED');
    f.server.control.failNext('chat', { type: 'drop' });
    const uncertain = await f.backend.invoke('createPlanningJob', { projectId: f.project.id, planningMode: 'MANUAL', requestedTypes: ['hero-image'] });
    await waitJob(f.backend, uncertain.id, 'UNKNOWN');
    await f.context.scheduler.waitForIdle([uncertain.id]);
    expect(f.context.repository.getProjectImagePlanning(f.project.id)).toBeUndefined();
    expect(f.context.repository.listJobs(f.project.id).every(job => !job.input.productImagePlanning)).toBe(true);
    await f.backend.invoke('retryJob', { jobId: cancelled.planJobId });
    await waitJob(f.backend, cancelled.planJobId);
    await f.context.scheduler.waitForIdle([cancelled.planJobId]);
    const second = await f.backend.invoke('createEditTurn', { sessionId: source.session.id, message: '旧项目另一编辑意图。' });
    await waitJob(f.backend, second.planJobId);
    await f.context.scheduler.waitForIdle([second.planJobId]);
    const approved = await f.backend.invoke('approveEditTurn', { turnId: second.turnId });
    await waitJob(f.backend, approved.job.id);
    expect(f.server.state.counts.chat).toBe(3);
    expect(f.server.state.counts['image-edit']).toBe(1);
    expect(f.context.repository.getJob(uncertain.id)?.status).toBe('UNKNOWN');
  });

  it('无需确认的旧编辑在执行期间启用规划后也不能自动发布新付费子任务', async () => {
    const entered = deferred(), release = deferred();
    const f = await setup({ automatic: true, beforeEditReply: async () => { entered.resolve(); await release.promise; } });
    const source = await legacyOutput(f);
    const edit = await f.backend.invoke('createEditTurn', { sessionId: source.session.id, message: '仅修改蒙版内背景。', editMask: file(f.bytes, 'mask.png') });
    try {
      await entered.promise;
      // 两次旧编辑都在启用新规划之前提交；另一请求真实断连后才保存目录。
      f.server.control.failNext('chat', { type: 'drop' });
      const second = await f.backend.invoke('createEditTurn', { sessionId: source.session.id, message: '另一个旧编辑请求。' });
      await waitJob(f.backend, second.planJobId, 'UNKNOWN');
      await f.context.scheduler.waitForIdle([second.planJobId]);
      await enableDirectory(f);
      const counts = f.server.control.snapshot().counts;
      release.resolve();
      await waitJob(f.backend, edit.planJobId, 'FAILED');
      await f.context.scheduler.waitForIdle([edit.planJobId]);
      expect(f.context.repository.listJobs(f.project.id).filter(job => job.type === 'EDIT_GENERATE')).toEqual([]);
      expect(f.context.repository.listOutputs(f.project.id)).toEqual([source.output]);
      expect(f.server.state.counts).toEqual(counts);
    } finally { release.resolve(); }
  });
});
