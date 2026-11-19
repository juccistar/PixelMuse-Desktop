import { createRequire } from 'node:module';
import { join } from 'node:path';
import { need, poll, items, root, sha256 } from './e2e-full-harness.mjs';
import { initializePsdPixels, verifyPsd, verifyMaskedPixels } from './e2e-full-support.mjs';

async function session(c) {
  const project = need(c.state.project, 'Project unavailable');
  const output = need(c.state.outputs?.[0], 'Generated output unavailable');
  return c.invoke('createEditSession', { projectId: project.id, outputId: output.id });
}
async function waitTurn(c, turnId, statuses) {
  return poll(() => c.invoke('getEditTurn', { turnId }), turn => statuses.includes(turn.status), { label: `edit turn ${turnId}` });
}
async function editedOutputs(c, turnId) {
  const project = need(c.state.project, 'Project unavailable');
  return items(await c.invoke('listOutputs', { projectId: project.id })).filter(output => output.editTurnId === turnId);
}
async function verifyEdit(c, editSession, queued, expectedPolicy, approve = false) {
  await c.waitJob(queued.planJobId);
  if (approve) {
    const waiting = await waitTurn(c, queued.turnId, ['AWAITING_CONFIRMATION','PLAN_READY']);
    c.equal(waiting.plan.compositePolicy, expectedPolicy);
    const approval = await c.invoke('approveEditTurn', { turnId: queued.turnId });
    await c.waitJob(approval.job.id);
  }
  const turn = await waitTurn(c, queued.turnId, ['SUCCEEDED','FAILED','UNKNOWN']);
  c.equal(turn.status, 'SUCCEEDED');
  const outputs = await editedOutputs(c, queued.turnId);
  c.check(outputs.length > 0, 'edit created persisted output lineage');
  for (const output of outputs) {
    c.equal(output.parentOutputId, turn.baseOutputId); c.equal(output.editSessionId, editSession.id); c.equal(output.editTurnId, turn.id);
    c.check(output.rootOutputId, 'edit has root lineage');
    await c.imageRef({ kind: 'OUTPUT', id: output.id }, { expectedHash: output.hash });
    await c.waitJob(output.jobId);
  }
  await c.evidence('turn', turn);
  return { turn, outputs };
}
export async function verifyLayers(c, record, { names, sourceOutput, pixelExact = false, maskBytes } = {}) {
  c.equal(record.status, 'SUCCEEDED');
  const psdBytes = await c.save({ kind: 'LAYER_PSD', id: record.id }, 'psd');
  const psdModule = createRequire(join(root, 'apps/desktop/package.json'))('ag-psd');
  initializePsdPixels(psdModule);
  const psd = verifyPsd(psdModule.readPsd, psdBytes);
  const compositePixels = need(psdModule.readPsd(psdBytes, { useImageData: true, skipThumbnail: true }).imageData, 'PSD composite RGBA unavailable');
  c.equal(compositePixels.width, psd.width); c.equal(compositePixels.height, psd.height);
  c.equal(compositePixels.data.length, psd.width * psd.height * 4);
  c.check(psd.layers.length > 0 && psd.visiblePixels > 0, 'PSD parser decodes actual editable layer RGBA');
  const layerNames = psd.layers.map(layer => layer.name);
  if (names) for (const name of names) c.check(layerNames.some(value => value.includes(name)), `PSD layer named ${name}`);
  const files = need(record.layerFiles, 'No PNG layer records');
  c.check(files.some(file => file.kind === 'element') && files.some(file => file.kind === 'composite'));
  const decoded = [];
  for (let index = 0; index < files.length; index++) {
    const handle = await c.invoke('downloadLayerExportLayer', { layerExportId: record.id, layerIndex: index });
    const file = files[index];
    if (file.kind === 'composite') {
      c.check(file.name.endsWith('.psd'), 'composite artifact declares PSD format');
      const bytes = await c.save(handle.ref, 'psd');
      c.equal(sha256(bytes), sha256(psdBytes), 'composite handle saves the actual PSD bytes');
      decoded.push({ kind: file.kind, bytes, metadata: { width: psd.width, height: psd.height }, data: Buffer.from(compositePixels.data) });
      continue;
    }
    const value = await c.imageRef(handle.ref, { alpha: file.kind === 'element' });
    c.equal(value.metadata.width, psd.width); c.equal(value.metadata.height, psd.height);
    const layer = psd.layers[decoded.filter(value => value.kind !== 'composite').length];
    c.check(layer && layer.name.includes(file.name.replace(/^\d+_/, '').replace(/\.png$/i, '')), 'PNG has corresponding editable PSD layer');
    const cropped = await c.sharp(value.bytes).extract({ left: layer.left, top: layer.top, width: layer.width, height: layer.height }).ensureAlpha().raw().toBuffer();
    c.equal(sha256(cropped), layer.pixelHash, 'editable PSD layer retains PNG RGBA pixels');
    decoded.push({ kind: file.kind, ...value });
  }
  const composite = need(decoded.find(value => value.kind === 'composite'), 'Missing composite');
  const pngLayers = decoded.filter(value => value.kind !== 'composite');
  c.equal(pngLayers.length, psd.layers.length, 'every PNG has one editable PSD layer');
  const expectedComposite = await c.sharp({ create: { width: psd.width, height: psd.height, channels: 4, background: '#00000000' } })
    .composite(pngLayers.map(layer => ({ input: layer.bytes }))).ensureAlpha().raw().toBuffer();
  c.equal(composite.data.length, expectedComposite.length);
  let compositeMaxError = 0;
  for (let i = 0; i < expectedComposite.length; i++) compositeMaxError = Math.max(compositeMaxError, Math.abs(composite.data[i] - expectedComposite[i]));
  c.check(compositeMaxError <= 1, 'PSD composite matches source-over composition of all native PNG layers');
  if (sourceOutput) {
    const source = await c.imageRef({ kind: 'OUTPUT', id: sourceOutput.id });
    const expectedMask = maskBytes ?? c.mock.images.mask;
    const mask = await c.sharp(expectedMask).resize(psd.width, psd.height).removeAlpha().greyscale().raw().toBuffer();
    const hasSoftMask = mask.some(value => value > 0 && value < 255);
    // An export without a background intentionally retains transparent pixels; a hard-mask export with background reconstructs the source.
    if (pixelExact && record.includeBackground && !hasSoftMask) c.equal(composite.data, source.data, 'SAM composition reproduces original decoded pixels');
    for (const [index, element] of decoded.filter(value => value.kind === 'element').entries()) {
      let foreground = 0, transparent = 0, soft = 0;
      for (let i = 0; i < element.data.length; i += 4) {
        if (pixelExact || maskBytes) c.equal(element.data[i+3], Math.round(source.data[i+3] * mask[i/4] / 255), 'segmented alpha matches every fixture mask pixel');
        if (element.data[i+3] === 0) transparent++;
        else c.equal(element.data.subarray(i, i+3), source.data.subarray(i, i+3), 'all visible segmented pixels preserve source RGB');
        if (element.data[i+3] > 0 && element.data[i+3] < 255) soft++;
        if (element.data[i+3] === 255) foreground++;
      }
      c.check(foreground > 0 && transparent > 0, 'element contains real source pixels and transparent pixels');
      if ((pixelExact || maskBytes) && hasSoftMask) {
        c.check(soft > 0, 'actual soft-mask export retains soft-alpha pixels');
        await c.evidence(`source-mask-pixels-${index}`, await verifyMaskedPixels(c.sharp, source.bytes, element.bytes, expectedMask));
      } else await c.evidence(`source-mask-pixels-${index}`, { foreground, transparent, soft });
    }
  }
  await c.evidence('psd-composite-pixels', { compositeMaxError, width: psd.width, height: psd.height });
  await c.evidence('psd-layer-structure', { width: psd.width, height: psd.height, layers: layerNames, files: files.map(file => ({ name: file.name, kind: file.kind })) });
  return record;
}
export const editLayerScenarios = [
  { id: 'edit-memory-references', title: 'Edit sessions, branch-scoped memory, references and promotion', run: async c => {
    const s = await session(c); c.state.editSession = s;
    await c.invoke('updateEditSessionMemory', { sessionId: s.id, outputId: s.currentOutputId, summary: 'root synthetic memory', constraints: ['Keep handle geometry'] });
    c.equal((await c.invoke('getEditSession', { sessionId: s.id })).memorySummary.summary, 'root synthetic memory');
    const temporaryFiles = await Promise.all([211, 287].map(async (hue, index) => ({
      name: `temporary-edit-reference-${index}.png`, mimeType: 'image/png',
      base64: (await c.sharp(c.mock.images.image).modulate({ hue, brightness: 0.83 + index * 0.08 }).png().toBuffer()).toString('base64'),
    })));
    const projectFiles = await Promise.all([c.byteFile(), c.byteFile(c.reference)]);
    c.equal(new Set([...projectFiles, ...temporaryFiles].map(file => sha256(Buffer.from(file.base64, 'base64')))).size, 4, 'temporary references have distinct valid image content from project assets');
    const ref = await c.invoke('uploadEditReferenceAsset', { sessionId: s.id, file: temporaryFiles[0], purpose: 'STYLE' });
    c.state.editReference = ref;
    c.check(items(await c.invoke('listEditReferenceAssets', { sessionId: s.id })).some(row => row.id === ref.id));
    await c.imageRef({ kind: 'EDIT_REFERENCE', id: ref.id });
    const disposable = await c.invoke('uploadEditReferenceAsset', { sessionId: s.id, file: temporaryFiles[1], purpose: 'LAYOUT' });
    await c.invoke('deleteEditReferenceAsset', { sessionId: s.id, referenceAssetId: disposable.id });
    c.check(!items(await c.invoke('listEditReferenceAssets', { sessionId: s.id })).some(row => row.id === disposable.id));
  } },
  { id: 'edit-confirmation', title: 'Edit plan confirmation, actual output lineage, branch selection and memory restoration', jobTypes: ['EDIT_PLAN','EDIT_GENERATE'], run: async c => {
    const s = need(c.state.editSession, 'Edit setup unavailable');
    c.state.editVariant = 'confirmation';
    const references = [
      { id: need(c.state.editReference, 'Temporary reference unavailable').id, source: 'TEMPORARY', purpose: 'STYLE', order: 0 },
      { id: need(c.state.referenceAsset, 'Project reference unavailable').id, source: 'PROJECT', purpose: 'LAYOUT', order: 1 },
    ];
    const queued = await c.invoke('createEditTurn', { sessionId: s.id, message: 'Adjust the scene while preserving product geometry.', referenceSelections: JSON.stringify(references) });
    const { turn, outputs } = await verifyEdit(c, s, queued, 'PROVIDER_RESULT', true);
    // The legacy asset-ID projection contains project assets; temporary lineage lives in typed selections.
    c.equal(turn.referenceAssetIds, [c.state.referenceAsset.id], 'edit turn retains selected project reference identity');
    c.equal(turn.referenceSelections, references, 'edit turn retains both reference identities, sources, purposes and ordering');
    const referenceList = await c.invoke('listEditReferenceAssets', { sessionId: s.id });
    const retained = need(items(referenceList).find(row => row.id === c.state.editReference.id), 'Selected temporary reference was lost');
    c.equal(retained.hash, c.state.editReference.hash, 'selected temporary reference retains exact image identity');
    c.equal(referenceList.suggestedSelections, references, 'next edit retains the previous turn reference selections');
    const child = outputs[0]; c.state.editedOutput = child;
    await c.invoke('selectEditSessionOutput', { sessionId: s.id, outputId: child.id });
    await c.invoke('updateEditSessionMemory', { sessionId: s.id, outputId: child.id, summary: 'child branch memory', constraints: ['Keep warm scene'] });
    await c.invoke('selectEditSessionOutput', { sessionId: s.id, outputId: s.currentOutputId });
    c.equal((await c.invoke('getEditSession', { sessionId: s.id })).memorySummary.summary, 'root synthetic memory');
    await c.invoke('selectEditSessionOutput', { sessionId: s.id, outputId: child.id });
    c.equal((await c.invoke('getEditSession', { sessionId: s.id })).memorySummary.summary, 'child branch memory');
  } },
  { id: 'edit-need-input', title: 'Ambiguous edit asks for input and cannot be approved or billed for generation', jobTypes: ['EDIT_PLAN'], run: async c => {
    const s = await session(c); c.state.editVariant = 'clarification';
    try {
      const before = c.mock.state.counts['image-edit'] + c.mock.state.counts['image-generation'];
      const queued = await c.invoke('createEditTurn', { sessionId: s.id, message: 'Change that unclear thing.' });
      await c.waitJob(queued.planJobId);
      const turn = await waitTurn(c, queued.turnId, ['NEED_INPUT','FAILED']); c.equal(turn.status, 'NEED_INPUT');
      await c.rejects('approveEditTurn', { turnId: turn.id });
      c.equal(c.mock.state.counts['image-edit'] + c.mock.state.counts['image-generation'], before);
      c.equal((await editedOutputs(c, turn.id)).length, 0);
    } finally { c.state.editVariant = 'confirmation'; }
  } },
  { id: 'edit-mask-protection', title: 'No-confirm mask edit preserves outside/protected source pixels', jobTypes: ['EDIT_PLAN','EDIT_GENERATE'], run: async c => {
    const s = await session(c), source = await c.imageRef({ kind: 'OUTPUT', id: s.currentOutputId });
    const { width, height } = source.metadata;
    const make = async (name, predicate) => {
      const raw = Buffer.alloc(width*height*4);
      for (let y=0;y<height;y++) for (let x=0;x<width;x++) { const i=(y*width+x)*4; const on=predicate(x,y); raw[i]=raw[i+1]=raw[i+2]=on?255:0; raw[i+3]=255; }
      return { name, mimeType: 'image/png', base64: (await c.sharp(raw,{raw:{width,height,channels:4}}).png().toBuffer()).toString('base64') };
    };
    const editMask = await make('edit-mask.png',(x,y)=>x<width*0.7 && y<height*0.7);
    const protectMask = await make('protect-mask.png',(x,y)=>x<width*0.2 && y<height*0.2);
    c.state.editVariant = 'no-confirmation';
    try {
      const queued = await c.invoke('createEditTurn', { sessionId: s.id, message: 'Recolor selected area; keep protected pixels.', editMask, protectMask });
      const { outputs } = await verifyEdit(c, s, queued, 'MASK_LOCKED');
      const changed = await c.imageRef({ kind: 'OUTPUT', id: outputs[0].id });
      c.equal(changed.info.width,width); c.equal(changed.info.height,height);
      let editableChanges=0;
      for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
        const i=(y*width+x)*4, locked=x>=width*0.7||y>=height*0.7||(x<width*0.2&&y<height*0.2);
        if(locked)c.equal(changed.data.subarray(i,i+4),source.data.subarray(i,i+4),'locked decoded RGBA pixel');
        else if(!changed.data.subarray(i,i+4).equals(source.data.subarray(i,i+4)))editableChanges++;
      }
      c.check(editableChanges>0,'fixture actually changed editable pixels');
      await c.invoke('getResource',{ref:{kind:'EDIT_MASK',id:queued.turnId}});
      await c.invoke('getResource',{ref:{kind:'PROTECT_MASK',id:queued.turnId}});
    } finally { c.state.editVariant='confirmation'; }
  } },
  { id: 'edit-outpaint', title: 'Outpaint expands canvas while locking the original rectangle', jobTypes: ['EDIT_PLAN','EDIT_GENERATE'], run: async c => {
    const s=await session(c),source=await c.imageRef({kind:'OUTPUT',id:s.currentOutputId});
    const {width,height}=source.metadata;
    c.state.editVariant='confirmation'; c.state.editOverrides={operation:'OUTPAINT',executionMode:'OUTPAINT',compositePolicy:'OUTPAINT'};
    try {
      const queued=await c.invoke('createEditTurn',{sessionId:s.id,message:'Expand 16 pixels on all sides.',annotations:JSON.stringify({sourceWidth:width,sourceHeight:height,annotations:[],canvasExpansion:{top:16,right:16,bottom:16,left:16}})});
      const {outputs}=await verifyEdit(c,s,queued,'OUTPAINT',true);
      const expanded=await c.imageRef({kind:'OUTPUT',id:outputs[0].id});
      c.equal(expanded.info.width,width+32);c.equal(expanded.info.height,height+32);
      for(let y=0;y<height;y++)c.equal(expanded.data.subarray(((y+16)*(width+32)+16)*4,((y+16)*(width+32)+16+width)*4),source.data.subarray(y*width*4,(y+1)*width*4),'outpaint preserves each original source row');
    } finally {c.state.editOverrides={};}
  } },
  { id: 'layer-auto-manual-sam', title: 'Automatic element plan plus manual boxes produce source-preserving PNG/PSD', jobTypes: ['LAYER_PLAN','LAYER_EXPORT'], run: async c => {
    const output=need(c.state.outputs?.[0],'Output unavailable'),p=need(c.state.project,'Project unavailable');
    await c.invoke('updateProject',{projectId:p.id,segmentationModel:{providerId:c.state.provider.id,modelId:'sam-3',protocol:'fal'}});
    const queued=await c.invoke('createLayerPlan',{outputId:output.id});await c.waitJob(queued.jobId);
    const plan=await c.invoke('getLayerPlan',{outputId:output.id});c.equal(plan.outputHash,output.hash);c.check(plan.elements.length>0);
    c.equal((await c.invoke('createLayerPlan',{outputId:output.id})).id,plan.id,'recognition cache');
    c.state.layerPlan=plan;
    const elements=[{id:plan.elements[0].id,name:plan.elements[0].name,source:'auto'},{id:'manual-corner',name:'Manual corner',source:'manual',bbox:{x:0,y:0,width:0.3,height:0.3}}];
    const queuedExport=await c.invoke('createLayerExport',{outputId:output.id,planId:plan.id,elements,includeBackground:true});await c.waitJob(queuedExport.job.id);
    const record=await c.invoke('getLayerExport',{outputId:output.id});
    await verifyLayers(c,record,{names:elements.map(element=>element.name),sourceOutput:output,pixelExact:true});
    c.state.layerExport=record;
    await c.invoke('downloadLayerExport',{layerExportId:record.id});
  } },
  ...[['grounded_sam','grounded-sam'],['gitee_sam3','sam3'],['seedream_layerize','doubao-seedream-5.0-pro-layerize']].map(([protocol,modelId])=>({id:`layer-${protocol}`,title:`${protocol} prompt segmentation and real layer history`,jobTypes:['LAYER_EXPORT'],run:async c=>{
    const output=need(c.state.outputs?.[0],'Output unavailable'),p=need(c.state.project,'Project unavailable');
    await c.invoke('updateProject',{projectId:p.id,segmentationModel:{providerId:c.state.provider.id,modelId,protocol}});
    // Seedream matches requested semantic names against returned layer labels; the local fixture labels its product layer 商品主体.
    const name=protocol==='seedream_layerize'?'商品主体':'Synthetic product body';
    const queued=await c.invoke('createLayerExport',{outputId:output.id,elements:[{id:`prompt-${protocol}`,name,source:'prompt'}],includeBackground:protocol==='seedream_layerize'});
    await c.waitJob(queued.job.id);
    const record=await c.invoke('getLayerExport',{outputId:output.id});
    const maskBytes=protocol==='seedream_layerize'?await c.sharp(c.mock.images.alpha).extractChannel('alpha').png().toBuffer():undefined;
    await verifyLayers(c,record,{names:[name],sourceOutput:output,pixelExact:protocol!=='seedream_layerize',maskBytes});
    const history=await c.invoke('listLayerExports',{outputId:output.id});c.check(history.exports.some(row=>row.id===record.id));
    c.check(c.mock.state.counts[protocol==='seedream_layerize'?'seedream':protocol==='grounded_sam'?'grounded-sam':'gitee-sam3']>0,'real declared protocol reached fixture');
  }})),
  {id:'export-zip-long-image',title:'Ordered ZIP selection, decoded long image/slices and manifest',jobTypes:['EXPORT'],run:async c=>{
    const project=need(c.state.project,'Project unavailable'),outputs=need(c.state.outputs,'Multiple outputs unavailable');
    const outputIds=[...outputs].reverse().map(output=>output.id);
    const request={projectId:project.id,outputIds,filenamePrefix:'full-acceptance',longImage:{targetWidth:750,sliceHeight:960}};
    const queued=await c.invoke('createExportJob',request);await c.waitJob(queued.job.id);
    c.equal((await c.invoke('createExportJob',request)).job.id,queued.job.id,'export dedupe');
    const record=await c.invoke('getExport',{exportId:queued.export.id});c.equal(record.status,'SUCCEEDED');
    const handle=await c.invoke('downloadExport',{exportId:record.id});
    const {unzip}=await import('./e2e-full-harness.mjs');const archive=unzip(await c.save(handle.ref,'zip'));
    const manifestBytes=need(archive.get('manifest.json'),'Missing ZIP manifest');
    const manifest=JSON.parse(manifestBytes.toString('utf8'));
    const serialized=JSON.stringify(manifest);c.check(!serialized.includes(c.fakeKey),'manifest excludes secret');
    // Require ordered IDs in the actual manifest; file signature alone is insufficient.
    const listed=manifest.outputs??manifest.outputIds??manifest.longImage?.screens??manifest.longImage?.outputIds;
    need(Array.isArray(listed),'Export manifest does not declare selected output ordering');
    c.equal(listed.map(entry=>typeof entry==='string'?entry:entry.outputId??entry.id),outputIds,'manifest selection order');
    const images=[...archive].filter(([name])=>/\.(png|jpe?g|webp)$/i.test(name));c.check(images.length>=outputs.length);
    let longCount=0;
    for(const [name,bytes]of images){const metadata=await c.sharp(bytes).metadata();c.check(metadata.width>0&&metadata.height>0);if(name.startsWith('long-image/')){longCount++;c.equal(metadata.width,750);}}
    c.check(longCount>1,'long image plus slices are actually present');
    const originals=images.filter(([name])=>!name.startsWith('long-image/'));
    c.equal(originals.length,outputIds.length,'only selected original files are archived');
    for(const output of outputs)c.check(originals.some(([,bytes])=>sha256(bytes)===output.hash),'archive retains exact selected output bytes');
    const all=items(await c.invoke('listOutputs',{projectId:project.id}));
    for(const output of all.filter(output=>!outputIds.includes(output.id)))c.check(!serialized.includes(output.id),'unselected output excluded from manifest');
    const geometry=need(manifest.longImage,'long image geometry absent');
    c.equal(geometry.screens.map(screen=>screen.outputId),outputIds,'long image screen order');
    const longFiles=images.filter(([name])=>name.startsWith('long-image/'));
    const dimensions=await Promise.all(longFiles.map(async([name,bytes])=>({name,bytes,metadata:await c.sharp(bytes).metadata()})));
    const full=need(dimensions.find(file=>file.metadata.height===geometry.totalHeight),'full long image geometry mismatch');
    const meanError=(a,b)=>{c.equal(a.length,b.length);let sum=0;for(let i=0;i<a.length;i++)sum+=Math.abs(a[i]-b[i]);return sum/a.length;};
    const screenErrors=[];
    for(const screen of geometry.screens){
      const source=await c.save({kind:'OUTPUT',id:screen.outputId});
      const expected=await c.sharp(source).resize({width:750,kernel:'lanczos3'}).removeAlpha().raw().toBuffer();
      const actual=await c.sharp(full.bytes).extract({left:0,top:screen.yTop,width:750,height:screen.height}).removeAlpha().raw().toBuffer();
      const error=meanError(actual,expected);c.check(error<8,'JPEG long-image screen pixels match selected source and order');screenErrors.push({outputId:screen.outputId,error});
    }
    let boundary=0;
    for(const slice of geometry.slices){
      c.equal(slice.yTop,boundary,'slices cover full long image without gaps or overlap');boundary+=slice.height;
      const bytes=need(archive.get(`long-image/${slice.name}`),'declared slice missing');
      const actual=await c.sharp(bytes).removeAlpha().raw().toBuffer();
      const expected=await c.sharp(full.bytes).extract({left:0,top:slice.yTop,width:750,height:slice.height}).removeAlpha().raw().toBuffer();
      c.check(meanError(actual,expected)<8,'slice pixels match declared region of full long image');
    }
    c.equal(boundary,geometry.totalHeight);
    await c.evidence('zip-manifest',{entries:[...archive.keys()],manifest,screenErrors});
  }},
];
