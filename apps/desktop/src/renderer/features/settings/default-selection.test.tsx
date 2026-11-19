import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APPLICATION_SETTINGS, MODEL_SPEC_DEFAULTS, type ApplicationSettings } from '@ecomgen/contracts';
import { FakeDesktop, PROVIDER_FIXTURE } from '../../test/fake-desktop';
import { renderWithProviders } from '../../test/render';
import { PLAN_JOB_FIXTURE } from '../../test/fixtures';
import { ModelsPage } from '../models/ModelsPage';
import { PatternWorkspacePage } from '../patterns/PatternWorkspacePage';
import { AppShell } from '../../components/AppShell';
import { DesktopChanges } from '../../api/changes';
import { SettingsPage } from './SettingsPage';
let desktop: FakeDesktop;
const persona = { id: '11111111-1111-4111-8111-111111111111', name: '默认选择回归模特', spec: MODEL_SPEC_DEFAULTS, notes: '', hasReferenceFace: false, portraitCount: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
const image1 = PROVIDER_FIXTURE.models[1]!;
const image2 = { ...image1, id: 'gpt-image-2' };
const provider = { ...PROVIDER_FIXTURE, models: [image1, image2] };
const settings = (modelId: string | null = null): ApplicationSettings => ({ ...structuredClone(DEFAULT_APPLICATION_SETTINGS), defaults: { ...DEFAULT_APPLICATION_SETTINGS.defaults, imageModel: modelId ? { providerId: provider.id, modelId } : null } });
beforeEach(() => { desktop = new FakeDesktop().install(); localStorage.clear(); sessionStorage.clear(); desktop.on('listModels', () => ({ items: [persona], nextCursor: null })); desktop.on('listModelPortraits', () => ({ items: [] })); });
async function pick(label: string, option: string) {
  const input = screen.getByLabelText(label, { selector: 'input' }); fireEvent.mouseDown(input); fireEvent.click(input);
  const options = await screen.findAllByTitle(option); fireEvent.click(options.find(element => element.classList.contains('ant-select-item-option'))!);
}
function selected(label: string, hidden = false) {
  const input = hidden ? document.querySelector(`[aria-label="${label}"]`)! : screen.getByLabelText(label, { selector: 'input' });
  return input.closest('.ant-select')!;
}
function noPaid() { expect(vi.mocked(desktop.api.invoke).mock.calls.filter(([op]) => /^(create.*Job|createDraft|testProviderConnection)/.test(op))).toEqual([]); }
function workspace() { return renderWithProviders(<><DesktopChanges/><Routes><Route element={<AppShell/>}><Route path="/models" element={<ModelsPage/>}/><Route path="/settings/:section" element={<SettingsPage/>}/></Route></Routes></>, { initialEntries: ['/models'] }); }
describe('显式选择优先于迟到默认值', () => {
  it('直接重选当前1/AUTO/1K也保留，并只按用户参数生成', async () => {
    desktop.on('listProviders', () => ({ items: [provider], nextCursor: null }));
    let release!: (value: ApplicationSettings) => void;
    desktop.on('getApplicationSettings', () => new Promise(resolve => { release = resolve; }));
    desktop.on('createModelCastJob', () => ({ ...PLAN_JOB_FIXTURE, reused: false }));
    const user = userEvent.setup(); renderWithProviders(<ModelsPage/>);
    await screen.findByText(persona.name, { selector: 'h2' });
    await pick('定妆照生图模型', 'OpenAI 官方 / gpt-image-2（透明底）');
    await pick('定妆照候选张数', '1 张'); await pick('定妆照画幅', 'AUTO'); await pick('定妆照分辨率', '1K');
    const late = settings('gpt-image-1'); late.defaults.candidatesPerType = 4; late.defaults.imageAspectRatio = '16:9'; late.defaults.imageResolution = '4K';
    await act(async () => release(late));
    expect(selected('定妆照候选张数')).toHaveTextContent('1 张'); expect(selected('定妆照画幅')).toHaveTextContent('AUTO'); expect(selected('定妆照分辨率')).toHaveTextContent('1K');
    noPaid(); await user.click(screen.getByRole('button', { name: '生成定妆照' }));
    await waitFor(() => expect(desktop.api.invoke).toHaveBeenCalledWith('createModelCastJob', expect.objectContaining({ imageModelId: 'gpt-image-2', candidateCount: 1, aspectRatio: 'AUTO', imageResolution: '1K' })));
  });
  it('首个连接的自动回退可以被随后配置的默认替换，返回保留搜索内容', async () => {
    let configured = false, preferred: string | null = null;
    desktop.on('listProviders', () => ({ items: configured ? [provider] : [], nextCursor: null })); desktop.on('getApplicationSettings', () => settings(preferred));
    const user = userEvent.setup(); workspace(); await screen.findByText(persona.name, { selector: 'h2' });
    await user.type(screen.getByLabelText('搜索模特'), '默认'); await user.click(screen.getByText('管理模型').closest('button')!); await screen.findByText('模型配置', { selector: 'h2' });
    act(() => { configured = true; desktop.emit({ topic: 'providers', aggregateId: provider.id }); });
    await waitFor(() => expect(selected('定妆照生图模型', true)).toHaveTextContent('OpenAI 官方 / gpt-image-1'));
    act(() => { preferred = 'gpt-image-2'; desktop.emit({ topic: 'settings', aggregateId: 'application' }); });
    await waitFor(() => expect(selected('定妆照生图模型', true)).toHaveTextContent('gpt-image-2'));
    await user.click(screen.getByText('返回创作页面').closest('button')!);
    expect(selected('定妆照生图模型')).toHaveTextContent('gpt-image-2'); expect(screen.getByLabelText('搜索模特')).toHaveValue('默认'); noPaid();
  });
  it('直接重选当前花型候选1张不会被迟到的4张默认覆盖', async () => {
    const patternId = '22222222-2222-4222-8222-222222222222';
    desktop.on('listPatterns', () => ({ items: [{ id: patternId, name: '独立花型', source: 'UPLOADED', tags: [], tileable: 'NONE', createdAt: PLAN_JOB_FIXTURE.createdAt, updatedAt: PLAN_JOB_FIXTURE.updatedAt }] }));
    desktop.on('listPatternPipelines', () => ({ items: [] })); desktop.on('listPatternPrintPacks', () => ({ items: [] })); desktop.on('getPatternListingResult', () => ({ result: null }));
    let release!: (value: ApplicationSettings) => void; desktop.on('getApplicationSettings', () => new Promise(resolve => { release = resolve; }));
    renderWithProviders(<Routes><Route path="/patterns/:patternId" element={<PatternWorkspacePage/>}/></Routes>, { initialEntries: [`/patterns/${patternId}?section=derive`] });
    await screen.findByRole('combobox', { name: '候选张数' }); await pick('候选张数', '1 张候选');
    const late = settings(); late.defaults.candidatesPerType = 4; await act(async () => release(late));
    expect(selected('候选张数')).toHaveTextContent('1 张候选'); noPaid();
  });
  it('直接选择当前自动回退模型也算用户选择，不能被新默认替换', async () => {
    let preferred: string | null = null;
    desktop.on('listProviders', () => ({ items: [provider], nextCursor: null })); desktop.on('getApplicationSettings', () => settings(preferred));
    const user = userEvent.setup(); workspace(); await screen.findByText(persona.name, { selector: 'h2' });
    await waitFor(() => expect(selected('定妆照生图模型')).toHaveTextContent('gpt-image-1'));
    await pick('定妆照生图模型', 'OpenAI 官方 / gpt-image-1（透明底）');
    await user.click(screen.getByText('管理模型').closest('button')!); await screen.findByText('模型配置', { selector: 'h2' });
    act(() => { preferred = 'gpt-image-2'; desktop.emit({ topic: 'settings', aggregateId: 'application' }); });
    await user.click(screen.getByText('返回创作页面').closest('button')!);
    expect(selected('定妆照生图模型')).toHaveTextContent('gpt-image-1'); noPaid();
  });
});
