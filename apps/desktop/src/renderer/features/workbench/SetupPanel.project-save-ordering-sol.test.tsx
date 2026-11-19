import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Input, Operation, Output } from '@ecomgen/contracts';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useProject } from '../../api/hooks/useProjects';
import { qk } from '../../api/queryKeys';
import { FakeDesktop } from '../../test/fake-desktop';
import { ASSET_FIXTURE, COPYWRITING_JOB_FIXTURE } from '../../test/fixtures';
import { renderWithProviders } from '../../test/render';
import { SetupPanel } from './SetupPanel';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
// A Node child keeps SQLite and default Backend imports in their actual runtime,
// while the real renderer hooks run in jsdom. No command/executor overrides.
const hostSource = `
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const { createBackend } = await import(pathToFileURL(process.argv[1]).href);
const backend = await createBackend({ dataDir: process.argv[2], masterKey: randomBytes(32).toString('base64'), version: 'save-ordering-regression' });
process.on('message', async ({ id, operation, input }) => {
  try {
    if (operation === '__close') { await backend.close(); process.send({ id, value: true }, () => process.disconnect()); return; }
    process.send({ id, value: await backend.invoke(operation, input) });
  } catch (error) { process.send({ id, error: { message: error.message, code: error.code } }); }
});
process.send({ ready: true });
`;
let root: string;
let host: ChildProcess;
let desktop: FakeDesktop;
let client: QueryClient;
let projectA: string;
let projectB: string;
let writes: Input<'updateProject'>[];
let releases: Array<() => void>;
let sequence: number;
let requests: Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>;
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
function Harness({ projectId }: { projectId: string }) {
  client = useQueryClient();
  const project = useProject(projectId);
  return project.data ? <SetupPanel detail={project.data}/> : null;
}
function edit(label: string, value: string, blur = true) {
  const field = screen.getByRole('textbox', { name: label });
  fireEvent.change(field, { target: { value } });
  if (blur) fireEvent.blur(field);
}
async function setup() {
  const view = renderWithProviders(<Harness projectId={projectA}/>);
  await screen.findByDisplayValue('Original A description');
  return view;
}
async function visit(view: ReturnType<typeof renderWithProviders>, projectId: string) {
  view.rerender(<Harness projectId={projectId}/>);
  await waitFor(() => expect(client.getQueryData(qk.project(projectId))).toMatchObject({ id: projectId }));
  await screen.findByRole('textbox', { name: '项目名称' });
}
async function description(projectId = projectA) {
  return (await invoke('getProject', { projectId })).productDescription;
}
function gateNameResponse() {
  const gate = deferred();
  releases.push(gate.resolve);
  let committed = false;
  desktop.on('updateProject', async input => {
    writes.push(input);
    const value = await invoke('updateProject', input);
    if (input.name === 'Name committed before response') {
      committed = true;
      await gate.promise;
    }
    return value;
  });
  return { release: gate.resolve, committed: () => committed };
}
async function drainWrites() {
  // A marker on a separate field proves the shared sequence has drained, even
  // when a superseded description was correctly skipped rather than invoked.
  fireEvent.click(screen.getByRole('button', { name: '商品事实与限制' }));
  expect(screen.getByRole('textbox', { name: '已核验事实' })).toBeVisible();
  edit('已核验事实', 'Sequence drained');
  await waitFor(async () => expect((await invoke('getProject', { projectId: projectA })).verifiedFacts).toEqual(['Sequence drained']));
  await act(async () => { await client.invalidateQueries({ queryKey: qk.project(projectA) }); });
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ecomgen-project-save-ordering-sol-'));
  sequence = 0;
  requests = new Map();
  releases = [];
  writes = [];
  host = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', hostSource, resolve('packages/backend/src/index.ts'), root], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let errors = '';
  host.stderr!.on('data', value => { errors += String(value); });
  await new Promise<void>((resolveReady, reject) => {
    host.on('message', (message: { ready?: boolean; id: number; value?: unknown; error?: unknown }) => {
      if (message.ready) { resolveReady(); return; }
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
  const provider = await invoke('createProvider', {
    name: 'Synthetic configuration only', baseUrl: 'https://provider.invalid/v1', reasoningProtocol: 'openai', apiKey: 'synthetic-test-key',
    models: [{ id: 'synthetic-reasoner', supportsVision: true, supportsTools: false, supportsThinking: false, supportsStructuredOutput: false },
      { id: 'synthetic-image', supportsVision: false, supportsTools: false, supportsThinking: false, supportsStructuredOutput: false, imageApiKind: 'openai_images' }],
  });
  const models = { reasoningProviderId: provider.id, reasoningModelId: 'synthetic-reasoner', imageProviderId: provider.id, imageModelId: 'synthetic-image', defaultMode: 'CREATIVE' as const };
  projectA = (await invoke('createProject', { ...models, name: 'Project A', productDescription: 'Original A description', candidatesPerType: 1 })).id;
  projectB = (await invoke('createProject', { ...models, name: 'Project B', productDescription: 'Original B description' })).id;
  desktop = new FakeDesktop().install();
  desktop.on('getProject', input => invoke('getProject', input));
  desktop.on('updateProject', input => { writes.push(input); return invoke('updateProject', input); });
});
afterEach(async () => {
  cleanup();
  for (const release of releases) release();
  // Let detached legitimate blur saves finish before closing their Backend.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  client?.clear();
  if (host?.connected) await rpc('__close');
  if (host && host.exitCode === null) await new Promise<void>(resolveExit => host.once('exit', () => resolveExit()));
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('SetupPanel project save ordering · default Backend and temporary SQLite', () => {
  it('keeps the latest A description after A → B → A when only an old committed name response is delayed', async () => {
    const view = await setup();
    const gate = gateNameResponse();
    edit('项目名称', 'Name committed before response');
    await waitFor(() => expect(gate.committed()).toBe(true));
    expect((await invoke('getProject', { projectId: projectA })).name).toBe('Name committed before response');
    edit('商品描述', 'Older visit user text');
    expect(writes).toHaveLength(1);
    await visit(view, projectB);
    await screen.findByDisplayValue('Original B description');
    await visit(view, projectA);
    edit('商品描述', 'Latest visit user text');
    await act(async () => { gate.release(); });
    await drainWrites();
    expect(await description()).toBe('Latest visit user text');
    expect(screen.getByRole('textbox', { name: '商品描述' })).toHaveValue('Latest visit user text');
    expect(await description(projectB)).toBe('Original B description');
    expect(writes.filter(write => write.productDescription !== undefined)).toEqual([{ projectId: projectA, productDescription: 'Latest visit user text' }]);
  });

  it('persists a legitimate queued blur after leaving, including when a later visit edits an independent field', async () => {
    const view = await setup();
    const gate = gateNameResponse();
    edit('项目名称', 'Name committed before response');
    await waitFor(() => expect(gate.committed()).toBe(true));
    edit('商品描述', 'Valid edit from earlier visit');
    await visit(view, projectB);
    await screen.findByDisplayValue('Original B description');
    await visit(view, projectA);
    fireEvent.click(screen.getByRole('button', { name: '商品事实与限制' }));
    expect(screen.getByRole('textbox', { name: '禁止宣称' })).toBeVisible();
    edit('禁止宣称', 'Independent latest claim');
    await visit(view, projectB);
    await screen.findByDisplayValue('Original B description');
    await act(async () => { gate.release(); });
    await waitFor(async () => expect(await description()).toBe('Valid edit from earlier visit'));
    await waitFor(async () => expect((await invoke('getProject', { projectId: projectA })).prohibitedClaims).toEqual(['Independent latest claim']));
    expect(screen.getByRole('textbox', { name: '商品描述' })).toHaveValue('Original B description');
    expect(await description(projectB)).toBe('Original B description');
  });

  it.each([false, true])('orders a delayed commit across remounts (additional unblurred draft: %s)', async hasDraft => {
    const view = await setup();
    const gate = deferred();
    releases.push(gate.resolve);
    desktop.on('updateProject', async input => {
      writes.push(input);
      if (input.productDescription === 'Delayed old commit') await gate.promise;
      return invoke('updateProject', input);
    });
    edit('商品描述', 'Delayed old commit');
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(await description()).toBe('Original A description');
    await visit(view, projectB);
    await screen.findByDisplayValue('Original B description');
    await visit(view, projectA);
    edit('商品描述', 'Latest persisted intent');
    if (hasDraft) edit('商品描述', 'Latest unblurred draft', false);
    await act(async () => { gate.resolve(); });
    await drainWrites();
    if (hasDraft) {
      expect(screen.getByRole('textbox', { name: '商品描述' })).toHaveValue('Latest unblurred draft');
      fireEvent.blur(screen.getByRole('textbox', { name: '商品描述' }));
      await waitFor(async () => expect(await description()).toBe('Latest unblurred draft'));
    } else {
      expect(await description()).toBe('Latest persisted intent');
      expect(screen.getByRole('textbox', { name: '商品描述' })).toHaveValue('Latest persisted intent');
    }
    expect(await description(projectB)).toBe('Original B description');
  });

  it('keeps a legitimate user blur when a later queued automatic adoption is abandoned on unmount', async () => {
    // Only copy generation and its prerequisite asset metadata are synthetic;
    // every project read/write still reaches the default SQLite Backend.
    desktop.on('getProject', async input => ({ ...await invoke('getProject', input), assets: [{ ...ASSET_FIXTURE, projectId: input.projectId }] }));
    desktop.on('listProviders', input => invoke('listProviders', input));
    const job = { ...COPYWRITING_JOB_FIXTURE, projectId: projectA, status: 'SUCCEEDED' as const, reused: false };
    desktop.on('createCopywritingJob', () => job);
    desktop.on('getJob', () => job);
    desktop.on('getCopywritingResult', () => ({ jobId: job.id, projectId: projectA, target: 'PRODUCT_DESCRIPTION', content: 'Generated but abandoned', createdAt: job.createdAt }));
    const view = await setup();
    const gate = gateNameResponse();
    edit('项目名称', 'Name committed before response');
    await waitFor(() => expect(gate.committed()).toBe(true));
    edit('商品描述', 'Legitimate queued user blur');
    const button = screen.getByRole('button', { name: 'AI 帮写商品描述' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await screen.findByDisplayValue('Generated but abandoned');
    const resultKey = [...qk.job(job.id), 'copywriting-result'];
    expect(client.getQueryData(resultKey)).toMatchObject({ content: 'Generated but abandoned' });
    view.unmount();
    await act(async () => { gate.release(); });
    await waitFor(async () => expect(await description()).toBe('Legitimate queued user blur'));
    expect(writes.filter(write => write.productDescription !== undefined)).toEqual([{ projectId: projectA, productDescription: 'Legitimate queued user blur' }]);
    expect(client.getQueryData(resultKey)).toMatchObject({ content: 'Generated but abandoned' });
  });

  it('does not roll back a newer optimistic selection when an older save fails', async () => {
    await setup();
    const gate = deferred();
    releases.push(gate.resolve);
    desktop.on('updateProject', async input => {
      writes.push(input);
      if (input.candidatesPerType === 2) { await gate.promise; throw new Error('Older save failed'); }
      return invoke('updateProject', input);
    });
    fireEvent.click(screen.getByRole('button', { name: '高级设置' }));
    expect(screen.getByRole('button', { name: '增加出图数' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '增加出图数' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: '增加出图数' }));
    await act(async () => { gate.resolve(); });
    await waitFor(async () => expect((await invoke('getProject', { projectId: projectA })).candidatesPerType).toBe(3));
    expect(screen.getByRole('button', { name: '增加出图数' }).previousElementSibling).toHaveTextContent('3');
    expect(screen.queryByText('Older save failed')).not.toBeInTheDocument();
  });
});
