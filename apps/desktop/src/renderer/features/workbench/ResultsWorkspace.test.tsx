import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { adaptProjectDetail } from '../../api/adapters/projectDetail';
import { FakeDesktop } from '../../test/fake-desktop';
import { EXPORT_FIXTURE, EXPORT_JOB_FIXTURE, GENERATE_JOB_FIXTURE, OUTPUT_FIXTURE, PRODUCT_IMAGE_CONTEXT_FIXTURE, PROJECT_ID, STORYBOARD_ITEM_FIXTURE, projectDetailPayload } from '../../test/fixtures';
import { renderWithProviders } from '../../test/render';
import { ResultsWorkspace } from './ResultsWorkspace';

// 多弹窗保留关闭内容时必须使用真实唯一标题 ID，避免 AntD 测试固定 ID 串名。
beforeEach(() => { vi.stubEnv('NODE_ENV', 'development'); });
afterEach(() => { vi.unstubAllEnvs(); });

it('shows the mapped generation lifecycle on the target and preserves the image during regeneration', async () => {
  const desktop = new FakeDesktop().install();
  const item = { ...STORYBOARD_ITEM_FIXTURE, imagePlanning: PRODUCT_IMAGE_CONTEXT_FIXTURE };
  desktop.on('getStoryboard', () => ({ storyboard: null, items: [item] }));
  const detail = (status: 'QUEUED' | 'RUNNING' | 'FAILED' | 'SUCCEEDED', withOutput = false) => adaptProjectDetail(projectDetailPayload({
    items: [item], jobs: [{ ...GENERATE_JOB_FIXTURE, status, error: status === 'FAILED' ? { message: 'provider failed' } : null }],
    outputs: withOutput ? [{ ...OUTPUT_FIXTURE, imagePlanning: PRODUCT_IMAGE_CONTEXT_FIXTURE }] : [],
  }));
  const view = renderWithProviders(<ResultsWorkspace detail={detail('QUEUED')}/>);
  const card = () => screen.getByRole('article', { name: `${item.displayName}成图` });
  expect(within(card()).getByRole('status')).toHaveTextContent('排队中');
  expect(within(card()).queryByRole('button', { name: '生成此图' })).not.toBeInTheDocument();
  view.rerender(<ResultsWorkspace detail={detail('RUNNING')}/>);
  expect(within(card()).getByRole('status')).toHaveTextContent('生成中');
  view.rerender(<ResultsWorkspace detail={detail('FAILED')}/>);
  expect(within(card()).getByText('生成失败')).toBeInTheDocument();
  expect(within(card()).getByRole('button', { name: '生成此图' })).toBeEnabled();
  view.rerender(<ResultsWorkspace detail={detail('SUCCEEDED', true)}/>);
  expect(within(card()).getByRole('img', { name: item.displayName })).toBeInTheDocument();
  view.rerender(<ResultsWorkspace detail={detail('RUNNING', true)}/>);
  expect(within(card()).getByRole('img', { name: item.displayName })).toBeInTheDocument();
  expect(within(card()).getByRole('status')).toHaveTextContent('生成中');
  expect(within(card()).getByRole('button', { name: `重新生成 ${item.displayName}` })).toBeDisabled();
});

it('persists adoption separately from checkboxes and restores it after reopening', async () => {
  const desktop = new FakeDesktop().install();
  const detail = adaptProjectDetail(projectDetailPayload({ items: [STORYBOARD_ITEM_FIXTURE], jobs: [], outputs: [OUTPUT_FIXTURE] }));
  desktop.on('getStoryboard', () => ({ storyboard: null, items: [STORYBOARD_ITEM_FIXTURE] }));
  desktop.on('createExportJob', () => ({ job: EXPORT_JOB_FIXTURE, export: EXPORT_FIXTURE, reused: false }));
  desktop.on('getExport', () => EXPORT_FIXTURE);
  const user = userEvent.setup();
  const first = renderWithProviders(<ResultsWorkspace detail={detail}/>);
  const adopt = await screen.findByRole('button', { name: '采用此图' });
  await waitFor(() => expect(adopt).toBeEnabled());
  await user.click(adopt);
  await screen.findByRole('button', { name: '取消采用' });
  expect(screen.getByRole('checkbox', { name: /选择下载/ })).not.toBeChecked();
  expect(vi.mocked(desktop.api.invoke).mock.calls).toContainEqual(['saveProjectWorkbench', expect.objectContaining({ projectId: PROJECT_ID, expectedRevision: 0, adoptions: [{ targetId: STORYBOARD_ITEM_FIXTURE.id, outputId: OUTPUT_FIXTURE.id }] })]);
  first.unmount();
  renderWithProviders(<ResultsWorkspace detail={detail}/>);
  await screen.findByRole('button', { name: '取消采用' });
  await user.click(screen.getByRole('button', { name: '下载已采用图片（1）' }));
  await waitFor(() => expect(vi.mocked(desktop.api.invoke).mock.calls).toContainEqual(['createExportJob', expect.objectContaining({ outputIds: [OUTPUT_FIXTURE.id] })]));
});

it('restores detail order and completed export records from the backend', async () => {
  const desktop = new FakeDesktop().install();
  const secondItem = { ...STORYBOARD_ITEM_FIXTURE, id: 'aaaaaaaa-1111-4222-8333-444444444444', displayName: '第二张详情' };
  const detail = adaptProjectDetail(projectDetailPayload({ items: [STORYBOARD_ITEM_FIXTURE, secondItem], jobs: [], outputs: [OUTPUT_FIXTURE] }));
  desktop.on('getProjectWorkbench', () => ({ projectId: PROJECT_ID, revision: 3, adoptions: [], detailOrder: [secondItem.id, STORYBOARD_ITEM_FIXTURE.id], updatedAt: null }));
  desktop.on('saveProjectWorkbench', input => ({ ...input, revision: 4, updatedAt: null }));
  desktop.on('listProjectExports', () => ({ items: [{ id: EXPORT_FIXTURE.id, projectId: PROJECT_ID, jobId: EXPORT_JOB_FIXTURE.id, status: 'SUCCEEDED', createdAt: EXPORT_FIXTURE.createdAt, updatedAt: EXPORT_FIXTURE.createdAt, outputIds: [OUTPUT_FIXTURE.id], longImage: true, downloadUrl: `ecomgen-resource://EXPORT/${EXPORT_FIXTURE.id}` }] }));
  renderWithProviders(<ResultsWorkspace detail={detail}/>);
  const user = userEvent.setup();
  await waitFor(() => expect(screen.getByRole('button', { name: '详情顺序' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: '详情顺序' }));
  const order = await screen.findByRole('dialog', { name: '详情顺序' });
  expect(within(order).getAllByRole('listitem')[0]).toHaveTextContent('第二张详情');
  await user.click(within(order).getByRole('button', { name: '下移详情 1' }));
  await user.click(within(order).getByRole('button', { name: '保存顺序' }));
  await waitFor(() => expect(vi.mocked(desktop.api.invoke).mock.calls).toContainEqual(['saveProjectWorkbench', expect.objectContaining({ expectedRevision: 3, detailOrder: [STORYBOARD_ITEM_FIXTURE.id, secondItem.id] })]));
  await user.click(screen.getByRole('button', { name: '导出记录' }));
  const records = await screen.findByRole('dialog', { name: '导出记录' });
  await user.click(within(records).getByRole('button', { name: '保存文件' }));
  await waitFor(() => expect(desktop.api.saveArtifact).toHaveBeenCalledWith({ kind: 'EXPORT', id: EXPORT_FIXTURE.id }));
});
