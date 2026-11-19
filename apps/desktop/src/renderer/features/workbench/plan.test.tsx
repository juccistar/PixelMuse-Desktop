import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { PLAN_JOB_FIXTURE, PROJECT_ID, projectDetailPayload } from '../../test/fixtures';
import { FakeDesktop } from '../../test/fake-desktop';
import { renderWithProviders } from '../../test/render';
import { saveProjectPlanningDraft } from '../../lib/projectPreparation';
import { WorkbenchPage } from './WorkbenchPage';
let desktop: FakeDesktop;
beforeEach(() => {
  desktop = new FakeDesktop().install();
  saveProjectPlanningDraft(PROJECT_ID, { selectionMode: 'AI', requestedTypes: [], requestedSuiteShots: [], instruction: '' });
});
function setup() { return renderWithProviders(<Routes><Route path="/projects/:projectId" element={<WorkbenchPage />} /></Routes>, { initialEntries: [`/projects/${PROJECT_ID}?view=setup`] }); }
describe('原版规划工作台 · 假 IPC', () => {
  it('保留手动类型选择，并提交具名规划参数', async () => {
    let captured: unknown;
    desktop.on('createProductImagePlanningJob', input => { captured = input; return { ...PLAN_JOB_FIXTURE, reused: false }; });
    const user = userEvent.setup(); setup();
    expect(await screen.findByDisplayValue('无线耳机 SPU')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '指定模板' }));
    const template = await screen.findByRole('button', { name: '白底/纯色底产品主图' });
    await user.click(template);
    expect(template).toHaveAttribute('aria-pressed', 'true');
    const submit = screen.getByRole('button', { name: 'AI 一键规划 →' });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    await waitFor(() => expect(captured).toMatchObject({ projectId: PROJECT_ID, scope: 'ALL', expectedRevision: expect.any(Number), regenerationKey: expect.any(String), planningMode: 'MANUAL', requestedTypes: ['hero-image'] }));
    expect(await screen.findByRole('heading', { name: '图片规划' })).toBeInTheDocument();
  });
  it('像素保护缺少商品真值时保留原门槛', async () => {
    desktop.on('getProject', () => projectDetailPayload({ defaultMode: 'PIXEL_PROTECTED', assets: [] })); setup();
    expect(await screen.findByText('像素保护需要至少一张产品图，否则生成会失败。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'AI 一键规划 →' })).toBeDisabled();
    expect(desktop.api.invoke).not.toHaveBeenCalledWith('createProductImagePlanningJob', expect.anything());
  });
  it('UNKNOWN 保留任务卡、解释结果待核实且阻止规划重发', async () => {
    const job = { ...PLAN_JOB_FIXTURE, status: 'UNKNOWN', retryable: false };
    desktop.on('getProject', () => projectDetailPayload({ jobs: [job] })); desktop.on('getJob', () => job); setup();
    expect(await screen.findByText(/任务已中断/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重试规划' })).not.toBeInTheDocument();
    expect(desktop.api.invoke).not.toHaveBeenCalledWith('retryJob', expect.anything());
  });
});
