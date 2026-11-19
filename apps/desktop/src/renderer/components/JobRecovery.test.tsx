import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { FakeDesktop } from '../test/fake-desktop';
import { renderWithProviders } from '../test/render';
import { JobRecovery } from './JobRecovery';

const jobId = '00000000-0000-4000-8000-000000000001';
let desktop: FakeDesktop;
beforeEach(() => {
  desktop = new FakeDesktop().install();
  desktop.on('getJobActions', () => ({ cancel: { available: false, reason: null }, retry: { available: true, reason: null }, end: { available: true, reason: null } }));
  desktop.on('getJobRecovery', () => ({ canRecover: false, recoveryReason: '暂不支持恢复' }));
  desktop.on('resolveJobInterruptions', input => ({ items: [{ jobId, status: input.action === 'RETRY' ? 'RETRIED' : 'ENDED', reason: null }] }));
});

it.each([['重试任务', 'RETRY'], ['结束任务', 'END']] as const)('directly handles %s without a dialog', async (label, action) => {
  renderWithProviders(<JobRecovery jobId={jobId}/>);
  const button = await screen.findByRole('button', { name: label });
  await waitFor(() => expect(button).toBeEnabled());
  await userEvent.setup().click(button);
  await waitFor(() => expect(desktop.api.invoke).toHaveBeenCalledWith('resolveJobInterruptions', { jobId, action }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  await waitFor(() => expect(vi.mocked(desktop.api.invoke).mock.calls.filter(([name]) => name === 'getJobActions').length).toBeGreaterThan(1));
});

it('disables unavailable actions and prevents a second click while pending', async () => {
  let finish!: (value: { items: { jobId: string; status: 'RETRIED'; reason: null }[] }) => void;
  desktop.on('getJobActions', () => ({ cancel: { available: false, reason: null }, retry: { available: true, reason: null }, end: { available: false, reason: '不可结束' } }));
  desktop.on('resolveJobInterruptions', () => new Promise(resolve => { finish = resolve; }));
  renderWithProviders(<JobRecovery jobId={jobId}/>);
  const retry = await screen.findByRole('button', { name: '重试任务' });
  await waitFor(() => expect(retry).toBeEnabled());
  expect(screen.getByRole('button', { name: '结束任务' })).toBeDisabled();
  await userEvent.setup().click(retry);
  expect(retry).toBeDisabled();
  finish({ items: [{ jobId, status: 'RETRIED', reason: null }] });
  await waitFor(() => expect(retry).toBeEnabled());
});

it('does not act while disabled', async () => {
  renderWithProviders(<JobRecovery jobId={jobId} disabled/>);
  const retry = await screen.findByRole('button', { name: '重试任务' });
  await waitFor(() => expect(desktop.api.invoke).toHaveBeenCalledWith('getJobActions', { jobId }));
  expect(retry).toBeDisabled();
  expect(screen.getByRole('button', { name: '结束任务' })).toBeDisabled();
  expect(desktop.api.invoke).not.toHaveBeenCalledWith('resolveJobInterruptions', expect.anything());
});

it('reports a skipped resolution and invokes the local reload callback', async () => {
  const onResolved = vi.fn();
  desktop.on('resolveJobInterruptions', () => ({ items: [{ jobId, status: 'SKIPPED', reason: '状态已变化' }] }));
  renderWithProviders(<JobRecovery jobId={jobId} onResolved={onResolved}/>);
  const retry = await screen.findByRole('button', { name: '重试任务' });
  await waitFor(() => expect(retry).toBeEnabled());
  await userEvent.setup().click(retry);
  expect(await screen.findByText('状态已变化')).toBeInTheDocument();
  expect(onResolved).toHaveBeenCalled();
});
