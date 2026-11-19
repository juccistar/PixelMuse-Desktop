import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MODEL_SPEC_DEFAULTS, type Input, type Operation, type Output } from '@ecomgen/contracts';
import { MODEL_CAST_PRESETS } from '@ecomgen/ecom-skill';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { qk } from '../../api/queryKeys';
import { FakeDesktop } from '../../test/fake-desktop';
import { renderWithProviders } from '../../test/render';
import { MODEL_IDENTITY_FILTERS } from '../../lib/modelIdentityFilters';
import { ModelsPage } from './ModelsPage';

// SQLite and the default commands/executors run under Node, while the real
// QueryClient, hooks, designer and page run in jsdom. Only IPC delivery is gated.
const hostSource = `
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const sharp = createRequire(process.argv[1])('sharp');
const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#887766' } }).png().toBuffer();
const calls = [];
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  calls.push({ url: req.url, body: Buffer.concat(chunks).toString() });
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'POST' && ['/v1/images/generations', '/v1/images/edits'].includes(req.url)) {
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
  } else { res.statusCode = 500; res.end(JSON.stringify({ error: 'Unexpected loopback request' })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = 'http://127.0.0.1:' + server.address().port + '/v1';
const { createBackend } = await import(pathToFileURL(process.argv[1]).href);
const backend = await createBackend({ dataDir: process.argv[2], masterKey: randomBytes(32).toString('base64'), version: 'model-create-refresh-sol' }, undefined, {
  fetch: (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(baseUrl + '/')) throw new Error('Only the isolated loopback provider is allowed');
    return fetch(input, init);
  },
});
process.on('message', async ({ id, operation, input }) => {
  try {
    if (operation === '__close') {
      await backend.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      process.send({ id, value: true }, () => process.disconnect());
      return;
    }
    const value = operation === '__evidence' ? { calls, png: png.toString('base64') } : await backend.invoke(operation, input);
    process.send({ id, value });
  } catch (error) { process.send({ id, error: { message: error.message, code: error.code } }); }
});
process.send({ ready: true, baseUrl });
`;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
let root: string;
let host: ChildProcess;
let desktop: FakeDesktop;
let client: QueryClient;
let sequence: number;
let requests: Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>;
let releases: Array<() => void>;
let providerId: string;
let listCalls: number;
let pendingListGate: ReturnType<typeof deferred> | undefined;
let capturedLists: Array<Output<'listModels'>>;
let created: Output<'createModel'> | undefined;
let castInputs: Input<'createModelCastJob'>[];
let faceInputs: Input<'uploadModelReferenceFace'>[];
function rpc(operation: string, input: unknown = {}): Promise<unknown> {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    requests.set(id, { resolve, reject });
    host.send({ id, operation, input });
  });
}
function invoke<K extends Operation>(operation: K, input: Input<K>): Promise<Output<K>> {
  return rpc(operation, input) as Promise<Output<K>>;
}
function Harness() {
  client = useQueryClient();
  // Match the production query freshness; rerenders must not repair the race.
  client.setDefaultOptions({ queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false }, mutations: { retry: false } });
  return <ModelsPage/>;
}
function gateNextList() {
  const gate = deferred();
  releases.push(gate.resolve);
  pendingListGate = gate;
  return gate;
}
async function seed(name: string) {
  return invoke('createModel', { name, spec: MODEL_SPEC_DEFAULTS });
}
// These waits include real child-process IPC/SQLite work under four-worker load.
// Check query state cheaply before traversing the rendered AntD page.
const backendWait = { timeout: 5_000 };
async function waitForInitialModels(count: number) {
  await waitFor(() => {
    expect(client.getQueryState(qk.models)?.status).toBe('success');
    expect(client.getQueryData<Output<'listModels'>>(qk.models)?.items).toHaveLength(count);
  }, backendWait);
  await screen.findByRole('list', { name: '模特列表' }, backendWait);
}
async function saveDesigner(name: string) {
  fireEvent.click(screen.getByRole('button', { name: '新建模特' }));
  await screen.findByPlaceholderText('例如：小满');
  const dialog = designer();
  fireEvent.change(within(dialog).getByPlaceholderText('例如：小满'), { target: { value: name } });
  fireEvent.mouseDown(within(dialog).getByRole('combobox'));
  fireEvent.click(await screen.findByText(MODEL_CAST_PRESETS[0]!.name, { exact: true }));
  fireEvent.click(within(dialog).getByText('创建模特').closest('button')!);
  await waitFor(() => expect(created?.name).toBe(name), backendWait);
}
function designer() {
  // AntD's NODE_ENV=test IDs are all "test-id": once the page has Selects,
  // aria-labelledby collides. Locate the real drawer via its unique name input.
  return screen.getByPlaceholderText('例如：小满').closest('[role="dialog"]') as HTMLElement;
}
function modelButton(name: string) {
  return within(screen.getByRole('list', { name: '模特列表' })).getByRole('button', { name: new RegExp(name) });
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ecomgen-model-create-refresh-sol-'));
  sequence = 0;
  requests = new Map();
  releases = [];
  listCalls = 0;
  pendingListGate = undefined;
  capturedLists = [];
  created = undefined;
  castInputs = [];
  faceInputs = [];
  host = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', hostSource, resolve('packages/backend/src/index.ts'), root], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let errors = '';
  host.stderr!.on('data', value => { errors += String(value); });
  const baseUrl = await new Promise<string>((resolveReady, reject) => {
    host.on('message', (message: { ready?: boolean; baseUrl: string; id: number; value?: unknown; error?: unknown }) => {
      if (message.ready) { resolveReady(message.baseUrl); return; }
      const pending = requests.get(message.id);
      requests.delete(message.id);
      if (message.error) pending?.reject(message.error);
      else pending?.resolve(message.value);
    });
    host.once('error', reject);
    host.once('exit', code => {
      const error = new Error(`Backend host exited ${code}: ${errors}`);
      reject(error);
      for (const pending of requests.values()) pending.reject(error);
    });
  });
  providerId = (await invoke('createProvider', {
    name: 'Synthetic loopback only', baseUrl, apiKey: 'synthetic-model-refresh-key', reasoningProtocol: 'openai',
    models: [{ id: 'gpt-image-1', supportsVision: false, supportsThinking: false, supportsTools: false, supportsStructuredOutput: false, imageApiKind: 'openai_images' }],
  })).id;
  desktop = new FakeDesktop().install();
  desktop.on('listProviders', input => invoke('listProviders', input));
  desktop.on('listModels', async input => {
    listCalls++;
    const gate = pendingListGate;
    pendingListGate = undefined;
    const snapshot = await invoke('listModels', input);
    capturedLists.push(snapshot);
    if (gate) await gate.promise;
    return snapshot;
  });
  desktop.on('createModel', async input => { created = await invoke('createModel', input); return created; });
  desktop.on('listModelPortraits', input => invoke('listModelPortraits', input));
  desktop.on('uploadModelReferenceFace', input => { faceInputs.push(input); return invoke('uploadModelReferenceFace', input); });
  desktop.on('createModelCastJob', input => { castInputs.push(input); return invoke('createModelCastJob', input); });
  desktop.on('getJob', input => invoke('getJob', input));
  desktop.on('selectModelPortrait', input => invoke('selectModelPortrait', input));
});
afterEach(async () => {
  cleanup();
  for (const release of releases) release();
  client?.clear();
  if (host?.connected) await rpc('__close');
  if (host && host.exitCode === null) await new Promise<void>(resolveExit => host.once('exit', () => resolveExit()));
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('model creation refresh · real QueryClient/page and default SQLite Backend', () => {
  it.each([0, 1])('refreshes after create while the initial pre-create list response is pending (%s existing models)', async count => {
    if (count) await seed('Existing model');
    const oldResponse = gateNextList();
    renderWithProviders(<Harness/>);
    await waitFor(() => expect(capturedLists).toHaveLength(1));
    expect(capturedLists[0]!.items).toHaveLength(count);
    expect(client.getQueryData(qk.models)).toBeUndefined();
    await saveDesigner('UI designed model');
    // Backend persistence is independent of the renderer cache, as in the EXE failure.
    expect((await invoke('listModels', {})).items.some(model => model.id === created!.id)).toBe(true);
    await act(async () => { oldResponse.resolve(); });
    await waitFor(() => expect(modelButton('UI designed model')).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByPlaceholderText('例如：小满')).not.toBeInTheDocument());
    expect(listCalls).toBe(2);
    expect(client.getQueryData(qk.models)).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ id: created!.id })]) });
    expect(client.getQueryState(qk.models)?.fetchStatus).toBe('idle');
    expect(client.getQueryState(qk.models)?.isInvalidated).toBe(false);
  });

  it('discards a cached background list response and keeps creation pending until its fresh query completes', async () => {
    await seed('Existing model');
    renderWithProviders(<Harness/>);
    await screen.findByRole('heading', { name: 'Existing model' });
    const oldResponse = gateNextList();
    let refetch!: Promise<void>;
    act(() => { refetch = client.invalidateQueries({ queryKey: qk.models }); });
    await waitFor(() => expect(capturedLists).toHaveLength(2));
    // Gate the post-create query separately so lifecycle completion is observable.
    const freshResponse = gateNextList();
    await saveDesigner('UI designed model');
    await waitFor(() => expect(capturedLists).toHaveLength(3));
    expect(designer()).toBeInTheDocument();
    expect(within(designer()).getByText('创建模特').closest('button')).toHaveClass('ant-btn-loading');
    await act(async () => { oldResponse.resolve(); await refetch; });
    expect(modelButton('Existing model')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: '模特列表' })).queryByText('UI designed model')).not.toBeInTheDocument();
    await act(async () => { freshResponse.resolve(); });
    await waitFor(() => expect(modelButton('UI designed model')).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByPlaceholderText('例如：小满')).not.toBeInTheDocument());
    expect(client.getQueryData(qk.models)).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ id: created!.id })]) });
  });

  it('preserves existing selection, text/identity filters and portrait child queries after ordinary creation', async () => {
    await seed('Existing first');
    const selected = await seed('Existing selected');
    renderWithProviders(<Harness/>);
    await waitForInitialModels(2);
    fireEvent.click(modelButton('Existing selected'));
    await screen.findByRole('heading', { name: 'Existing selected' });
    const portraitsBefore = vi.mocked(desktop.api.invoke).mock.calls.filter(([operation]) => operation === 'listModelPortraits').length;
    fireEvent.change(screen.getByLabelText('搜索模特'), { target: { value: 'Existing' } });
    fireEvent.click(screen.getByRole('button', { name: '身份筛选' }));
    const genderFilter = MODEL_IDENTITY_FILTERS.find(filter => filter.key === 'gender')!;
    const genderLabel = genderFilter.options.find(option => option.value === selected.spec.gender)!.label;
    fireEvent.mouseDown(screen.getByLabelText(genderFilter.label));
    fireEvent.click(await screen.findByTitle(genderLabel));
    await saveDesigner('UI designed model');
    await waitFor(() => expect(screen.queryByPlaceholderText('例如：小满')).not.toBeInTheDocument());
    expect(screen.getByLabelText('搜索模特')).toHaveValue('Existing');
    expect(screen.getByText('2 / 3 位')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Existing selected' })).toBeInTheDocument();
    expect(modelButton('Existing selected')).toHaveAttribute('aria-current', 'true');
    expect(modelButton('Existing first')).not.toHaveAttribute('aria-current');
    // Preserve prefix invalidation of mounted portrait children rather than narrowing it to the list.
    await waitFor(() => expect(vi.mocked(desktop.api.invoke).mock.calls.filter(([operation]) => operation === 'listModelPortraits').length).toBeGreaterThan(portraitsBefore));
    expect(client.getQueryData(qk.modelPortraits(selected.id))).toEqual({ items: [] });
    fireEvent.change(screen.getByLabelText('搜索模特'), { target: { value: '' } });
    // The new preset may differ from the identity filter. Clearing it must restore the full list.
    const filterClear = screen.getByLabelText(genderFilter.label).closest('.ant-select')!.querySelector('.ant-select-clear');
    expect(filterClear).not.toBeNull();
    fireEvent.mouseDown(filterClear!);
    fireEvent.click(filterClear!);
    await waitFor(() => expect(screen.getByText('共 3 位')).toBeInTheDocument());
    expect(modelButton('Existing selected')).toHaveAttribute('aria-current', 'true');
    expect(modelButton('UI designed model')).toBeInTheDocument();
  });

  // The full designer → upload → worker → selection path exceeded 20s in the
  // four-worker suite; allow 30s for its real SQLite/image work, scoped to this case.
  it('uploads a reference face, casts and selects a portrait for a newly created model without changing existing models', async () => {
    const first = await seed('Existing first');
    const selected = await seed('Existing selected');
    renderWithProviders(<Harness/>);
    await waitForInitialModels(2);
    await saveDesigner('UI designed model');
    await waitFor(() => expect(screen.queryByPlaceholderText('例如：小满')).not.toBeInTheDocument());
    fireEvent.click(modelButton('UI designed model'));
    await screen.findByRole('heading', { name: 'UI designed model' });
    const evidence = await rpc('__evidence') as { png: string; calls: unknown[] };
    const faceFile = new File([Buffer.from(evidence.png, 'base64')], 'synthetic-face.png', { type: 'image/png' });
    const detail = screen.getByRole('region', { name: '模特 UI designed model' });
    fireEvent.change(detail.querySelector('input[type=file]')!, { target: { files: [faceFile] } });
    await waitFor(() => expect(faceInputs).toHaveLength(1), backendWait);
    await waitFor(async () => expect((await invoke('getModel', { modelId: created!.id })).hasReferenceFace).toBe(true), backendWait);
    await waitFor(() => expect(client.getQueryData<Output<'listModels'>>(qk.models)?.items.find(model => model.id === created!.id)?.hasReferenceFace).toBe(true), backendWait);
    await within(detail).findByRole('button', { name: '更换参考脸' }, backendWait);
    expect(faceInputs.map(input => input.modelId)).toEqual([created!.id]);
    expect((await invoke('getModel', { modelId: first.id })).hasReferenceFace).toBe(false);
    fireEvent.mouseDown(within(detail).getByRole('combobox', { name: '定妆照生图模型' }));
    const imageOptions = await screen.findAllByTitle(/Synthetic loopback only \/ gpt-image-1/);
    fireEvent.click(imageOptions.find(element => element.classList.contains('ant-select-item-option'))!);
    fireEvent.click(screen.getByRole('button', { name: '生成定妆照' }));
    await waitFor(() => expect(castInputs).toHaveLength(1), backendWait);
    expect(castInputs[0]).toMatchObject({ modelId: created!.id, providerId, imageModelId: 'gpt-image-1' });
    // A persisted candidate can precede job completion. Observe SUCCEEDED through
    // the real QueryClient so the page's terminal effect refreshes the portraits.
    await waitFor(async () => {
      await act(async () => { await client.refetchQueries({ queryKey: ['jobs'], type: 'active' }); });
      expect(client.getQueriesData<Output<'getJob'>>({ queryKey: ['jobs'] }).some(([, job]) => job?.status === 'SUCCEEDED')).toBe(true);
    }, { timeout: 10_000, interval: 100 });
    expect((await invoke('listModelPortraits', { modelId: created!.id })).items).toHaveLength(1);
    fireEvent.click(await within(detail).findByRole('button', { name: '设为选定' }, backendWait));
    await waitFor(async () => expect((await invoke('getModel', { modelId: created!.id })).selectedPortrait?.modelId).toBe(created!.id), backendWait);
    await within(detail).findByText('当前选定', {}, backendWait);
    const model = await invoke('getModel', { modelId: created!.id });
    expect(model.hasReferenceFace).toBe(true);
    expect(model.selectedPortrait?.modelId).toBe(created!.id);
    expect((await invoke('listModelPortraits', { modelId: selected.id })).items).toEqual([]);
    const finalEvidence = await rpc('__evidence') as { calls: Array<{ url: string; body: string }> };
    expect(finalEvidence.calls).toHaveLength(1);
    expect(finalEvidence.calls[0]!.url).toBe('/v1/images/edits');
    expect(finalEvidence.calls[0]!.body).toContain('filename=');
  }, 30_000);
});
