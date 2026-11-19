import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APPLICATION_SETTINGS, MODEL_SPEC_DEFAULTS, type ApplicationSettings } from '@ecomgen/contracts';
import { FakeDesktop, PROVIDER_FIXTURE } from '../../test/fake-desktop';
import { ASSET_FIXTURE, PLAN_JOB_FIXTURE, PROJECT_ID, projectDetailPayload } from '../../test/fixtures';
import { renderWithProviders } from '../../test/render';
import { adaptProjectDetail } from '../../api/adapters/projectDetail';
import { DesktopChanges } from '../../api/changes';
import { AppShell } from '../../components/AppShell';
import { AssetsStage } from '../workbench/AssetsStage';
import { ModelsPage } from '../models/ModelsPage';
import { PatternsPage } from '../patterns/PatternsPage';
import { PatternWorkspacePage } from '../patterns/PatternWorkspacePage';
import { SettingsPage } from './SettingsPage';
let desktop: FakeDesktop;
beforeEach(() => { desktop = new FakeDesktop().install(); localStorage.clear(); });
function Destination() { const location = useLocation(); return <p>目的地 {location.pathname}</p>; }
function renderWorkspace(source: React.ReactElement, initialEntry: string) {
  return renderWithProviders(<><DesktopChanges/><Routes><Route element={<AppShell/>}>
    <Route path="/projects/:projectId" element={source}/>
    <Route path="/patterns" element={source}/>
    <Route path="/models" element={source}/>
    <Route path="/patterns/:patternId" element={<Destination/>}/>
    <Route path="/library" element={<Destination/>}/>
    <Route path="/settings/:section" element={<SettingsPage/>}/>
  </Route></Routes></>, { initialEntries: [initialEntry] });
}
function assertNoPaidCalls() {
  const paid = vi.mocked(desktop.api.invoke).mock.calls.filter(([operation]) => /^(create.*Job|createDraft|testProviderConnection)/.test(operation));
  expect(paid).toEqual([]);
}
async function pick(_user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  const input = screen.getByLabelText(label, { selector: 'input' });
  fireEvent.mouseDown(input); fireEvent.click(input);
  const options = await screen.findAllByTitle(option);
  fireEvent.click(options.find(element => element.classList.contains('ant-select-item-option'))!);
}
const persona = { id: '11111111-1111-4111-8111-111111111111', name: '回归模特', spec: MODEL_SPEC_DEFAULTS, notes: '', hasReferenceFace: false, portraitCount: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
function installPersona() {
  desktop.on('listModels', () => ({ items: [persona], nextCursor: null }));
  desktop.on('listModelPortraits', () => ({ items: [] }));
}
describe('设置后台页面的实际事件与任务生命周期', () => {
  it('花型详情数据在设置期间返回，不触发来源深链清理跳转', async () => {
    const patternId = '22222222-2222-4222-8222-222222222222';
    let release!: (value: unknown) => void;
    desktop.on('listPatterns', () => new Promise(resolve => { release = resolve; }));
    desktop.on('listPatternPipelines', () => ({ items: [] }));
    desktop.on('listPatternPrintPacks', () => ({ items: [] }));
    const user = userEvent.setup();
    renderWithProviders(<Routes><Route element={<AppShell/>}><Route path="/patterns/:patternId" element={<PatternWorkspacePage/>}/><Route path="/settings/:section" element={<SettingsPage/>}/></Route></Routes>, { initialEntries: [`/patterns/${patternId}?section=derive`] });
    await user.click(screen.getByRole('button', { name: '设置' }));
    await user.type(await screen.findByLabelText('图片文案语言'), '保留深链设置');
    await act(async () => release({ items: [{ id: patternId, name: '迟到花型', source: 'UPLOADED', tags: [], tileable: 'NONE', createdAt: PLAN_JOB_FIXTURE.createdAt, updatedAt: PLAN_JOB_FIXTURE.updatedAt }] }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
    expect(screen.getByLabelText('图片文案语言')).toHaveValue('保留深链设置');
    assertNoPaidCalls();
  });
  it('设置中的图片粘贴不写入隐藏商品，返回保留素材类型并恢复实际粘贴', async () => {
    desktop.on('uploadAsset', input => ({ ...ASSET_FIXTURE, kind: input.kind }));
    const user = userEvent.setup();
    renderWorkspace(<AssetsStage detail={adaptProjectDetail(projectDetailPayload())}/>, `/projects/${PROJECT_ID}?view=setup`);
    // 保留默认 PRODUCT 的真实监听场景。
    await user.click(screen.getByRole('button', { name: '设置' }));
    const language = await screen.findByLabelText('图片文案语言');
    const image = new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII='), char => char.charCodeAt(0))], 'clipboard.png', { type: 'image/png' });
    fireEvent.paste(language, { clipboardData: { files: [image] } });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
    expect(desktop.api.invoke).not.toHaveBeenCalledWith('uploadAsset', expect.anything());
    await user.type(language, '未保存的语言');
    await user.click(screen.getByRole('button', { name: '返回创作页面' }));
    await user.click(await screen.findByRole('button', { name: '放弃修改' }));
    await waitFor(() => expect(screen.getByLabelText('上传商品图')).toBeVisible());
    fireEvent.paste(document, { clipboardData: { files: [image] } });
    await waitFor(() => expect(desktop.api.invoke).toHaveBeenCalledWith('uploadAsset', expect.objectContaining({ projectId: PROJECT_ID, kind: 'PRODUCT' })));
    assertNoPaidCalls();
  });
  it.each(['return', 'other-workspace'] as const)('隐藏花型完成不会丢弃设置输入，结果导航仅在来源返回时执行：%s', async action => {
    let completed = false;
    const patternId = '22222222-2222-4222-8222-222222222222';
    sessionStorage.setItem('ecomgen.patterns.activeJobs', JSON.stringify([{ jobId: PLAN_JOB_FIXTURE.id, kind: 'EXTRACT', title: '后台提取' }]));
    desktop.on('getJob', () => ({ ...PLAN_JOB_FIXTURE, type: 'PATTERN_EXTRACT', status: completed ? 'SUCCEEDED' : 'QUEUED' }));
    const existing = { id: '33333333-3333-4333-8333-333333333333', name: '已有花型', source: 'UPLOADED', tags: [], tileable: 'NONE', createdAt: PLAN_JOB_FIXTURE.createdAt, updatedAt: PLAN_JOB_FIXTURE.updatedAt };
    desktop.on('listPatterns', () => ({ items: [existing, ...(completed ? [{ ...existing, id: patternId, name: '完成花型', source: 'EXTRACTED', sourceJobId: PLAN_JOB_FIXTURE.id }] : [])] }));
    const user = userEvent.setup(); renderWorkspace(<PatternsPage/>, '/patterns');
    await waitFor(() => expect(desktop.api.invoke).toHaveBeenCalledWith('getJob', { jobId: PLAN_JOB_FIXTURE.id }));
    await user.click(screen.getByRole('button', { name: '设置' }));
    await user.type(await screen.findByLabelText('图片文案语言'), '保留这项未保存设置');
    act(() => { completed = true; desktop.emit({ topic: 'jobs', aggregateId: PLAN_JOB_FIXTURE.id, projectId: PROJECT_ID }); });
    await screen.findByText('「后台提取」完成，新增 1 个花型');
    expect(screen.getByLabelText('图片文案语言')).toHaveValue('保留这项未保存设置');
    expect(screen.queryByText(`目的地 /patterns/${patternId}`)).not.toBeInTheDocument();
    if (action === 'return') {
      await user.click(screen.getByRole('button', { name: '返回创作页面' }));
      await user.click(await screen.findByRole('button', { name: '放弃修改' }));
      expect(await screen.findByText(`目的地 /patterns/${patternId}`)).toBeVisible();
    } else {
      await user.click(within(screen.getByRole('navigation', { name: '全局导航' })).getByRole('button', { name: '资产库' }));
      await user.click(await screen.findByRole('button', { name: '放弃修改' }));
      expect(await screen.findByText('目的地 /library')).toBeVisible();
      await user.click(within(screen.getByRole('navigation', { name: '全局导航' })).getByRole('button', { name: '花型工坊' }));
      expect(await screen.findByText('完成花型')).toBeVisible();
      expect(screen.queryByText(`目的地 /patterns/${patternId}`)).not.toBeInTheDocument();
    }
    assertNoPaidCalls();
  });
});
describe('迟到默认值与首个连接的实际控件', () => {
  it('花型衍生显式选回 1 张后，迟到默认值不增加候选或自动创建任务', async () => {
    const patternId = '22222222-2222-4222-8222-222222222222';
    desktop.on('listPatterns', () => ({ items: [{ id: patternId, name: '衍生来源', source: 'UPLOADED', tags: [], tileable: 'NONE', createdAt: PLAN_JOB_FIXTURE.createdAt, updatedAt: PLAN_JOB_FIXTURE.updatedAt }] }));
    desktop.on('listPatternPipelines', () => ({ items: [] }));
    desktop.on('listPatternPrintPacks', () => ({ items: [] }));
    desktop.on('getPatternListingResult', () => ({ result: null }));
    let release!: (settings: ApplicationSettings) => void;
    desktop.on('getApplicationSettings', () => new Promise(resolve => { release = resolve; }));
    const user = userEvent.setup();
    renderWithProviders(<Routes><Route element={<AppShell/>}><Route path="/patterns/:patternId" element={<PatternWorkspacePage/>}/><Route path="/settings/:section" element={<SettingsPage/>}/></Route></Routes>, { initialEntries: [`/patterns/${patternId}?section=derive`] });
    await screen.findByRole('combobox', { name: '候选张数' });
    await pick(user, '候选张数', '2 张候选'); await pick(user, '候选张数', '1 张候选');
    await act(async () => release({ ...structuredClone(DEFAULT_APPLICATION_SETTINGS), defaults: { ...DEFAULT_APPLICATION_SETTINGS.defaults, candidatesPerType: 4 } }));
    expect(screen.getByRole('combobox', { name: '候选张数' }).closest('.ant-select')).toHaveTextContent('1 张候选');
    await user.click(screen.getByRole('button', { name: '设置' }));
    await user.type(await screen.findByLabelText('图片文案语言'), '衍生设置输入');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
    expect(screen.getByLabelText('图片文案语言')).toHaveValue('衍生设置输入');
    assertNoPaidCalls();
  });
  it('先选回 1/AUTO/1K 后，迟到的 4/16:9/4K 不覆盖显式值，点击生成仍只提交 1 张', async () => {
    installPersona();
    const provider = { ...PROVIDER_FIXTURE, models: [{ ...PROVIDER_FIXTURE.models[1]!, id: 'gpt-image-2' }] };
    desktop.on('listProviders', () => ({ items: [provider], nextCursor: null }));
    let release!: (settings: ApplicationSettings) => void;
    desktop.on('getApplicationSettings', () => new Promise(resolve => { release = resolve; }));
    desktop.on('createModelCastJob', () => ({ ...PLAN_JOB_FIXTURE, reused: false }));
    const user = userEvent.setup(); renderWithProviders(<ModelsPage/>);
    await screen.findByText(persona.name, { selector: 'h2' });
    await pick(user, '定妆照生图模型', 'OpenAI 官方 / gpt-image-2（透明底）');
    await pick(user, '定妆照候选张数', '2 张'); await pick(user, '定妆照候选张数', '1 张');
    await pick(user, '定妆照画幅', '2:3'); await pick(user, '定妆照画幅', 'AUTO');
    await pick(user, '定妆照分辨率', '2K'); await pick(user, '定妆照分辨率', '1K');
    await act(async () => release({ ...structuredClone(DEFAULT_APPLICATION_SETTINGS), defaults: { ...DEFAULT_APPLICATION_SETTINGS.defaults, candidatesPerType: 4, imageAspectRatio: '16:9', imageResolution: '4K' } }));
    assertNoPaidCalls();
    await user.click(screen.getByRole('button', { name: '生成定妆照' }));
    await waitFor(() => expect(desktop.api.invoke).toHaveBeenCalledWith('createModelCastJob', expect.objectContaining({ imageModelId: 'gpt-image-2', candidateCount: 1, aspectRatio: 'AUTO', imageResolution: '1K' })));
  });
  it('初始空连接经设置添加首个默认模型后，原模特实例自动填充空选择且不发生成请求', async () => {
    installPersona();
    let configured = false;
    const preferred = { providerId: PROVIDER_FIXTURE.id, modelId: 'gpt-image-1' };
    desktop.on('listProviders', () => ({ items: configured ? [PROVIDER_FIXTURE] : [], nextCursor: null }));
    desktop.on('getApplicationSettings', () => ({ ...structuredClone(DEFAULT_APPLICATION_SETTINGS), defaults: { ...DEFAULT_APPLICATION_SETTINGS.defaults, imageModel: configured ? preferred : null } }));
    const user = userEvent.setup(); renderWorkspace(<ModelsPage/>, '/models');
    await screen.findByText(persona.name, { selector: 'h2' });
    await user.type(screen.getByLabelText('搜索模特'), '回归');
    expect(screen.getByLabelText('定妆照生图模型', { selector: 'input' }).closest('.ant-select')).toHaveTextContent('选择生图模型');
    await user.click(screen.getByRole('button', { name: '管理模型' }));
    await screen.findByRole('heading', { name: '模型配置' });
    act(() => { configured = true; desktop.emit({ topic: 'providers', aggregateId: PROVIDER_FIXTURE.id }); desktop.emit({ topic: 'settings', aggregateId: 'application' }); });
    await user.click(screen.getByRole('button', { name: '返回创作页面' }));
    await waitFor(() => expect(screen.getByLabelText('定妆照生图模型', { selector: 'input' }).closest('.ant-select')).toHaveTextContent('OpenAI 官方 / gpt-image-1'));
    expect(screen.getByLabelText('搜索模特')).toHaveValue('回归');
    assertNoPaidCalls();
  });
});
