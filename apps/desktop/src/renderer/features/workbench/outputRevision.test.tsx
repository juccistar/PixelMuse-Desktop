import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { adaptProjectDetail } from '../../api/adapters/projectDetail';
import { FakeDesktop } from '../../test/fake-desktop';
import { OUTPUT_FIXTURE, STORYBOARD_ITEM_FIXTURE, projectDetailPayload } from '../../test/fixtures';
import { renderWithProviders } from '../../test/render';
import { ReviewStage } from './ReviewStage';

it('shows the public regeneration marker and retries one candidate using the existing batch', async () => {
  new FakeDesktop().install().on('getStoryboard', () => ({ storyboard: null, items: [STORYBOARD_ITEM_FIXTURE] }));
  const detail = adaptProjectDetail(projectDetailPayload({ items: [STORYBOARD_ITEM_FIXTURE], jobs: [], outputs: [{ ...OUTPUT_FIXTURE, revision: 'retry' }] }));
  const retry = vi.fn();
  renderWithProviders(<ReviewStage detail={detail} selectedOutputIds={[]} onSelectionChange={vi.fn()} onRetryItem={retry} />);
  expect(await screen.findByText(/重新生成 ·/)).toBeInTheDocument();
  const action = screen.getByRole('button', { name: /^重新生成 / });
  await waitFor(() => expect(action).toBeEnabled());
  fireEvent.click(action);
  await waitFor(() => expect(retry).toHaveBeenCalledWith(STORYBOARD_ITEM_FIXTURE.id, expect.objectContaining({ candidateCount: 1 }), OUTPUT_FIXTURE.jobId));
});
