import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { AssetRecord, EcomRepository, JobRecord, LocalAssetStore, ProjectRecord, ProviderRecord } from '@ecomgen/core';
import type { ResourceRef } from '@ecomgen/contracts';
import type { ModelDefinition, SegmentationProtocol } from '@ecomgen/domain';
import { buildReasoningModel, bindExternalRequests, GeminiImageProvider, OpenAiCompatibleImageProvider, createSegmentationProvider, SeedreamLayerizeProvider } from '@ecomgen/providers';
import { reviseImagePrompt, type AgentRunOptions, type WebResearchConfig } from '@ecomgen/agent';
import { compileUserTemplate, type EcomTemplate } from '@ecomgen/ecom-skill';
import type { ExecutionContext } from '../runtime/ports.js';
import { FROZEN_READS, readKey, type ExecutionInputs } from './snapshot.js';

/** 纯 Backend 执行上下文；所有发布操作通过当前运行代次的同步检查点。 */
export interface WorkerContext {
  readonly runtime: ExecutionContext;
  readonly repository: EcomRepository;
  readonly suiteCatalog: { listSuites(): ExecutionInputs['suites']; getSuite(id: string): ExecutionInputs['suites'][number] | undefined; resolveShot(type: string): { suite: ExecutionInputs['suites'][number]; shot: ExecutionInputs['suites'][number]['shots'][number] } | undefined };
  readonly storage: LocalAssetStore;
  readonly secrets: ExecutionContext['secrets'];
  readonly events: { publish(projectId: string, topic: string, detail?: unknown): Promise<void> };
  readonly updateJob: (job: JobRecord, patch: Parameters<EcomRepository['updateJob']>[1]) => Promise<void>;
  readonly throwIfCancelled: (job: JobRecord) => void;
  readonly projectFor: (job: JobRecord) => ProjectRecord;
  readonly providerFor: (id: string | null) => ProviderRecord;
  readonly imageModelForJob: (job: JobRecord) => { provider: ProviderRecord; model: ModelDefinition };
  readonly imageGeneratorFor: (provider: ProviderRecord, model: { id: string; imageApiKind: string | null }) => GeminiImageProvider | OpenAiCompatibleImageProvider;
  readonly segmentationFor: (protocol: SegmentationProtocol, provider: ProviderRecord, key: string, modelId?: string) => ReturnType<typeof createSegmentationProvider>;
  readonly layerizerFor: (provider: ProviderRecord, modelId: string, key: string) => SeedreamLayerizeProvider;
  readonly agentOptions: (key: string, providerId?: string, modelId?: string) => AgentRunOptions;
  readonly commitCandidate: (key: string) => void;
  readonly cachedCompressForVision: (buffer: Buffer, hash?: string) => Promise<{ data: Buffer; mimeType: string }>;
  readonly visionImageContents: (assets: AssetRecord[]) => Promise<Array<{ type: 'image'; mimeType: string; data: string }>>;
  readonly visionSourceImage: (path: string) => Promise<{ type: 'image'; mimeType: string; data: string }>;
  readonly compiledUserTemplates: () => EcomTemplate[];
  readonly configuredWebResearch: () => WebResearchConfig | undefined;
  readonly reviseGenerationPrompt: (project: ProjectRecord, prompt: string, revision: string) => Promise<string>;
}

export class JobCancelled extends Error {}
export function projectIdFor(job: JobRecord): string { if (!job.projectId) throw new Error('Task requires a project'); return job.projectId; }
export function generationKeyFor(jobId: string, candidateIndex: number): string { return `ecomgen:generation:${jobId}:candidate:${candidateIndex}`; }
/** 不依赖已完成数量，候选身份由任务和稳定序号决定。 */
export function candidateIdFor(jobId: string, index: number): string { const hex=createHash('sha256').update(generationKeyFor(jobId,index)).digest('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`; }
export function extensionForMime(mime: string): string { return mime.includes('webp') ? '.webp' : mime.includes('jpeg') ? '.jpg' : '.png'; }
export function mimeForStoragePath(path: string): string { const ext = path.toLowerCase().split('.').pop(); return ({jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',avif:'image/avif',tif:'image/tiff',tiff:'image/tiff',psd:'image/vnd.adobe.photoshop',json:'application/json',zip:'application/zip'} as Record<string,string>)[ext ?? ''] ?? 'image/png'; }
export function safeName(value: string): string { return value.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 80) || 'ecomgen'; }

/** 从调度器端口组装真实上下文，不读取环境变量、旧数据库或全局单例。 */
export function createExecutionContext(runtime: ExecutionContext): WorkerContext {
  const inputs = runtime.snapshot.effective.execution as unknown as ExecutionInputs;
  if (!inputs || inputs.version !== 1) throw new Error('Execution snapshot is missing');
  const raw = runtime.repository;
  const written = new Map<string, unknown>();
  const storedFiles = new Map<string, string>();
  const throwIfCancelled = () => {
    runtime.assertCurrent();
    if (runtime.signal.aborted || raw.getJob(runtime.job.id)?.cancelRequested) throw new JobCancelled('Task cancelled');
    if (inputs.pipeline) {
      const step = raw.getPatternPipelineStepByJobId(runtime.job.id);
      if (!step || step.id !== inputs.pipeline.stepId || step.pipelineId !== inputs.pipeline.id || step.jobId !== inputs.pipeline.jobId) throw new Error('STALE_PIPELINE_GENERATION');
    }
    for (const frozen of inputs.slots ?? []) {
      const slot = raw.listDraftSlots(frozen.batchId).find(entry => entry.index === frozen.index);
      if (!slot || slot.jobId !== runtime.job.id || slot.attempt !== frozen.attempt || slot.status === 'UNKNOWN') throw new Error('STALE_SLOT_ATTEMPT');
    }
  };
  function register(ref: ResourceRef, path: string, hash: string | null | undefined, owner: string): void {
    if (!hash) throw new Error('Artifact hash is missing');
    runtime.resources.register({ ref, relativePath: path, hash, mimeType: mimeForStoragePath(path), owners: [owner, `job:${runtime.job.id}`] });
  }
  function publishRecord(method: string, row: any): void {
    if (!row) return;
    if (method === 'createOutput') register({ kind: 'OUTPUT', id: row.id }, row.storagePath, row.hash, `project:${row.projectId}`);
    if (method === 'createModelPortrait') register({ kind: 'PORTRAIT', id: row.id }, row.storagePath, row.hash, `model:${row.modelId}`);
    if ((method === 'createPattern' || method === 'setPatternArtifact') && row.storagePath) register({ kind: 'PATTERN', id: row.id }, row.storagePath, row.fileHash, `pattern:${row.id}`);
    if (method === 'createDraftCandidate') register({ kind: 'DRAFT_CANDIDATE', id: row.id }, row.storagePath, row.fileHash, `draft:${row.draftId}`);
    if (method === 'updateLayerExport' && row.psdStoragePath) {
      const file = row.layerFiles.find((entry: any) => entry.storagePath === row.psdStoragePath);
      register({ kind: 'LAYER_PSD', id: row.id }, row.psdStoragePath, file?.hash, `project:${row.projectId}`);
      row.layerFiles.forEach((entry: any, index: number) => register({ kind: 'LAYER_FILE', id: row.id, index }, entry.storagePath, entry.hash, `project:${row.projectId}`));
    }
    if (method === 'updatePrintPack' && row.status === 'SUCCEEDED') row.files.forEach((file: any, index: number) => register({ kind: 'PRINT_PACK_FILE', id: row.id, index }, file.storagePath, file.hash, `pattern:${row.patternId}`));
    if (method === 'updateExport' && row.storagePath) register({ kind: 'EXPORT', id: row.id }, row.storagePath, storedFiles.get(row.storagePath), `project:${row.projectId}`);
  }
  const repository = new Proxy(raw, { get(target, name) {
    const method = String(name), fn = Reflect.get(target, name, target);
    if (typeof fn !== 'function') return fn;
    if (method === 'transaction') return <T>(work: () => T): T => runtime.checkpoint(() => { throwIfCancelled(); return work(); });
    if (FROZEN_READS.has(method)) return (...args: unknown[]) => {
      const key = readKey(method, args);
      if (written.has(key)) return structuredClone(written.get(key));
      if (!(key in inputs.reads)) throw new Error(`FROZEN_INPUT_MISSING: ${method}`);
      return structuredClone(inputs.reads[key] ?? undefined);
    };
    if (/^(create|save|set|update|record|confirm|delete|claim|assign)/.test(method)) return (...args: unknown[]) => runtime.checkpoint(() => {
      throwIfCancelled();
      const row = fn.apply(target, args);
      if (row && typeof row.then === 'function') throw new Error('Async repository transaction is forbidden');
      publishRecord(method, row);
      const getter = ({updateEditTurn:'getEditTurn',updateEditSession:'getEditSession',updateLayerPlan:'getLayerPlan',setPatternArtifact:'getPattern',setPatternTileable:'getPattern',setDraftCandidateTileable:'getDraftCandidate'} as Record<string,string>)[method];
      if (getter && row) written.set(readKey(getter, [row.id]), row);
      return row;
    });
    return fn.bind(target);
  } });
  const optionPositions: Record<string,number> = {putOutput:4,putExportStream:2,putEditArtifact:5,putLayerArtifact:5,putModelPortrait:4,putPatternArtifact:4,putPrintPackArtifact:4,putDraftCandidate:4,putDraftMedia:4,putThumbnail:2,read:1};
  const storage = new Proxy(runtime.storage, { get(target, name) {
    const fn = Reflect.get(target, name, target), method = String(name);
    if (typeof fn !== 'function') return fn;
    if (method === 'read' || method.startsWith('put')) return async (...args: any[]) => {
      throwIfCancelled();
      const index = optionPositions[method];
      if (index !== undefined) { while (args.length <= index) args.push(undefined); args[index] = { ...args[index], signal: runtime.signal }; }
      const result = await fn.apply(target, args);
      throwIfCancelled();
      if (result?.path) {
        let hash = result.hash;
        if (!hash) { const digest = createHash('sha256'); for await (const chunk of target.stream(result.path, { signal: runtime.signal })) digest.update(chunk); hash = digest.digest('hex'); }
        storedFiles.set(result.path, hash);
      }
      if (method === 'putThumbnail') runtime.checkpoint(() => register({kind:'THUMBNAIL',id:args[0]}, result, createHash('sha256').update(args[1]).digest('hex'), `thumbnail:${args[0]}`));
      return result;
    };
    return fn.bind(target);
  } });
  function providerFor(id: string | null): ProviderRecord { if (!id) throw new Error('No provider selected'); const provider = repository.getProvider(id); if (!provider) throw new Error('Frozen provider missing'); return provider; }
  const binding = (key: string, providerId?: string, modelId?: string) => bindExternalRequests(runtime.external, key, providerId && modelId ? {providerId,modelId} : undefined);
  function imageGeneratorFor(provider: ProviderRecord, model: {id:string;imageApiKind:string|null}) {
    // 一个适配器可生成多个候选；每次调用按请求的稳定幂等键重新绑定。
    const make = (request: {idempotencyKey?:string}, action: 'generate'|'editImage') => {
      const connection = {baseUrl:provider.baseUrl,apiKey:runtime.secrets.decrypt(provider.encryptedApiKey),external:binding(request.idempotencyKey ?? `${runtime.job.id}:${action}`,provider.id,model.id)};
      if (model.imageApiKind === 'gemini') return new GeminiImageProvider(connection);
      if (model.imageApiKind === 'openai_images') return new OpenAiCompatibleImageProvider(connection);
      throw new Error('Selected model has no image API');
    };
    return new Proxy({} as GeminiImageProvider | OpenAiCompatibleImageProvider, {get:(_target,method) => (request:any) => { throwIfCancelled(); const adapter=make(request,method as 'generate'|'editImage'); return (adapter[method as 'generate'] as Function).call(adapter,{...request,signal:runtime.signal}); }});
  }
  const cache = new Map<string, Promise<{data:Buffer;mimeType:string}>>();
  function cachedCompressForVision(buffer: Buffer, sourceHash?: string) {
    const key = sourceHash ?? createHash('sha256').update(buffer).digest('hex');
    let pending=cache.get(key);
    if (!pending) { pending=(async()=>{throwIfCancelled();const meta=await sharp(buffer).metadata();const pass=(meta.width??0)<=1024&&(meta.height??0)<=1024&&buffer.length<=512*1024&&['png','jpeg','webp'].includes(meta.format??'');return pass?{data:buffer,mimeType:`image/${meta.format}`}:{data:await sharp(buffer).rotate().resize(1024,1024,{fit:'inside',withoutEnlargement:true}).jpeg({quality:80}).toBuffer(),mimeType:'image/jpeg'};})();cache.set(key,pending); }
    return pending;
  }
  const visionSourceImage = async (path:string) => {const value=await cachedCompressForVision(await storage.read(path));return {type:'image' as const,mimeType:value.mimeType,data:value.data.toString('base64')};};
  const agentOptions = (key:string,providerId?:string,modelId?:string):AgentRunOptions => ({signal:runtime.signal,external:binding(key,providerId,modelId),...(inputs.ai ? {timeoutMs: inputs.ai.requestTimeoutSeconds * 1000, thinkingLevel: inputs.ai.thinkingLevel, maxOutputTokens: inputs.ai.maxOutputTokens} : {})});
  return {
    runtime,repository,storage,secrets:runtime.secrets,
    suiteCatalog:{listSuites:()=>structuredClone(inputs.suites),getSuite:id=>structuredClone(inputs.suites.find(suite=>suite.id===id)),resolveShot:type=>{for(const suite of inputs.suites){const shot=suite.shots.find(shot=>shot.assetType===type);if(shot)return structuredClone({suite,shot});}return undefined;}},
    events:{publish:async(projectId,topic)=>{throwIfCancelled();const kind=topic.split('.')[0]!;const topics:Record<string,string>={job:'jobs',output:'outputs',storyboard:'storyboards','edit-turn':'editSessions','edit-session':'editSessions','layer-plan':'outputs','layer-export':'outputs',export:'outputs'};const target=topics[kind];if(!target)throw new Error('Unknown execution event');runtime.events.publish({topic:target,projectId,aggregateId:runtime.job.id});}},
    updateJob:async(_job,patch)=>{throwIfCancelled();if(patch.progress!==undefined)runtime.progress(patch.progress,patch.progressDetail??undefined);},
    throwIfCancelled,providerFor,projectFor:job=>{const project=repository.getProject(projectIdFor(job));if(!project)throw new Error('Frozen project missing');return project;},
    imageModelForJob:job=>{const provider=providerFor(job.providerId);const model=provider.models.find(model=>model.id===job.modelId);if(!model||(model.imageApiKind!=='gemini'&&model.imageApiKind!=='openai_images'))throw new Error('Selected model has no image API');return {provider,model};},
    imageGeneratorFor,agentOptions,
    commitCandidate:key=>runtime.checkpoint(()=>{for(const request of runtime.requestLedger.summaries(runtime.job.id))if(request.requestKey.startsWith(`${key}:`)&&request.state==='COMPLETED')runtime.external.committed(request.requestKey);}),
    segmentationFor:(protocol,provider,key,modelId)=>{if(protocol==='seedream_layerize')throw new Error('Layerize requires the layerizer port');return createSegmentationProvider(protocol,{baseUrl:provider.baseUrl,apiKey:runtime.secrets.decrypt(provider.encryptedApiKey),external:binding(key,provider.id,modelId??inputs.intent.modelId??undefined)});},
    layerizerFor:(provider,modelId,key)=>new SeedreamLayerizeProvider({baseUrl:provider.baseUrl,apiKey:runtime.secrets.decrypt(provider.encryptedApiKey),external:binding(key,provider.id,modelId)},{modelId}),
    cachedCompressForVision,visionSourceImage,
    visionImageContents:assets=>Promise.all(assets.map(async asset=>{const value=await cachedCompressForVision(await storage.read(asset.storagePath),asset.hash);return {type:'image' as const,mimeType:value.mimeType,data:value.data.toString('base64')};})),
    compiledUserTemplates:()=>repository.listUserTemplates().map(record=>compileUserTemplate({id:record.id,name:record.name,prompt:record.prompt,defaultSize:record.defaultSize,supportsImageReference:record.supportsImageReference})),
    configuredWebResearch:()=>{const sources=repository.listSearchSources().filter(source=>source.enabled&&(source.kind==='searxng'||source.encryptedApiKey)).map(source=>({id:source.id,name:source.name,kind:source.kind,baseUrl:source.baseUrl,apiKey:source.encryptedApiKey?runtime.secrets.decrypt(source.encryptedApiKey):undefined}));return sources.length?{sources,maxResults:3,timeoutMs:8000}:undefined;},
    reviseGenerationPrompt:async(project,prompt,revision)=>{const provider=providerFor(project.reasoningProviderId);const model=provider.models.find(model=>model.id===project.reasoningModelId);if(!model)throw new Error('Reasoning model missing');return reviseImagePrompt({...agentOptions('prompt-revision',provider.id,model.id),model:buildReasoningModel({providerId:provider.id,modelId:model.id,baseUrl:provider.baseUrl,protocol:provider.reasoningProtocol,supportsVision:model.supportsVision,supportsThinking:model.supportsThinking,supportsStructuredOutput:model.supportsStructuredOutput}),apiKey:runtime.secrets.decrypt(provider.encryptedApiKey),prompt,revision});},
  };
}

/** 图像尺寸必须真实可解码；缩略图是可重建缓存，不能掩盖主产物损坏。 */
export async function outputDerivatives(storage: LocalAssetStore, hash: string, image: Buffer): Promise<{width:number;height:number}> {
  const meta=await sharp(image).metadata();if(!meta.width||!meta.height)throw new Error('Invalid image dimensions');
  if (!(await storage.hasThumbnail(hash))) {const thumbnail=await sharp(image).rotate().resize(512,512,{fit:'inside',withoutEnlargement:true}).webp({quality:78}).toBuffer();await storage.putThumbnail(hash,thumbnail);}
  return {width:meta.width,height:meta.height};
}
