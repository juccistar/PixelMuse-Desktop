import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { SqliteDatabase } from '@ecomgen/core';
import { collectionHostOperations, sanitizeCollectionPageUrl, type CollectionHostInput, type CollectionHostOperation, type CollectionHostOutput, type CollectionSource } from '@ecomgen/contracts';
import type { CommandContext } from '../runtime/ports.js';
import { BackendError, check } from '../validation.js';
import { readImage } from './support.js';
import { assertProjectAssetCapacity, ensureProject, renderThumbnail } from './helpers.js';

type Handlers = { [K in CollectionHostOperation]: (input: CollectionHostInput<K>) => Promise<CollectionHostOutput<K>> };
/** 在 Backend 再次清洗来源，防止宿主误传认证查询、片段或控制字符。 */
function safeSource(source: CollectionSource): CollectionSource {
  let pageUrl: string;
  try { pageUrl = sanitizeCollectionPageUrl(source.pageUrl); } catch { throw new BackendError('INVALID_INPUT', '来源页面地址无效。'); }
  return { platform: source.platform.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80) || '网页', pageUrl, title: source.title.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240), collectedAt: source.collectedAt };
}
/** 共用唯一 SQLite，资产、来源与资源登记在同一最终事务内发布。 */
export function createCollectedAssetHandlers(context: CommandContext, db: SqliteDatabase): Handlers {
  const active = new Map<string, AbortController>();
  const cancelled = new Map<string, number>();
  let previews = 0;
  const prune = () => { const now = Date.now(); for (const [id, expires] of cancelled) if (expires < now) cancelled.delete(id); };
  const handlers: Handlers = {
    'host.cancelCollectionImport': async input => {
      check(collectionHostOperations['host.cancelCollectionImport'].input, input);
      prune();
      // Keep tombstones for late delivery without retaining any image or authentication data.
      active.get(input.requestId)?.abort();
      if (cancelled.size >= 512) throw new BackendError('BUSY', '采集请求过多，请稍后重试。');
      cancelled.set(input.requestId, Date.now() + 120000);
      return null;
    },
    'host.previewCollectionImage': async input => {
      check(collectionHostOperations['host.previewCollectionImage'].input, input);
      if (previews >= 2) throw new BackendError('BUSY', '图片预览繁忙，请稍后重试。');
      previews++;
      try {
        const image = await readImage(input.file, context);
        const bytes = await sharp(image.buffer, { limitInputPixels: 100000000, failOn: 'warning' }).rotate().resize(720, 720, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 78 }).toBuffer();
        context.signal.throwIfAborted();
        const result = { dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}` };
        check(collectionHostOperations['host.previewCollectionImage'].output, result, true);
        return result;
      } catch (error) { if (error instanceof BackendError) throw error; throw new BackendError('INVALID_IMAGE', '图片预览失败或已取消。'); }
      finally { previews--; }
    },
    'host.importCollectedAsset': async input => {
      check(collectionHostOperations['host.importCollectedAsset'].input, input);
      prune();
      if (active.size >= 2 || active.has(input.requestId)) throw new BackendError('BUSY', '采集导入繁忙，请稍后重试。');
      if (cancelled.has(input.requestId)) throw new BackendError('CANCELLED', '采集导入已取消。');
      const controller = new AbortController(); active.set(input.requestId, controller);
      const signal = AbortSignal.any([context.signal, controller.signal]);
      const ctx = { ...context, signal };
      let staged: { path: string; hash: string } | undefined;
      let published = false;
      try {
        signal.throwIfAborted(); ensureProject(ctx.repository, input.projectId);
        const source = safeSource(input.source);
        const image = await readImage(input.file, ctx);
        const dimensions = await ctx.storage.inspectImage(image.buffer, signal);
        const duplicate = ctx.repository.listAssets(input.projectId).find(asset => asset.hash === image.hash);
        if (duplicate) return { assetId: duplicate.id, status: 'ALREADY_PRESENT' };
        assertProjectAssetCapacity(ctx.repository, input.projectId, 'STYLE_REFERENCE');
        const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/avif': 'avif', 'image/tiff': 'tiff' } as Record<string, string>)[image.mimetype];
        // Remote filenames and URL path components never become local paths.
        const name = `采集参考图.${ext}`;
        const thumbnail = await renderThumbnail(image.buffer);
        signal.throwIfAborted();
        await ctx.storage.putThumbnail(image.hash, thumbnail);
        ctx.transaction(() => ctx.resources.register({ ref: { kind: 'THUMBNAIL', id: image.hash }, relativePath: ctx.storage.thumbnailPath(image.hash), hash: createHash('sha256').update(thumbnail).digest('hex'), mimeType: 'image/webp', owners: [`thumbnail:${image.hash}`] }));
        signal.throwIfAborted();
        staged = await ctx.storage.putAsset(input.projectId, name, image.buffer, { signal });
        const result = ctx.transaction(() => {
          signal.throwIfAborted();
          ensureProject(ctx.repository, input.projectId);
          const existing = ctx.repository.listAssets(input.projectId).find(asset => asset.hash === image.hash);
          if (existing) return { assetId: existing.id, status: 'ALREADY_PRESENT' as const };
          assertProjectAssetCapacity(ctx.repository, input.projectId, 'STYLE_REFERENCE');
          const asset = ctx.repository.createAsset({ projectId: input.projectId, role: 'STYLE_REFERENCE', storagePath: staged!.path, hash: staged!.hash, originalName: name, mimeType: image.mimetype, byteSize: image.buffer.length, width: dimensions.width, height: dimensions.height });
          db.prepare('INSERT INTO desktop_asset_provenance(asset_id,platform,page_url,title,collected_at) VALUES(?,?,?,?,?)').run(asset.id, source.platform, source.pageUrl, source.title, source.collectedAt);
          ctx.resources.register({ ref: { kind: 'ASSET', id: asset.id }, relativePath: staged!.path, hash: staged!.hash, mimeType: image.mimetype, owners: [`project:${input.projectId}`] });
          return { assetId: asset.id, status: 'IMPORTED' as const };
        });
        published = result.status === 'IMPORTED';
        if (published) { ctx.events.publish({ topic: 'assets', projectId: input.projectId }); ctx.events.publish({ topic: 'projects', projectId: input.projectId }); }
        return result;
      } catch (error) {
        if (signal.aborted) throw new BackendError('CANCELLED', '采集导入已取消。');
        if (error instanceof BackendError) throw error;
        throw new BackendError('COLLECTION_IMPORT_FAILED', '采集导入失败，请重新查询项目素材。');
      } finally {
        active.delete(input.requestId);
        if (staged && !published) ctx.transaction(() => {
          const ref = { kind: 'SUITE_SOURCE' as const, id: `collection-stage-${ctx.idFactory()}` };
          ctx.resources.register({ ref, relativePath: staged!.path, hash: staged!.hash, mimeType: 'application/octet-stream', owners: [] });
          ctx.resources.scheduleCleanup(ref);
        });
      }
    },
    'host.collectionSources': async input => {
      check(collectionHostOperations['host.collectionSources'].input, input);
      ensureProject(context.repository, input.projectId);
      return { items: db.prepare(`SELECT p.asset_id AS assetId,p.platform,p.page_url AS pageUrl,p.title,p.collected_at AS collectedAt FROM desktop_asset_provenance p JOIN assets a ON a.id=p.asset_id WHERE a.project_id=? ORDER BY p.collected_at DESC,p.asset_id`).all(input.projectId) as CollectionHostOutput<'host.collectionSources'>['items'] };
    },
  };
  return handlers;
}
