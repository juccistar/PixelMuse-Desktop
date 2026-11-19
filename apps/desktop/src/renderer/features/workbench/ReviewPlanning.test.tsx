import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { adaptProjectDetail } from '../../api/adapters/projectDetail';
import { FakeDesktop } from '../../test/fake-desktop';
import { ASSET_ID, OUTPUT_FIXTURE, PRODUCT_IMAGE_CONTEXT_FIXTURE, STORYBOARD_ITEM_B_FIXTURE, STORYBOARD_ITEM_FIXTURE, projectDetailPayload } from '../../test/fixtures';
import { renderWithProviders } from '../../test/render';
import { ReviewStage } from './ReviewStage';

it('当前规划查询排除旧分镜后仍显示旧成图；用途、SKU标签和单图文件名取输出冻结快照', async () => {
  const desktop = new FakeDesktop().install();
  const snapshot = {
    ...PRODUCT_IMAGE_CONTEXT_FIXTURE, purpose: 'SKU' as const, targetId: 'SKU:11111111-2222-4333-8444-555555555555:1',
    skus: [{ id: '11111111-2222-4333-8444-555555555555', name: '原始规格', code: 'OLD-CODE', attributes: [{ name: '尺寸', value: '原始尺寸' }], productAssetIds: [ASSET_ID] }], productAssetIds: [ASSET_ID],
  };
  const oldItem = { ...STORYBOARD_ITEM_FIXTURE, status: 'GENERATED', planningSuperseded: true, imagePlanning: { ...snapshot, skus: [{ ...snapshot.skus[0]!, name: '今天的规格名称' }] } };
  const current = { ...STORYBOARD_ITEM_B_FIXTURE, imagePlanning: PRODUCT_IMAGE_CONTEXT_FIXTURE };
  desktop.on('getStoryboard', () => ({ storyboard: null, items: [current] }));
  const detail = adaptProjectDetail(projectDetailPayload({ items: [oldItem, current], outputs: [{ ...OUTPUT_FIXTURE, imagePlanning: snapshot }] }));
  renderWithProviders(<ReviewStage detail={detail} selectedOutputIds={[]} onSelectionChange={vi.fn()} onRetryItem={vi.fn()}/>);
  expect(await screen.findByText('SKU 图 · 原始规格 · OLD-CODE')).toBeInTheDocument();
  await waitFor(() => expect(desktop.api.invoke).toHaveBeenCalledWith('getStoryboard', { projectId: detail.id }));
  const card = screen.getByRole('article', { name: `${STORYBOARD_ITEM_FIXTURE.displayName}成图` });
  expect(card).toHaveAttribute('data-output-id', OUTPUT_FIXTURE.id);
  await userEvent.setup().click(within(card).getByRole('button', { name: /下载原图/ }));
  await waitFor(() => expect(desktop.api.saveArtifact).toHaveBeenCalledWith({ kind: 'OUTPUT', id: OUTPUT_FIXTURE.id }, expect.stringContaining('SKU 图 · 原始规格 · OLD-CODE')));
  expect(screen.queryByText(/今天的规格名称/)).not.toBeInTheDocument();
});

it('没有新用途快照的旧成图保持未分类，不从分镜关联猜测SKU', async () => {
  new FakeDesktop().install().on('getStoryboard', () => ({ storyboard: null, items: [STORYBOARD_ITEM_FIXTURE] }));
  const detail = adaptProjectDetail(projectDetailPayload({ items: [{ ...STORYBOARD_ITEM_FIXTURE, imagePlanning: PRODUCT_IMAGE_CONTEXT_FIXTURE }], outputs: [OUTPUT_FIXTURE] }));
  renderWithProviders(<ReviewStage detail={detail} selectedOutputIds={[]} onSelectionChange={vi.fn()} onRetryItem={vi.fn()}/>);
  const card = await screen.findByRole('article', { name: `${STORYBOARD_ITEM_FIXTURE.displayName}成图` });
  expect(card).toHaveAttribute('data-output-id', OUTPUT_FIXTURE.id);
  expect(within(card.parentElement!).getByText('已有 / 未分类')).toBeInTheDocument();
});
