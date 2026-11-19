import { describe, expect, it } from 'vitest';
import { type MockRequestContext } from '../../../../scripts/full-mock-provider.mjs';
import { regressionFixtures, file, waitJob } from '../desktop-regression-helpers.js';
import { RuntimeStore } from '../../src/runtime/state.js';

const fixtures = regressionFixtures();
const CORRECT_PROMPT = 'Preserve the exact supplied product cutout and visible view. Change only the background; do not invent unseen angles or redesign the product.';

async function setup(reply: 'correct' | 'mode' | 'always-invalid') {
  const requests: MockRequestContext[] = [];
  let firstPayload: Record<string, any> = {};
  const f = await fixtures.fixture({ mode: 'PIXEL_PROTECTED', mock: {
    replyForRequest: request => {
      if ((request.json as any)?.response_format?.json_schema?.name !== 'ecomgen_visual_storyboard') return undefined;
      requests.push(request);
      if (request.payload.productImageBatch) firstPayload = request.payload;
      const wrong = reply === 'always-invalid' || (reply === 'mode' && requests.length === 1);
      return { campaignStyleLock: 'clean', items: firstPayload.productImageBatch.targets.map((target: any, index: number) => ({
        displayName: `画面${index + 1}`, intent: '展示商品', referenceIntent: '保留统一视觉方向',
        mode: wrong ? 'CREATIVE' : firstPayload.defaultMode, referencedAssets: target.productHandles,
        promptInstruction: wrong ? 'Invent a new hidden product view.' : CORRECT_PROMPT, factClaims: [], riskFlags: [],
      })) };
    },
  } });
  await f.backend.invoke('updateProject', { projectId: f.project.id, candidatesPerType: 3 });
  await f.backend.invoke('uploadAsset', { projectId: f.project.id, role: 'PRODUCT_TRUTH', file: file(f.bytes, 'truth.png') });
  const planning = await f.backend.invoke('saveProjectImagePlanning', { projectId: f.project.id, expectedRevision: 0,
    config: { mainCount: 1, detailCount: 0, skuImagesPerGroup: 1, shareImages: false }, skus: [], imageGroups: [],
  });
  const submit = () => f.backend.invoke('createProductImagePlanningJob', { projectId: f.project.id, expectedRevision: planning.planning.revision });
  return { ...f, requests, submit };
}

function userText(request: MockRequestContext): string {
  const messages = request.json?.messages as Array<{ role?: string; content?: string | Array<{ text?: string }> }> | undefined;
  const message = messages?.filter(entry => entry.role === 'user').at(-1);
  return typeof message?.content === 'string' ? message.content : (message?.content ?? []).map(part => part.text ?? '').join('\n');
}

describe('规划候选数与模式：真实Backend、SQLite、Pi及本机SSE', () => {
  it('正确方案一次发布，候选数仅从本地冻结配置赋值', async () => {
    const f = await setup('correct');
    const job = await f.submit(); await waitJob(f.backend, job.id);
    expect(f.requests).toHaveLength(1);
    const request = JSON.stringify(f.requests[0]!.json);
    expect(request).not.toMatch(/candidateCount|candidatesPerType/);
    expect(userText(f.requests[0]!)).toContain('PIXEL_PROTECTED');
    const snapshot = new RuntimeStore((f.context.repository as any).db).get(job.id)!.snapshot;
    expect((snapshot.effective.execution as any).reads[`getProject:${JSON.stringify([f.project.id])}`]).toMatchObject({ candidatesPerType: 3, defaultMode: 'PIXEL_PROTECTED' });
    const board = await f.backend.invoke('getStoryboard', { projectId: f.project.id });
    expect(board.items[0]).toMatchObject({ candidateCount: 3, mode: 'PIXEL_PROTECTED', promptInstruction: CORRECT_PROMPT });
    expect(f.server.state.counts['image-generation'] + f.server.state.counts['image-edit']).toBe(0);
  });

  it('模式冲突仅纠正一次，保存纠正后的完整提示词且两轮分别记账', async () => {
    const f = await setup('mode');
    const job = await f.submit(); await waitJob(f.backend, job.id);
    expect(f.requests).toHaveLength(2);
    expect(userText(f.requests[1]!)).toContain('PIXEL_PROTECTED');
    expect(JSON.stringify(f.requests[1]!.json)).not.toMatch(/candidateCount|candidatesPerType/);
    expect(userText(f.requests[1]!)).toContain('do not only relabel its mode field');
    const board = await f.backend.invoke('getStoryboard', { projectId: f.project.id });
    expect(board.items[0]).toMatchObject({ candidateCount: 3, mode: 'PIXEL_PROTECTED', promptInstruction: CORRECT_PROMPT });
    expect(f.context.requestLedger.summaries(job.id)).toEqual([
      { requestKey: 'product-plan:batch:001:model:0', state: 'COMPLETED', localState: 'COMMITTED' },
      { requestKey: 'product-plan:batch:001:model:1', state: 'COMPLETED', localState: 'COMMITTED' },
    ]);
    expect(f.context.repository.listPlanningConfigSnapshots(f.project.id)).toHaveLength(1);
  });

  it('两轮都冲突则失败，不发布、不覆盖字段；重放已有回执不新增请求', async () => {
    const f = await setup('always-invalid');
    const job = await f.submit(); await waitJob(f.backend, job.id, 'FAILED');
    await f.context.scheduler.waitForIdle([job.id]);
    expect(f.requests).toHaveLength(2);
    expect(f.context.repository.listStoryboardItems(f.project.id)).toEqual([]);
    expect(f.context.repository.listPlanningConfigSnapshots(f.project.id)).toEqual([]);
    expect(f.context.requestLedger.summaries(job.id).every(request => request.state === 'COMPLETED' && request.localState === 'PENDING')).toBe(true);
    await f.backend.invoke('retryJob', { jobId: job.id });
    await waitJob(f.backend, job.id, 'FAILED');
    expect(f.requests).toHaveLength(2);
    expect(f.context.repository.listStoryboardItems(f.project.id)).toEqual([]);
  });

  it('第一轮断线保留UNKNOWN，不进入配置纠正或发送下一轮', async () => {
    const f = await setup('correct');
    f.server.control.failNext('chat', { type: 'drop' });
    const job = await f.submit(); await waitJob(f.backend, job.id, 'UNKNOWN');
    expect(f.server.state.counts.chat).toBe(1);
    expect(f.context.requestLedger.summaries(job.id)).toEqual([{ requestKey: 'product-plan:batch:001:model:0', state: 'UNKNOWN', localState: 'PENDING' }]);
    expect(f.context.repository.listStoryboardItems(f.project.id)).toEqual([]);
  });
});
