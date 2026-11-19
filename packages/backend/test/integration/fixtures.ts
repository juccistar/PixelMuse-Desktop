import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach } from 'vitest';
import type { BackendOptions, ChangeEvent } from '@ecomgen/contracts';
import { startFullMockProvider, storyboardReply, type FullMockOptions } from '../../../../scripts/full-mock-provider.mjs';
import { createBackend } from '../../src/index.js';
export { waitJob, poll, generate, file, unzip } from '../desktop-regression-helpers.js';

export function integrationFixtures() {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
  const directory = async () => {
    const root = await mkdtemp(join(tmpdir(), 'ecomgen-default-integration-'));
    cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
    return root;
  };
  const open = async (options: BackendOptions, onChange?: (event: ChangeEvent) => void) => {
    const backend = await createBackend(options, onChange);
    cleanups.push(() => backend.close());
    return backend;
  };
  const fixture = async (mock: FullMockOptions = {}) => {
    const started = Date.now();
    const root = await directory();
    const bytes = await sharp({ create: { width: 32, height: 24, channels: 4, background: '#dd5533' } }).png().toBuffer();
    const server = await startFullMockProvider({ image: bytes, replies: { storyboard: storyboardReply({ assetTypes: ['hero-image'], candidateCount: 1, mode: 'CREATIVE', referencedAssets: [] }) }, ...mock });
    cleanups.push(() => server.close());
    const options = { dataDir: root, masterKey: randomBytes(32).toString('base64'), version: 'default-integration' };
    const backend = await open(options);
    const provider = await backend.invoke('createProvider', {
      name: '本机假协议', baseUrl: server.baseUrl, reasoningProtocol: 'openai', apiKey: 'isolated-default-test-key',
      models: [
        { id: 'mock-reasoner', supportsVision: true, supportsThinking: false, supportsTools: false, supportsStructuredOutput: true },
        { id: 'gpt-image-1', supportsVision: false, supportsThinking: false, supportsTools: false, supportsStructuredOutput: false, imageApiKind: 'openai_images' },
        { id: 'sam', supportsVision: false, supportsThinking: false, supportsTools: false, supportsStructuredOutput: false, segmentationProtocol: 'grounded_sam' },
      ],
    });
    const project = await backend.invoke('createProject', { name: '陶瓷杯', productDescription: '陶瓷杯', verifiedFacts: ['陶瓷杯'], defaultMode: 'CREATIVE', promptLanguage: 'ENGLISH',
      reasoningProviderId: provider.id, reasoningModelId: 'mock-reasoner', imageProviderId: provider.id, imageModelId: 'gpt-image-1', candidatesPerType: 1,
      segmentationModel: { providerId: provider.id, modelId: 'sam' } });
    if (process.env.ECOMGEN_TEST_TIMINGS === '1') console.info(`[backend timing] fixture ready: ${Date.now() - started}ms`);
    return { backend, server, options, root, bytes, project, provider };
  };
  return { directory, open, fixture };
}
