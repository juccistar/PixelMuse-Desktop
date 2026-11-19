import { webcrypto } from 'node:crypto';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { App as AntdApp, ConfigProvider } from 'antd';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, Route, RouterProvider, Routes } from 'react-router';
import type { ProjectImagePlanning, ProjectSku } from '@ecomgen/contracts';
import { adaptProjectDetail, type StoryboardItem } from '../../api/adapters/projectDetail';
import { BusinessActivityContext } from '../../components/businessActivity';
import type { BeforeNavigate } from '../../components/navigationGuard';
import { clearPlanningIntent, readPlanningIntent, readProjectPlanningDraft, saveProjectPlanningDraft } from '../../lib/projectPreparation';
import { FakeDesktop } from '../../test/fake-desktop';
import { ASSET_ID, GENERATE_JOB_FIXTURE, PLAN_JOB_FIXTURE, PRODUCT_IMAGE_CONTEXT_FIXTURE, PROJECT_ID, PROJECT_IMAGE_PLANNING_FIXTURE, STORYBOARD_FIXTURE, STORYBOARD_ITEM_B_FIXTURE, STORYBOARD_ITEM_FIXTURE, projectDetailPayload } from '../../test/fixtures';
import { renderWithProviders } from '../../test/render';
import { StoryboardStage } from './StoryboardStage';
import { WorkbenchPage } from './WorkbenchPage';

function renderPlanning(ui: ReactElement, options?: Parameters<typeof renderWithProviders>[1]) {
  // jsdom 只验证交互结果；CSS 过渡由真实 Electron 验收，避免关闭动画遮住下一次操作。
  const content = (element: ReactElement) => <ConfigProvider theme={{ token: { motion: false } }}>{element}</ConfigProvider>;
  const view = renderWithProviders(content(ui), options);
  return { ...view, rerender: (element: ReactElement) => view.rerender(content(element)) };
}

let desktop: FakeDesktop;
beforeEach(() => {
  // AntD 在 test 环境把所有关联标题 ID 固定为 test-id；使用运行环境的唯一 ID，
  // 才能真实断言同时打开的 SKU 抽屉和确认弹窗各自的无障碍名称。
  vi.stubEnv('NODE_ENV', 'development');
  // jsdom 没有 SubtleCrypto；使用真实 Web Crypto 验证意图摘要。
  vi.stubGlobal('crypto', webcrypto);
  desktop = new FakeDesktop().install();
  // 共享草稿和未决请求都跨组件存活；各场景从独立项目意图开始。
  saveProjectPlanningDraft(PROJECT_ID, { selectionMode: 'AI', requestedTypes: [], requestedSuiteShots: [], instruction: '' });
  const pendingIntent = readPlanningIntent(PROJECT_ID);
  if (pendingIntent) clearPlanningIntent(PROJECT_ID, pendingIntent.regenerationKey);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const uuid = (index: number) => `11111111-2222-4333-8444-${String(index).padStart(12, '0')}`;
const freshPlanning = (): ProjectImagePlanning => ({ ...structuredClone(PROJECT_IMAGE_PLANNING_FIXTURE), revision: 1, updatedAt: '2026-11-07T00:00:00.000Z' });
function installDirectory(initial: ProjectImagePlanning) {
  let planning = structuredClone(initial);
  desktop.on('getProjectImagePlanning', () => planning);
  desktop.on('saveProjectImagePlanning', input => {
    if (input.expectedRevision !== planning.revision) throw Object.assign(new Error('目录版本冲突'), { code: 'CONFLICT' });
    planning = { projectId: input.projectId, revision: planning.revision + 1, config: input.config, skus: input.skus, imageGroups: input.imageGroups, updatedAt: '2026-11-07T00:01:00.000Z' };
    return { planning, staleItemIds: [] };
  });
  desktop.on('createProductImagePlanningJob', () => ({ ...PLAN_JOB_FIXTURE, reused: false }));
}
function stage(items: StoryboardItem[] = [], props: Partial<Parameters<typeof StoryboardStage>[0]> = {}) {
  const detail = adaptProjectDetail(projectDetailPayload({ items, storyboard: items.length ? STORYBOARD_FIXTURE : null, candidatesPerType: 2 }));
  desktop.on('getStoryboard', () => ({ storyboard: items.length ? STORYBOARD_FIXTURE : null, items }));
  return renderPlanning(<StoryboardStage detail={detail} {...props}/>);
}
const callsTo = (name: string) => vi.mocked(desktop.api.invoke).mock.calls.filter(call => call[0] === name);
async function openSkuEditor(user: ReturnType<typeof userEvent.setup>) {
  const button = screen.getByRole('button', { name: '管理 SKU' });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
}

async function expandDetails(user: ReturnType<typeof userEvent.setup>, text: string | RegExp) {
  const summary = await screen.findByText(text, { selector: 'summary' });
  const details = summary.closest('details')!;
  if (!details.open) await user.click(summary);
  expect(details).toHaveAttribute('open');
}
async function openPlanningInstruction(user: ReturnType<typeof userEvent.setup>) {
  await expandDetails(user, /^图片需求 ·/);
  await expandDetails(user, '规划要求（可选）');
}

// 测目录事务、模型提交和所选画面边界，不依赖卡片样式。
describe('商品图片规划完整路径', () => {
  it('空目录不创建样例；先保存数量，再用保存回执版本及独立规划要求提交', async () => {
    stage();
    expect(await screen.findByText(/SKU 0 个 · 0 组图片/)).toBeInTheDocument();
    const order: string[] = [];
    desktop.on('saveProjectImagePlanning', input => {
      order.push('save');
      return { planning: { ...freshPlanning(), revision: 7, config: input.config }, staleItemIds: [] };
    });
    desktop.on('createProductImagePlanningJob', input => {
      order.push('plan');
      expect(input.expectedRevision).toBe(7);
      return { ...PLAN_JOB_FIXTURE, reused: false };
    });
    const user = userEvent.setup();
    fireEvent.change(screen.getByRole('spinbutton', { name: '主图数量' }), { target: { value: '5' } });
    fireEvent.blur(screen.getByRole('spinbutton', { name: '主图数量' }));
    await openPlanningInstruction(user);
    await user.type(screen.getByRole('textbox', { name: '图片规划要求' }), '强调包装细节');
    await user.click(screen.getByRole('button', { name: '生成图片规划' }));
    await waitFor(() => expect(callsTo('createProductImagePlanningJob')).toHaveLength(1));
    expect(order).toEqual(['save', 'plan']);
    expect(callsTo('saveProjectImagePlanning')[0]![1]).toMatchObject({ projectId: PROJECT_ID, expectedRevision: 0, config: { mainCount: 5 }, skus: [], imageGroups: [] });
    expect(callsTo('createProductImagePlanningJob')[0]![1]).toMatchObject({ expectedRevision: 7, scope: 'ALL', userInstruction: '强调包装细节', regenerationKey: expect.any(String) });
    expect(callsTo('createGenerationJobs')).toHaveLength(0);
  });

  it('规划回执丢失后重按保留同一regenerationKey，实际输入改变后使用新意图', async () => {
    installDirectory(freshPlanning());
    const keys: string[] = [];
    desktop.on('createProductImagePlanningJob', input => {
      keys.push(input.regenerationKey!);
      if (keys.length === 1) throw new Error('IPC 回执丢失');
      return { ...PLAN_JOB_FIXTURE, status: 'SUCCEEDED', reused: keys.length === 2 };
    });
    desktop.on('getJob', () => ({ ...PLAN_JOB_FIXTURE, status: 'SUCCEEDED' }));
    stage();
    const user = userEvent.setup();
    const submit = await screen.findByRole('button', { name: '生成图片规划' });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    await screen.findByText('图片规划未提交');
    expect(keys).toHaveLength(1);
    await user.click(submit);
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).toBe(keys[0]);
    await openPlanningInstruction(user);
    await user.type(screen.getByRole('textbox', { name: '图片规划要求' }), '新的实际规划要求');
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    await waitFor(() => expect(keys).toHaveLength(3));
    expect(keys[2]).not.toBe(keys[0]);
    expect(callsTo('createGenerationJobs')).toHaveLength(0);
  });

  it('规划回执丢失后真实卸载并重挂仍重放同一意图，明确回执后才释放', async () => {
    installDirectory(freshPlanning());
    const instruction = '需要保留的私有规划说明';
    const keys: string[] = [];
    desktop.on('createProductImagePlanningJob', input => {
      expect(input.userInstruction).toBe(instruction);
      keys.push(input.regenerationKey!);
      if (keys.length === 1) throw new Error('任务已成功，但 IPC 回执丢失');
      return { ...PLAN_JOB_FIXTURE, status: 'SUCCEEDED', reused: keys.length === 2 };
    });
    desktop.on('getJob', () => ({ ...PLAN_JOB_FIXTURE, status: 'SUCCEEDED' }));
    const first = stage();
    const user = userEvent.setup();
    await openPlanningInstruction(user);
    fireEvent.change(screen.getByRole('textbox', { name: '图片规划要求' }), { target: { value: instruction } });
    await user.click(screen.getByRole('button', { name: '生成图片规划' }));
    await screen.findByText('图片规划未提交');
    const storageKey = `pixelmuse.imagePlanningIntent.${PROJECT_ID}`;
    const persistedIntent = sessionStorage.getItem(storageKey)!;
    const draftStorageKey = `pixelmuse.projectPreparation.${PROJECT_ID}`;
    const persistedDraft = localStorage.getItem(draftStorageKey)!;
    expect(JSON.parse(persistedDraft)).toMatchObject({ instruction });
    expect(persistedIntent).not.toContain(instruction);
    expect(JSON.parse(persistedIntent)).toEqual({ fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), regenerationKey: keys[0] });
    first.unmount();
    const second = stage();
    const submit = await screen.findByRole('button', { name: '生成图片规划' });
    await waitFor(() => expect(submit).toBeEnabled());
    expect(keys).toHaveLength(1);
    await openPlanningInstruction(user);
    expect(screen.getByRole('textbox', { name: '图片规划要求' })).toHaveValue(instruction);
    await user.click(submit);
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).toBe(keys[0]);
    await waitFor(() => expect(sessionStorage.getItem(storageKey)).toBeNull());
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    await waitFor(() => expect(keys).toHaveLength(3));
    expect(keys[2]).not.toBe(keys[0]);
    await waitFor(() => expect(sessionStorage.getItem(storageKey)).toBeNull());
    second.unmount();
    // 清空内存草稿后恢复实际写出的持久记录，证明无需重新输入也能重放原意图。
    saveProjectPlanningDraft(PROJECT_ID, { ...readProjectPlanningDraft(PROJECT_ID), instruction: '' });
    localStorage.setItem(draftStorageKey, persistedDraft);
    sessionStorage.setItem(storageKey, persistedIntent);
    stage();
    await openPlanningInstruction(user);
    const restored = screen.getByRole('textbox', { name: '图片规划要求' });
    expect(restored).toHaveValue(instruction);
    await user.click(screen.getByRole('button', { name: '生成图片规划' }));
    await waitFor(() => expect(keys).toHaveLength(4));
    expect(keys[3]).toBe(keys[0]);
  });

  it('显式三组共图为16画面32候选；取消共图保存后为19画面38候选且不启动模型', async () => {
    const skus: ProjectSku[] = Array.from({ length: 6 }, (_, index) => ({ id: uuid(index + 1), name: `实际规格 ${index + 1}`, code: null, attributes: [], included: true, productAssetIds: [ASSET_ID] }));
    installDirectory({ ...freshPlanning(), config: { mainCount: 5, detailCount: 8, skuImagesPerGroup: 1, shareImages: true }, skus, imageGroups: Array.from({ length: 3 }, (_, index) => ({ id: uuid(index + 20), name: `确认共图组 ${index + 1}`, skuIds: skus.slice(index * 2, index * 2 + 2).map(sku => sku.id), productAssetIds: [ASSET_ID] })) });
    stage();
    expect(await screen.findByText(/16 个画面 · 每画面 2 个候选 · 预计生成 32 张/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '管理 SKU' }));
    const drawer = await screen.findByRole('dialog', { name: /管理 SKU/ });
    await user.click(within(drawer).getByRole('checkbox', { name: '同外观规格共用图片' }));
    await user.click(within(drawer).getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(drawer).not.toBeVisible());
    expect(await screen.findByText(/19 个画面 · 每画面 2 个候选 · 预计生成 38 张/)).toBeInTheDocument();
    expect(callsTo('saveProjectImagePlanning')).toHaveLength(1);
    expect(callsTo('createProductImagePlanningJob')).toHaveLength(0);
    expect(callsTo('createPlanningJob')).toHaveLength(0);
    expect(callsTo('createGenerationJobs')).toHaveLength(0);
  });

  it('保存冲突保留数量草稿，不继续提交规划或生成', async () => {
    desktop.on('saveProjectImagePlanning', () => { throw Object.assign(new Error('目录版本冲突'), { code: 'CONFLICT' }); });
    stage();
    const count = await screen.findByRole('spinbutton', { name: '主图数量' });
    fireEvent.change(count, { target: { value: '3' } }); fireEvent.blur(count);
    await userEvent.setup().click(screen.getByRole('button', { name: '生成图片规划' }));
    await screen.findByText('图片规划未提交');
    expect(count).toHaveValue('3');
    expect(within(screen.getByRole('region', { name: '图片数量' })).getByText(/数量未保存/)).toBeVisible();
    expect(callsTo('createProductImagePlanningJob')).toHaveLength(0);
    expect(callsTo('createGenerationJobs')).toHaveLength(0);
  });

  it('用途和仅看已选筛选保留选择；按画面独立候选数和当前版本确认生成', async () => {
    installDirectory({ ...freshPlanning(), config: { mainCount: 1, detailCount: 1, skuImagesPerGroup: 1, shareImages: false } });
    const main = { ...STORYBOARD_ITEM_FIXTURE, candidateCount: 4, imagePlanning: PRODUCT_IMAGE_CONTEXT_FIXTURE };
    const detail = { ...STORYBOARD_ITEM_B_FIXTURE, candidateCount: 3, imagePlanning: { ...PRODUCT_IMAGE_CONTEXT_FIXTURE, purpose: 'DETAIL' as const, targetId: 'DETAIL:1' } };
    const old = { ...main, id: uuid(50), displayName: '已被替代画面', planningSuperseded: true };
    const onGenerated = vi.fn();
    stage([main, detail, old], { onGenerated });
    desktop.on('confirmStoryboard', () => ({ ...STORYBOARD_FIXTURE, status: 'CONFIRMED' }));
    desktop.on('createGenerationJobs', () => ({ jobs: [GENERATE_JOB_FIXTURE], reused: false }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: `选择${main.displayName}` }));
    await user.click(screen.getByRole('tab', { name: '详情图 1' }));
    expect(screen.queryByRole('button', { name: `${main.displayName} 分镜` })).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: `选择${detail.displayName}` }));
    await user.click(screen.getByRole('checkbox', { name: '仅看已选' }));
    await user.click(screen.getByRole('tab', { name: '全部 2' }));
    expect(screen.getByRole('checkbox', { name: `选择${main.displayName}` })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('共 2 个 · 预计 7/7 张候选')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '已被替代画面 分镜' })).not.toBeInTheDocument();
    const generate = screen.getByRole('button', { name: '确认并生成' });
    await waitFor(() => expect(generate).toBeEnabled());
    await user.click(generate);
    await waitFor(() => expect(onGenerated).toHaveBeenCalledOnce());
    expect(callsTo('confirmStoryboard')[0]![1]).toEqual({ projectId: PROJECT_ID, version: STORYBOARD_FIXTURE.version });
    expect(callsTo('createGenerationJobs')[0]![1]).toEqual({ projectId: PROJECT_ID, storyboardItemIds: [main.id, detail.id] });
  });

  it.each(['stale', 'incomplete', 'unknown', 'retire-only'] as const)('%s 状态阻止确认生成；更新只用显式STALE意图', async reason => {
    installDirectory({ ...freshPlanning(), config: { mainCount: reason === 'retire-only' ? 0 : 1, detailCount: reason === 'incomplete' ? 1 : 0, skuImagesPerGroup: 1, shareImages: false } });
    const item = { ...STORYBOARD_ITEM_FIXTURE, imagePlanning: PRODUCT_IMAGE_CONTEXT_FIXTURE, planningStale: reason === 'stale' || reason === 'retire-only' };
    const jobs = reason === 'unknown' ? [{ ...PLAN_JOB_FIXTURE, status: 'UNKNOWN', retryable: false }] : [];
    const detail = adaptProjectDetail(projectDetailPayload({ items: [item], storyboard: STORYBOARD_FIXTURE, jobs }));
    desktop.on('getStoryboard', () => ({ storyboard: STORYBOARD_FIXTURE, items: [item] }));
    renderPlanning(<StoryboardStage detail={detail}/>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: `选择${item.displayName}` }));
    await expandDetails(user, /^图片需求 ·/);
    expect(screen.getByRole('spinbutton', { name: '主图数量' })).toBeVisible();
    expect(screen.getByRole('button', { name: '确认并生成' })).toBeDisabled();
    if (reason === 'unknown') {
      expect(screen.getByRole('button', { name: '重做整套方案' })).toBeDisabled();
      expect(callsTo('createProductImagePlanningJob')).toHaveLength(0);
    }
    else {
      await user.click(screen.getByRole('button', { name: '更新受影响规划' }));
      await waitFor(() => expect(callsTo('createProductImagePlanningJob')).toHaveLength(1));
      expect(callsTo('createProductImagePlanningJob')[0]![1]).toMatchObject({ expectedRevision: 1, scope: 'STALE' });
    }
    expect(callsTo('confirmStoryboard')).toHaveLength(0);
    expect(callsTo('createGenerationJobs')).toHaveLength(0);
  });

  it.each(['关闭', 'SKU 抽屉', '任务抽屉', '工作阶段', '其他分镜', '项目路由'] as const)('%s 在防抖前等待分镜保存，延迟失败保留编辑器，重试成功后恢复操作', async destination => {
    installDirectory({ ...freshPlanning(), config: { mainCount: 1, detailCount: 0, skuImagesPerGroup: 1, shareImages: false } });
    let item = { ...STORYBOARD_ITEM_FIXTURE, imagePlanning: PRODUCT_IMAGE_CONTEXT_FIXTURE };
    const second = { ...STORYBOARD_ITEM_B_FIXTURE, promptInstruction: '第二个画面的原始说明' };
    desktop.on('getProject', () => projectDetailPayload({ items: [item, second], storyboard: STORYBOARD_FIXTURE }));
    desktop.on('getStoryboard', () => ({ storyboard: STORYBOARD_FIXTURE, items: [item, second] }));
    let rejectSave!: (error: Error) => void;
    let attempt = 0;
    desktop.on('updateStoryboardItem', input => {
      attempt++;
      if (attempt === 1) return new Promise<StoryboardItem>((_resolve, reject) => { rejectSave = reject; });
      // 与真实 updateStoryboardItem 的 readText 一样返回规范化回执。
      item = { ...item, promptInstruction: input.promptInstruction?.trim() ?? item.promptInstruction };
      return item;
    });
    const router = createMemoryRouter([
      { path: '/projects/:projectId', element: <WorkbenchPage/> },
      { path: '/away', element: <p>已离开分镜项目</p> },
    ], { initialEntries: [`/projects/${PROJECT_ID}?view=storyboard`] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    if (destination === '工作阶段' || destination === '项目路由') {
      render(<QueryClientProvider client={client}><ConfigProvider theme={{ token: { motion: false } }} button={{ autoInsertSpace: false }}><AntdApp><RouterProvider router={router}/></AntdApp></ConfigProvider></QueryClientProvider>);
    } else {
      stage([item, second]);
      desktop.on('getStoryboard', () => ({ storyboard: STORYBOARD_FIXTURE, items: [item, second] }));
    }
    const board = within(await screen.findByRole('region', { name: '图片规划' }));
    const generate = board.getByRole('button', { name: '确认并生成' });
    const user = userEvent.setup();
    await user.click(board.getByRole('checkbox', { name: `选择${item.displayName}` }));
    await user.click(board.getByRole('button', { name: `${item.displayName} 分镜` }));
    const prompt = await screen.findByLabelText('生图 Prompt');
    const editor = within(screen.getByRole('complementary', { name: '画面检查器' }));
    fireEvent.change(prompt, { target: { value: '  关闭前必须保存的实际编辑  ' } });
    expect(attempt).toBe(0);
    const leave = () => {
      if (destination === '关闭') fireEvent.click(editor.getByRole('button', { name: '关闭画面检查器' }));
      else if (destination === 'SKU 抽屉') fireEvent.click(board.getByRole('button', { name: '管理 SKU' }));
      else if (destination === '任务抽屉') fireEvent.click(board.getByRole('button', { name: '任务详情' }));
      else if (destination === '工作阶段') fireEvent.click(within(screen.getByRole('navigation', { name: '工作阶段' })).getByRole('button', { name: /商品准备/ }));
      else if (destination === '其他分镜') fireEvent.click(board.getByRole('button', { name: `${second.displayName} 分镜` }));
      else void router.navigate('/away');
    };
    await act(async () => { leave(); });
    await waitFor(() => expect(attempt).toBe(1));
    expect(prompt).toBeVisible();
    expect(generate).toBeDisabled();
    await act(async () => { rejectSave(new Error('延迟返回的真实保存失败')); });
    await editor.findByText('保存失败，可重试编辑');
    expect(prompt).toBeVisible();
    expect(prompt).toHaveValue('  关闭前必须保存的实际编辑  ');
    if (destination === '工作阶段' || destination === '项目路由') expect(router.state.location.pathname).toBe(`/projects/${PROJECT_ID}`);
    expect(screen.queryByRole('dialog', { name: /管理 SKU|任务详情/ })).not.toBeInTheDocument();
    expect(generate).toBeDisabled();
    await act(async () => { leave(); });
    await waitFor(() => expect(attempt).toBe(2));
    if (destination === '其他分镜') expect(await screen.findByLabelText('生图 Prompt')).toHaveValue(second.promptInstruction);
    else await waitFor(() => expect(prompt).not.toBeVisible());
    if (destination === '关闭') await waitFor(() => expect(generate).toBeEnabled());
    if (destination === 'SKU 抽屉') expect(await screen.findByRole('dialog', { name: /管理 SKU/ })).toBeVisible();
    if (destination === '任务抽屉') expect(await screen.findByRole('dialog', { name: '任务详情' })).toBeVisible();
    if (destination === '工作阶段') expect(await screen.findByRole('button', { name: '模型自主规划' })).toBeVisible();
    if (destination === '项目路由') expect(await screen.findByText('已离开分镜项目')).toBeVisible();
    expect(callsTo('updateStoryboardItem')[1]![1]).toMatchObject({ itemId: item.id, promptInstruction: '  关闭前必须保存的实际编辑  ' });
    expect(callsTo('createProductImagePlanningJob')).toHaveLength(0);
    expect(callsTo('createGenerationJobs')).toHaveLength(0);
  });

  it.each(['检查器', '卡片'] as const)('通过%s明确删除正在编辑的分镜会清理草稿和防抖，剩余画面可继续确认生成', async entry => {
    let items = [STORYBOARD_ITEM_FIXTURE, STORYBOARD_ITEM_B_FIXTURE];
    stage(items);
    desktop.on('getStoryboard', () => ({ storyboard: STORYBOARD_FIXTURE, items }));
    desktop.on('deleteStoryboardItem', input => { items = items.filter(item => item.id !== input.itemId); return null; });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: `选择${STORYBOARD_ITEM_B_FIXTURE.displayName}` }));
    await user.click(screen.getByRole('button', { name: `${STORYBOARD_ITEM_FIXTURE.displayName} 分镜` }));
    const prompt = await screen.findByLabelText('生图 Prompt');
    vi.useFakeTimers();
    try {
      fireEvent.change(prompt, { target: { value: '删除时明确放弃的未保存内容' } });
      fireEvent.click(entry === '卡片'
        ? screen.getByRole('button', { name: `删除${STORYBOARD_ITEM_FIXTURE.displayName}` })
        : within(screen.getByRole('complementary', { name: '画面检查器' })).getByRole('button', { name: '取消此图片需求' }));
      const confirmation = screen.getByRole('dialog', { name: '取消此图片需求？' });
      await act(async () => {
        fireEvent.click(within(confirmation).getByRole('button', { name: '取消图片需求' }));
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(callsTo('deleteStoryboardItem')).toHaveLength(1);
      expect(callsTo('updateStoryboardItem')).toHaveLength(0);
      expect(prompt).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: `${STORYBOARD_ITEM_FIXTURE.displayName} 分镜` })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: '确认并生成' })).toBeEnabled();
    } finally { vi.useRealTimers(); }
  });

  it('自动保存已在途时关闭等待原回执，失败不隐式重试也不卸载草稿', async () => {
    stage([STORYBOARD_ITEM_FIXTURE]);
    let rejectSave!: (error: Error) => void;
    desktop.on('updateStoryboardItem', () => new Promise<StoryboardItem>((_resolve, reject) => { rejectSave = reject; }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: `${STORYBOARD_ITEM_FIXTURE.displayName} 分镜` }));
    const prompt = await screen.findByRole('textbox', { name: '生图 Prompt' });
    fireEvent.change(prompt, { target: { value: '已发出保存的草稿' } });
    await waitFor(() => expect(callsTo('updateStoryboardItem')).toHaveLength(1));
    fireEvent.click(within(screen.getByRole('complementary', { name: '画面检查器' })).getByRole('button', { name: '关闭画面检查器' }));
    expect(prompt).toBeVisible();
    await act(async () => { rejectSave(new Error('在途自动保存失败')); });
    await screen.findByText('保存失败，可重试编辑');
    expect(callsTo('updateStoryboardItem')).toHaveLength(1);
    expect(prompt).toBeVisible();
    expect(prompt).toHaveValue('已发出保存的草稿');
    expect(screen.getByRole('button', { name: '重做整套方案' })).toBeDisabled();
  });

  it('任务抽屉切换先确认SKU脏草稿；取消后输入保留，保存后任务与SKU抽屉互斥', async () => {
    let guard: BeforeNavigate | null = null;
    stage([], { registerNavigationGuard: value => { guard = value; } });
    const user = userEvent.setup();
    await openSkuEditor(user);
    const drawer = await screen.findByRole('dialog', { name: /管理 SKU/ });
    await user.click(within(drawer).getByRole('button', { name: '添加 SKU' }));
    await user.type(within(drawer).getByRole('textbox', { name: 'SKU 1 名称' }), '真实规格');
    await waitFor(() => expect(guard).toBeTypeOf('function'));
    await user.click(screen.getByRole('button', { name: '任务详情' }));
    const confirm = await screen.findByRole('dialog', { name: '放弃未保存的图片规划修改？' });
    await user.click(within(confirm).getByRole('button', { name: '继续编辑' }));
    await waitFor(() => expect(confirm).not.toBeInTheDocument());
    expect(within(drawer).getByRole('textbox', { name: 'SKU 1 名称' })).toHaveValue('真实规格');
    expect(screen.queryByRole('dialog', { name: '任务详情' })).not.toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(drawer).not.toBeVisible());
    await user.click(screen.getByRole('button', { name: '任务详情' }));
    expect(await screen.findByRole('dialog', { name: '任务详情' })).toBeVisible();
    expect(callsTo('createProductImagePlanningJob')).toHaveLength(0);
  });

  it('业务页隐藏时SKU portal不可交互，返回后仍保留未保存草稿', async () => {
    const detail = adaptProjectDetail(projectDetailPayload());
    const view = renderPlanning(<BusinessActivityContext.Provider value={true}><StoryboardStage detail={detail}/></BusinessActivityContext.Provider>);
    const user = userEvent.setup();
    await openSkuEditor(user);
    await user.click(await screen.findByRole('button', { name: '添加 SKU' }));
    await user.type(screen.getByRole('textbox', { name: 'SKU 1 名称' }), '保留草稿');
    view.rerender(<BusinessActivityContext.Provider value={false}><StoryboardStage detail={detail}/></BusinessActivityContext.Provider>);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /管理 SKU/ })).not.toBeInTheDocument());
    view.rerender(<BusinessActivityContext.Provider value={true}><StoryboardStage detail={detail}/></BusinessActivityContext.Provider>);
    expect(await screen.findByRole('textbox', { name: 'SKU 1 名称' })).toHaveValue('保留草稿');
  });

  it('数据路由离开项目前确认SKU脏草稿，取消保留项目和输入，放弃后才卸载', async () => {
    const router = createMemoryRouter([
      { path: '/projects/:projectId', element: <WorkbenchPage/> },
      { path: '/away', element: <p>其他工作空间</p> },
    ], { initialEntries: [`/projects/${PROJECT_ID}?view=storyboard`] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><ConfigProvider theme={{ token: { motion: false } }} button={{ autoInsertSpace: false }}><AntdApp><RouterProvider router={router}/></AntdApp></ConfigProvider></QueryClientProvider>);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: '图片规划' });
    await openSkuEditor(user);
    await user.click(await screen.findByRole('button', { name: '添加 SKU' }));
    await user.type(screen.getByRole('textbox', { name: 'SKU 1 名称' }), '项目切换草稿');
    await act(async () => { void router.navigate('/away'); });
    const confirm = await screen.findByRole('dialog', { name: '放弃未保存的图片规划修改？' });
    await user.click(within(confirm).getByRole('button', { name: '继续编辑' }));
    await waitFor(() => expect(confirm).not.toBeInTheDocument());
    await waitFor(() => expect(router.state.blockers.size === 0 || Array.from(router.state.blockers.values()).every(blocker => blocker.state === 'unblocked')).toBe(true));
    expect(router.state.location.pathname).toBe(`/projects/${PROJECT_ID}`);
    expect(screen.getByRole('textbox', { name: 'SKU 1 名称' })).toHaveValue('项目切换草稿');
    await act(async () => { void router.navigate('/away'); });
    const discard = await screen.findByRole('dialog', { name: '放弃未保存的图片规划修改？' });
    await act(async () => { fireEvent.click(within(discard).getByRole('button', { name: '放弃修改' })); });
    expect(await screen.findByText('其他工作空间')).toBeInTheDocument();
    expect(callsTo('saveProjectImagePlanning')).toHaveLength(0);
  });

  it('往返商品准备与图片规划共享说明，自主风格和双向编辑草稿写入持久存储', async () => {
    const page = <Routes><Route path="/projects/:projectId" element={<WorkbenchPage/>}/></Routes>;
    const view = renderPlanning(page, { initialEntries: [`/projects/${PROJECT_ID}?view=setup`] });
    const user = userEvent.setup();
    expect(await screen.findByRole('button', { name: '模型自主规划' })).toHaveAttribute('data-active', 'true');
    expect(screen.queryByRole('button', { name: '指定模板' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: '风格指导' }), { target: { value: '参考图的暗部与侧光' } });
    fireEvent.change(screen.getByRole('textbox', { name: '补充说明' }), { target: { value: '保留原手动模板要求' } });
    await user.click(within(screen.getByRole('navigation', { name: '工作阶段' })).getByRole('button', { name: /图片规划/ }));
    await screen.findByRole('heading', { name: '图片规划' });
    expect(screen.queryByRole('complementary', { name: '制作配置', hidden: true })).not.toBeInTheDocument();
    await openPlanningInstruction(user);
    const instruction = screen.getByRole('textbox', { name: '图片规划要求' });
    expect(instruction).toHaveValue('保留原手动模板要求');
    fireEvent.change(instruction, { target: { value: '保留原手动模板要求，规划页补充包装细节' } });
    await user.click(within(screen.getByRole('navigation', { name: '工作阶段' })).getByRole('button', { name: /商品准备/ }));
    expect(await screen.findByRole('textbox', { name: '补充说明' })).toHaveValue('保留原手动模板要求，规划页补充包装细节');
    expect(screen.getByRole('button', { name: '模型自主规划' })).toHaveAttribute('data-active', 'true');
    expect(screen.getByRole('textbox', { name: '风格指导' })).toHaveValue('参考图的暗部与侧光');
    const storageKey = `pixelmuse.projectPreparation.${PROJECT_ID}`;
    const persistedDraft = localStorage.getItem(storageKey)!;
    expect(JSON.parse(persistedDraft)).toMatchObject({ selectionMode: 'AI', styleInstruction: '参考图的暗部与侧光', instruction: '保留原手动模板要求，规划页补充包装细节' });
    view.unmount();
    expect(callsTo('createPlanningJob')).toHaveLength(0);
    expect(callsTo('createProductImagePlanningJob')).toHaveLength(0);
    expect(callsTo('createGenerationJobs')).toHaveLength(0);
  });

  it('旧手动模板草稿保留共享说明，重新进入准备页使用自主规划且不提交模型任务', async () => {
    const storageKey = `pixelmuse.projectPreparation.${PROJECT_ID}`;
    localStorage.setItem(storageKey, JSON.stringify({ selectionMode: 'MANUAL', requestedTypes: [STORYBOARD_ITEM_FIXTURE.assetType], requestedSuiteShots: [], instruction: '保留原手动模板要求，规划页补充包装细节' }));
    renderPlanning(<Routes><Route path="/projects/:projectId" element={<WorkbenchPage/>}/></Routes>, { initialEntries: [`/projects/${PROJECT_ID}?view=setup`] });
    expect(await screen.findByRole('textbox', { name: '补充说明' })).toHaveValue('保留原手动模板要求，规划页补充包装细节');
    expect(screen.getByRole('button', { name: '模型自主规划' })).toHaveAttribute('data-active', 'true');
    expect(screen.queryByRole('button', { name: '指定模板' })).not.toBeInTheDocument();
    expect(callsTo('createPlanningJob')).toHaveLength(0);
    expect(callsTo('createProductImagePlanningJob')).toHaveLength(0);
    expect(callsTo('createGenerationJobs')).toHaveLength(0);
  });

  it('切换工作阶段须确认放弃SKU草稿；规划和成图页没有第二个常驻配置面板', async () => {
    renderPlanning(<Routes><Route path="/projects/:projectId" element={<WorkbenchPage/>}/></Routes>, { initialEntries: [`/projects/${PROJECT_ID}?view=storyboard`] });
    const user = userEvent.setup();
    const preview = within(await screen.findByRole('main'));
    expect(await preview.findByRole('heading', { name: '图片规划' })).toBeVisible();
    expect(screen.queryByRole('complementary', { name: '制作配置', hidden: true })).not.toBeInTheDocument();
    const manage = preview.getByRole('button', { name: '管理 SKU' });
    await waitFor(() => expect(manage).toBeEnabled());
    await user.click(manage);
    const drawer = within(await screen.findByRole('dialog', { name: /管理 SKU/ }));
    await user.click(drawer.getByRole('button', { name: '添加 SKU' }));
    const name = drawer.getByRole('textbox', { name: 'SKU 1 名称' });
    await user.type(name, '导航草稿');
    const results = within(screen.getByRole('navigation', { name: '工作阶段' })).getByRole('button', { name: /成图与修改/ });
    await user.click(results);
    const confirm = await screen.findByRole('dialog', { name: '放弃未保存的图片规划修改？' });
    await user.click(within(confirm).getByRole('button', { name: '继续编辑' }));
    await waitFor(() => expect(confirm).not.toBeInTheDocument());
    expect(name).toHaveValue('导航草稿');
    expect(name).toBeVisible();
    await user.click(results);
    const discard = await screen.findByRole('dialog', { name: '放弃未保存的图片规划修改？' });
    await act(async () => { fireEvent.click(within(discard).getByRole('button', { name: '放弃修改' })); });
    expect(await preview.findByRole('heading', { name: /^成图与修改/ })).toBeVisible();
    expect(screen.queryByRole('complementary', { name: '制作配置', hidden: true })).not.toBeInTheDocument();
    expect(callsTo('saveProjectImagePlanning')).toHaveLength(0);
  });
});
