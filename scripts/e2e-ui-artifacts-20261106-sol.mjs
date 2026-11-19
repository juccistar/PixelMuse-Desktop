import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { need, poll, root, sha256 } from './e2e-full-harness.mjs';
import { initializePsdPixels, verifyPsd } from './e2e-full-support.mjs';

export async function exportUiComposition(c, stack) {
  const filename=join(c.artifacts,`${c.current.id}-visible-composition.png`);
  await c.app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},filename);
  await c.click('导出合成图',stack);
  const bytes=await poll(async()=>{
    const alert=stack.getByRole('alert');if(await alert.count())throw Error(`UI composition export failed: ${await alert.innerText()}`);
    try{return await readFile(filename);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  },bytes=>Boolean(bytes?.length),{label:'real layer composition canvas exported through native save'});
  const image=await c.sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  c.check(image.info.width>0&&image.info.height>0&&image.data.some((value,index)=>index%4===3&&value>0),'actual UI composition has decoded visible pixels');
  c.current.evidence.push(filename);
  await c.evidence('composition-cors',{width:image.info.width,height:image.info.height,hash:sha256(bytes),sample:[...image.data.subarray(0,16)],hiddenLayers:await stack.locator('img[data-hidden="true"]').count()});
}

// The published layer list calls the PSD file "composite"; its pixels live in the PSD composite image.
export async function verifyUiLayers(c, record, sourceOutput) {
  c.equal(record.status,'SUCCEEDED');
  const psdBytes=await c.save({kind:'LAYER_PSD',id:record.id},'psd');
  const psdModule=createRequire(join(root,'apps/desktop/package.json'))('ag-psd');
  initializePsdPixels(psdModule);
  const structure=verifyPsd(psdModule.readPsd,psdBytes);
  c.check(structure.layers.length>0&&structure.visiblePixels>0,'PSD contains decoded editable layer pixels');
  const source=await c.imageRef({kind:'OUTPUT',id:sourceOutput.id});
  const psd=psdModule.readPsd(psdBytes,{useImageData:true,skipThumbnail:true});
  c.equal(Buffer.from(need(psd.imageData,'PSD composite pixels unavailable').data),source.data,'PSD composition reproduces original decoded pixels');
  const files=need(record.layerFiles,'Layer files unavailable');
  c.check(files.some(file=>file.kind==='element')&&files.some(file=>file.kind==='composite'));
  for(let index=0;index<files.length;index++) {
    const file=files[index];const handle=await c.invoke('downloadLayerExportLayer',{layerExportId:record.id,layerIndex:index});
    if(file.kind==='composite') {
      c.check(file.name.endsWith('.psd'),'composite file declares PSD format');
      c.equal(sha256(await c.save(handle.ref,'psd')),sha256(psdBytes),'composite handle resolves the real PSD');
      continue;
    }
    const image=await c.imageRef(handle.ref,{alpha:file.kind==='element'});
    c.equal(image.metadata.width,structure.width);c.equal(image.metadata.height,structure.height);
    if(file.kind==='element') {
      const mask=await c.sharp(c.mock.images.mask).resize(source.metadata.width,source.metadata.height).removeAlpha().greyscale().raw().toBuffer();
      let transparent=0,nonzero=0,soft=0;
      for(let pixel=0;pixel<mask.length;pixel++) {
        const offset=pixel*4;const expected=Math.round(source.data[offset+3]*mask[pixel]/255);
        c.equal(image.data[offset+3],expected,'segmented alpha exactly matches actual fixture mask');
        if(expected===0)transparent++;else {nonzero++;c.equal(image.data.subarray(offset,offset+3),source.data.subarray(offset,offset+3),'all visible segmented RGB preserves source');}
        if(expected>0&&expected<255)soft++;
      }
      c.check(transparent>0&&nonzero>0,'fixture mask contains empty and visible source pixels');
      await c.evidence(`mask-pixels-${index}`,{transparent,nonzero,soft});
      let foreground=0;
      for(let offset=0;offset<image.data.length;offset+=4)if(image.data[offset+3]===255) {
        foreground++;c.equal(image.data.subarray(offset,offset+4),source.data.subarray(offset,offset+4),'opaque segmented pixel preserves source');
      }
      c.check(foreground>0,'element has real opaque source pixels');
    }
  }
  await c.evidence('psd-layer-structure',{...structure,files:files.map(file=>({name:file.name,kind:file.kind}))});
}
