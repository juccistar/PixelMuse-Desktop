import archiver from "archiver";
import type { JobRecord, OutputRecord, ProjectRecord } from "@ecomgen/core";
import { outputImagePlanning, outputProvenance } from './snapshot.js';
import type { LongImageExportConfig } from './long-image.js';
import type { WorkerContext } from "./context.js";
import { safeName } from "./context.js";
import { LONG_IMAGE_DIVIDER_COLOR, LONG_IMAGE_DIVIDER_HEIGHT, LONG_IMAGE_ENCODING_QUALITY, orderLongImageScreens, renderLongImage, type LongImageRender } from "./long-image.js";

export async function executeExport(ctx: WorkerContext, job: JobRecord): Promise<void> {
  const { repository, storage, events, updateJob, throwIfCancelled, projectFor } = ctx;
  throwIfCancelled(job);
  if (repository.getExportByJobId(job.id)?.status === "SUCCEEDED") return;
  const project = projectFor(job); const outputIds = Array.isArray(job.input.outputIds) ? job.input.outputIds.filter((value): value is string => typeof value === "string") : undefined;
  const available = repository.listOutputs(project.id);
  const outputs = outputIds ? outputIds.map(id => available.find(output => output.id === id)).filter((output): output is OutputRecord => Boolean(output)) : available;
  if (outputs.length === 0 || (outputIds && outputs.length !== outputIds.length)) throw new Error('No outputs are available for export or a selected output is missing');
  const exportRecord = repository.getExportByJobId(job.id); await updateJob(job, { progress: 25 });
  // 长图在 ZIP 打包前合成：失败直接让任务 FAILED，不产出半成品导出记录。
  const longImageConfig = readLongImageConfig(job.input.longImage);
  const longImage = longImageConfig
    ? await renderLongImage({
      // 拼接顺序：请求 outputIds 的数组顺序（用户在导出弹窗可调整）优先；
      // 全量导出回退分镜 sort_order（此时才需要查询分镜列表），listOutputs 的 created_at DESC 只是逐张打包的展示序。
      screens: orderLongImageScreens(
        outputs,
        outputIds ? undefined : new Map(repository.listStoryboardItems(project.id).map((item, index) => [item.id, index] as const)),
        outputIds,
      ).map((output) => ({ outputId: output.id, absolutePath: storage.absolute(output.storagePath) })),
      config: longImageConfig,
      nameStem: safeName(project.name),
    })
    : null;
  if (longImage) await updateJob(job, { progress: 50 });
  // manifest 让导出包可追溯到事实、模板、Prompt、审核结果和输出内容 hash；
  // 长图段只引用 outputId 与几何，来源信息由 storyboard 段按 outputId 关联，不重复。
  const manifest = { version: 1, generatedAt: new Date().toISOString(), project: { id: project.id, name: project.name, platforms: project.platformTargets, category: project.category, imageResolution: project.imageResolution, imageAspectRatio: project.imageAspectRatio }, facts: { verified: project.verifiedFacts, prohibited: project.prohibitedClaims, brandGuidelines: project.brandGuidelines }, storyboard: outputs.map(outputManifest), ...(longImage ? { longImage: longImageManifest(longImage) } : {}) };
  // 流式导出：图片从磁盘直接进 archiver 管道，内存峰值从"全部图片 + 整个 ZIP"降为常数级；
  // zlib level 1——产物是已压缩的 PNG/JPEG，level 9 几乎无压缩收益，纯耗 CPU。长图产物同样先落盘再入 ZIP。
  try {
    const stored = await storage.putExportStream(project.id, async (destination) => {
      const zip = archiver("zip", { zlib: { level: 1 } });
      const settled = new Promise<void>((resolve, reject) => {
        destination.once("close", () => resolve());
        destination.once("error", reject);
        zip.once("error", reject);
      });
      zip.pipe(destination);
      outputs.forEach((output, index) => zip.file(storage.absolute(output.storagePath), { name: exportFileName(ctx, project, output, index) }));
      if (longImage) for (const file of longImage.files) zip.file(file.path, { name: `long-image/${file.name}` });
      zip.append(Buffer.from(JSON.stringify(manifest, null, 2), "utf8"), { name: "manifest.json" });
      await zip.finalize();
      await settled;
    });
    const target = exportRecord ?? repository.createExport({ projectId: project.id, jobId: job.id, status: "QUEUED", storagePath: null }); const updated = repository.updateExport(target.id, { status: "SUCCEEDED", storagePath: stored.path }); await events.publish(project.id, "export.updated", { export: updated });
  } finally {
    await longImage?.cleanup();
  }
}

function outputManifest(output: OutputRecord) {
  const evidence = outputProvenance(output.generationSnapshot);
  // 显式列出可导出的参数，不能把私有快照或后续新增的 Provider 字段整包带出。
  const fields = ['providerId', 'modelId', 'resolution', 'aspectRatio', 'size', 'candidateIndex', 'quality', 'outputFormat', 'inputFidelity', 'revision', 'operation', 'executionMode', 'targetDescription', 'targetConfidence', 'sourceOutputId', 'maskHash', 'protectMaskHash', 'compositePolicy', 'referenceSelections', 'referenceHashes'];
  const snapshot = output.generationSnapshot as Record<string, unknown> | null;
  return {
    outputId: output.id, jobId: output.jobId,
    imagePlanning: outputImagePlanning(output.generationSnapshot) ?? null,
    assetType: evidence?.storyboard?.assetType ?? null, displayName: evidence?.storyboard?.displayName ?? null,
    templateVariant: evidence?.storyboard?.templateVariant ?? null, mode: evidence?.storyboard?.mode ?? null,
    candidateIndex: output.candidateIndex,
    generationSnapshot: snapshot ? Object.fromEntries(fields.filter(key => snapshot[key] !== undefined).map(key => [key, snapshot[key]])) : null,
    prompt: evidence?.finalPrompt ?? null,
    provenance: evidence ? { status: 'AVAILABLE', ...evidence } : { status: 'UNAVAILABLE', reason: 'OUTPUT_EVIDENCE_MISSING' },
    sha256: output.hash,
  };
}

function longImageManifest(render: LongImageRender) {
  const { config, layout, slices, files } = render;
  return {
    targetWidth: config.targetWidth,
    dividerColor: LONG_IMAGE_DIVIDER_COLOR,
    dividerHeight: LONG_IMAGE_DIVIDER_HEIGHT,
    format: "jpeg",
    quality: LONG_IMAGE_ENCODING_QUALITY,
    resampleKernel: "lanczos3",
    totalHeight: layout.totalHeight,
    screens: layout.screens,
    // files[0] 是整图，切片文件按顺序跟在后面；名字从产物侧派生，避免双份维护
    slices: slices.map((slice, index) => ({ name: files[index + 1]!.name, ...slice })),
  };
}

/** job.input 由 API 校验后写入，这里只做窄化兜底（对齐 print-pack 读取版式快照的口径）。 */
function readLongImageConfig(value: unknown): LongImageExportConfig | null {
  if (!value || typeof value !== "object" || typeof (value as LongImageExportConfig).targetWidth !== "number") return null;
  return value as LongImageExportConfig;
}

function exportFileName(ctx: WorkerContext, project: ProjectRecord, output: OutputRecord, index: number): string {
  const planning = outputImagePlanning(output.generationSnapshot);
  const evidence = outputProvenance(output.generationSnapshot);
  const extension = output.storagePath.slice(output.storagePath.lastIndexOf('.'));
  const attribution = planning ? `_${planning.purpose}_${String(planning.ordinal).padStart(2, '0')}${planning.skus.length ? `_${safeName(planning.skus.map(sku => sku.code || sku.name).join('+'))}` : ''}` : '';
  const assetType = evidence?.storyboard?.assetType ?? ctx.repository.getStoryboardItem(output.storyboardItemId)?.assetType ?? 'image';
  return `${safeName(project.name)}_${String(index + 1).padStart(2, '0')}${attribution}_${safeName(assetType)}${extension}`;
}
