import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { resourceRefFromUrl, type ResourceRef } from '@ecomgen/contracts';
import { patternResources, registerEntries, registerJobResources } from '../../src/commands/resources.js';
import { mimeForStoragePath } from '../../src/execution/context.js';
import { integrationFixtures, waitJob } from '../integration/fixtures.js';
import { regressionFixtures } from '../desktop-regression-helpers.js';

const defaults = integrationFixtures();
const captured = regressionFixtures();
const specId = 'phonecase-generic';

describe('resource MIME consistency across execution and commands', () => {
  it('queries and downloads a real default print pack, reuses it, then completes Listing after reopening', async () => {
    const f = await defaults.fixture();
    const pattern = await f.backend.invoke('uploadPattern', {
      name: 'Synthetic print artwork', file: { name: 'pattern.png', mimeType: 'image/png', base64: f.bytes.toString('base64') },
    });
    const input = { patternId: pattern.id, specId };
    const created = await f.backend.invoke('createPrintPackJob', input);
    await waitJob(f.backend, created.job.id);
    const pack = await f.backend.invoke('getPrintPack', { printPackId: created.printPack!.id });
    expect(pack.status).toBe('SUCCEEDED');
    expect(pack.files.map(file => file.kind)).toEqual(['PRINT_FILE', 'MOCKUP', 'MANIFEST']);
    expect((await f.backend.invoke('listPatternPrintPacks', { patternId: pattern.id })).items).toEqual([pack]);
    expect((await f.backend.invoke('createPrintPackJob', input)).job.id).toBe(created.job.id);

    for (const [index, file] of pack.files.entries()) {
      const ref = resourceRefFromUrl(file.url);
      const mimeType = file.kind === 'MANIFEST' ? 'application/json' : 'image/png';
      expect(await f.backend.invoke('getResource', { ref })).toEqual({ ref, mimeType });
      const handle = await f.backend.invoke('getPrintPackFile', { printPackId: pack.id, index });
      expect(handle).toEqual({ ref, mimeType });
      const resolved = await f.backend.invokeHost('host.resolveResource', { ref: handle.ref });
      expect(resolved).toMatchObject({ mimeType, hash: file.hash });
      const bytes = await readFile(resolved.path);
      if (file.kind === 'MANIFEST') {
        expect(JSON.parse(bytes.toString('utf8'))).toMatchObject({
          kind: 'ecomgen.print-pack', printPackId: pack.id, pattern: { id: pattern.id }, spec: { id: specId },
        });
      } else expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    }
    expect(f.server.state.counts.chat).toBe(0);
    expect(f.server.state.counts['image-generation']).toBe(0);

    await f.backend.close();
    const backend = await defaults.open(f.options);
    expect(await backend.invoke('getPrintPack', { printPackId: pack.id })).toEqual(pack);
    const listing = await backend.invoke('createPatternListingJob', {
      patternId: pattern.id, providerId: f.provider.id, modelId: 'mock-reasoner', platform: 'ETSY',
    });
    await waitJob(backend, listing.id);
    expect(await backend.invoke('getPatternListingResult', { patternId: pattern.id, jobId: listing.id })).toMatchObject({ jobId: listing.id });
    expect((await backend.invoke('getJobRequests', { jobId: listing.id })).items).toEqual([
      expect.objectContaining({ state: 'COMPLETED', localState: 'COMMITTED' }),
    ]);
    expect(f.server.state.counts.chat).toBe(1);
    expect(f.server.state.counts['image-generation']).toBe(0);
  });

  it('finishes the default tile-check, print-pack and Listing pipeline with an already published pack', async () => {
    const f = await defaults.fixture();
    const pattern = await f.backend.invoke('uploadPattern', {
      name: 'Synthetic seamless artwork', file: { name: 'tile.png', mimeType: 'image/png', base64: f.bytes.toString('base64') },
    });
    const pack = await f.backend.invoke('createPrintPackJob', { patternId: pattern.id, specId });
    await waitJob(f.backend, pack.job.id);
    const pipeline = await f.backend.invoke('createPatternPipeline', {
      patternId: pattern.id, specId, layout: 'TILE', listingPlatform: 'ETSY',
      listingProviderId: f.provider.id, listingModelId: 'mock-reasoner',
    });
    let settled = await f.backend.invoke('getPatternPipeline', { pipelineId: pipeline.id });
    for (const name of ['TILE_CHECK', 'PRINT_PACK', 'LISTING']) {
      const step = settled.steps.find(step => step.step === name)!;
      expect(step.jobId, JSON.stringify(settled)).toBeTruthy();
      await waitJob(f.backend, step.jobId!);
      settled = await f.backend.invoke('getPatternPipeline', { pipelineId: pipeline.id });
    }
    expect(settled.status).toBe('SUCCEEDED');
    expect(settled.steps.map(step => [step.step, step.status])).toEqual([
      ['TILE_CHECK', 'SUCCEEDED'], ['PRINT_PACK', 'SUCCEEDED'], ['LISTING', 'SUCCEEDED'],
    ]);
    const packs = await f.backend.invoke('listPatternPrintPacks', { patternId: pattern.id });
    expect(packs.items).toHaveLength(2);
    expect(packs.items.every(pack => pack.status === 'SUCCEEDED')).toBe(true);
    const tiledPack = packs.items.find(pack => pack.jobId === settled.steps.find(step => step.step === 'PRINT_PACK')!.jobId)!;
    expect(tiledPack.files.map(file => file.kind)).toContain('SEAMLESS_TILE');
    const manifestIndex = tiledPack.files.findIndex(file => file.kind === 'MANIFEST');
    const manifest = await f.backend.invoke('getPrintPackFile', { printPackId: tiledPack.id, index: manifestIndex });
    expect(manifest.mimeType).toBe('application/json');
    expect((await f.backend.invokeHost('host.resolveResource', { ref: manifest.ref })).hash).toBe(tiledPack.files[manifestIndex]!.hash);
    const listingId = settled.steps.find(step => step.step === 'LISTING')!.jobId!;
    expect(await f.backend.invoke('getPatternListingResult', { patternId: pattern.id, jobId: listingId })).toMatchObject({ jobId: listingId });
    expect(f.server.state.counts.chat).toBe(1);
    expect(f.server.state.counts['image-generation']).toBe(0);
  });

  it('keeps command metadata consistent for supported suffixes and rejects changed path, hash or MIME', async () => {
    const root = await captured.directory();
    const { backend, context } = await captured.open({
      dataDir: root, masterKey: Buffer.alloc(32, 17).toString('base64'), version: 'mime-consistency',
    });
    const patternId = randomUUID();
    const stored = await context.storage.putPatternArtifact(patternId, 'metadata-fixture', Buffer.from('synthetic artifact bytes'));
    context.repository.createPattern({
      id: patternId, name: 'Metadata fixture', sourceType: 'UPLOADED', sourceJobId: null, sourceAssetHash: stored.hash,
      parentPatternId: null, storagePath: stored.path, fileHash: stored.hash, width: 1, height: 1, tags: [],
    });
    const job = context.repository.createJob({ id: randomUUID(), type: 'PRINT_PACK', status: 'SUCCEEDED', projectId: null, storyboardItemId: null, input: { patternId } });
    const pack = context.repository.createPrintPack({ patternId, jobId: job.id, specId, specVersion: 'metadata-test', status: 'QUEUED' });
    const formats = [
      ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.WEBP', 'image/webp'],
      ['.avif', 'image/avif'], ['.AVIF', 'image/avif'], ['.tif', 'image/tiff'], ['.TIFF', 'image/tiff'],
      ['.psd', 'image/vnd.adobe.photoshop'], ['.ZIP', 'application/zip'], ['.JSON', 'application/json'],
    ] as const;
    const files = [];
    for (const [index, [extension, mimeType]] of formats.entries()) {
      const artifact = await context.storage.putPrintPackArtifact(pack.id, `metadata-${index}`, Buffer.from(`synthetic ${extension} metadata fixture`), extension);
      const ref: ResourceRef = { kind: 'PRINT_PACK_FILE', id: pack.id, index };
      // Match publication by the real execution context before command-side collection.
      expect(mimeForStoragePath(artifact.path)).toBe(mimeType);
      context.resources.register({ ref, relativePath: artifact.path, hash: artifact.hash, mimeType, owners: [`pattern:${patternId}`] });
      files.push({ name: `metadata${extension}`, kind: 'PRINT_FILE' as const, storagePath: artifact.path, hash: artifact.hash });
    }
    context.repository.updatePrintPack(pack.id, { status: 'SUCCEEDED', files });
    registerEntries(context, patternResources(context, patternId));
    registerJobResources(context, job);
    for (const [index, [, mimeType]] of formats.entries()) {
      const ref: ResourceRef = { kind: 'PRINT_PACK_FILE', id: pack.id, index };
      expect(await backend.invoke('getPrintPackFile', { printPackId: pack.id, index })).toEqual({ ref, mimeType });
      expect(await backend.invokeHost('host.resolveResource', { ref })).toMatchObject({ mimeType, hash: files[index]!.hash });
    }

    const original = { ref: { kind: 'PRINT_PACK_FILE' as const, id: pack.id, index: 0 }, relativePath: files[0]!.storagePath,
      hash: files[0]!.hash, mimeType: 'image/png', owners: ['test:additional-owner'] };
    expect(() => context.resources.register(original)).not.toThrow();
    for (const patch of [{ relativePath: files[1]!.storagePath }, { hash: 'f'.repeat(64) }, { mimeType: 'application/octet-stream' }]) {
      expect(() => context.resources.register({ ...original, ...patch })).toThrowError(expect.objectContaining({ code: 'RESOURCE_CONFLICT' }));
    }
    expect(await backend.invoke('getPrintPackFile', { printPackId: pack.id, index: 0 })).toEqual({ ref: original.ref, mimeType: 'image/png' });
  });
});
