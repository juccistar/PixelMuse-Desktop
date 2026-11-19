import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adaptProjectDetail, type StoryboardItem } from '../../api/adapters/projectDetail';
import { assetPreviewUrl } from '../../lib/assetUrl';
import { FakeDesktop } from '../../test/fake-desktop';
import { ASSET_FIXTURE, ASSET_ID, GENERATE_JOB_FIXTURE, OUTPUT_FIXTURE, PLAN_JOB_FIXTURE, PROJECT_ID, STORYBOARD_FIXTURE, STORYBOARD_ITEM_B_FIXTURE, STORYBOARD_ITEM_FIXTURE, projectDetailPayload } from '../../test/fixtures';
import { renderWithProviders } from '../../test/render';
import { StoryboardStage } from './StoryboardStage';

let desktop: FakeDesktop;
// 多弹窗重开时使用真实唯一标题 ID，避免 AntD 测试固定 ID 串名。
beforeEach(() => { vi.stubEnv('NODE_ENV', 'development'); desktop = new FakeDesktop().install(); });
afterEach(() => { vi.unstubAllEnvs(); });

function setup(items: StoryboardItem[], jobs: unknown[] = [], assets = [ASSET_FIXTURE]) {
  const storyboard = { ...STORYBOARD_FIXTURE, version: 7 };
  const detail = adaptProjectDetail(projectDetailPayload({ storyboard, items, jobs, assets, outputs: [OUTPUT_FIXTURE] }));
  desktop.on('getStoryboard', () => ({ storyboard, items }));
  const onGenerated = vi.fn();
  renderWithProviders(<StoryboardStage detail={detail} onGenerated={onGenerated}/>);
  return { storyboard, onGenerated };
}

describe('图片规划', () => {
  it('仅展示仍存在的已引用项目素材，引用缺失或读取失败时回到规划占位', async () => {
    setup([
      { ...STORYBOARD_ITEM_FIXTURE, referencedAssets: [ASSET_ID] },
      { ...STORYBOARD_ITEM_B_FIXTURE, referencedAssets: ['11111111-2222-4333-8444-555555555555'] },
      { ...STORYBOARD_ITEM_B_FIXTURE, id: '22222222-3333-4444-8555-666666666666', displayName: '未选参考素材', referencedAssets: [] },
    ]);
    const referencedCard = await screen.findByRole('button', { name: `${STORYBOARD_ITEM_FIXTURE.displayName} 分镜` });
    const image = within(referencedCard).getByRole('img', { name: '参考素材：product.png' });
    expect(image).toHaveAttribute('src', assetPreviewUrl(ASSET_FIXTURE));
    expect(within(screen.getByRole('button', { name: `${STORYBOARD_ITEM_B_FIXTURE.displayName} 分镜` })).queryByRole('img')).not.toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: '未选参考素材 分镜' })).queryByRole('img')).not.toBeInTheDocument();
    fireEvent.error(image);
    expect(within(referencedCard).queryByRole('img')).not.toBeInTheDocument();
    expect(within(referencedCard).getByText('规划分镜')).toBeInTheDocument();
    fireEvent.click(referencedCard);
    const inspector = within(screen.getByRole('complementary', { name: '画面检查器' }));
    expect(await inspector.findByRole('textbox', { name: '生图 Prompt' })).toHaveValue(STORYBOARD_ITEM_FIXTURE.promptInstruction);
    expect(inspector.getByRole('button', { name: '关闭画面检查器' })).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(desktop.api.invoke).not.toHaveBeenCalledWith('createGenerationJobs', expect.anything());
  });

  it('参考素材可预览并切换，不会打开检查器或改变选择', async () => {
    const second = { ...ASSET_FIXTURE, id: '22222222-2222-4222-8222-222222222222', originalName: 'second.png' };
    setup([{ ...STORYBOARD_ITEM_FIXTURE, referencedAssets: [ASSET_ID, second.id] }], [], [ASSET_FIXTURE, second]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '预览参考素材：product.png' }));
    const dialog = await screen.findByRole('dialog', { name: '参考素材预览' });
    expect(within(dialog).getByRole('img', { name: 'product.png' })).toHaveAttribute('src', assetPreviewUrl(ASSET_FIXTURE));
    expect(screen.getByRole('checkbox', { name: `选择${STORYBOARD_ITEM_FIXTURE.displayName}` })).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByRole('textbox', { name: '生图 Prompt' })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '下一张' }));
    expect(within(dialog).getByRole('img', { name: 'second.png' })).toHaveAttribute('src', assetPreviewUrl(second));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '参考素材预览' })).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: `${STORYBOARD_ITEM_FIXTURE.displayName} 分镜` }));
    await user.click(await screen.findByRole('button', { name: '预览使用素材：second.png' }));
    expect(within(await screen.findByRole('dialog', { name: '参考素材预览' })).getByRole('img', { name: 'second.png' })).toBeInTheDocument();
  });

  it('批量删除跳过受保护画面，失败项保持选中', async () => {
    const protectedItem = { ...STORYBOARD_ITEM_B_FIXTURE, id: '33333333-3333-4333-8333-333333333333', displayName: '已有成图', status: 'GENERATED' as const };
    const items: StoryboardItem[] = [STORYBOARD_ITEM_FIXTURE, STORYBOARD_ITEM_B_FIXTURE, protectedItem];
    setup(items);
    desktop.on('deleteStoryboardItem', input => {
      if (input.itemId === STORYBOARD_ITEM_B_FIXTURE.id) throw new Error('删除失败');
      items.splice(items.findIndex(item => item.id === input.itemId), 1);
      return null;
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '全选' }));
    await user.click(screen.getByRole('button', { name: '删除所选' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: `${STORYBOARD_ITEM_FIXTURE.displayName} 分镜` })).not.toBeInTheDocument());
    expect(desktop.api.invoke).toHaveBeenCalledWith('deleteStoryboardItem', { itemId: STORYBOARD_ITEM_B_FIXTURE.id });
    expect(desktop.api.invoke).not.toHaveBeenCalledWith('deleteStoryboardItem', { itemId: protectedItem.id });
    expect(screen.getByRole('checkbox', { name: `选择${STORYBOARD_ITEM_B_FIXTURE.displayName}` })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('checkbox', { name: '选择已有成图' })).toHaveAttribute('aria-checked', 'true');
    expect(await screen.findByText(/部分画面未删除/)).toBeInTheDocument();
    expect(screen.getByText('2 个已选分镜')).toBeInTheDocument();
  });

  it('卡片删除先确认，取消保留需求和选择，确认后刷新且繁忙时阻止重复删除', async () => {
    const items: StoryboardItem[] = [STORYBOARD_ITEM_FIXTURE, STORYBOARD_ITEM_B_FIXTURE];
    setup(items);
    let finishDelete!: () => void;
    desktop.on('deleteStoryboardItem', input => new Promise<null>(resolve => {
      finishDelete = () => { items.splice(items.findIndex(item => item.id === input.itemId), 1); resolve(null); };
    }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: `选择${STORYBOARD_ITEM_FIXTURE.displayName}` }));
    const remove = screen.getByRole('button', { name: `删除${STORYBOARD_ITEM_FIXTURE.displayName}` });
    await user.click(remove);
    const confirmation = await screen.findByRole('dialog', { name: '取消此图片需求？' });
    expect(screen.queryByRole('textbox', { name: '生图 Prompt' })).not.toBeInTheDocument();
    expect(screen.getByText('1 个已选分镜')).toBeInTheDocument();
    await user.click(within(confirmation).getByRole('button', { name: '保留需求' }));
    await waitFor(() => expect(confirmation).not.toBeInTheDocument());
    expect(desktop.api.invoke).not.toHaveBeenCalledWith('deleteStoryboardItem', expect.anything());
    expect(screen.getByRole('checkbox', { name: `选择${STORYBOARD_ITEM_FIXTURE.displayName}` })).toHaveAttribute('aria-checked', 'true');
    const planningReads = vi.mocked(desktop.api.invoke).mock.calls.filter(call => call[0] === 'getProjectImagePlanning').length;
    await user.click(remove);
    await user.click(within(await screen.findByRole('dialog', { name: '取消此图片需求？' })).getByRole('button', { name: '取消图片需求' }));
    await waitFor(() => expect(desktop.api.invoke).toHaveBeenCalledWith('deleteStoryboardItem', { itemId: STORYBOARD_ITEM_FIXTURE.id }));
    const otherRemove = screen.getByRole('button', { name: `删除${STORYBOARD_ITEM_B_FIXTURE.displayName}` });
    await waitFor(() => expect(otherRemove).toBeDisabled());
    expect(otherRemove).toHaveAttribute('aria-description', '正在保存或提交操作，请稍后再删除。');
    await act(async () => { finishDelete(); });
    await waitFor(() => expect(screen.queryByRole('button', { name: `${STORYBOARD_ITEM_FIXTURE.displayName} 分镜` })).not.toBeInTheDocument());
    await waitFor(() => expect(vi.mocked(desktop.api.invoke).mock.calls.filter(call => call[0] === 'getProjectImagePlanning').length).toBeGreaterThan(planningReads));
    expect(screen.getByText('0 个已选分镜')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: '生图 Prompt' })).not.toBeInTheDocument();
    await waitFor(() => expect(otherRemove).toBeEnabled());
  });

  it.each([
    { status: 'GENERATED' as const, jobs: [], reason: '此画面已有成图，不能删除图片需求。' },
    { status: 'GENERATING' as const, jobs: [], reason: '此画面正在生成，请等待任务结束后再删除。' },
    { status: 'DRAFT' as const, jobs: [{ ...PLAN_JOB_FIXTURE, status: 'RUNNING' }], reason: '规划正在执行或有任务已中断，请先在任务详情处理。' },
    { status: 'DRAFT' as const, jobs: [{ ...GENERATE_JOB_FIXTURE, status: 'UNKNOWN' }], reason: '规划正在执行或有任务已中断，请先在任务详情处理。' },
  ])('卡片及检查器保留删除保护：$status / $reason', async ({ status, jobs, reason }) => {
    setup([{ ...STORYBOARD_ITEM_FIXTURE, status }], jobs);
    const user = userEvent.setup();
    const remove = await screen.findByRole('button', { name: `删除${STORYBOARD_ITEM_FIXTURE.displayName}` });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAttribute('aria-description', reason);
    await user.click(remove);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: `${STORYBOARD_ITEM_FIXTURE.displayName} 分镜` }));
    const inspectorRemove = await screen.findByRole('button', { name: '取消此图片需求' });
    expect(inspectorRemove).toBeDisabled();
    expect(inspectorRemove).toHaveAttribute('aria-description', reason);
    expect(desktop.api.invoke).not.toHaveBeenCalledWith('deleteStoryboardItem', expect.anything());
  });

  it('保留选择候选计数，以当前版本确认后仅生成所选分镜并调用完成回调', async () => {
    const { storyboard, onGenerated } = setup([
      { ...STORYBOARD_ITEM_FIXTURE, candidateCount: 2 },
      { ...STORYBOARD_ITEM_B_FIXTURE, candidateCount: 3 },
    ]);
    const order: string[] = [];
    desktop.on('confirmStoryboard', () => {
      order.push('confirm');
      return { ...storyboard, status: 'CONFIRMED' };
    });
    desktop.on('createGenerationJobs', () => {
      order.push('generate');
      return { jobs: [GENERATE_JOB_FIXTURE], reused: false };
    });
    const user = userEvent.setup();
    const generate = screen.getByRole('button', { name: '确认并生成' });
    expect(generate).toBeDisabled();
    await user.click(await screen.findByRole('checkbox', { name: `选择${STORYBOARD_ITEM_B_FIXTURE.displayName}` }));
    expect(screen.getByText('1 个已选分镜')).toBeInTheDocument();
    expect(screen.getByText('共 2 个 · 预计 3/5 张候选')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '全选' }));
    expect(screen.getByText('共 2 个 · 预计 5/5 张候选')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '取消全选' }));
    expect(generate).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: `选择${STORYBOARD_ITEM_B_FIXTURE.displayName}` }));
    await waitFor(() => expect(generate).toBeEnabled());
    await user.click(generate);
    await waitFor(() => expect(onGenerated).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['confirm', 'generate']);
    expect(desktop.api.invoke).toHaveBeenCalledWith('confirmStoryboard', { projectId: PROJECT_ID, version: 7 });
    expect(desktop.api.invoke).toHaveBeenCalledWith('createGenerationJobs', { projectId: PROJECT_ID, storyboardItemIds: [STORYBOARD_ITEM_B_FIXTURE.id] });
  });
});
