import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import type { SqliteDatabase } from '@ecomgen/core';
import { RuntimeStore } from '../../src/runtime/state.js';
import { FAKE_KEY, file, generate, managedFiles, regressionFixtures, waitJob } from '../desktop-regression-helpers.js';

const { fixture, open } = regressionFixtures();

describe('generation intent and complete image validation regressions', { timeout: 120000 }, () => {
  it('reuses completed candidates after execution updates the item and only pays for newly requested candidates', async () => {
    const f = await fixture();
    const generated = await generate(f.backend, f.project.id);
    const request = { projectId: f.project.id, storyboardItemIds: [generated.board.items[0]!.id] };
    const outputs = await f.backend.invoke('listOutputs', { projectId: f.project.id });
    const counts = f.server.control.snapshot().counts;
    expect(f.context.repository.getStoryboardItem(generated.board.items[0]!.id)).toMatchObject({ status: 'GENERATED', compiledPrompt: expect.any(String) });
    const repeat = await f.backend.invoke('createGenerationJobs', request);
    expect(repeat).toMatchObject({ reused: true, jobs: [{ id: generated.job.id, status: 'SUCCEEDED' }] });
    expect(await f.backend.invoke('listOutputs', { projectId: f.project.id })).toEqual(outputs);
    expect(f.server.state.counts).toEqual(counts);
    for (const revision of ['retry', ' retry ']) {
      const retry = await f.backend.invoke('createGenerationJobs', { ...request, revision });
      expect(retry).toMatchObject({ reused: true, jobs: [{ id: generated.job.id, status: 'SUCCEEDED' }] });
      expect(await f.backend.invoke('listOutputs', { projectId: f.project.id })).toEqual(outputs);
      expect(f.server.state.counts).toEqual(counts);
    }
    // These commands advance operational timestamps/version without changing the effective image input.
    await f.backend.invoke('updateStoryboardItem', { itemId: generated.board.items[0]!.id, imageResolution: generated.board.items[0]!.imageResolution });
    await f.backend.invoke('updateProvider', { providerId: f.provider.id, name: 'Renamed isolated provider' });
    expect((await f.backend.invoke('createGenerationJobs', request)).jobs[0]!.id).toBe(generated.job.id);
    expect(f.server.state.counts).toEqual(counts);

    const extended = await f.backend.invoke('createGenerationJobs', { ...request, revision: 'retry', generationConfig: { candidateCount: 2 } });
    expect(extended.jobs[0]!.id).toBe(generated.job.id);
    expect(extended.jobs[1]!.id).not.toBe(generated.job.id);
    await waitJob(f.backend, extended.jobs[1]!.id);
    expect(f.server.state.counts['image-generation']).toBe(counts['image-generation'] + 1);
    const after = await f.backend.invoke('listOutputs', { projectId: f.project.id });
    expect(after.items).toHaveLength(2);
    expect(after.items).toContainEqual(outputs.items[0]);
    expect((await f.backend.invoke('createGenerationJobs', { ...request, generationConfig: { candidateCount: 2 } })).jobs.map(job => job.id)).toEqual(extended.jobs.map(job => job.id));
    expect(f.context.repository.getJob(extended.jobs[1]!.id)!.input).toMatchObject({ revision: 'retry', generationBatchId: outputs.items[0]!.generationBatchId });
    const finalCounts = f.server.control.snapshot().counts;
    await f.backend.close();
    const reopened = await open(f.options);
    for (const revision of [undefined, 'retry', ' retry ']) {
      expect((await reopened.backend.invoke('createGenerationJobs', { ...request, revision, generationConfig: { candidateCount: 2 } })).jobs.map(job => job.id)).toEqual(extended.jobs.map(job => job.id));
    }
    expect(await reopened.backend.invoke('listOutputs', { projectId: f.project.id })).toEqual(after);
    expect(f.server.state.counts).toEqual(finalCounts);
  });

  it.each([undefined, 'retry'])('reuses initial UNKNOWN intent with revision %s across retry markers and restart without another paid request', async revision => {
    const f = await fixture();
    const plan = await f.backend.invoke('createPlanningJob', { projectId: f.project.id, planningMode: 'MANUAL', requestedTypes: ['hero-image'] });
    await waitJob(f.backend, plan.id);
    const board = await f.backend.invoke('getStoryboard', { projectId: f.project.id });
    await f.backend.invoke('confirmStoryboard', { projectId: f.project.id, version: Number(board.storyboard!.version) });
    f.server.control.failNext('image-generation', { type: 'drop' });
    const request = { projectId: f.project.id, storyboardItemIds: [board.items[0]!.id] };
    const uncertain = await f.backend.invoke('createGenerationJobs', { ...request, revision });
    await waitJob(f.backend, uncertain.jobs[0]!.id, 'UNKNOWN');
    const outputs = await f.backend.invoke('listOutputs', { projectId: f.project.id });
    const counts = f.server.control.snapshot().counts;
    expect(counts['image-generation']).toBe(1);
    const store = new RuntimeStore((f.context.repository as unknown as { db: SqliteDatabase }).db);
    const frozen = store.get(uncertain.jobs[0]!.id)!.snapshot;
    expect(f.context.repository.getJob(uncertain.jobs[0]!.id)!.input.revision).toBe(revision);
    const assertReused = async (backend: typeof f.backend) => {
      for (const marker of [undefined, 'retry', ' retry ']) {
        const repeat = await backend.invoke('createGenerationJobs', { ...request, revision: marker });
        expect(repeat).toMatchObject({ reused: true, jobs: [{ id: uncertain.jobs[0]!.id, status: 'UNKNOWN' }] });
      }
      await expect(backend.invoke('retryJob', { jobId: uncertain.jobs[0]!.id })).rejects.toMatchObject({ code: 'RETRY_UNSAFE' });
      expect((await backend.invoke('getJobRequests', { jobId: uncertain.jobs[0]!.id })).items).toEqual([expect.objectContaining({ state: 'UNKNOWN' })]);
      expect(await backend.invoke('listOutputs', { projectId: f.project.id })).toEqual(outputs);
      expect((await backend.invoke('listJobs', { projectId: f.project.id })).items.filter(job => job.type === 'GENERATE')).toHaveLength(1);
      expect(f.server.state.counts).toEqual(counts);
    };
    await assertReused(f.backend);
    expect(store.get(uncertain.jobs[0]!.id)!.snapshot).toEqual(frozen);
    await f.backend.close();
    const reopened = await open(f.options);
    await assertReused(reopened.backend);
    const reopenedStore = new RuntimeStore((reopened.context.repository as unknown as { db: SqliteDatabase }).db);
    expect(reopenedStore.get(uncertain.jobs[0]!.id)!.snapshot).toEqual(frozen);
  });

  it('explicit regeneration creates a new image while replaying its key stays idempotent across restart', async () => {
    const f = await fixture();
    const generated = await generate(f.backend, f.project.id);
    const original = (await f.backend.invoke('listOutputs', { projectId: f.project.id })).items[0]!;
    const counts = f.server.control.snapshot().counts;
    const request = { projectId: f.project.id, storyboardItemIds: [generated.board.items[0]!.id], generationBatchId: original.generationBatchId!, revision: 'retry', regenerationKey: '11111111-2222-4333-8444-555555555555', generationConfig: { candidateCount: 1 } };
    const submitted = await f.backend.invoke('createGenerationJobs', request);
    expect(submitted.jobs).toHaveLength(1);
    expect(submitted.jobs[0]!.id).not.toBe(generated.job.id);
    expect((await f.backend.invoke('createGenerationJobs', request)).jobs[0]!.id).toBe(submitted.jobs[0]!.id);
    await expect(f.backend.invoke('createGenerationJobs', { ...request, regenerationKey: '22222222-2222-4333-8444-555555555555' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await waitJob(f.backend, submitted.jobs[0]!.id);
    const outputs = (await f.backend.invoke('listOutputs', { projectId: f.project.id })).items;
    expect(outputs).toHaveLength(2);
    expect(outputs).toContainEqual(original);
    expect(outputs.find(output => output.jobId === submitted.jobs[0]!.id)?.generationBatchId).toBe(original.generationBatchId);
    expect(f.server.state.counts['image-generation']).toBe(counts['image-generation'] + 1);
    expect(f.server.state.counts.chat).toBe(counts.chat);
    await f.backend.close();
    const reopened = await open(f.options);
    expect((await reopened.backend.invoke('createGenerationJobs', request)).jobs[0]!.id).toBe(submitted.jobs[0]!.id);
    expect(f.server.state.counts['image-generation']).toBe(counts['image-generation'] + 1);
  });

  it('explicit regeneration cannot bypass an unknown external result with a different key', async () => {
    const f = await fixture();
    const generated = await generate(f.backend, f.project.id);
    f.server.control.failNext('image-generation', { type: 'drop' });
    const request = { projectId: f.project.id, storyboardItemIds: [generated.board.items[0]!.id], revision: 'retry', regenerationKey: '33333333-2222-4333-8444-555555555555' };
    const submitted = await f.backend.invoke('createGenerationJobs', request);
    await waitJob(f.backend, submitted.jobs[0]!.id, 'UNKNOWN');
    const counts = f.server.control.snapshot().counts;
    expect((await f.backend.invoke('createGenerationJobs', request)).jobs[0]!.id).toBe(submitted.jobs[0]!.id);
    await expect(f.backend.invoke('createGenerationJobs', { ...request, regenerationKey: '44444444-2222-4333-8444-555555555555' })).rejects.toMatchObject({ code: 'EXTERNAL_UNKNOWN' });
    expect(f.server.state.counts).toEqual(counts);
  });

  it('keeps freeform prompt revisions distinct from the initial intent and retry marker', async () => {
    const f = await fixture();
    const generated = await generate(f.backend, f.project.id);
    const request = { projectId: f.project.id, storyboardItemIds: [generated.board.items[0]!.id] };
    const original = f.context.repository.getJob(generated.job.id)!;
    const outputs = await f.backend.invoke('listOutputs', { projectId: f.project.id });
    const counts = f.server.control.snapshot().counts;
    const ids = new Set([generated.job.id]);
    for (const revision of ['Move the cup to the left.', 'Use a close-up composition.']) {
      const changed = await f.backend.invoke('createGenerationJobs', { ...request, revision });
      expect(ids.has(changed.jobs[0]!.id)).toBe(false);
      ids.add(changed.jobs[0]!.id);
      await waitJob(f.backend, changed.jobs[0]!.id);
      expect((await f.backend.invoke('createGenerationJobs', { ...request, revision: ` ${revision} ` })).jobs[0]!.id).toBe(changed.jobs[0]!.id);
    }
    expect(f.server.state.counts['image-generation']).toBe(counts['image-generation'] + 2);
    expect(f.server.state.counts.chat).toBe(counts.chat + 2);
    const revisedCounts = f.server.control.snapshot().counts;
    expect((await f.backend.invoke('createGenerationJobs', { ...request, revision: 'retry' })).jobs[0]!.id).toBe(generated.job.id);
    expect(f.server.state.counts).toEqual(revisedCounts);
    expect(f.context.repository.getJob(generated.job.id)!.input).toEqual(original.input);
    expect((await f.backend.invoke('listOutputs', { projectId: f.project.id })).items).toContainEqual(outputs.items[0]);
  });

  it('permits a new safe intent after a known failed request while preserving retry metadata', async () => {
    const f = await fixture();
    const plan = await f.backend.invoke('createPlanningJob', { projectId: f.project.id, planningMode: 'MANUAL', requestedTypes: ['hero-image'] });
    await waitJob(f.backend, plan.id);
    const board = await f.backend.invoke('getStoryboard', { projectId: f.project.id });
    await f.backend.invoke('confirmStoryboard', { projectId: f.project.id, version: Number(board.storyboard!.version) });
    const request = { projectId: f.project.id, storyboardItemIds: [board.items[0]!.id] };
    f.server.control.failNext('image-generation', { type: 'http', status: 400 });
    const failed = await f.backend.invoke('createGenerationJobs', request);
    await waitJob(f.backend, failed.jobs[0]!.id, 'FAILED');
    expect((await f.backend.invoke('getJobRequests', { jobId: failed.jobs[0]!.id })).items).toEqual([expect.objectContaining({ state: 'COMPLETED' })]);
    const retried = await f.backend.invoke('createGenerationJobs', { ...request, revision: 'retry' });
    expect(retried.jobs[0]!.id).not.toBe(failed.jobs[0]!.id);
    expect(f.context.repository.getJob(retried.jobs[0]!.id)!.input.revision).toBe('retry');
    await waitJob(f.backend, retried.jobs[0]!.id);
    expect((await f.backend.invoke('createGenerationJobs', request)).jobs[0]!.id).toBe(retried.jobs[0]!.id);
    expect(f.server.state.counts['image-generation']).toBe(2);
    expect((await f.backend.invoke('listOutputs', { projectId: f.project.id })).items).toEqual([expect.objectContaining({ jobId: retried.jobs[0]!.id })]);
  });

  it('distinguishes effective model and generation settings after completion', async () => {
    const f = await fixture();
    const generated = await generate(f.backend, f.project.id);
    const alternate = await f.backend.invoke('createProvider', {
      name: 'Second isolated model', baseUrl: f.server.baseUrl, reasoningProtocol: 'openai', apiKey: FAKE_KEY,
      models: [{ id: 'gpt-image-1', supportsVision: false, supportsThinking: false, supportsTools: false, supportsStructuredOutput: false, imageApiKind: 'openai_images' }],
    });
    const request = { projectId: f.project.id, storyboardItemIds: [generated.board.items[0]!.id] };
    const ids = new Set([generated.job.id]);
    for (const generationConfig of [
      { imageModel: { providerId: alternate.id, modelId: 'gpt-image-1' } },
      { imageResolution: '2K' as const },
      { imageAspectRatio: '1:1' as const },
      { quality: 'low' as const },
      { outputFormat: 'jpeg' as const },
    ]) {
      const changed = await f.backend.invoke('createGenerationJobs', { ...request, generationConfig });
      expect(ids.has(changed.jobs[0]!.id)).toBe(false);
      ids.add(changed.jobs[0]!.id);
      await waitJob(f.backend, changed.jobs[0]!.id);
      expect((await f.backend.invoke('createGenerationJobs', { ...request, generationConfig })).jobs[0]!.id).toBe(changed.jobs[0]!.id);
    }
    expect(f.server.state.counts['image-generation']).toBe(6);
    expect((await f.backend.invoke('createGenerationJobs', request)).jobs[0]!.id).toBe(generated.job.id);
  });

  it.each(['prompt', 'reference'] as const)('distinguishes an actual queued %s edit while preserving the original frozen input', async change => {
    const f = await fixture();
    const asset = await f.backend.invoke('uploadAsset', { projectId: f.project.id, file: file(f.bytes), kind: 'REFERENCE' });
    const plan = await f.backend.invoke('createPlanningJob', { projectId: f.project.id, planningMode: 'MANUAL', requestedTypes: ['hero-image'] });
    await waitJob(f.backend, plan.id);
    let board = await f.backend.invoke('getStoryboard', { projectId: f.project.id });
    const itemId = board.items[0]!.id;
    await f.backend.invoke('updateStoryboardItem', { itemId, referencedAssets: [] });
    board = await f.backend.invoke('getStoryboard', { projectId: f.project.id });
    await f.backend.invoke('confirmStoryboard', { projectId: f.project.id, version: Number(board.storyboard!.version) });
    const request = { projectId: f.project.id, storyboardItemIds: [itemId] };
    // enqueue wakes setImmediate: these synchronous command transactions finish before execution starts.
    const original = await f.backend.invoke('createGenerationJobs', request);
    expect(original.jobs[0]!.status).toBe('QUEUED');
    const store = new RuntimeStore((f.context.repository as unknown as { db: SqliteDatabase }).db);
    const frozen = store.get(original.jobs[0]!.id)!.snapshot;
    await f.backend.invoke('updateStoryboardItem', change === 'prompt'
      ? { itemId, promptInstruction: 'A genuinely edited composition with the cup on the left.' }
      : { itemId, referencedAssets: [asset.id] });
    const edited = await f.backend.invoke('createGenerationJobs', request);
    expect(edited.jobs[0]!.id).not.toBe(original.jobs[0]!.id);
    expect((await f.backend.invoke('createGenerationJobs', request)).jobs[0]!.id).toBe(edited.jobs[0]!.id);
    await waitJob(f.backend, original.jobs[0]!.id);
    await waitJob(f.backend, edited.jobs[0]!.id);
    expect(store.get(original.jobs[0]!.id)!.snapshot).toEqual(frozen);
    const outputs = await f.backend.invoke('listOutputs', { projectId: f.project.id });
    expect(outputs.items.map(output => output.jobId).sort()).toEqual([original.jobs[0]!.id, edited.jobs[0]!.id].sort());
    expect(f.server.state.counts['image-generation'] + f.server.state.counts['image-edit']).toBe(2);
  });

  it('rejects metadata-readable truncated PNG before publishing any pattern, draft media, source file or job', async () => {
    const f = await fixture();
    const truncated = f.bytes.subarray(0, f.bytes.length - 20);
    expect(await sharp(truncated).metadata()).toMatchObject({ width: 32, height: 24 });
    await expect(sharp(truncated, { failOn: 'error' }).stats()).rejects.toThrow();
    const draft = await f.backend.invoke('createPatternDraft', { name: 'Damaged upload rejection' });
    const before = await managedFiles(f.options.dataDir);
    const counts = f.server.control.snapshot().counts;
    await expect(f.backend.invoke('createPatternExtractJob', {
      file: file(truncated), providerId: f.provider.id, modelId: 'gpt-image-1', mode: 'GENERATE', background: 'WHITE',
    })).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    await expect(f.backend.invoke('uploadPattern', { file: file(truncated) })).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    await expect(f.backend.invoke('createDraftMedia', { draftId: draft.id, role: 'REFERENCE', file: file(truncated) })).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    // The real batch handler must still validate every input before publishing even its valid first file.
    await expect(f.backend.invoke('createSuiteForgeJob', {
      providerId: f.provider.id, modelId: 'mock-reasoner', files: [file(f.bytes), file(truncated)],
    })).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    expect((await f.backend.invoke('listPatterns', {})).items).toEqual([]);
    expect((await f.backend.invoke('listDraftMedia', { draftId: draft.id })).items).toEqual([]);
    expect((await f.backend.invoke('listJobs', {})).items).toEqual([]);
    expect(f.context.repository.listPatterns()).toEqual([]);
    expect(await managedFiles(f.options.dataDir)).toEqual(before);
    expect(f.server.state.counts).toEqual(counts);
  });

  it.each(['avif', 'tiff'] as const)('fully decodes actual %s through extraction, pattern upload and draft media commands', async format => {
    const f = await fixture();
    const bytes = await sharp(f.bytes).toFormat(format).toBuffer();
    const input = file(bytes, `source.${format}`, `image/${format}`);
    const pattern = await f.backend.invoke('uploadPattern', { file: input, name: `${format} import` });
    expect(pattern).toMatchObject({ width: 32, height: 24, source: 'UPLOADED' });
    const patternPath = await f.backend.invokeHost('host.resolveResource', { ref: { kind: 'PATTERN', id: pattern.id } });
    expect(await sharp(await readFile(patternPath.path)).metadata()).toMatchObject({ width: 32, height: 24, format: 'png' });
    const draft = await f.backend.invoke('createPatternDraft', {});
    const media = await f.backend.invoke('createDraftMedia', { draftId: draft.id, role: 'REFERENCE', file: input });
    expect(media).toMatchObject({ width: 32, height: 24, mimeType: 'image/png' });
    const mediaPath = await f.backend.invokeHost('host.resolveResource', { ref: { kind: 'DRAFT_MEDIA', id: media.id } });
    expect(await sharp(await readFile(mediaPath.path)).metadata()).toMatchObject({ width: 32, height: 24, format: 'png' });
    const extraction = await f.backend.invoke('createPatternExtractJob', {
      file: input, providerId: f.provider.id, modelId: 'gpt-image-1', mode: 'GENERATE', background: 'WHITE',
    });
    const savedSource = f.context.repository.getJob(extraction.id)!.input.sourcePath as string;
    expect(await f.context.storage.read(savedSource)).toEqual(bytes);
    await waitJob(f.backend, extraction.id);
    expect(f.context.repository.listPatterns().find(record => record.sourceJobId === extraction.id)).toMatchObject({ width: 32, height: 24, sourceType: 'EXTRACTED' });
    expect(f.server.state.counts['image-edit']).toBe(1);
  });
});
