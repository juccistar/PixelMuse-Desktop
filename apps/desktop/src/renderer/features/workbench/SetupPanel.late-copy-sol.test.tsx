import type { Input, Output } from '@ecomgen/contracts';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useProject } from '../../api/hooks/useProjects';
import { qk } from '../../api/queryKeys';
import { saveProjectPlanningDraft } from '../../lib/projectPreparation';
import { FakeDesktop } from '../../test/fake-desktop';
import { COPYWRITING_JOB_FIXTURE, PROJECT_FIXTURE, PROJECT_ID, projectDetailPayload } from '../../test/fixtures';
import { renderWithProviders } from '../../test/render';
import { SetupPanel } from './SetupPanel';

type Target = Exclude<Input<'createCopywritingJob'>['target'], 'LISTING'>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const SECOND_PROJECT = 'aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff';
let desktop: FakeDesktop;
let client: QueryClient;
let persisted: Map<string, string | null>;
let writes: Input<'updateProject'>[];
let saveGate: ReturnType<typeof deferred<void>> | undefined;
let copyResults: Map<string, ReturnType<typeof deferred<Output<'getCopywritingResult'>>>>;
let copyCount: number;

function Harness({ projectId = PROJECT_ID }: { projectId?: string }) {
  client = useQueryClient();
  const project = useProject(projectId);
  return project.data ? <SetupPanel detail={project.data}/> : null;
}
function copyJob(id: string, projectId = PROJECT_ID): Output<'createCopywritingJob'> {
  return { ...COPYWRITING_JOB_FIXTURE, id, projectId, status: 'SUCCEEDED', reused: false };
}
function result(id: string, target: Target = 'PRODUCT_DESCRIPTION', content = 'Delayed generated copy', projectId = PROJECT_ID): Output<'getCopywritingResult'> {
  return { jobId: id, projectId, target, content, createdAt: PROJECT_FIXTURE.createdAt };
}
function copyButton(target: Target = 'PRODUCT_DESCRIPTION') {
  return screen.getByRole('button', { name: target === 'PRODUCT_DESCRIPTION' ? 'AI 帮写商品描述' : 'AI 帮写补充说明' });
}
async function start(target: Target = 'PRODUCT_DESCRIPTION') {
  await waitFor(() => expect(copyButton(target)).toBeEnabled());
  const previousCount = copyCount;
  fireEvent.click(copyButton(target));
  await waitFor(() => expect(copyCount).toBe(previousCount + 1));
  const id = `abababab-bcbc-4dcd-8eee-${String(copyCount).padStart(12, '0')}`;
  await waitFor(() => expect(desktop.api.invoke).toHaveBeenCalledWith('getCopywritingResult', { jobId: id }));
  return id;
}
async function finish(id: string, target: Target = 'PRODUCT_DESCRIPTION', content?: string) {
  const value = result(id, target, content);
  await act(async () => { copyResults.get(id)!.resolve(value); });
  await waitFor(() => expect(client.getQueryData([...qk.job(id), 'copywriting-result'])).toEqual(value));
  // Query notifications and SetupPanel's adoption effect must both settle before assertions.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
async function setup() {
  const view = renderWithProviders(<Harness/>);
  await screen.findByRole('textbox', { name: '商品描述' });
  return view;
}
function editDescription(value: string, blur = true) {
  const field = screen.getByRole('textbox', { name: '商品描述' });
  fireEvent.change(field, { target: { value } });
  if (blur) fireEvent.blur(field);
}
beforeEach(() => {
  desktop = new FakeDesktop().install();
  for (const projectId of [PROJECT_ID, SECOND_PROJECT]) {
    saveProjectPlanningDraft(projectId, { selectionMode: 'AI', requestedTypes: [], requestedSuiteShots: [], instruction: '' });
  }
  persisted = new Map([[PROJECT_ID, PROJECT_FIXTURE.productDescription], [SECOND_PROJECT, 'Second project description']]);
  writes = [];
  saveGate = undefined;
  copyResults = new Map();
  copyCount = 0;
  desktop.on('getProject', ({ projectId }) => ({ ...projectDetailPayload(), id: projectId, productDescription: persisted.get(projectId) }));
  desktop.on('updateProject', async input => {
    writes.push(input);
    const gate = saveGate;
    if (gate) await gate.promise;
    if (input.productDescription !== undefined) persisted.set(input.projectId, input.productDescription);
    return { ...PROJECT_FIXTURE, id: input.projectId, productDescription: persisted.get(input.projectId) };
  });
  desktop.on('createCopywritingJob', input => {
    const id = `abababab-bcbc-4dcd-8eee-${String(++copyCount).padStart(12, '0')}`;
    copyResults.set(id, deferred<Output<'getCopywritingResult'>>());
    return copyJob(id, input.projectId);
  });
  desktop.on('getJob', ({ jobId }) => copyJob(jobId));
  desktop.on('getCopywritingResult', ({ jobId }) => copyResults.get(jobId)!.promise);
});

describe('SetupPanel delayed copy adoption · actual component and typed fake IPC', () => {
  it('offers result reload after a read failure without permanently blocking the lower action', async () => {
    await setup();
    const id = await start();
    expect(copyButton('PLANNING_INSTRUCTION')).toBeDisabled();
    await act(async () => copyResults.get(id)!.reject(new Error('read unavailable')));
    expect(await screen.findByText(/帮写已完成，但读取结果失败/)).toBeVisible();
    await waitFor(() => expect(copyButton('PLANNING_INSTRUCTION')).toBeEnabled());
    desktop.on('getCopywritingResult', () => result(id));
    fireEvent.click(screen.getByRole('button', { name: '重新读取帮写结果' }));
    await waitFor(() => expect(persisted.get(PROJECT_ID)).toBe('Delayed generated copy'));
    expect(screen.queryByText(/帮写已完成，但读取结果失败/)).not.toBeInTheDocument();
  });

  it('blocks a reattached active description job without adopting its result over a draft', async () => {
    const id = 'abababab-bcbc-4dcd-8eee-000000000099';
    let status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'UNKNOWN' = 'QUEUED';
    desktop.on('getProject', ({ projectId }) => ({ ...projectDetailPayload(), id: projectId, productDescription: persisted.get(projectId), jobs: [{ ...copyJob(id, projectId), status, copywritingTarget: 'PRODUCT_DESCRIPTION' }] }));
    const view = await setup();
    expect(copyButton('PLANNING_INSTRUCTION')).toBeDisabled();
    view.unmount();
    status = 'RUNNING';
    await setup();
    await act(async () => { await client.invalidateQueries({ queryKey: qk.project(PROJECT_ID) }); });
    expect(copyButton('PLANNING_INSTRUCTION')).toBeDisabled();
    editDescription('My reattached draft', false);
    status = 'SUCCEEDED';
    await act(async () => { await client.invalidateQueries({ queryKey: qk.project(PROJECT_ID) }); });
    await waitFor(() => expect(copyButton('PLANNING_INSTRUCTION')).toBeEnabled());
    expect(screen.getByRole('textbox', { name: '商品描述' })).toHaveValue('My reattached draft');
    expect(desktop.api.invoke).not.toHaveBeenCalledWith('getCopywritingResult', { jobId: id });
    status = 'UNKNOWN';
    await act(async () => { await client.invalidateQueries({ queryKey: qk.project(PROJECT_ID) }); });
    expect(copyButton('PLANNING_INSTRUCTION')).toBeEnabled();
  });
  it('blocks instruction help until the description result has been saved', async () => {
    await setup();
    const id = await start();
    expect(copyButton('PLANNING_INSTRUCTION')).toBeDisabled();
    saveGate = deferred<void>();
    await finish(id);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(copyButton('PLANNING_INSTRUCTION')).toBeDisabled();
    const gate = saveGate;
    saveGate = undefined;
    await act(async () => { gate.resolve(); });
    await waitFor(() => expect(copyButton('PLANNING_INSTRUCTION')).toBeEnabled());
    expect(persisted.get(PROJECT_ID)).toBe('Delayed generated copy');
  });

  it('saves an unblurred description before submitting instruction help and stops on failure', async () => {
    await setup();
    editDescription('Unsaved description', false);
    saveGate = deferred<void>();
    fireEvent.click(copyButton('PLANNING_INSTRUCTION'));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(copyCount).toBe(0);
    const gate = saveGate;
    saveGate = undefined;
    await act(async () => { gate.reject(new Error('Save failed')); });
    await waitFor(() => expect(copyButton('PLANNING_INSTRUCTION')).toBeEnabled());
    expect(copyCount).toBe(0);
    fireEvent.click(copyButton('PLANNING_INSTRUCTION'));
    await waitFor(() => expect(copyCount).toBe(1));
    expect(persisted.get(PROJECT_ID)).toBe('Unsaved description');
  });
  it('retains the user save and generated result when an edit is persisted before completion', async () => {
    await setup();
    const id = await start();
    editDescription('User text saved before AI completion');
    await waitFor(() => expect(persisted.get(PROJECT_ID)).toBe('User text saved before AI completion'));
    await finish(id);
    expect(screen.getByRole('textbox', { name: '商品描述' })).toHaveValue('User text saved before AI completion');
    expect(writes).toEqual([{ projectId: PROJECT_ID, productDescription: 'User text saved before AI completion' }]);
    expect(persisted.get(PROJECT_ID)).toBe('User text saved before AI completion');
    expect(client.getQueryData([...qk.job(id), 'copywriting-result'])).toEqual(result(id));
  });

  it('preserves unsaved edits even when the user changes the text back to its submission value', async () => {
    await setup();
    const id = await start();
    editDescription('Temporary user edit', false);
    editDescription(PROJECT_FIXTURE.productDescription, false);
    await finish(id);
    expect(screen.getByRole('textbox', { name: '商品描述' })).toHaveValue(PROJECT_FIXTURE.productDescription);
    expect(writes).toEqual([]);
  });

  it('adopts and persists unchanged description normally, and adopts unchanged instruction independently', async () => {
    await setup();
    const id = await start();
    fireEvent.change(screen.getByRole('textbox', { name: '补充说明' }), { target: { value: 'Independent instruction edit' } });
    await finish(id);
    await waitFor(() => expect(persisted.get(PROJECT_ID)).toBe('Delayed generated copy'));
    expect(screen.getByRole('textbox', { name: '商品描述' })).toHaveValue('Delayed generated copy');
    const instructionId = await start('PLANNING_INSTRUCTION');
    await finish(instructionId, 'PLANNING_INSTRUCTION', 'Generated instruction');
    expect(screen.getByRole('textbox', { name: '补充说明' })).toHaveValue('Generated instruction');
    expect(JSON.parse(localStorage.getItem(`pixelmuse.projectPreparation.${PROJECT_ID}`)!)).toMatchObject({ instruction: 'Generated instruction' });
    expect(writes).toEqual([{ projectId: PROJECT_ID, productDescription: 'Delayed generated copy' }]);
  });

  it('captures edits made before the create-job mutation returns', async () => {
    const creation = deferred<Output<'createCopywritingJob'>>();
    const id = COPYWRITING_JOB_FIXTURE.id;
    copyResults.set(id, deferred<Output<'getCopywritingResult'>>());
    desktop.on('createCopywritingJob', () => creation.promise);
    await setup();
    await waitFor(() => expect(copyButton()).toBeEnabled());
    fireEvent.click(copyButton());
    await waitFor(() => expect(desktop.api.invoke).toHaveBeenCalledWith('createCopywritingJob', expect.objectContaining({ target: 'PRODUCT_DESCRIPTION' })));
    editDescription('Edited before create response');
    await waitFor(() => expect(persisted.get(PROJECT_ID)).toBe('Edited before create response'));
    await act(async () => { creation.resolve(copyJob(id)); });
    await waitFor(() => expect(desktop.api.invoke).toHaveBeenCalledWith('getCopywritingResult', { jobId: id }));
    await finish(id);
    expect(screen.getByRole('textbox', { name: '商品描述' })).toHaveValue('Edited before create response');
    expect(writes.map(write => write.productDescription)).toEqual(['Edited before create response']);
  });

  it('respects a changed persisted target from a project refresh', async () => {
    await setup();
    const id = await start();
    persisted.set(PROJECT_ID, 'Changed persisted description');
    await act(async () => { await client.invalidateQueries({ queryKey: qk.project(PROJECT_ID) }); });
    await screen.findByDisplayValue('Changed persisted description');
    await finish(id);
    expect(screen.getByRole('textbox', { name: '商品描述' })).toHaveValue('Changed persisted description');
    expect(persisted.get(PROJECT_ID)).toBe('Changed persisted description');
    expect(writes).toEqual([]);
  });

  it('retains user edits after an automatic save has completed', async () => {
    await setup();
    const id = await start();
    await finish(id);
    await waitFor(() => expect(persisted.get(PROJECT_ID)).toBe('Delayed generated copy'));
    editDescription('User edit after AI save');
    await waitFor(() => expect(persisted.get(PROJECT_ID)).toBe('User edit after AI save'));
    await act(async () => { await client.invalidateQueries({ queryKey: [...qk.job(id), 'copywriting-result'] }); });
    expect(screen.getByRole('textbox', { name: '商品描述' })).toHaveValue('User edit after AI save');
    expect(writes.map(write => write.productDescription)).toEqual(['Delayed generated copy', 'User edit after AI save']);
  });

  it('retains and restores shared instruction edits made while its result is pending', async () => {
    const view = await setup();
    const id = await start('PLANNING_INSTRUCTION');
    fireEvent.change(screen.getByRole('textbox', { name: '补充说明' }), { target: { value: 'User instruction' } });
    await finish(id, 'PLANNING_INSTRUCTION');
    expect(screen.getByRole('textbox', { name: '补充说明' })).toHaveValue('User instruction');
    const storageKey = `pixelmuse.projectPreparation.${PROJECT_ID}`;
    const persistedDraft = localStorage.getItem(storageKey)!;
    expect(JSON.parse(persistedDraft)).toMatchObject({ instruction: 'User instruction' });
    expect(client.getQueryData([...qk.job(id), 'copywriting-result'])).toEqual(result(id, 'PLANNING_INSTRUCTION'));
    view.unmount();
    saveProjectPlanningDraft(PROJECT_ID, { selectionMode: 'AI', requestedTypes: [], requestedSuiteShots: [], instruction: '' });
    localStorage.setItem(storageKey, persistedDraft);
    await setup();
    expect(screen.getByRole('textbox', { name: '补充说明' })).toHaveValue('User instruction');
    expect(writes).toEqual([]);
    expect(copyCount).toBe(1);
    expect(desktop.api.invoke).not.toHaveBeenCalledWith('createProductImagePlanningJob', expect.anything());
    expect(desktop.api.invoke).not.toHaveBeenCalledWith('createGenerationJobs', expect.anything());
  });

  it.each(['User edit during AI save', PROJECT_FIXTURE.productDescription])('retains draft %s through an in-flight AI save and persists it on blur', async userDraft => {
    await setup();
    saveGate = deferred<void>();
    const id = await start();
    await finish(id);
    await waitFor(() => expect(writes).toHaveLength(1));
    editDescription(userDraft, false);
    const gate = saveGate;
    saveGate = undefined;
    await act(async () => { gate.resolve(); });
    await waitFor(() => expect(client.getQueryData(qk.project(PROJECT_ID))).toMatchObject({ productDescription: 'Delayed generated copy' }));
    expect(screen.getByRole('textbox', { name: '商品描述' })).toHaveValue(userDraft);
    fireEvent.blur(screen.getByRole('textbox', { name: '商品描述' }));
    await waitFor(() => expect(persisted.get(PROJECT_ID)).toBe(userDraft));
    expect(writes.map(write => write.productDescription)).toEqual(['Delayed generated copy', userDraft]);
  });

  it('does not enqueue a late result behind a pending user save', async () => {
    await setup();
    const id = await start();
    saveGate = deferred<void>();
    editDescription('Pending user save');
    await waitFor(() => expect(writes).toHaveLength(1));
    await finish(id);
    const gate = saveGate;
    saveGate = undefined;
    await act(async () => { gate.resolve(); });
    await waitFor(() => expect(persisted.get(PROJECT_ID)).toBe('Pending user save'));
    expect(screen.getByRole('textbox', { name: '商品描述' })).toHaveValue('Pending user save');
    expect(writes.map(write => write.productDescription)).toEqual(['Pending user save']);
  });

  it('skips a queued automatic write when the user edits before the save queue reaches it', async () => {
    await setup();
    saveGate = deferred<void>();
    fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: 'Queued name save' } });
    fireEvent.blur(screen.getByRole('textbox', { name: '项目名称' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    const id = await start();
    await finish(id);
    expect(screen.getByRole('textbox', { name: '商品描述' })).toHaveValue('Delayed generated copy');
    editDescription('User edit before queued AI save');
    const gate = saveGate;
    saveGate = undefined;
    await act(async () => { gate.resolve(); });
    await waitFor(() => expect(persisted.get(PROJECT_ID)).toBe('User edit before queued AI save'));
    expect(writes.map(write => write.productDescription).filter(value => value !== undefined)).toEqual(['User edit before queued AI save']);
  });

  it('ignores an older result after a newer request has taken ownership', async () => {
    await setup();
    const older = await start();
    const newer = await start();
    await finish(newer, 'PRODUCT_DESCRIPTION', 'Newer generated text');
    await waitFor(() => expect(persisted.get(PROJECT_ID)).toBe('Newer generated text'));
    await finish(older, 'PRODUCT_DESCRIPTION', 'Stale generated text');
    expect(screen.getByRole('textbox', { name: '商品描述' })).toHaveValue('Newer generated text');
    expect(writes.map(write => write.productDescription)).toEqual(['Newer generated text']);
  });

  it('ignores delayed create callbacks after switching projects', async () => {
    const creation = deferred<Output<'createCopywritingJob'>>();
    desktop.on('createCopywritingJob', () => creation.promise);
    const view = await setup();
    await waitFor(() => expect(copyButton()).toBeEnabled());
    fireEvent.click(copyButton());
    await waitFor(() => expect(desktop.api.invoke).toHaveBeenCalledWith('createCopywritingJob', expect.objectContaining({ projectId: PROJECT_ID })));
    view.rerender(<Harness projectId={SECOND_PROJECT}/>);
    await screen.findByDisplayValue('Second project description');
    await act(async () => { creation.resolve(copyJob(COPYWRITING_JOB_FIXTURE.id)); });
    expect(screen.getByRole('textbox', { name: '商品描述' })).toHaveValue('Second project description');
    expect(desktop.api.invoke).not.toHaveBeenCalledWith('getCopywritingResult', expect.anything());
    expect(writes).toEqual([]);
  });

  it('ignores results after unmount and leaves the generated result available in the query cache', async () => {
    const view = await setup();
    const id = await start();
    view.unmount();
    await finish(id);
    expect(writes).toEqual([]);
    expect(persisted.get(PROJECT_ID)).toBe(PROJECT_FIXTURE.productDescription);
  });
});
