import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { compositeMaskedEdit, compositeOutpaint, createOutpaintCanvas } from '../../src/execution/edit-imaging.js';
import { buildSeamCanvas } from '../../src/execution/seam-edit.js';
const image=async(color:number[])=>sharp(Buffer.from(color),{raw:{width:1,height:1,channels:4}}).png().toBuffer();
const raw=async(value:Buffer)=>sharp(value).ensureAlpha().raw().toBuffer();
describe('源像素和几何回归',()=>{
 it('硬选区外连透明像素的隐藏RGB也逐字节保留',async()=>{
  const source=await image([123,45,67,0]),generated=await image([10,20,30,255]);
  const mask=await sharp(Buffer.from([0]),{raw:{width:1,height:1,channels:1}}).png().toBuffer();
  expect(await raw(await compositeMaskedEdit(source,generated,mask))).toEqual(await raw(source));
 });
 it('扩图原区域保留源alpha和RGB，不能让生成背景透进源透明像素',async()=>{
  const source=await image([123,45,67,0]),generated=await image([10,20,30,255]);
  const result=await raw(await compositeOutpaint(source,generated,{width:3,height:3,left:1,top:1}));
  expect(result.subarray(16,20)).toEqual(await raw(source));expect([...result.subarray(0,4)]).toEqual([10,20,30,255]);
 });
 it('编辑蒙版和保护蒙版尺寸错配必须显式拒绝',async()=>{
  const source=await image([1,2,3,255]),generated=await image([5,6,7,255]);const mask=await sharp(Buffer.alloc(4,255),{raw:{width:2,height:2,channels:1}}).png().toBuffer();
  await expect(compositeMaskedEdit(source,generated,mask)).rejects.toThrow('IMAGE_DIMENSION_MISMATCH');
 });
 it('扩图拒绝负数、非整数与超容量，避免分配失控',async()=>{
  const source=await image([1,2,3,255]);
  await expect(createOutpaintCanvas(source,{left:-1,right:0,top:0,bottom:0})).rejects.toThrow('Invalid');
  await expect(createOutpaintCanvas(source,{left:100000,right:0,top:100000,bottom:0})).rejects.toThrow('pixel limit');
 });
 it('小画布接缝带不会大于半边，也不把小数带传给extract',async()=>{
  const source=await sharp({create:{width:4,height:4,channels:4,background:'red'}}).png().toBuffer();
  const context=await buildSeamCanvas(source,'LEFT_RIGHT',48.5,128);expect(context.band).toBe(2);expect(context.canvasWidth).toBe(8);
  await expect(buildSeamCanvas(source,'LEFT_RIGHT',Number.NaN,128)).rejects.toThrow('geometry');
 });
});
