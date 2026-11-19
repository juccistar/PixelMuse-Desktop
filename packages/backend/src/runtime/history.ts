import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { Value } from '@sinclair/typebox/value';
import { EcomSuiteFile } from '@ecomgen/domain';
import { DesktopHistoryResultSchema, type DesktopHistory, type DesktopHistoryResult, type ResourceRef } from '@ecomgen/contracts';
import type { JobRecord } from '@ecomgen/core';
import type { CommandContext } from './ports.js';
import { assertPublicOutput, BackendError } from '../validation.js';

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const shaPattern = /^[a-f0-9]{64}$/;

/** 首次登记前检查归档边界；只读有界头/目录，不能把截断文件的现存hash当成完整产物。 */
async function verifyContainer(path: string, kind: ResourceRef['kind'], size: number, signal: AbortSignal): Promise<void> {
  const file = await open(path, 'r');
  try {
    if ((await file.stat()).size !== size) throw new Error('Artifact changed');
    const read = async (offset: number, length: number) => {
      signal.throwIfAborted();
      if (offset < 0 || offset + length > size) throw new Error('Truncated artifact');
      const buffer = Buffer.alloc(length);
      if ((await file.read(buffer, 0, length, offset)).bytesRead !== length) throw new Error('Truncated artifact');
      return buffer;
    };
    if (kind === 'EXPORT') {
      const tailOffset = Math.max(0, size - 65557), tail = await read(tailOffset, size - tailOffset);
      const end = tail.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));
      if (end < 0 || end + 22 > tail.length || end + 22 + tail.readUInt16LE(end + 20) !== tail.length) throw new Error('Invalid ZIP directory');
      const entries = tail.readUInt16LE(end + 10), directorySize = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16);
      if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6) || tail.readUInt16LE(end + 8) !== entries || offset + directorySize !== tailOffset + end) throw new Error('Invalid ZIP directory');
      if (entries ? directorySize < 46 || !(await read(offset, 4)).equals(Buffer.from([0x50,0x4b,0x01,0x02])) : directorySize !== 0) throw new Error('Invalid ZIP directory');
    } else {
      const header = await read(0, 26), channels = header.readUInt16BE(12), height = header.readUInt32BE(14), width = header.readUInt32BE(18), depth = header.readUInt16BE(22);
      if (header.toString('ascii', 0, 4) !== '8BPS' || header.readUInt16BE(4) !== 1 || !header.subarray(6, 12).equals(Buffer.alloc(6)) || channels < 1 || channels > 56 || !width || !height || width > 30000 || height > 30000 || width * height > 100_000_000 || ![1,8,16,32].includes(depth)) throw new Error('Invalid PSD header');
      let offset = 26;
      for (let section = 0; section < 3; section++) { const length = (await read(offset, 4)).readUInt32BE(); offset += 4 + length; }
      const compression = (await read(offset, 2)).readUInt16BE(); offset += 2;
      if (compression === 0) { if (size - offset < Math.ceil(width * depth / 8) * height * channels) throw new Error('Truncated PSD image'); }
      else if (compression === 1) {
        const rows = channels * height, lengths = await read(offset, rows * 2); let total = 0;
        for (let row = 0; row < rows; row++) total += lengths.readUInt16BE(row * 2);
        if (offset + lengths.length + total > size) throw new Error('Truncated PSD image');
      } else if (![2,3].includes(compression) || size <= offset) throw new Error('Invalid PSD image');
    }
  } finally { await file.close(); }
}

/** 历史文件只按迁移保留的记录寻址，不扫描目录或解释旧任务执行输入。 */
export class DesktopHistoryResources {
  constructor(private readonly context: CommandContext) {}

  /** 即便资源由领域命令首次登记，也保留独立的历史引用，避免删除聚合时误回收。 */
  owners(ref: ResourceRef): string[] {
    const { repository, history } = this.context;
    if (ref.kind === 'ASSET') {
      const asset = repository.getAsset(ref.id);
      return asset && history.getPreservedProjectHistory(asset.projectId) ? [`history:project:${asset.projectId}`] : [];
    }
    if (ref.kind === 'EXPORT' || ref.kind === 'LAYER_PSD') {
      const record = history.getPreservedJobHistory(ref.id);
      if (record && record.kind === (ref.kind === 'EXPORT' ? 'EXPORT' : 'LAYER')) return [`history:job:${ref.id}`, `job:${ref.id}`];
    }
    return [];
  }

  /** 未登记的旧图片/ZIP/PSD按需进入同一资源表；首次归档校验和一旦发布就不能变化。 */
  async prepare(ref: ResourceRef): Promise<void> {
    const { repository, history, storage, resources, signal } = this.context;
    let relativePath: string | undefined, mimeType: string | undefined, hash: string | undefined;
    let owners = this.owners(ref);
    if (!owners.length) return;
    if (ref.kind === 'ASSET') {
      const asset = repository.getAsset(ref.id)!;
      relativePath = asset.storagePath; mimeType = asset.mimeType; hash = asset.hash;
      owners.push(`project:${asset.projectId}`);
      if (!shaPattern.test(hash)) throw new BackendError('RESOURCE_UNAVAILABLE', '历史图片校验信息不可用。');
    } else {
      const record = history.getPreservedJobHistory(ref.id)!;
      if (!record.artifactPath) return;
      relativePath = record.artifactPath;
      mimeType = ref.kind === 'EXPORT' ? 'application/zip' : 'image/vnd.adobe.photoshop';
      const job = repository.getJob(ref.id);
      if (job?.projectId) owners.push(`project:${job.projectId}`);
      // 发布桌面未保存归档hash；只在首次实际读取时固定现存字节，不冒称有原始hash。
      const digest = createHash('sha256'); let size = 0;
      try {
        for await (const chunk of storage.stream(relativePath, { signal })) {
          const bytes = Buffer.from(chunk); size += bytes.length;
          if (size > 2 * 1024 * 1024 * 1024) throw new Error('Historical artifact too large');
          digest.update(bytes);
        }
        await verifyContainer(storage.absolute(relativePath), ref.kind, size, signal);
        hash = digest.digest('hex');
      } catch { throw new BackendError('RESOURCE_UNAVAILABLE', '历史文件不可用。'); }
    }
    signal.throwIfAborted();
    this.context.transaction(() => resources.register({ ref, relativePath: relativePath!, mimeType: mimeType!, hash: hash!, owners }));
  }

  /** 白名单结果投影与文件可用性彼此独立；损坏文件不能抹掉可读历史。 */
  async project(job: JobRecord): Promise<DesktopHistory | undefined> {
    if (!job.preservedHistory) return undefined;
    const record = this.context.history.getPreservedJobHistory(job.id);
    if (!record) throw new BackendError('INVALID_HISTORY', '历史任务记录不可用。');
    let result: DesktopHistoryResult | null = null;
    let resultStatus: DesktopHistory['resultStatus'] = record.resultJson === null ? 'NONE' : 'UNAVAILABLE';
    if (record.resultJson !== null) {
      try {
        if (record.resultJson.length > 2 * 1024 * 1024) throw new Error('Historical result too large');
        const original: unknown = JSON.parse(record.resultJson);
        if (!original || typeof original !== 'object' || Array.isArray(original)) throw new Error('Invalid result');
        const value = original as Record<string, unknown>;
        const projected = { assetIds: value.assetIds, ...(value.storyboardId === undefined ? {} : { storyboardId: value.storyboardId }),
          ...(value.text === undefined ? {} : { text: value.text }), ...(value.tileability === undefined ? {} : { tileability: value.tileability }) };
        if (!Value.Check(DesktopHistoryResultSchema, projected)) throw new Error('Invalid result');
        if (projected.text !== undefined) {
          const suite: unknown = JSON.parse(projected.text);
          if (!Value.Check(EcomSuiteFile, suite)) throw new Error('Invalid suite result');
          assertPublicOutput(suite);
        }
        assertPublicOutput(projected);
        // 文件归属按真实Asset记录验证，不能让旧JSON引用其它项目的素材。
        if (projected.assetIds.some(id => {
          const asset = this.context.repository.getAsset(id);
          return asset && asset.projectId !== job.projectId;
        })) throw new Error('Foreign historical asset');
        if (projected.storyboardId !== undefined && !this.context.history.listStoryboardVersions(job.projectId!).some(board => board.id === projected.storyboardId)) throw new Error('Missing storyboard');
        result = projected; resultStatus = 'AVAILABLE';
      } catch { /* 保留原JSON，只将公开结果标为不可用。 */ }
    }
    const files: DesktopHistory['files'] = [];
    for (const assetId of result?.assetIds ?? []) {
      const asset = this.context.repository.getAsset(assetId);
      files.push(await this.file({ kind: 'ASSET', id: assetId }, asset?.mimeType ?? 'application/octet-stream', asset?.originalName, `job:${job.id}`));
    }
    if (record.artifactPath) {
      const ref: ResourceRef = { kind: record.kind === 'LAYER' ? 'LAYER_PSD' : 'EXPORT', id: job.id };
      files.push(await this.file(ref, record.kind === 'LAYER' ? 'image/vnd.adobe.photoshop' : 'application/zip', record.resultName));
    }
    return { sourceVersion: record.sourceVersion as 1 | 2, kind: record.kind as DesktopHistory['kind'],
      originalStatus: record.originalStatus as DesktopHistory['originalStatus'], requestState: record.requestState as DesktopHistory['requestState'],
      executable: false, resultStatus, result, files };
  }

  private async file(ref: ResourceRef, mimeType: string, name?: string | null, owner?: string): Promise<DesktopHistory['files'][number]> {
    let available = false;
    if (idPattern.test(ref.id)) {
      try {
        const resolved = await this.context.resources.resolve(ref); mimeType = resolved.mimeType;
        if (owner) this.context.transaction(() => this.context.resources.retain(ref, owner));
        available = true;
      } catch { /* 不返回内部文件路径或校验细节；getResource仍提供安全错误码。 */ }
    }
    // 显示文件名不接受路径。无效原名仍原样保存在只读历史表。
    const safeName = name && name.length <= 240 && !/[\\/:\x00-\x1f]/.test(name) ? name : undefined;
    return { ref, mimeType, ...(safeName ? { name: safeName } : {}), available };
  }
}
