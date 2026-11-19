import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { StrictMode } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { qk } from '../../api/queryKeys';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Input, Output } from '@ecomgen/contracts';
import { FakeDesktop } from '../../test/fake-desktop';
import { renderWithProviders } from '../../test/render';
import { PatternDraftWorkspacePage } from './PatternDraftWorkspacePage';
import { AppShell } from '../../components/AppShell';
const DRAFT: Output<'getPatternDraft'> = { id: 'aaaaaaaa-1111-4222-8333-444444444444', name: '隔离草稿', composeType: 'PLACEMENT', conditions: { theme: '', aspectRatio: '1:1', background: 'WHITE', candidateCount: 1 }, revision: 1, selectedCandidateId: null, compareCandidateId: null, archivedAt: null, candidateCount: 0, previewUrl: null, createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z' };
let desktop: FakeDesktop;
let cache: QueryClient;
function CachedDraft() { cache = useQueryClient(); return <PatternDraftWorkspacePage />; }
beforeEach(() => {
  desktop = new FakeDesktop().install(); desktop.on('getPatternDraft', () => DRAFT);
  desktop.on('listDraftMedia', () => ({ items: [] })); desktop.on('listDraftBatches', () => ({ items: [] })); desktop.on('listDraftCandidates', () => ({ items: [] }));
});
function setup() { renderWithProviders(<StrictMode><Routes><Route path="/pattern-drafts/:draftId" element={<CachedDraft />} /><Route path="/patterns" element={<p>花型墙目的地</p>} /></Routes></StrictMode>, { initialEntries: [`/pattern-drafts/${DRAFT.id}`] }); }
describe('草稿 CAS 自动保存与离开前 flush', () => {
  it('保存中继续编辑，使用返回 revision 串行保存最新内容', async () => {
    let release!: (value: unknown) => void; const calls: Input<'updatePatternDraft'>[] = [];
    desktop.on('updatePatternDraft', input => { calls.push(input); if (calls.length === 1) return new Promise(resolve => { release = resolve; }); return { ...DRAFT, ...input, revision: 3 }; });
    const user = userEvent.setup(); setup(); const field = await screen.findByLabelText('草稿名称');
    await user.clear(field); await user.type(field, '第一版');
    await waitFor(() => expect(calls).toHaveLength(1), { timeout: 2500 });
    await user.clear(field); await user.type(field, '第二版');
    await act(async () => release({ ...DRAFT, name: '第一版', revision: 2 }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toMatchObject({ name: '第二版', expectedRevision: 2 });
    expect(await screen.findByText('已保存')).toBeInTheDocument(); expect(field).toHaveValue('第二版');
  });
  it('迟到的旧版本查询不能覆盖已经保存的新名称', async () => {
    desktop.on('updatePatternDraft', input => ({ ...DRAFT, ...input, revision: 2 }));
    const user = userEvent.setup(); setup(); const field = await screen.findByLabelText('草稿名称');
    await user.clear(field); await user.type(field, '已保存的新名称');
    await waitFor(() => expect(cache.getQueryData<Output<'getPatternDraft'>>(qk.patternDraft(DRAFT.id))?.revision).toBe(2), { timeout: 2500 });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    await act(async () => { cache.setQueryData(qk.patternDraft(DRAFT.id), { ...DRAFT }); await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(field).toHaveValue('已保存的新名称');
  });
  it('冲突保留本地输入，停止自动重发并提供重新加载', async () => {
    let calls = 0; desktop.on('updatePatternDraft', () => { calls++; throw Object.assign(new Error('版本冲突'), { code: 'CONFLICT' }); });
    const user = userEvent.setup(); setup(); const field = await screen.findByLabelText('草稿名称');
    await user.clear(field); await user.type(field, '保留此修改');
    expect(await screen.findByText('有未保存修改（版本冲突）', {}, { timeout: 2500 })).toBeInTheDocument();
    expect(field).toHaveValue('保留此修改');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 900)); });
    expect(calls).toBe(1); expect(screen.getByRole('button', { name: '重新加载' })).toBeInTheDocument();
  });
  it('持久侧栏等待草稿 flush 后再导航', async () => {
    let release!: (value: unknown) => void; let input: Input<'updatePatternDraft'> | undefined;
    desktop.on('updatePatternDraft', value => { input = value; return new Promise(resolve => { release = resolve; }); });
    const user = userEvent.setup();
    renderWithProviders(<StrictMode><Routes><Route element={<AppShell />}><Route path="/pattern-drafts/:draftId" element={<CachedDraft />} /><Route path="/library" element={<p>资产库目的地</p>} /></Route></Routes></StrictMode>, { initialEntries: [`/pattern-drafts/${DRAFT.id}`] });
    const field = await screen.findByLabelText('草稿名称');
    await user.type(field, ' · 侧栏修改');
    await user.click(within(screen.getByRole('navigation', { name: '全局导航' })).getByRole('button', { name: '资产库' }));
    await waitFor(() => expect(input?.name).toContain('侧栏修改'));
    expect(screen.queryByText('资产库目的地')).not.toBeInTheDocument();
    await act(async () => release({ ...DRAFT, name: input!.name, revision: 2 }));
    expect(await screen.findByText('资产库目的地')).toBeInTheDocument();
  });
  it('持久侧栏保存失败时保留草稿和本地修改', async () => {
    desktop.on('updatePatternDraft', () => { throw new Error('写入失败'); });
    const user = userEvent.setup();
    renderWithProviders(<Routes><Route element={<AppShell />}><Route path="/pattern-drafts/:draftId" element={<CachedDraft />} /><Route path="/library" element={<p>资产库目的地</p>} /></Route></Routes>, { initialEntries: [`/pattern-drafts/${DRAFT.id}`] });
    const field = await screen.findByLabelText('草稿名称');
    await user.type(field, ' · 未保存');
    await user.click(within(screen.getByRole('navigation', { name: '全局导航' })).getByRole('button', { name: '资产库' }));
    expect(await screen.findByText('保存失败')).toBeInTheDocument();
    expect(screen.queryByText('资产库目的地')).not.toBeInTheDocument();
    expect(field).toHaveValue('隔离草稿 · 未保存');
  });
  it('返回花型墙等待当前修改持久保存后才导航', async () => {
    let release!: (value: unknown) => void; let input: Input<'updatePatternDraft'> | undefined;
    desktop.on('updatePatternDraft', value => { input = value; return new Promise(resolve => { release = resolve; }); });
    const user = userEvent.setup(); setup(); const field = await screen.findByLabelText('草稿名称');
    await user.type(field, ' · 最新'); await user.click(screen.getByRole('button', { name: '花型工坊' }));
    await waitFor(() => expect(input?.name).toContain('最新'));
    expect(screen.queryByText('花型墙目的地')).not.toBeInTheDocument();
    await act(async () => release({ ...DRAFT, name: input!.name, revision: 2 }));
    expect(await screen.findByText('花型墙目的地')).toBeInTheDocument();
  });
});
