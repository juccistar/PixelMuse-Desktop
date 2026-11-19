import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { afterEach, expect } from 'vitest';
import sharp from 'sharp';
import type { BackendOptions, ByteImport, ChangeEvent } from '@ecomgen/contracts';
import { startFullMockProvider, storyboardReply, type FullMockOptions } from '../../../scripts/full-mock-provider.mjs';
import { createBackend, type Backend, type CommandContext } from '../src/index.js';
import { registerDomainCommands } from '../src/commands/index.js';
import { registerExecutors } from '../src/execution/index.js';

/** 新视觉规划假回复只引用本次实际发送的目标商品和参考附件。 */
export function visualStoryboardReply(payload: Record<string, any>, fallbackLock: string) {
  const references: string[] = (payload.assets ?? []).filter((asset: any) => asset.kind === 'REFERENCE').map((asset: any) => asset.handle);
  return {
    campaignStyleLock: payload.productImageBatch.campaignStyleLock ?? fallbackLock,
    items: payload.productImageBatch.targets.map((target: any, index: number) => ({
      displayName: `商品画面${index + 1}`, intent: `展示目标${index + 1}`, referenceIntent: references[0] ? `${references[0]}光线` : '统一风格',
      referencedAssets: [target.productHandles[0], ...references.slice(0, 1)], mode: payload.defaultMode,
      promptInstruction: `Preserve ${target.productHandles[0]} identity. ${references[0] ? `Use ${references[0]} as visual reference.` : ''} Composition ${index + 1}.`,
      factClaims: [], riskFlags: [],
    })),
  };
}

/** 每个测试文件单独持有清理栈；即使断言失败也先关闭 owner/socket，再删自身临时目录。 */
export function regressionFixtures() {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.splice(0).reverse()) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Regression fixture cleanup failed');
  });
  const directory = async () => {
    const root = await mkdtemp(join(tmpdir(), 'ecomgen-v3-regression-'));
    cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
    return root;
  };
  const open = async (options: BackendOptions, onChange?: (event: ChangeEvent) => void) => {
    let context!: CommandContext;
    const backend = await createBackend(options, onChange, {
      commands: current => { context = current; return registerDomainCommands(current); },
      executors: registerExecutors,
    });
    cleanups.push(() => backend.close());
    return { backend, context };
  };
  const fixture = async (configuration: { mode?: 'CREATIVE' | 'PIXEL_PROTECTED'; mock?: FullMockOptions; onChange?: (event: ChangeEvent) => void } = {}) => {
    const root = await directory();
    const bytes = await sharp({ create: { width: 32, height: 24, channels: 4, background: '#dd5533' } }).png().toBuffer();
    const server = await startFullMockProvider({ image: bytes, replies: { storyboard: storyboardReply({ assetTypes: ['hero-image'], candidateCount: 1, mode: configuration.mode ?? 'CREATIVE', referencedAssets: [] }) }, ...configuration.mock });
    cleanups.push(() => server.close());
    const options: BackendOptions = { dataDir: join(root, 'managed'), masterKey: randomBytes(32).toString('base64'), version: 'regression-test' };
    const opened = await open(options, configuration.onChange);
    const provider = await opened.backend.invoke('createProvider', {
      name: 'Isolated mock', baseUrl: server.baseUrl, reasoningProtocol: 'openai', apiKey: FAKE_KEY,
      models: [
        { id: 'mock-reasoner', supportsVision: true, supportsThinking: false, supportsTools: false, supportsStructuredOutput: true },
        { id: 'gpt-image-1', supportsVision: false, supportsThinking: false, supportsTools: false, supportsStructuredOutput: false, imageApiKind: 'openai_images' },
        { id: 'sam', supportsVision: false, supportsThinking: false, supportsTools: false, supportsStructuredOutput: false, segmentationProtocol: 'grounded_sam' },
      ],
    });
    const project = await opened.backend.invoke('createProject', {
      name: '陶瓷杯', productDescription: '经核实的陶瓷杯', verifiedFacts: ['陶瓷杯'],
      reasoningProviderId: provider.id, reasoningModelId: 'mock-reasoner', imageProviderId: provider.id, imageModelId: 'gpt-image-1',
      defaultMode: configuration.mode ?? 'CREATIVE', promptLanguage: 'ENGLISH', candidatesPerType: 1,
      segmentationModel: { providerId: provider.id, modelId: 'sam' },
    });
    return { ...opened, root, bytes, options, server, provider, project };
  };
  return { fixture, open, directory };
}
export const FAKE_KEY = 'isolated-regression-key-never-use-a-real-provider';
export const file = (bytes: Buffer, name = 'source.png', mimeType: ByteImport['mimeType'] = 'image/png'): ByteImport => ({ name, mimeType, base64: bytes.toString('base64') });

/** 轮询实际 await 后的状态；终态错误立即保留到断言信息，不把 Promise 当作真值。 */
export async function waitJob(backend: Backend, id: string, status = 'SUCCEEDED') {
  const started = Date.now();
  let last: unknown;
  const job = await poll(async () => {
    const current = await backend.invoke('getJob', { jobId: id });
    last = current;
    return ['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(current.status) ? current : undefined;
  }, `job ${id} to settle`).catch(async error => {
    throw new Error(`${String(error)}; last=${JSON.stringify(last)}; requests=${JSON.stringify(await backend.invoke('getJobRequests', { jobId: id }))}`);
  });
  if (process.env.ECOMGEN_TEST_TIMINGS === '1') console.info(`[backend timing] ${job.type} ${job.status}: ${Date.now() - started}ms`);
  expect(job.status, JSON.stringify(job)).toBe(status);
  return job;
}
export async function poll<T>(read: () => Promise<T | undefined>, description: string, timeout = 45000): Promise<T> {
  const deadline = Date.now() + timeout;
  do {
    const result = await read();
    if (result !== undefined) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}`);
}
export async function generate(backend: Backend, projectId: string) {
  const plan = await backend.invoke('createPlanningJob', { projectId, planningMode: 'MANUAL', requestedTypes: ['hero-image'] });
  await waitJob(backend, plan.id);
  const board = await backend.invoke('getStoryboard', { projectId });
  expect(board.storyboard).not.toBeNull();
  const version = board.storyboard!.version;
  expect(typeof version).toBe('number');
  await backend.invoke('confirmStoryboard', { projectId, version: Number(version) });
  const result = await backend.invoke('createGenerationJobs', { projectId, storyboardItemIds: [board.items[0]!.id] });
  expect(result.jobs).toHaveLength(1);
  await waitJob(backend, result.jobs[0]!.id);
  const outputs = await backend.invoke('listOutputs', { projectId });
  const output = outputs.items.find(item => item.jobId === result.jobs[0]!.id)!;
  expect(output).toBeDefined();
  return { plan, board, job: result.jobs[0]!, output };
}
export async function managedFiles(path: string) {
  return (await readdir(path, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)).sort();
}
/** 校验中央目录而非搜索 PK 字符串，返回归档内的实际解压字节。 */
export function unzip(buffer: Buffer): Map<string, Buffer> {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThanOrEqual(0);
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let index = 0; index < count; index++) {
    expect(buffer.readUInt32LE(offset)).toBe(0x02014b50);
    const method = buffer.readUInt16LE(offset + 10), size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28), extraLength = buffer.readUInt16LE(offset + 30), commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42), name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    expect(name).not.toMatch(/(?:^\/|^[A-Za-z]:|\\|(?:^|\/)\.\.(?:\/|$))/);
    expect(files.has(name)).toBe(false);
    const dataOffset = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const compressed = buffer.subarray(dataOffset, dataOffset + size);
    expect([0, 8]).toContain(method);
    const bytes = method === 8 ? inflateRawSync(compressed) : compressed;
    expect(bytes.length).toBe(buffer.readUInt32LE(offset + 24));
    files.set(name, bytes);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}
