import archiver from 'archiver';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import type { Asset, Project } from '@ecomgen/contracts';
import { managedDirectory, managedPath } from './storage.js';
import { BackendError } from './validation.js';

/** 内部素材记录中的 file 是相对托管路径，不进入公开契约或 manifest。 */
export interface StoredAsset extends Asset { file: string; sha256: string }
/** 任务创建时冻结素材与项目元数据，重试不能读取当前项目替代快照。 */
export interface ExportSnapshot { version: 1; project: Project; assets: StoredAsset[] }

/** 固定任务 ID 决定输出路径，取消和恢复可重复清理。 */
export async function cleanupExport(root: string, id: string): Promise<void> {
  const directory = await managedDirectory(root, 'exports');
  await Promise.all([rm(join(directory, `${id}.zip.partial`), { force: true }), rm(join(directory, `${id}.zip`), { force: true })]);
}

/** 先写临时 ZIP 再发布；逐文件核验快照哈希，取消时销毁归档与文件流。 */
export async function writeExport(root: string, id: string, snapshot: ExportSnapshot, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const directory = await managedDirectory(root, 'exports');
  const partial = join(directory, `${id}.zip.partial`);
  const destination = join(directory, `${id}.zip`);
  await cleanupExport(root, id);
  signal.throwIfAborted();
  const archive = archiver('zip', { zlib: { level: 6 } });
  const output = createWriteStream(partial, { flags: 'wx', mode: 0o600 });
  const streams: Readable[] = [];
  const abort = () => {
    archive.abort();
    archive.destroy(new BackendError('CANCELLED', '任务已取消。'));
    for (const stream of streams) stream.destroy();
    output.destroy();
  };
  signal.addEventListener('abort', abort, { once: true });
  // warning 也代表缺失产物，不可导出一个表面成功但素材不完整的 ZIP。
  archive.on('warning', error => archive.destroy(error));
  const writing = pipeline(archive, output, { signal });
  // 提前挂接拒绝处理，组装文件期间取消时也不会产生 unhandled rejection。
  void writing.catch(() => undefined);
  try {
    const manifestAssets = [];
    for (const asset of snapshot.assets) {
      signal.throwIfAborted();
      const path = await managedPath(root, asset.file);
      const archivePath = `assets/${asset.id}.${asset.file.split('.').pop()!}`;
      const source = Readable.from((async function* () {
        const hash = createHash('sha256');
        let size = 0;
        // 按归档消费顺序打开文件，避免大项目同时耗尽文件句柄。
        for await (const chunk of createReadStream(path, { signal })) {
          const bytes = chunk as Buffer;
          size += bytes.length;
          hash.update(bytes);
          yield bytes;
        }
        if (size !== asset.size || hash.digest('hex') !== asset.sha256) {
          throw new BackendError('ASSET_CHANGED', '素材内容已变化，请重新导入。');
        }
      })());
      source.on('error', error => archive.destroy(error));
      streams.push(source);
      archive.append(source, { name: archivePath, date: new Date(asset.createdAt) });
      const { file: _file, ...publicAsset } = asset;
      manifestAssets.push({ ...publicAsset, archivePath });
    }
    archive.append(JSON.stringify({ version: 1, project: snapshot.project, assets: manifestAssets }, null, 2), { name: 'manifest.json' });
    await Promise.all([archive.finalize(), writing]);
    signal.throwIfAborted();
    await rename(partial, destination);
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener('abort', abort);
    archive.abort();
    for (const stream of streams) stream.destroy();
    output.destroy();
    // 等待文件流关闭后才删除，兼容 Windows 的打开文件限制。
    await writing.catch(() => undefined);
    await rm(partial, { force: true });
    if (signal.aborted) await rm(destination, { force: true });
  }
}
