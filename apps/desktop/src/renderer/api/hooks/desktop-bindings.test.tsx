import '../../test/setup';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDesktop } from '../../test/fake-desktop';
import { ASSET_FIXTURE, EXPORT_FIXTURE, EXPORT_JOB_FIXTURE, GENERATE_JOB_FIXTURE, ITEM_ID, PLAN_JOB_FIXTURE, PROJECT_ID } from '../../test/fixtures';
import { useUploadAsset } from './useAssets';
import { useCreateGenerationJobs } from './useGeneration';
import { useCreatePlanningJob } from './usePlanning';
import { useCreateExportJob } from './useExport';
import { useProjectEvents } from './useProjectEvents';
import { fileInput, invoke } from '../client';
import { readResource, saveResource } from '../../lib/resource';
let desktop: FakeDesktop; let client: QueryClient;
beforeEach(() => { desktop = new FakeDesktop().install(); client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); });
function wrapper({ children }: { children: ReactNode }) { return <QueryClientProvider client={client}>{children}</QueryClientProvider>; }
const PNG = Uint8Array.from([137,80,78,71,13,10,26,10]);
describe('桌面命名操作与资源绑定', () => {
  it('上传有界真实图片字节，返回受限资源 URL', async () => {
    desktop.on('uploadAsset', input => { expect(input).toMatchObject({ projectId: PROJECT_ID, kind: 'PRODUCT', file: { name: 'truth.png', mimeType: 'image/png', base64: 'iVBORw0KGgo=' } }); return ASSET_FIXTURE; });
    const { result } = renderHook(() => useUploadAsset(), { wrapper });
    const asset = await act(() => result.current.mutateAsync({ projectId: PROJECT_ID, file: new File([PNG], 'truth.png', { type: 'image/png' }), kind: 'PRODUCT' }));
    expect(asset.url).toBe(`ecomgen-resource://ASSET/${ASSET_FIXTURE.id}`);
    expect(asset).not.toHaveProperty('storagePath');
  });
  it('空文件/伪装扩展名在 IPC 前拒绝', async () => {
    await expect(fileInput(new File([], 'empty.png'))).rejects.toMatchObject({ code: 'INVALID_FILE' });
    await expect(fileInput(new File(['pretend'], 'fake.png', { type: 'image/png' }))).rejects.toMatchObject({ code: 'UNSUPPORTED_IMAGE' });
    expect(desktop.api.invoke).not.toHaveBeenCalled();
  });
  it('规划直接读取持久任务与 reused，不解释传输状态码', async () => {
    desktop.on('createPlanningJob', input => { expect(input).toMatchObject({ projectId: PROJECT_ID, planningMode: 'AI', targetImageCount: 12 }); return { ...PLAN_JOB_FIXTURE, reused: true }; });
    const { result } = renderHook(() => useCreatePlanningJob(PROJECT_ID), { wrapper });
    const job = await act(() => result.current.mutateAsync({ planningMode: 'AI', targetImageCount: 12 }));
    expect(job.reused).toBe(true); expect(client.getQueryData(['jobs', job.id])).toMatchObject({ id: job.id });
  });
  it('候选批次和明确重新生成参数完整传递', async () => {
    desktop.on('createGenerationJobs', input => { expect(input).toMatchObject({ storyboardItemIds: [ITEM_ID], revision: 'retry', generationConfig: { candidateCount: 4, imageResolution: '2K' } }); return { jobs: [GENERATE_JOB_FIXTURE], reused: false }; });
    const { result } = renderHook(() => useCreateGenerationJobs(PROJECT_ID), { wrapper });
    const jobs = await act(() => result.current.mutateAsync({ storyboardItemIds: [ITEM_ID], revision: 'retry', generationConfig: { candidateCount: 4, imageResolution: '2K' } }));
    expect(jobs[0]?.id).toBe(GENERATE_JOB_FIXTURE.id);
  });
  it('长图导出保留用户顺序与切片配置', async () => {
    desktop.on('createExportJob', input => { expect(input).toMatchObject({ outputIds: ['second', 'first'], longImage: { targetWidth: 790, sliceHeight: 960 } }); return { job: EXPORT_JOB_FIXTURE, export: EXPORT_FIXTURE, reused: false }; });
    const { result } = renderHook(() => useCreateExportJob(PROJECT_ID), { wrapper });
    // IDs 使用契约中的 UUID，数组顺序由断言在具名调用处验证。
    const ids = ['eeeeeeee-1111-4222-8333-555555555555', 'eeeeeeee-1111-4222-8333-444444444444'];
    desktop.on('createExportJob', input => { expect(input.outputIds).toEqual(ids); expect(input.longImage).toEqual({ targetWidth: 790, sliceHeight: 960 }); return { job: EXPORT_JOB_FIXTURE, export: EXPORT_FIXTURE, reused: false }; });
    const bundle = await act(() => result.current.mutateAsync({ outputIds: ids, longImage: { targetWidth: 790, sliceHeight: 960 } }));
    expect(bundle.export?.id).toBe(EXPORT_FIXTURE.id);
  });
  it('公开领域错误保持 code/message，UNKNOWN 不被吞掉', async () => {
    desktop.on('retryJob', () => { throw Object.assign(new Error('外部结果待核实'), { code: 'EXTERNAL_RESULT_UNKNOWN' }); });
    await expect(invoke('retryJob', { jobId: PLAN_JOB_FIXTURE.id })).rejects.toMatchObject({ code: 'EXTERNAL_RESULT_UNKNOWN', message: '外部结果待核实' });
  });
  it('事件只失效当前项目，断线/恢复状态可见，卸载解除订阅', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result, unmount } = renderHook(() => useProjectEvents(PROJECT_ID), { wrapper });
    await waitFor(() => expect(result.current).toBe('open'));
    act(() => desktop.emit({ topic: 'outputs', projectId: 'other' })); expect(invalidate).not.toHaveBeenCalled();
    act(() => desktop.emit({ topic: 'outputs', projectId: PROJECT_ID })); expect(invalidate).toHaveBeenCalledWith({ queryKey: ['projects', PROJECT_ID] });
    act(() => desktop.status('disconnected')); expect(result.current).toBe('retrying');
    act(() => desktop.status('ready')); expect(result.current).toBe('open');
    unmount(); expect(desktop.listenerCount).toBe(0);
  });
  it('canvas 读取拒绝 HTTP/file/blob/data 地址，原生保存只接收 ResourceRef', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    try {
      for (const url of ['https://provider.invalid/image','file:///C:/secret','data:image/png;base64,AAAA','blob:untrusted']) await expect(readResource(url)).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
      await saveResource('ecomgen-resource://LAYER_FILE/export-1/2'); expect(desktop.api.saveArtifact).toHaveBeenCalledWith({ kind: 'LAYER_FILE', id: 'export-1', index: 2 });
    } finally { vi.unstubAllGlobals(); }
  });
});
