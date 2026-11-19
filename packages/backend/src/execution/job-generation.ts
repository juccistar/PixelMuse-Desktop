import { createHash } from 'node:crypto';
import type { JobRecord } from "@ecomgen/core";
import type { OutputGenerationSnapshot } from './snapshot.js';
import { resolveOpenAiImageSize, supportsOpenAiImageOutputFormat, supportsOpenAiImageQuality } from "@ecomgen/domain";
import type { ImageAspectRatio, ImageResolution } from "@ecomgen/domain";
import { generationSource, assertVisualGenerationReferences } from './generation-source.js';
import { highInputFidelityForOpenAiImageModel } from "@ecomgen/providers";
import { assertPixelProtectedInputs, selectGenerationAssets, withGenerationAssetRoles, assignImageHandles } from "./visual-assets.js";
import { extensionForMime, generationKeyFor, outputDerivatives } from "./context.js";
import { openAiImageRequestParams, normalizeOutputFormat, outputFormatFromSnapshot, qualityFromSnapshot, resolutionFromSnapshot } from "./image-params.js";
import type { WorkerContext } from "./context.js";

export async function executeGeneration(ctx: WorkerContext, job: JobRecord, signal: AbortSignal): Promise<void> {
  const { repository, storage, suiteCatalog, events, updateJob, throwIfCancelled, projectFor, providerFor, imageGeneratorFor, compiledUserTemplates, reviseGenerationPrompt } = ctx;
  throwIfCancelled(job);
  if (!job.storyboardItemId) throw new Error("Generation job has no storyboard item");
  const project = projectFor(job); const item = repository.getStoryboardItem(job.storyboardItemId); if (!item || item.projectId !== project.id) throw new Error("Storyboard item is missing or belongs to another project");
  const providerId = job.providerId ?? item.imageProviderId;
  const modelId = job.modelId ?? item.imageModelId;
  if (!providerId || !modelId) throw new Error("该项目尚未选择生图模型（Provider 可能已被删除），请在项目设置中重新选择");
  const provider = providerFor(providerId); const model = provider.models.find((candidate) => candidate.id === modelId); if (!model) throw new Error("Configured image model no longer exists in its provider"); if (model.imageApiKind !== "openai_images" && model.imageApiKind !== "gemini") throw new Error("Selected image model has no executable image API");
  const storyboard = repository.getStoryboard(project.id); if (!storyboard) throw new Error("Storyboard is missing");
  const source = generationSource(item, compiledUserTemplates, id => suiteCatalog.resolveShot(id));
  const fallbackDefaultSize = source.defaultSize;
  const projectAssets = repository.listAssets(project.id);
  const inputs = selectGenerationAssets(projectAssets, item);
  const generationInputs = source.supportsImageReference ? inputs : [];
  const handles = assignImageHandles(projectAssets);
  assertVisualGenerationReferences(item, projectAssets, generationInputs, handles);
  if (item.mode === "PIXEL_PROTECTED") assertPixelProtectedInputs(generationInputs);
  const revision = typeof job.input.revision === "string" ? job.input.revision.trim() : "";
  const isRetry = revision === "retry";
  const generationBatchId = typeof job.input.generationBatchId === "string" ? job.input.generationBatchId : job.id;
  const candidateIndex = typeof job.input.candidateIndex === "number" ? job.input.candidateIndex : 1;
  const resolution = resolutionFromSnapshot(typeof job.input.imageResolution === "string" ? job.input.imageResolution : item.imageResolution);
  const aspectRatio = (typeof job.input.imageAspectRatio === "string" ? job.input.imageAspectRatio : item.imageAspectRatio) as ImageAspectRatio;
  // 套图分镜自带期望比例：仅当项目/分镜未指定（AUTO）时采用，避免覆盖用户的显式选择。
  const effectiveAspectRatio = aspectRatio === "AUTO" && source.aspectRatio ? source.aspectRatio : aspectRatio;
  const quality = qualityFromSnapshot(job.input.quality);
  const outputFormat = outputFormatFromSnapshot(job.input.outputFormat);
  const size = resolveOpenAiImageSize(model.id, resolution, effectiveAspectRatio, fallbackDefaultSize);
  // 快照只记录实际下发值：参数进入请求体前先按模型能力门控，请求与溯源引用同一份结果。
  const openAiQuality = supportsOpenAiImageQuality(model.id) ? quality ?? "high" : undefined;
  const openAiOutputFormat = supportsOpenAiImageOutputFormat(model.id) ? outputFormat : undefined;
  const basePrompt = item.promptInstruction.trim();
  if (!basePrompt) throw new Error("Storyboard item has no final image prompt; re-plan the storyboard before generating");
  if (/upstream template|template fields|anti-ai guidance|category guidance|promptcontract/i.test(basePrompt)) {
    throw new Error("This storyboard contains an old internal template prompt; re-plan the storyboard before generating");
  }
  const generationKey = generationKeyFor(job.id, candidateIndex);
  const existingOutput = repository.getOutputByGenerationKey(generationKey);
  if (existingOutput) {
    repository.updateStoryboardItem(item.id, { status: "GENERATED", ...(item.imagePlanning ? { planningStale: false } : {}) });

    await events.publish(project.id, "output.created", { output: existingOutput });
    return;
  }
  const sharedOwner = typeof job.input.sharedPromptOwnerId === 'string' ? job.input.sharedPromptOwnerId : undefined;
  let prompt = basePrompt;
  if (revision && !isRetry) {
    const prepared = sharedOwner ? repository.getGenerationPrompt(sharedOwner) : undefined;
    if (prepared) prompt = prepared.prompt;
    else {
      if (sharedOwner && sharedOwner !== job.id) throw new Error('Shared generation prompt has not been prepared by its owner');
      prompt = await reviseGenerationPrompt(project, basePrompt, revision);
      if (sharedOwner) repository.saveGenerationPrompt({ ownerJobId: sharedOwner, prompt });
    }
  }
  if (item.planningSource) assertVisualGenerationReferences({ ...item, promptInstruction: prompt }, projectAssets, generationInputs, handles);
  const compiledPrompt = withGenerationAssetRoles(prompt, generationInputs, handles);
  repository.updateStoryboardItem(item.id, { status: 'GENERATING', compiledPrompt }); await updateJob(job, { progress: 30 });
  const images = await Promise.all(generationInputs.map(async (asset) => ({ data: await storage.read(asset.storagePath), filename: asset.originalName, mimeType: asset.mimeType })));
  const generator = imageGeneratorFor(provider, model);

  const inputFidelity = model.imageApiKind === "openai_images" && generationInputs.some((asset) => asset.role === "PRODUCT_TRUTH")
    ? highInputFidelityForOpenAiImageModel(model.id)
    : undefined;
  // 使用同一批请求字节计算 hash，而非当前素材记录或后续分镜的引用。
  const generationSnapshot: OutputGenerationSnapshot = {
    providerId, modelId, resolution, aspectRatio: effectiveAspectRatio, size, candidateIndex,
    ...(item.imagePlanning ? { imagePlanning: structuredClone(item.imagePlanning) } : {}),
    ...(item.planningSource ? { planningSource: structuredClone(item.planningSource) } : {}),
    ...(openAiQuality ? { quality: openAiQuality } : {}),
    ...(openAiOutputFormat ? { outputFormat: openAiOutputFormat } : {}),
    ...(inputFidelity ? { inputFidelity } : {}),
    ...(revision ? { revision } : {}),
    provenance: {
      version: 1, finalPrompt: compiledPrompt,
      attachments: images.map((image, index) => ({
        source: 'PROJECT_ASSET', id: generationInputs[index]!.id, role: generationInputs[index]!.role,
        handle: handles.get(generationInputs[index]!.id), filename: image.filename, mimeType: image.mimeType,
        sha256: createHash('sha256').update(image.data).digest('hex'),
      })),
      storyboard: { assetType: item.assetType, displayName: item.displayName, templateVariant: item.templateVariant, mode: item.mode },
    },
  };
  const result = await generator.generate(model.imageApiKind === "gemini"
    ? { model: model.id, prompt: compiledPrompt, imageAspectRatio: effectiveAspectRatio, imageResolution: resolution, images: images.length ? images : undefined, idempotencyKey: generationKey, signal }
    : { model: model.id, prompt: compiledPrompt, ...openAiImageRequestParams(model.id, resolution, effectiveAspectRatio, fallbackDefaultSize, { quality: openAiQuality, outputFormat: openAiOutputFormat }), images: images.length ? images : undefined, inputFidelity, idempotencyKey: generationKey, signal });
  throwIfCancelled(job);
  await updateJob(job, { progress: 80 });
  // 渠道没兑现 output_format 时本地转码兜底，保证落盘格式与用户选择一致。
  const normalized = await normalizeOutputFormat(result.image, openAiOutputFormat, result.mimeType);
  const stored = await storage.putOutput(project.id, normalized.image, extensionForMime(normalized.mimeType), generationKey);
  throwIfCancelled(job);
  const { width, height } = await outputDerivatives(storage, stored.hash, normalized.image);
  const output = repository.createOutput({
    projectId: project.id,
    storyboardItemId: item.id,
    jobId: job.id,
    candidateIndex,
    generationSnapshot,
    storagePath: stored.path,
    hash: stored.hash,
    width,
    height,
    generationKey,
    generationBatchId,
  });

  repository.updateStoryboardItem(item.id, { status: "GENERATED", ...(item.imagePlanning ? { planningStale: false } : {}) }); await events.publish(project.id, "output.created", { output });
}
