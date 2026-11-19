import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resourceUrlFor, type DesktopHistory } from '@ecomgen/contracts';
import { adaptJob, adaptProjectDetail } from '../../api/adapters/projectDetail';
import { DesktopChanges } from '../../api/changes';
import { FakeDesktop } from '../../test/fake-desktop';
import { ASSET_ID, GENERATE_JOB_ID, PLAN_JOB_FIXTURE, PROJECT_ID, projectDetailPayload } from '../../test/fixtures';
import { renderWithProviders } from '../../test/render';
import { JobRecords } from './JobRecords';
import { BusinessActivityContext } from '../../components/businessActivity';
let desktop: FakeDesktop;
beforeEach(() => { desktop = new FakeDesktop().install(); });
const history = (changes: Partial<DesktopHistory> = {}): DesktopHistory => ({ sourceVersion: 2, kind: 'GENERATE', originalStatus: 'SUCCEEDED', requestState: 'COMPLETED', executable: false, resultStatus: 'AVAILABLE', result: { assetIds: [ASSET_ID], text: '保留的安全结果文本', tileability: { status: 'VERIFIED', score: 0.5 } }, files: [{ ref: { kind: 'ASSET', id: ASSET_ID }, mimeType: 'image/png', name: '原图.png', available: true }], ...changes });
const job = (extra: object = {}) => ({ ...PLAN_JOB_FIXTURE, id: GENERATE_JOB_ID, type: 'GENERATE', status: 'SUCCEEDED', retryable: false, ...extra });
function setup(rows: unknown[], canonical: (id: string) => unknown, open = true) {
  desktop.on('getJob', input => canonical(input.jobId));
  const detail = adaptProjectDetail(projectDetailPayload({ jobs: rows }));
  const view = renderWithProviders(<><DesktopChanges /><JobRecords detail={detail} /></>);
  if (open) fireEvent.click(screen.getByRole('button', { name: '任务详情' }));
  return view;
}

describe('canonical task records in the compact summary and right drawer', () => {
  it('runs project batch across pages and reports partial failures without a confirmation', async () => {
    const rows = Array.from({ length: 12 }, (_, index) => job({ id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, status: 'UNKNOWN' }));
    desktop.on('resolveJobInterruptions', () => ({ items: [{ jobId: rows[0]!.id, status: 'RETRIED', reason: null }, { jobId: rows[11]!.id, status: 'FAILED', reason: '任务状态已变化' }] }));
    setup(rows, id => rows.find(row => row.id === id)!);
    await userEvent.setup().click(screen.getByRole('button', { name: '重试异常任务' }));
    await waitFor(() => expect(desktop.api.invoke).toHaveBeenCalledWith('resolveJobInterruptions', { projectId: PROJECT_ID, action: 'RETRY' }));
    expect(await screen.findByText(/任务状态已变化/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
  it('keeps the page compact and counts all project tasks before reading drawer details', async () => {
    const rows = Array.from({ length: 501 }, (_, index) => job({ id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, status: index === 498 ? 'RUNNING' : index === 499 ? 'FAILED' : index === 500 ? 'UNKNOWN' : 'SUCCEEDED' }));
    setup(rows, id => rows.find(row => row.id === id)!, false);
    const summary = screen.getByRole('region', { name: '执行摘要' });
    expect(within(summary).getByText('进行中 1')).toBeInTheDocument();
    expect(within(summary).getByText('已完成 498')).toBeInTheDocument();
    expect(within(summary).getByText('失败 1')).toBeInTheDocument();
    expect(within(summary).getByText('已中断 1')).toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(desktop.api.invoke).not.toHaveBeenCalledWith('getJob', expect.anything());
    const user = userEvent.setup();
    await user.click(within(summary).getByRole('button', { name: '任务详情' }));
    await user.click(within(screen.getByRole('group', { name: '任务筛选' })).getByRole('button', { name: '异常' }));
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(2));
    expect(screen.getByText('任务已中断，可以重试或结束。')).toBeInTheDocument();
    const unknown = document.querySelector('article[data-status="UNKNOWN"]')!;
    expect(within(unknown as HTMLElement).getByRole('button', { name: '重试任务' })).toBeInTheDocument();
    expect(desktop.api.invoke).not.toHaveBeenCalledWith('retryJob', expect.anything());
    expect(desktop.api.invoke).not.toHaveBeenCalledWith('cancelJob', expect.anything());
  });

  it.each([false, true])('closes on outside click and reopens with controlled=%s, preserving Escape and close button', async controlled => {
    const detail = adaptProjectDetail(projectDetailPayload());
    function Records() {
      const [open, setOpen] = useState(false);
      return <JobRecords detail={detail} {...(controlled ? { open, onOpenChange: setOpen } : {})}/>;
    }
    renderWithProviders(<Records/>);
    const user = userEvent.setup();
    const openDetails = async () => {
      await user.click(screen.getByRole('button', { name: '任务详情' }));
      return screen.findByRole('dialog', { name: '任务详情' });
    };
    const dialog = await openDetails();
    const mask = dialog.closest('.ant-drawer')!.querySelector<HTMLElement>('.ant-drawer-mask')!;
    expect(mask).toBeInTheDocument();
    await user.click(mask);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '任务详情' })).not.toBeInTheDocument());
    const reopened = await openDetails();
    fireEvent.keyDown(reopened, { key: 'Escape', keyCode: 27 });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '任务详情' })).not.toBeInTheDocument());
    const reopenedAgain = await openDetails();
    await user.click(within(reopenedAgain).getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '任务详情' })).not.toBeInTheDocument());
  });

  it('closes the task portal while the preserved business page is hidden', async () => {
    desktop.on('getJob', () => job());
    const detail = adaptProjectDetail(projectDetailPayload({ jobs: [job()] }));
    const view = renderWithProviders(<BusinessActivityContext.Provider value={true}><JobRecords detail={detail}/></BusinessActivityContext.Provider>);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '任务详情' }));
    expect(await screen.findByRole('dialog', { name: '任务详情' })).toBeVisible();
    view.rerender(<BusinessActivityContext.Provider value={false}><JobRecords detail={detail}/></BusinessActivityContext.Provider>);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '任务详情' })).not.toBeInTheDocument());
    view.rerender(<BusinessActivityContext.Provider value={true}><JobRecords detail={detail}/></BusinessActivityContext.Provider>);
    expect(screen.queryByRole('dialog', { name: '任务详情' })).not.toBeInTheDocument();
  });

  it('honors backend retry capability for cancelled jobs', async () => {
    const cancelled = job({ status: 'CANCELLED', retryable: true });
    desktop.on('getJobActions', () => ({ cancel: { available: false, reason: null }, retry: { available: false, reason: '请在领域工作区继续' }, end: { available: false, reason: null } }));
    setup([cancelled], () => cancelled);
    const button = await screen.findByRole('button', { name: '重试任务' });
    await waitFor(() => expect(desktop.api.invoke).toHaveBeenCalledWith('getJobActions', { jobId: GENERATE_JOB_ID }));
    expect(button).toBeDisabled();
    expect(desktop.api.invoke).not.toHaveBeenCalledWith('retryJob', expect.anything());
  });

  it('keeps failed detail reads explicit and lets the user read them again', async () => {
    let failed = true;
    setup([job()], () => { if (failed) throw new Error('record unavailable'); return job(); });
    expect(await screen.findByText('任务记录加载失败')).toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    failed = false;
    await userEvent.setup().click(screen.getByRole('button', { name: '重新读取' }));
    expect(await screen.findByRole('article')).toBeInTheDocument();
  });
  it('retains validated history in both project and single-job adapters', () => {
    const raw = job({ history: history(), retryable: true });
    expect(adaptJob(raw)).toMatchObject({ retryable: false, history: { executable: false, result: { text: '保留的安全结果文本' } } });
    expect(adaptProjectDetail(projectDetailPayload({ jobs: [raw] })).jobs[0]!.history).toEqual(history());
  });

  it('queries history absent from getProject, previews the ASSET and saves original resource identities', async () => {
    const user = userEvent.setup();
    const files: DesktopHistory['files'] = [
      { ref: { kind: 'ASSET', id: ASSET_ID }, name: '原图.png', mimeType: 'image/png', available: true },
      { ref: { kind: 'EXPORT', id: GENERATE_JOB_ID }, name: '旧包.zip', mimeType: 'application/zip', available: true },
      { ref: { kind: 'LAYER_PSD', id: GENERATE_JOB_ID }, name: '旧图.psd', mimeType: 'image/vnd.adobe.photoshop', available: true },
    ];
    setup([job()], () => job({ history: history({ files }) }));
    expect(await screen.findByText('桌面 v2 · 生图 · 只读历史')).toBeInTheDocument();
    expect(screen.getByText('保留的安全结果文本')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '原图.png' })).toHaveAttribute('src', resourceUrlFor({ kind: 'ASSET', id: ASSET_ID }));
    const buttons = screen.getAllByRole('button', { name: '保存文件' });
    for (const button of buttons) await user.click(button);
    for (const file of files) expect(desktop.api.saveArtifact).toHaveBeenCalledWith(file.ref);
    expect(desktop.api.invoke).toHaveBeenCalledWith('getJob', { jobId: GENERATE_JOB_ID });
    expect(desktop.api.invoke).not.toHaveBeenCalledWith('createGenerationJobs', expect.anything());
  });

  it('shows UNKNOWN and unavailable results/files with no retry/cancel/regenerate controls', async () => {
    setup([job({ status: 'UNKNOWN', retryable: true })], () => job({ status: 'UNKNOWN', history: history({ originalStatus: 'RUNNING', requestState: 'IN_FLIGHT', resultStatus: 'UNAVAILABLE', result: null, files: [{ ref: { kind: 'ASSET', id: ASSET_ID }, available: false }] }) }));
    expect(await screen.findByText(/外部请求结果未知，请核实原服务记录/)).toBeInTheDocument();
    expect(screen.getByText('历史结果无法安全读取，原记录已保留。')).toBeInTheDocument();
    expect(screen.getByText(/文件不可用：文件缺失/)).toBeInTheDocument();
    expect(within(screen.getByRole('article')).queryByRole('button')).not.toBeInTheDocument();
    expect(desktop.api.invoke).not.toHaveBeenCalledWith('retryJob', expect.anything());
    expect(desktop.api.invoke).not.toHaveBeenCalledWith('cancelJob', expect.anything());
  });

  it('turns a failed restricted preview into an unavailable resource and refreshes on resource invalidation', async () => {
    let available = true;
    setup([job()], () => job({ history: history({ files: [{ ref: { kind: 'ASSET', id: ASSET_ID }, mimeType: 'image/png', name: '原图.png', available }] }) }));
    const image = await screen.findByRole('img', { name: '原图.png' });
    fireEvent.error(image);
    expect(await screen.findByText(/文件不可用：文件缺失/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '保存文件' })).not.toBeInTheDocument();
    const before = vi.mocked(desktop.api.invoke).mock.calls.filter(call => call[0] === 'getJob').length;
    available = false; desktop.emit({ topic: 'resources', projectId: PROJECT_ID });
    await waitFor(() => expect(vi.mocked(desktop.api.invoke).mock.calls.filter(call => call[0] === 'getJob').length).toBeGreaterThan(before));
    expect(screen.queryByRole('button', { name: '保存文件' })).not.toBeInTheDocument();
  });

  it('shows a file changed after querying as unavailable when native save rejects it', async () => {
    const user = userEvent.setup();
    vi.mocked(desktop.api.saveArtifact).mockRejectedValue(Object.assign(new Error('资源已改变'), { code: 'RESOURCE_CHANGED' }));
    setup([job()], () => job({ history: history({ files: [{ ref: { kind: 'EXPORT', id: GENERATE_JOB_ID }, name: '旧包.zip', mimeType: 'application/zip', available: true }] }) }));
    await user.click(await screen.findByRole('button', { name: '保存文件' }));
    expect(await screen.findByText(/文件不可用：文件缺失/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '保存文件' })).not.toBeInTheDocument();
  });

  it('keeps all 501 project IDs reachable with at most ten canonical requests per page', async () => {
    const user = userEvent.setup();
    const rows = Array.from({ length: 501 }, (_, i) => job({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }));
    setup(rows, id => job({ id, history: history({ kind: 'EXPORT', sourceVersion: 1, resultStatus: 'NONE', result: null, files: [] }) }));
    await waitFor(() => expect(vi.mocked(desktop.api.invoke).mock.calls.filter(call => call[0] === 'getJob')).toHaveLength(10));
    await user.click(screen.getByTitle('51').querySelector('a')!);
    expect(screen.getByTitle('51')).toHaveClass('ant-pagination-item-active');
    await waitFor(() => expect(desktop.api.invoke).toHaveBeenCalledWith('getJob', { jobId: rows[500]!.id }));
    expect(vi.mocked(desktop.api.invoke).mock.calls.filter(call => call[0] === 'getJob')).toHaveLength(11);
    expect(desktop.api.invoke).not.toHaveBeenCalledWith('listJobs', expect.anything());
    expect(screen.getByText('桌面 v1 · 导出 · 只读历史')).toBeInTheDocument();
  });

  it('preserves normal live-job retry and cancellation', async () => {
    const user = userEvent.setup();
    const failed = job({ status: 'FAILED', retryable: true });
    desktop.on('getJobActions', () => ({ cancel: { available: false, reason: null }, retry: { available: true, reason: null }, end: { available: false, reason: null } }));
    desktop.on('retryJob', () => job({ status: 'QUEUED' }));
    desktop.on('cancelJob', () => job({ status: 'CANCELLED' }));
    setup([failed], () => failed);
    const retryButton = await screen.findByRole('button', { name: '重试任务' });
    await waitFor(() => expect(retryButton).toBeEnabled());
    await user.click(retryButton);
    expect(desktop.api.invoke).toHaveBeenCalledWith('retryJob', { jobId: GENERATE_JOB_ID });
    expect(desktop.api.invoke).not.toHaveBeenCalledWith('cancelJob', { jobId: GENERATE_JOB_ID });
  });
});
