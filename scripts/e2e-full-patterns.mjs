import { need, items, poll, sha256 } from './e2e-full-harness.mjs';

/** Consume the DTO's published immutable resource identity through the shared decoder. */
export async function modelFaceRef(model) {
  const { resourceRefFromUrl } = await import('../packages/contracts/dist/index.js');
  const ref = resourceRefFromUrl(need(model.referenceFaceUrl, 'Uploaded reference face has no published resource URL'));
  need(ref.kind === 'MODEL_FACE', 'Reference face URL does not identify a model face');
  return ref;
}

/** Keep a hole and soft alpha inside the crop, and restore the shared fixture even on failure. */
export async function withExtractionMask(c, run) {
  const originalMask = c.mock.images.mask, originalHash = sha256(originalMask);
  const source = await c.sharp(c.mock.images.image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = source.info;
  const bounds = { left: Math.floor(width / 4), top: Math.floor(height / 4), width: Math.ceil(width * 3 / 4) - Math.floor(width / 4), height: Math.ceil(height * 3 / 4) - Math.floor(height / 4) };
  need(bounds.width >= 8 && bounds.height >= 8, 'Extraction fixture needs room for a hole and soft alpha');
  const gray = Buffer.alloc(width * height);
  for (let y = bounds.top; y < bounds.top + bounds.height; y++) for (let x = bounds.left; x < bounds.left + bounds.width; x++) {
    const hole = x >= Math.floor(width * 7 / 16) && x < Math.ceil(width * 9 / 16) && y >= Math.floor(height * 7 / 16) && y < Math.ceil(height * 9 / 16);
    gray[y * width + x] = hole ? 0 : 255;
  }
  gray[(bounds.top + 1) * width + bounds.left + 1] = 128;
  const mask = await c.sharp(gray, { raw: { width, height, channels: 1 } }).png().toBuffer();
  try {
    c.mock.images.mask = mask;
    return await run({ source, gray, bounds, maskHash: sha256(mask), sourceHash: sha256(c.mock.images.image) });
  } finally {
    c.mock.images.mask = originalMask;
    c.check(c.mock.images.mask === originalMask, 'shared mask object is restored');
    c.equal(sha256(c.mock.images.mask), originalHash, 'shared mask bytes are restored');
  }
}

export async function verifyExtractionPixels(c, actual, fixture) {
  const { source, gray, bounds } = fixture;
  c.equal(actual.info.width, bounds.width, 'all transparent horizontal border is cropped');
  c.equal(actual.info.height, bounds.height, 'all transparent vertical border is cropped');
  let transparent = 0, soft = 0, opaque = 0;
  for (let y = 0; y < bounds.height; y++) for (let x = 0; x < bounds.width; x++) {
    const sourceIndex = (y + bounds.top) * source.info.width + x + bounds.left;
    const offset = (y * bounds.width + x) * 4;
    const alpha = Math.round(source.data[sourceIndex * 4 + 3] * gray[sourceIndex] / 255);
    c.equal(actual.data[offset + 3], alpha, 'cropped alpha is source alpha multiplied by the served mask');
    if (alpha > 0) c.equal(actual.data.subarray(offset, offset + 3), source.data.subarray(sourceIndex * 4, sourceIndex * 4 + 3), 'visible extraction RGB comes from the original source');
    if (alpha === 0) transparent++; else if (alpha === 255) opaque++; else soft++;
  }
  c.check(transparent > 0 && soft > 0 && opaque > 0, 'cropped result proves interior transparency, soft alpha and opaque source pixels');
  await c.evidence('extraction-pixels', { bounds, transparent, soft, opaque, sourceHash: fixture.sourceHash, maskHash: fixture.maskHash, outputHash: sha256(actual.bytes) });
}

const spec = { gender:'FEMALE',age:'LATE_20S',heritage:'EAST_ASIAN',stature:'STANDARD_165',build:'SLENDER',faceShape:'OVAL',eyeShape:'ALMOND',eyeColor:'DARK_BROWN',browShape:'STRAIGHT_SOFT',noseShape:'DELICATE',lipShape:'NATURAL',hairLength:'SHOULDER',hairstyle:'SOFT_WAVE',hairColor:'INK_BLACK',hairTexture:'NATURAL_VOLUME',hairline:'ROUNDED',complexion:'LIGHT_NEUTRAL',skinTexture:'NATURAL_PORES',facialHair:'NONE',distinctiveMarks:['DIMPLES'],expression:'SOFT_SMILE',gaze:'DIRECT_TO_CAMERA',aura:['WARM_APPROACHABLE'],makeup:'MINIMAL_DEWY',baseWardrobe:'WHITE_TANK',framing:'WAIST_UP',pose:'HANDS_RELAXED',backdrop:'SEAMLESS_GREY',lighting:'SOFTBOX_THREE_POINT',lens:'LENS_50' };
export const modelSpec = spec;
const providerId = c => need(c.state.provider,'Provider unavailable').id;
async function patternForJob(c, jobId) {
  const pattern = items(await c.invoke('listPatterns')).find(pattern => pattern.sourceJobId===jobId);
  need(pattern,'Completed pattern job has no persisted pattern');
  await c.imageRef({kind:'PATTERN',id:pattern.id});return pattern;
}
async function batch(c, draftId, input, expected='SUCCEEDED') {
  const response = await c.invoke(input.candidateId ? 'createDraftCandidateEdit' : 'createDraftBatch',{draftId,clientKey:`full-${input.operation}-${input.instruction??'default'}`,candidateCount:1,...input});
  need(response.job?.id,'Draft submission did not create a durable job');await c.waitJob(response.job.id,expected);
  const persisted=items(await c.invoke('listDraftBatches',{draftId})).find(item=>item.id===response.batch.id);
  need(persisted,'Draft batch missing after completion');c.equal(persisted.slots.length,response.batch.candidateCount);
  const candidates=items(await c.invoke('listDraftCandidates',{draftId})).filter(candidate=>candidate.batchId===persisted.id);
  if(expected==='SUCCEEDED') {
    c.equal(persisted.slots.map(slot=>slot.status),Array(persisted.candidateCount).fill('SUCCEEDED'));
    c.equal(candidates.length,persisted.candidateCount);
    for(const candidate of candidates)await c.imageRef({kind:'DRAFT_CANDIDATE',id:candidate.id});
  }
  await c.evidence(`batch-${persisted.id}`,{batch:persisted,candidates});return {response,persisted,candidates};
}
export const patternScenarios = [
  {id:'global-models',title:'Model designer record, reference face, cast, unique selected portrait and library',jobTypes:['MODEL_CAST'],run:async c=>{
    const model=await c.invoke('createModel',{name:'Full acceptance model',spec,notes:'Synthetic offline model'});c.state.model=model;
    c.equal(model.hasReferenceFace,false);
    const face=await c.invoke('uploadModelReferenceFace',{modelId:model.id,file:await c.byteFile(c.reference)});c.equal(face.hasReferenceFace,true);
    const referenceFace = await modelFaceRef(face);
    const faceImage = await c.imageRef(referenceFace);
    const uploadedFace = await c.byteFile(c.reference);
    c.equal(sha256(faceImage.bytes),sha256(Buffer.from(uploadedFace.base64,'base64')),'published reference face resolves to the uploaded content');
    c.equal(await modelFaceRef(await c.invoke('getModel',{modelId:model.id})),referenceFace,'reference face identity survives model reread');
    const request={modelId:model.id,providerId:providerId(c),imageModelId:'mock-image',aspectRatio:'AUTO',candidateCount:2};
    const job=await c.invoke('createModelCastJob',request);await c.waitJob(job.id);c.equal(job.projectId,null);
    c.equal((await c.invoke('createModelCastJob',request)).id,job.id);
    const portraits=items(await c.invoke('listModelPortraits',{modelId:model.id}));
    await c.evidence('model-cast-portraits',{requestedCandidates:request.candidateCount,portraits});
    c.equal(portraits.length,2,'two requested model cast candidates persist');
    for(const portrait of portraits)await c.imageRef({kind:'PORTRAIT',id:portrait.id});
    for(const portrait of portraits){const selected=await c.invoke('selectModelPortrait',{portraitId:portrait.id});c.equal(selected.selectedPortrait.id,portrait.id);}
    const renamed=await c.invoke('updateModel',{modelId:model.id,name:'Full acceptance model renamed'});c.equal(renamed.notes,'Synthetic offline model');c.equal(renamed.spec,spec);
    const reread=await c.invoke('getModel',{modelId:model.id});c.equal(reread.selectedPortrait.id,portraits[1].id);
    c.equal(items(await c.invoke('listModels')).filter(item=>item.id===model.id).length,1);
    const lib=items(await c.invoke('listLibraryAssets',{kind:'MODEL',q:'Full acceptance model',modelGender:'FEMALE'}));c.check(lib.length>0);
    await c.invoke('deleteModelPortrait',{portraitId:portraits[0].id});c.equal(items(await c.invoke('listModelPortraits',{modelId:model.id})).length,1);
    c.check(c.observations.some(row=>row.markers['Identity reference']),'reference face identity anchor reached actual model prompt');
  }},
  {id:'pattern-import',title:'Formal pattern upload, metadata, resource and library',run:async c=>{
    const pattern=await c.invoke('uploadPattern',{file:await c.byteFile(c.reference),name:'Full imported pattern',tags:JSON.stringify(['synthetic','geometric'])});
    c.state.pattern=pattern;c.equal(pattern.source,'UPLOADED');
    const updated=await c.invoke('updatePattern',{patternId:pattern.id,name:'Full imported pattern edited',tags:['synthetic','edited']});c.equal(updated.name,'Full imported pattern edited');
    c.equal((await c.invoke('getPattern',{patternId:pattern.id})).id,pattern.id);
    await c.imageRef((await c.invoke('getPatternFile',{patternId:pattern.id})).ref);
    c.check(items(await c.invoke('listLibraryAssets',{kind:'PATTERN'})).some(item=>item.id===`pattern:${pattern.id}`));
    const specs=await c.invoke('listPodPrintSpecs');c.check(specs.items.some(item=>item.id==='mug-11oz-wrap'));
  }},
  ...[['SEGMENT','sam-3','fal'],['GENERATE','mock-image',undefined]].map(([mode,modelId,protocol])=>({id:`pattern-extract-${mode.toLowerCase()}`,title:`Formal ${mode} extraction commits pixels and deduplicates`,jobTypes:['PATTERN_EXTRACT'],run:async c=>{
    const definition=c.catalog.operations.find(item=>item.operation==='createPatternExtractJob');
    need(definition?.input?.properties?.file?.type==='object','createPatternExtractJob still declares legacy multipart file:string; restricted ByteImport IPC must be wired before extraction acceptance');
    const extract = async fixture => {
      const request={providerId:providerId(c),modelId,mode,file:await c.byteFile(),name:`Extract ${mode}`,background:mode==='GENERATE'?'WHITE':'TRANSPARENT',...(protocol?{protocol}:{}),idempotencyKey:`extract-${mode}`};
      const job=await c.invoke('createPatternExtractJob',request);await c.waitJob(job.id);c.equal(job.projectId,null);
      const pattern=await patternForJob(c,job.id);c.equal(pattern.source,'EXTRACTED');
      c.equal((await c.invoke('createPatternExtractJob',request)).id,job.id);
      if(mode==='SEGMENT')await verifyExtractionPixels(c,await c.imageRef({kind:'PATTERN',id:pattern.id},{alpha:true}),fixture);
    };
    if(mode==='SEGMENT')await withExtractionMask(c,extract);else await extract();
  }})),
  {id:'pattern-forge-variant-recolor-tile',title:'Formal forge, AI variant, deterministic recolor lineage and tile check',jobTypes:['PATTERN_FORGE','PATTERN_VARIANT','PATTERN_DERIVE','PATTERN_TILE_CHECK'],run:async c=>{
    const job=await c.invoke('createPatternForgeJob',{providerId:providerId(c),imageModelId:'mock-image',theme:'Synthetic coral leaves and blue dots',candidateCount:2,idempotencyKey:'formal-forge'});await c.waitJob(job.id);
    const generated=items(await c.invoke('listPatterns')).filter(item=>item.sourceJobId===job.id);c.equal(generated.length,2);
    for(const pattern of generated)await c.imageRef({kind:'PATTERN',id:pattern.id});
    const source=need(c.state.pattern,'Imported pattern unavailable');
    const variant=await c.invoke('createPatternVariantJob',{patternId:source.id,providerId:providerId(c),imageModelId:'mock-image',axis:'STYLE',preset:'WATERCOLOR',candidateCount:1,idempotencyKey:'variant-full'});await c.waitJob(variant.id);
    const variation=await patternForJob(c,variant.id);c.equal(variation.parentPatternId,source.id);
    const request={patternId:source.id,hueShift:80,saturationPct:120,idempotencyKey:'recolor-full'};
    const recolor=await c.invoke('createPatternDeriveJob',request);await c.waitJob(recolor.id);
    const derived=await patternForJob(c,recolor.id);c.equal(derived.parentPatternId,source.id);c.equal(derived.source,'DERIVED');
    const original=await c.imageRef({kind:'PATTERN',id:source.id}),colored=await c.imageRef({kind:'PATTERN',id:derived.id});c.check(!original.data.equals(colored.data),'recolor changes actual decoded pixels');
    c.equal((await c.invoke('createPatternDeriveJob',request)).id,recolor.id);
    const tile=await c.invoke('createPatternTileCheckJob',{patternId:source.id});await c.waitJob(tile.id);
    const checked=await c.invoke('getPattern',{patternId:source.id});c.check(['VERIFIED','RISK','FAILED'].includes(checked.tileable),'persisted deterministic seam assessment');
  }},
  {id:'pattern-print-listing',title:'Print file/mockup/tile/manifest bytes and Etsy Listing constraints',jobTypes:['PRINT_PACK','COPYWRITE:LISTING'],run:async c=>{
    const pattern=need(c.state.pattern,'Pattern unavailable');
    const specs=await c.invoke('listPodPrintSpecs');c.equal(specs.items.length,6,'all original print specifications');
    const configs=[...specs.items.map(spec=>({specId:spec.id,layout:'CENTERED'})),...['STRAIGHT','HALF_DROP','ONE_THIRD_DROP','HALF_BRICK','MIRROR'].map(repeatLayout=>({specId:'mug-11oz-wrap',layout:'TILE',repeatLayout}))];
    for(const config of configs) {
      const request={patternId:pattern.id,...config};const queued=await c.invoke('createPrintPackJob',request);await c.waitJob(queued.job.id);
      const pack=await c.invoke('getPrintPack',{printPackId:queued.printPack.id});c.equal(pack.status,'SUCCEEDED');
      c.check(pack.files.some(file=>file.kind==='PRINT_FILE')&&pack.files.some(file=>file.kind==='MOCKUP')&&pack.files.some(file=>file.kind==='MANIFEST'));
      for(let index=0;index<pack.files.length;index++) {
        const handle=await c.invoke('getPrintPackFile',{printPackId:pack.id,index});
        if(pack.files[index].kind==='MANIFEST') {
          const manifest=JSON.parse((await c.save(handle.ref,'json')).toString('utf8'));c.equal(manifest.kind,'ecomgen.print-pack');if(config.repeatLayout)c.equal(manifest.repeatLayout,config.repeatLayout);
        } else {
          const image=await c.imageRef(handle.ref,{expectedHash:pack.files[index].hash});
          if(pack.files[index].kind==='PRINT_FILE'){const spec=specs.items.find(spec=>spec.id===config.specId);c.equal(image.metadata.width,spec.widthPx);c.equal(image.metadata.height,spec.heightPx);}
        }
      }
      c.equal((await c.invoke('createPrintPackJob',request)).job.id,queued.job.id);
    }
    c.equal(items(await c.invoke('listPatternPrintPacks',{patternId:pattern.id})).length,configs.length);
    for(const platform of ['ETSY','AMAZON','TIKTOK_SHOP']) {
      const request={patternId:pattern.id,providerId:providerId(c),modelId:'mock-reasoner',platform,sellingPoints:'Synthetic botanical artwork',bannedWords:'disney',idempotencyKey:`listing-full-${platform}`};
      const job=await c.invoke('createPatternListingJob',request);await c.waitJob(job.id);
      const listing=await c.invoke('getPatternListingResult',{patternId:pattern.id,jobId:job.id});c.equal(listing.platform,platform);
      if(platform==='ETSY'){c.check(listing.copy.title.length<=140);c.equal(listing.copy.tags.length,13);c.check(listing.copy.tags.every(tag=>tag.length<=20));}
      if(platform==='AMAZON'){c.check(listing.copy.title.length<=75);c.equal(listing.copy.bullets.length,5);}
      if(platform==='TIKTOK_SHOP')c.check(listing.copy.title.length>=25&&listing.copy.title.length<=200);
      c.check(!JSON.stringify(listing.copy).toLowerCase().includes('disney'));
      c.equal((await c.invoke('createPatternListingJob',request)).id,job.id);await c.evidence(`listing-${platform}`,listing);
    }
    c.check(items(await c.invoke('listLibraryAssets',{kind:'PRINT_PACK'})).length>0);
  }},
  {id:'draft-media-cas',title:'Draft media CRUD, monotonic ordinals, conditions CAS and pattern reference snapshots',run:async c=>{
    const draft=await c.invoke('createPatternDraft',{name:'Full acceptance draft',composeType:'REPEAT'});c.state.draft=draft;
    const m1=await c.invoke('createDraftMedia',{draftId:draft.id,file:await c.byteFile(),role:'REFERENCE',source:'UPLOAD',notes:'first reference'});
    const m2=await c.invoke('createDraftMedia',{draftId:draft.id,file:await c.byteFile(c.reference),role:'REFERENCE',source:'UPLOAD'});c.equal(m2.ordinal,m1.ordinal+1);
    await c.invoke('updateDraftMedia',{draftId:draft.id,mediaId:m1.id,notes:'reference @图1 updated'});
    c.equal(items(await c.invoke('listDraftMedia',{draftId:draft.id})).find(item=>item.id===m1.id).notes,'reference @图1 updated');
    await c.invoke('deleteDraftMedia',{draftId:draft.id,mediaId:m2.id});
    const m3=await c.invoke('createDraftMedia',{draftId:draft.id,role:'REFERENCE',source:'PATTERN',patternId:need(c.state.pattern,'Pattern unavailable').id});c.check(m3.ordinal>m2.ordinal,'deleted ordinal is never reused');
    const annotation=await c.invoke('createDraftMedia',{draftId:draft.id,file:await c.byteFile(),role:'ANNOTATION',source:'UPLOAD'});c.equal(annotation.ordinal,null);c.state.draftAnnotation=annotation;
    for(const media of [m1,m3,annotation])await c.imageRef((await c.invoke('downloadDraftMediaFile',{draftId:draft.id,mediaId:media.id})).ref);
    const current=await c.invoke('getPatternDraft',{draftId:draft.id});
    const conditions={theme:'@图1 botanical artwork #ff7755 palette',aspectRatio:'1:1',imageResolution:'1K',quality:'high',background:'WHITE',candidateCount:2,providerId:providerId(c),imageModelId:'gpt-image-1',repeatLayout:'STRAIGHT'};
    const updated=await c.invoke('updatePatternDraft',{draftId:draft.id,expectedRevision:current.revision,conditions});c.check(updated.revision>current.revision);c.equal(updated.conditions,conditions);
    await c.rejects('updatePatternDraft',{draftId:draft.id,expectedRevision:current.revision,name:'stale overwrite'});
    c.state.draft=updated;
  }},
  {id:'draft-generate-slots',title:'Draft generation/batch/slot/candidate records, stable idempotence and snapshots',jobTypes:['PATTERN_DRAFT_GENERATE'],run:async c=>{
    const draft=need(c.state.draft,'Draft unavailable');
    const before=items(await c.invoke('listPatterns')).map(pattern=>pattern.id);
    const input={operation:'GENERATE',candidateCount:2,providerId:providerId(c),imageModelId:'gpt-image-1',theme:'@图1 botanical motifs #ff7755 palette',aspectRatio:'1:1',background:'WHITE',clientKey:'draft-generate-full'};
    const result=await batch(c,draft.id,input);c.state.draftCandidates=result.candidates;
    c.equal((await c.invoke('createDraftBatch',{draftId:draft.id,...input})).batch.id,result.persisted.id);
    c.equal(items(await c.invoke('listPatterns')).map(pattern=>pattern.id),before,'draft candidates do not silently enter formal library');
    c.check(result.persisted.snapshot&&Object.keys(result.persisted.snapshot).length>0,'immutable batch execution snapshot');
    c.equal(new Set(result.candidates.map(candidate=>candidate.slotIndex)).size,2);
  }},
  {id:'draft-edit-cutout-process-seam',title:'Draft marked edit, cutout alpha, local recolor and paired-edge seam edit',jobTypes:['PATTERN_DRAFT_EDIT','PATTERN_DRAFT_CUTOUT','PATTERN_DRAFT_PROCESS'],run:async c=>{
    const draft=need(c.state.draft,'Draft unavailable'),parent=need(c.state.draftCandidates?.[0],'Draft candidate unavailable');
    const operations=[{operation:'EDIT',candidateId:parent.id,providerId:providerId(c),imageModelId:'gpt-image-1',instruction:'Use @图1 and #ff7755 only within the marked flower.',annotationMediaId:c.state.draftAnnotation.id},{operation:'CUTOUT',providerId:providerId(c),imageModelId:'sam-3'},{operation:'RECOLOR',recolor:{hueShift:70,saturationPct:110,brightnessPct:100}},{operation:'SEAM_EDIT',providerId:providerId(c),imageModelId:'gpt-image-1',instruction:'Match the paired edges.',seam:{edge:'LEFT_RIGHT',band:8}}];
    operations.push({operation:'SEAM_EDIT',providerId:providerId(c),imageModelId:'gpt-image-1',instruction:'Match the paired top and bottom edges.',seam:{edge:'TOP_BOTTOM',band:8}});
    for(const input of operations){
      const result=await batch(c,draft.id,{...input,parentCandidateId:parent.id});
      for(const candidate of result.candidates){
        c.equal(candidate.parentCandidateId,parent.id);c.equal(candidate.transform,input.operation);
        if(input.operation==='CUTOUT'){c.equal(candidate.hasAlpha,true);await c.imageRef({kind:'DRAFT_CANDIDATE',id:candidate.id},{alpha:true});}
        if(input.operation==='SEAM_EDIT'){
          const source=await c.imageRef({kind:'DRAFT_CANDIDATE',id:parent.id});const changed=await c.imageRef({kind:'DRAFT_CANDIDATE',id:candidate.id});
          c.equal(changed.info.width,source.info.width);c.equal(changed.info.height,source.info.height);
          for(let y=0;y<source.info.height;y++)for(let x=0;x<source.info.width;x++){
            const center=input.seam.edge==='LEFT_RIGHT'?x>=8&&x<source.info.width-8:y>=8&&y<source.info.height-8;
            if(center){const i=(y*source.info.width+x)*4;c.equal(changed.data.subarray(i,i+4),source.data.subarray(i,i+4),'seam process preserves center RGBA');}
          }
        }
      }
    }
    c.check(c.observations.some(row=>row.markers['@图1']&&row.markers['#ff7755']),'reference ordinal and palette reached actual provider');
    const seam=await c.invoke('checkDraftCandidateTileability',{draftId:draft.id,candidateId:parent.id});await c.waitJob(seam.id);
    const checked=items(await c.invoke('listDraftCandidates',{draftId:draft.id})).find(candidate=>candidate.id===parent.id);
    c.check(checked.tileable?.algorithmVersion,'persisted deterministic candidate seam result includes algorithm version');
    const beforeInvalid=c.mock.state.total;
    await c.rejects('createDraftBatch',{draftId:draft.id,clientKey:'invalid-ordinal',operation:'EDIT',candidateCount:1,parentCandidateId:parent.id,providerId:providerId(c),imageModelId:'gpt-image-1',instruction:'Use @图999999'});
    c.equal(c.mock.state.total,beforeInvalid,'unknown ordinal fails before provider');
  }},
  {id:'draft-compare-finalize',title:'Draft comparison/removal, explicit finalization and idempotent formal copy',run:async c=>{
    const draft=need(c.state.draft,'Draft unavailable'),candidates=need(c.state.draftCandidates,'Candidates unavailable');
    const current=await c.invoke('getPatternDraft',{draftId:draft.id});
    const selected=await c.invoke('updatePatternDraft',{draftId:draft.id,expectedRevision:current.revision,selectedCandidateId:candidates[0].id,compareCandidateId:candidates[1].id});c.equal(selected.compareCandidateId,candidates[1].id);
    const request={draftId:draft.id,candidateId:candidates[0].id,clientKey:'finalize-full',name:'Explicitly finalized full pattern'};
    const finalized=await c.invoke('finalizeDraftCandidate',request);c.check(finalized.pattern.id);c.equal((await c.invoke('finalizeDraftCandidate',request)).pattern.id,finalized.pattern.id);
    c.state.finalizedPattern=finalized.pattern;
    await c.imageRef((await c.invoke('downloadDraftCandidateFile',{draftId:draft.id,candidateId:candidates[0].id})).ref);
    await c.invoke('deleteDraftCandidate',{draftId:draft.id,candidateId:candidates[1].id});c.check(!items(await c.invoke('listDraftCandidates',{draftId:draft.id})).some(item=>item.id===candidates[1].id));
    c.check(items(await c.invoke('listPatternDrafts',{archived:false})).some(item=>item.id===draft.id));
    const scratch=await c.invoke('createPatternDraft',{name:'Delete isolated draft'});await c.invoke('deletePatternDraft',{draftId:scratch.id});c.check(!items(await c.invoke('listPatternDrafts')).some(item=>item.id===scratch.id));
  }},
];

export const pipelineScenarios=[
  {id:'pipeline-full-chain',title:'Persisted source/tile/print/listing pipeline runs to actual artifacts',jobTypes:['PATTERN_TILE_CHECK','PRINT_PACK','COPYWRITE:LISTING'],run:async c=>{
    const image=await c.sharp({create:{width:64,height:64,channels:4,background:'#7a8c5a'}}).png().toBuffer();
    const pipeline={specId:'mug-11oz-wrap',layout:'TILE',listingPlatform:'ETSY',listingProviderId:providerId(c),listingModelId:'mock-reasoner'};
    const pattern=await c.invoke('uploadPattern',{file:{name:'uniform.png',mimeType:'image/png',base64:image.toString('base64')},name:'Uniform pipeline pattern',pipeline:JSON.stringify(pipeline)});
    const started=items(await c.invoke('listPatternPipelines',{patternId:pattern.id}));c.equal(started.length,1);
    const sealed=await poll(()=>c.invoke('getPatternPipeline',{pipelineId:started[0].id}),value=>['SUCCEEDED','FAILED','CANCELLED','AWAITING_INPUT'].includes(value.status),{timeout:90000,label:'full packaging pipeline'});
    c.equal(sealed.status,'SUCCEEDED');c.equal(sealed.steps.map(step=>step.step),['TILE_CHECK','PRINT_PACK','LISTING']);c.check(sealed.steps.every(step=>step.status==='SUCCEEDED'));
    for(const step of sealed.steps)await c.waitJob(step.jobId);
    const packs=items(await c.invoke('listPatternPrintPacks',{patternId:pattern.id}));c.equal(packs.length,1);
    const imageIndex=packs[0].files.findIndex(file=>file.kind==='PRINT_FILE');await c.imageRef({kind:'PRINT_PACK_FILE',id:packs[0].id,index:imageIndex});
    const listingStep=sealed.steps.find(step=>step.step==='LISTING');c.equal((await c.invoke('getPatternListingResult',{patternId:pattern.id,jobId:listingStep.jobId})).copy.tags.length,13);
    c.state.pipeline=sealed;
  }},
  ...['USE_CENTERED','USE_MIRROR','ALLOW_SEAM'].map(resolution=>({id:`pipeline-seam-${resolution.toLowerCase()}`,title:`Seam gate persists before ${resolution} decision`,run:async c=>{
    // 1x1 is deliberately outside the seam algorithm's measurable range: deterministic risk.
    const pixel=await c.sharp({create:{width:1,height:1,channels:4,background:'#884422'}}).png().toBuffer();
    const pattern=await c.invoke('uploadPattern',{file:{name:'seam-risk.png',mimeType:'image/png',base64:pixel.toString('base64')},name:`Seam risk ${resolution}`});
    const request={patternId:pattern.id,specId:'mug-11oz-wrap',layout:'TILE',listingPlatform:'ETSY',listingProviderId:providerId(c),listingModelId:'mock-reasoner',idempotencyKey:`seam-${resolution}`};
    const queued=await c.invoke('createPatternPipeline',request);
    const waiting=await poll(()=>c.invoke('getPatternPipeline',{pipelineId:queued.id}),value=>value.status==='AWAITING_INPUT',{label:'seam decision gate'});
    c.equal(waiting.blockReason,'SEAM_RISK');const pack=waiting.steps.find(step=>step.step==='PRINT_PACK');c.equal(pack.status,'PENDING');c.equal(pack.jobId,null,'no print before decision');
    await c.invoke('continuePatternPipeline',{pipelineId:waiting.id,resolution});
    const sealed=await poll(()=>c.invoke('getPatternPipeline',{pipelineId:waiting.id}),value=>['SUCCEEDED','FAILED','CANCELLED'].includes(value.status),{timeout:90000,label:'continued seam pipeline'});c.equal(sealed.status,'SUCCEEDED');
    if(resolution==='USE_CENTERED')c.equal(sealed.layout,'CENTERED');if(resolution==='USE_MIRROR')c.equal(sealed.repeatLayout,'MIRROR');
    for(const step of sealed.steps)if(step.jobId)await c.waitJob(step.jobId);
  }})),
  {id:'pipeline-source-cancel-retry',title:'Generated SOURCE step, explicit cancellation/retry and generation isolation',run:async c=>{
    const pipeline={specId:'mug-11oz-wrap',layout:'CENTERED',listingPlatform:'ETSY',listingProviderId:providerId(c),listingModelId:'mock-reasoner'};
    c.mock.control.failNext('image-generation',{type:'http',status:400});
    const sourceRequest={providerId:providerId(c),imageModelId:'mock-image',theme:'Pipeline source failure',candidateCount:1,pipeline,idempotencyKey:'pipeline-source-failure'};
    const source=await c.invoke('createPatternForgeJob',sourceRequest);
    await c.waitJob(source.id,'FAILED');
    // The owning pipeline must expose its SOURCE failure, not silently drop the intent.
    const sourceOwner=await c.inspect('sourcePipeline',{jobId:source.id});
    const pipelineId=need(sourceOwner?.id,'Failed global source has no persisted owning SOURCE step');
    const before=await c.invoke('getPatternPipeline',{pipelineId});c.check(before.steps.some(step=>step.step==='SOURCE'&&step.status==='FAILED'));
    await c.rejects('retryPatternPipelineStep',{pipelineId,step:'SOURCE'},/^该流水线还没有花型，无法重跑$/);
    // SOURCE belongs to its original entry, not downstream step reruns. Explicitly reissue the known HTTP400 failure.
    const retried=await c.invoke('createPatternForgeJob',sourceRequest);c.check(retried.id!==source.id,'source entry creates a distinct retry generation');
    const retryOwner=await c.inspect('sourcePipeline',{jobId:retried.id});
    const retryPipelineId=need(retryOwner?.id,'Retried source has no persisted owning SOURCE step');c.check(retryPipelineId!==pipelineId,'retry generation owns its own pipeline');
    const completed=await poll(()=>c.invoke('getPatternPipeline',{pipelineId:retryPipelineId}),value=>['SUCCEEDED','FAILED'].includes(value.status),{timeout:90000,label:'retried source pipeline'});c.equal(completed.status,'SUCCEEDED');
    const retainedFailure=await c.invoke('getPatternPipeline',{pipelineId});c.equal(retainedFailure.status,'FAILED');c.equal(retainedFailure.steps,before.steps,'failed SOURCE history is immutable');
    c.equal(completed.steps.find(step=>step.step==='SOURCE').jobId,retried.id,'completed SOURCE belongs to the explicit retry');
    c.equal((await c.invoke('createPatternForgeJob',sourceRequest)).id,retried.id,'successful source retry remains deduplicated');
    const other=need(c.state.pipeline,'Independent pipeline unavailable');c.equal((await c.invoke('getPatternPipeline',{pipelineId:other.id})).status,'SUCCEEDED');
    c.check(completed.steps.find(step=>step.step==='SOURCE').jobId!==source.id,'retry isolates new SOURCE job generation');
    const pixel=await c.sharp({create:{width:1,height:1,channels:4,background:'#553311'}}).png().toBuffer();
    const risk=await c.invoke('uploadPattern',{file:{name:'cancel-risk.png',mimeType:'image/png',base64:pixel.toString('base64')},name:'Cancel at durable seam gate'});
    const cancel=await c.invoke('createPatternPipeline',{patternId:risk.id,...pipeline,layout:'TILE',idempotencyKey:'pipeline-cancel'});
    await poll(()=>c.invoke('getPatternPipeline',{pipelineId:cancel.id}),value=>value.status==='AWAITING_INPUT',{label:'cancel before downstream billing'});
    await c.invoke('cancelPatternPipeline',{pipelineId:cancel.id});const cancelled=await c.invoke('getPatternPipeline',{pipelineId:cancel.id});c.equal(cancelled.status,'CANCELLED');
    c.check(cancelled.steps.filter(step=>step.step!=='TILE_CHECK').every(step=>step.jobId===null),'cancelled pipeline creates no downstream paid intent');
    const rerun=await c.invoke('retryPatternPipelineStep',{pipelineId:cancel.id,step:'TILE_CHECK'});
    c.check(rerun.steps.find(step=>step.step==='TILE_CHECK').jobId!==cancelled.steps.find(step=>step.step==='TILE_CHECK').jobId,'supported downstream retry isolates the new step generation');
    const gated=await poll(()=>c.invoke('getPatternPipeline',{pipelineId:cancel.id}),value=>['AWAITING_INPUT','FAILED','CANCELLED'].includes(value.status),{label:'retried seam decision gate'});
    c.equal(gated.status,'AWAITING_INPUT');c.equal(gated.blockReason,'SEAM_RISK');c.check(gated.steps.filter(step=>step.step!=='TILE_CHECK').every(step=>step.jobId===null),'retry preserves the seam gate before any downstream paid intent');
    await c.invoke('continuePatternPipeline',{pipelineId:cancel.id,resolution:'USE_CENTERED'});
    const recovered=await poll(()=>c.invoke('getPatternPipeline',{pipelineId:cancel.id}),value=>['SUCCEEDED','FAILED','CANCELLED'].includes(value.status),{timeout:90000,label:'cancelled pipeline recovery'});c.equal(recovered.status,'SUCCEEDED');
    c.equal((await c.invoke('getPatternPipeline',{pipelineId:retryPipelineId})).steps,completed.steps,'other pipeline retry cannot overwrite SOURCE generation');
  }},
];
