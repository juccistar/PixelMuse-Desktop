import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { adaptProjectDetail, type Job } from '../../api/adapters/projectDetail';
import { FakeDesktop } from '../../test/fake-desktop';
import { GENERATE_JOB_FIXTURE, OUTPUT_FIXTURE, STORYBOARD_ITEM_FIXTURE, projectDetailPayload } from '../../test/fixtures';
import { renderWithProviders } from '../../test/render';
import { outputPreviewUrl } from '../../lib/assetUrl';
import { ReviewStage } from './ReviewStage';

function setup() {
  const desktop = new FakeDesktop().install();
  desktop.on('getStoryboard', () => ({ storyboard: null, items: [STORYBOARD_ITEM_FIXTURE] }));
  return adaptProjectDetail(projectDetailPayload({ items: [STORYBOARD_ITEM_FIXTURE], jobs: [], outputs: [OUTPUT_FIXTURE, { ...OUTPUT_FIXTURE, id: 'eeeeeeee-1111-4222-8333-555555555555', candidateIndex: 2, createdAt: '2026-08-01T00:31:00.000Z' }] }));
}

it('stacks candidates and switches image, download selection and full preview together', async () => {
  const detail = setup();
  const select = vi.fn();
  renderWithProviders(<ReviewStage detail={detail} selectedOutputIds={[]} onSelectionChange={select} onRetryItem={vi.fn()}/>);
  const user = userEvent.setup();
  const card = await screen.findByRole('article');
  expect(screen.getAllByRole('article')).toHaveLength(1);
  expect(card).toHaveAttribute('data-output-id', detail.outputs[1]!.id);
  expect(within(card).getByLabelText('当前候选图片')).toHaveTextContent('2 / 2');
  await user.click(within(card).getByRole('button', { name: /上一张/ }));
  expect(card).toHaveAttribute('data-output-id', detail.outputs[0]!.id);
  await user.click(within(card).getByRole('checkbox'));
  expect(select).toHaveBeenLastCalledWith([detail.outputs[0]!.id]);
  await user.click(within(card).getByRole('button', { name: /下载原图/ }));
  expect(window.ecomgen.saveArtifact).toHaveBeenCalledWith({ kind: 'OUTPUT', id: detail.outputs[0]!.id }, expect.any(String));
  await user.click(within(card).getByRole('button', { name: /灯箱/ }));
  const lightbox = await screen.findByRole('dialog', { name: /灯箱/ });
  expect(within(lightbox).getByRole('img', { name: STORYBOARD_ITEM_FIXTURE.displayName })).toHaveAttribute('src', detail.outputs[0]!.url);
  await user.click(within(lightbox).getByRole('button', { name: /Close|关闭/ }));
  await waitFor(() => expect(lightbox).not.toBeVisible());
  await user.click(within(card).getByRole('button', { name: /预览/ }));
  await waitFor(() => expect(document.querySelector('.ant-image-preview-img')).toHaveAttribute('src', detail.outputs[0]!.url));
});

it('adopts the visible candidate independently from download selection', async () => {
  const detail = setup();
  const adopt = vi.fn();
  const select = vi.fn();
  const user = userEvent.setup();
  renderWithProviders(<ReviewStage detail={detail} adoptions={[]} onAdopt={adopt} selectedOutputIds={[detail.outputs[0]!.id]} onSelectionChange={select} onRetryItem={vi.fn()}/>);
  const card = await screen.findByRole('article');
  await user.click(within(card).getByRole('button', { name: '采用此图' }));
  expect(adopt).toHaveBeenLastCalledWith(detail.outputs[1]!.storyboardItemId, detail.outputs[1]!.id);
  expect(select).not.toHaveBeenCalled();
  expect(within(card).getByRole('checkbox')).not.toBeChecked();
  await user.click(within(card).getByRole('button', { name: /上一张/ }));
  await user.click(within(card).getByRole('button', { name: '采用此图' }));
  expect(adopt).toHaveBeenLastCalledWith(detail.outputs[0]!.storyboardItemId, detail.outputs[0]!.id);
  expect(within(card).getByRole('checkbox')).toBeChecked();
});

it('one click submits one image in its batch and locks repeated clicks until submission completes', async () => {
  const detail = setup();
  let finish!: (jobs: Job[]) => void;
  const retry = vi.fn(() => new Promise<Job[]>(resolve => { finish = resolve; }));
  renderWithProviders(<ReviewStage detail={detail} selectedOutputIds={[]} onSelectionChange={vi.fn()} onRetryItem={retry}/>);
  await waitFor(() => expect(screen.getByRole('button', { name: /重新生成 / })).toBeEnabled());
  // Wait for the real model query; a click must not silently switch model.
  await screen.findByRole('article');
  const button = screen.getByRole('button', { name: /重新生成 / });
  await userEvent.setup().click(button);
  expect(retry).toHaveBeenCalledTimes(1);
  expect(retry).toHaveBeenCalledWith(STORYBOARD_ITEM_FIXTURE.id, expect.objectContaining({ candidateCount: 1, imageModel: { providerId: STORYBOARD_ITEM_FIXTURE.imageProviderId, modelId: STORYBOARD_ITEM_FIXTURE.imageModelId } }), OUTPUT_FIXTURE.jobId);
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(retry).toHaveBeenCalledTimes(1);
  finish([]);
  await waitFor(() => expect(button).toBeEnabled());
});

it('expands every candidate and keeps viewing identity independent from export selection across refreshes', async () => {
  const base = setup();
  const detail = { ...base, outputs: Array.from({ length: 6 }, (_, index) => {
    const id = `eeeeeeee-1111-4222-8333-${String(index + 1).padStart(12, '0')}`;
    return { ...base.outputs[0]!, id, url: outputPreviewUrl({ id }), candidateIndex: index + 1, createdAt: `2026-08-01T00:${30 + index}:00.000Z` };
  }) };
  const selected = detail.outputs[1]!.id;
  const select = vi.fn();
  const retry = vi.fn();
  const view = renderWithProviders(<ReviewStage detail={detail} selectedOutputIds={[selected]} onSelectionChange={select} onRetryItem={retry}/>);
  const user = userEvent.setup();
  const card = await screen.findByRole('article');
  const toggle = within(card).getByRole('button', { name: '展开候选' });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(within(card).queryByRole('list')).not.toBeInTheDocument();
  await user.click(toggle);
  const filmstrip = within(card).getByRole('list', { name: /全部候选/ });
  expect(within(filmstrip).getAllByRole('button')).toHaveLength(6);
  expect(within(filmstrip).getByRole('button', { name: /查看候选 6 ·/ })).toHaveAttribute('aria-current', 'true');
  await user.click(within(filmstrip).getByRole('button', { name: /查看候选 2 ·/ }));
  expect(card).toHaveAttribute('data-output-id', selected);
  expect(within(card).getByRole('checkbox')).toBeChecked();
  expect(within(filmstrip).getByRole('button', { name: /查看候选 2 ·/ })).toHaveAttribute('aria-current', 'true');
  expect(select).not.toHaveBeenCalled();

  view.rerender(<ReviewStage detail={{ ...detail, outputs: detail.outputs.map((output) => ({ ...output })) }} selectedOutputIds={[selected]} onSelectionChange={select} onRetryItem={retry}/>);
  expect(card).toHaveAttribute('data-output-id', selected);
  expect(within(card).getByRole('button', { name: '收起候选' })).toHaveAttribute('aria-expanded', 'true');
  await user.click(within(card).getByRole('button', { name: /上一张/ }));
  expect(within(card).getByRole('checkbox')).not.toBeChecked();
  await user.click(within(card).getByRole('checkbox'));
  expect(select).toHaveBeenLastCalledWith([selected, detail.outputs[0]!.id]);
  await user.click(within(card).getByRole('button', { name: '收起候选' }));
  expect(within(card).queryByRole('list')).not.toBeInTheDocument();
  expect(card).toHaveAttribute('data-output-id', detail.outputs[0]!.id);
});

it('retains the viewed image while generation is pending and fronts only the new successful image', async () => {
  const detail = { ...setup(), jobs: [{ ...GENERATE_JOB_FIXTURE, status: 'SUCCEEDED' as const }] };
  const pending: Job = { ...GENERATE_JOB_FIXTURE, id: 'abababab-1111-4222-8333-555555555555', createdAt: '2026-08-01T00:39:00.000Z' };
  const retry = vi.fn().mockResolvedValue([pending]);
  const select = vi.fn();
  const selected = detail.outputs[0]!.id;
  const view = renderWithProviders(<ReviewStage detail={detail} selectedOutputIds={[selected]} onSelectionChange={select} onRetryItem={retry}/>);
  const user = userEvent.setup();
  const card = await screen.findByRole('article');
  await user.click(within(card).getByRole('button', { name: /上一张/ }));
  await user.click(within(card).getByRole('button', { name: '展开候选' }));
  const button = within(card).getByRole('button', { name: /重新生成 / });
  await user.click(button);
  await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
  expect(button).toBeDisabled();
  expect(within(card).getByRole('status')).toHaveTextContent('排队中');
  expect(card).toHaveAttribute('data-output-id', selected);
  expect(within(card).getByRole('img', { name: STORYBOARD_ITEM_FIXTURE.displayName })).toHaveAttribute('src', detail.outputs[0]!.url);
  expect(within(within(card).getByRole('list')).getAllByRole('button')).toHaveLength(2);

  view.rerender(<ReviewStage detail={{ ...detail, jobs: [...detail.jobs, { ...pending, status: 'RUNNING' }], outputs: detail.outputs.map((output) => ({ ...output })) }} selectedOutputIds={[selected]} onSelectionChange={select} onRetryItem={retry}/>);
  expect(within(card).getByRole('status')).toHaveTextContent('生成中');
  expect(card).toHaveAttribute('data-output-id', selected);
  expect(within(card).getByRole('checkbox')).toBeChecked();
  fireEvent.click(button);
  expect(retry).toHaveBeenCalledTimes(1);

  const id = 'eeeeeeee-1111-4222-8333-666666666666';
  const fresh = { ...detail.outputs[1]!, id, url: outputPreviewUrl({ id }), jobId: pending.id, generationBatchId: OUTPUT_FIXTURE.jobId, revision: 'retry', candidateIndex: 1, createdAt: '2026-08-01T00:40:00.000Z' };
  view.rerender(<ReviewStage detail={{ ...detail, jobs: [...detail.jobs, { ...pending, status: 'SUCCEEDED' }], outputs: [...detail.outputs, fresh] }} selectedOutputIds={[selected]} onSelectionChange={select} onRetryItem={retry}/>);
  await waitFor(() => expect(card).toHaveAttribute('data-output-id', fresh.id));
  expect(screen.getAllByRole('article')).toHaveLength(1);
  expect(within(card).getByLabelText('当前候选图片')).toHaveTextContent('3 / 3');
  expect(within(card).queryByRole('status')).not.toBeInTheDocument();
  expect(button).toBeEnabled();
  expect(within(card).getByRole('checkbox')).not.toBeChecked();
  const filmstrip = within(card).getByRole('list');
  expect(within(filmstrip).getAllByRole('button')).toHaveLength(3);
  await user.click(within(filmstrip).getByRole('button', { name: /查看候选 1 ·/ }));
  expect(card).toHaveAttribute('data-output-id', selected);
  expect(within(card).getByRole('checkbox')).toBeChecked();
  expect(select).not.toHaveBeenCalled();
});

it('keeps hidden candidates and edited versions in the full image preview sequence', async () => {
  const detail = setup();
  const id = 'eeeeeeee-1111-4222-8333-777777777777';
  const edited = { ...detail.outputs[0]!, id, url: outputPreviewUrl({ id }), editSessionId: 'abababab-1111-4222-8333-777777777777', rootOutputId: detail.outputs[0]!.id, parentOutputId: detail.outputs[0]!.id, createdAt: '2026-08-01T00:42:00.000Z' };
  renderWithProviders(<ReviewStage detail={{ ...detail, outputs: [...detail.outputs, edited] }} selectedOutputIds={[]} onSelectionChange={vi.fn()} onRetryItem={vi.fn()}/>);
  const user = userEvent.setup();
  const card = await screen.findByRole('article');
  await user.click(within(card).getByRole('button', { name: /上一张/ }));
  expect(within(card).getByRole('button', { name: '编辑 1 版' })).toBeInTheDocument();
  await user.click(within(card).getByRole('button', { name: /预览/ }));
  await waitFor(() => expect(document.querySelector('.ant-image-preview-img')).toHaveAttribute('src', detail.outputs[0]!.url));
  fireEvent.keyDown(document.body, { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 });
  await waitFor(() => expect(document.querySelector('.ant-image-preview-img')).toHaveAttribute('src', edited.url));
  fireEvent.keyDown(document.body, { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 });
  await waitFor(() => expect(document.querySelector('.ant-image-preview-img')).toHaveAttribute('src', detail.outputs[1]!.url));
});

it('retains the local storyboard association when public job responses omit it', async () => {
  const detail = setup();
  const job = { ...GENERATE_JOB_FIXTURE, storyboardItemId: undefined };
  const retry = vi.fn().mockResolvedValue([job]);
  const view = renderWithProviders(<ReviewStage detail={detail} selectedOutputIds={[]} onSelectionChange={vi.fn()} onRetryItem={retry}/>);
  const button = await screen.findByRole('button', { name: /重新生成 / });
  await userEvent.setup().click(button);
  await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
  expect(button).toBeDisabled();
  view.rerender(<ReviewStage detail={{ ...detail, jobs: [{ ...job, status: 'SUCCEEDED' }] }} selectedOutputIds={[]} onSelectionChange={vi.fn()} onRetryItem={retry}/>);
  await waitFor(() => expect(button).toBeEnabled());
});
