import { linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync, type WriteStream } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalAssetStore } from './files.js';

const directories: string[]=[];
afterEach(() => { for(const path of directories.splice(0)) rmSync(path,{ recursive:true,force:true }); });
function directory() { const path=mkdtempSync(join(tmpdir(),'core-storage-boundaries-')); directories.push(path); return path; }

describe('LocalAssetStore boundaries', () => {
  it.each(['../escape','a/b','a\\b','C:stream','.','..','NUL','trailing.'])('拒绝写入标识 %s 的穿越、设备或替代流', async id => {
    const store=new LocalAssetStore(directory()); await store.initialize();
    await expect(store.putAsset(id,'image.png',Buffer.from('data'))).rejects.toThrow();
    await expect(store.putOutput(id,Buffer.from('data'))).rejects.toThrow();
    await expect(store.putDraftCandidate('draft',id,Buffer.from('data'))).rejects.toThrow();
    await expect(store.putPatternArtifact('pattern',id,Buffer.from('data'))).rejects.toThrow();
  });

  it('拒绝受管根目录、子目录及递归删除树中的 junction，外部数据保持原样', async () => {
    const parent=directory(), outside=directory();
    writeFileSync(join(outside,'protected.txt'),'protected');
    symlinkSync(outside,join(parent,'linked-root'),'junction');
    await expect(new LocalAssetStore(join(parent,'linked-root')).initialize()).rejects.toThrow('Linked managed paths');
    const store=new LocalAssetStore(join(parent,'managed')); await store.initialize();
    symlinkSync(outside,store.absolute('assets/linked'),'junction');
    await expect(store.read('assets/linked/protected.txt')).rejects.toThrow('Linked managed paths');
    await expect(store.putAsset('linked','a.txt',Buffer.from('replacement'))).rejects.toThrow('Linked managed paths');
    await expect(store.deleteProject('linked')).rejects.toThrow('Linked managed paths');
    mkdirSync(store.absolute('assets/project'));
    symlinkSync(outside,store.absolute('assets/project/nested'),'junction');
    await expect(store.deleteProject('project')).rejects.toThrow('Linked managed paths');
    expect(readdirSync(outside)).toEqual(['protected.txt']);
  });

  it('硬链接文件不能读取、覆盖或删除，不改变源文件', async () => {
    const root=directory(), outside=directory();
    const store=new LocalAssetStore(root); await store.initialize();
    writeFileSync(join(outside,'original'),'external');
    linkSync(join(outside,'original'),join(root,'assets','linked.bin'));
    await expect(store.read('assets/linked.bin')).rejects.toThrow('Linked managed paths');
    await expect(store.delete('assets/linked.bin')).rejects.toThrow('Linked managed paths');
    expect(() => store.absolute('assets/linked.bin')).toThrow('Linked managed paths');
  });

  it('v2 平铺资源可读且仅按显式引用删除，不影响其它项目平铺资源', async () => {
    const root=directory(), store=new LocalAssetStore(root); await store.initialize();
    writeFileSync(join(root,'assets','old-asset.png'),'first');
    writeFileSync(join(root,'assets','other-asset.png'),'second');
    expect((await store.read('assets/old-asset.png')).toString()).toBe('first');
    await store.deleteProject('old-project');
    expect(await store.exists('assets/old-asset.png')).toBe(true);
    await store.delete('assets/old-asset.png');
    expect(await store.exists('assets/old-asset.png')).toBe(false);
    expect((await store.read('assets/other-asset.png')).toString()).toBe('second');
  });

  it('有界缓冲读写、图片解码像素上限和取消，拒绝无限制调用方覆盖', async () => {
    const root=directory(), store=new LocalAssetStore(root,{ maxBufferedBytes:16,maxImageBytes:8,maxImagePixels:100 }); await store.initialize();
    await expect(store.putOutput('p',Buffer.alloc(9))).rejects.toThrow('byte limit');
    await expect(store.putPrintPackArtifact('pack','manifest',Buffer.alloc(17),'.json')).rejects.toThrow('byte limit');
    writeFileSync(join(root,'assets','large.bin'),Buffer.alloc(17));
    await expect(store.read('assets/large.bin')).rejects.toThrow('read limit');
    await expect(store.read('assets/large.bin',{ maxBytes:100 })).rejects.toThrow('read limit');
    const signal=AbortSignal.abort(new Error('cancelled before write'));
    await expect(store.putAsset('p','a.bin',Buffer.from('small'),{ signal })).rejects.toThrow('cancelled');
    await expect(store.read('assets/large.bin',{ signal })).rejects.toThrow('cancelled');
    const image=await sharp({ create:{ width:11,height:11,channels:4,background:'#ffffff' } }).png().toBuffer();
    const pixels=new LocalAssetStore(root,{ maxImagePixels:100 });
    await expect(pixels.inspectImage(image)).rejects.toThrow();
    expect(readdirSync(join(root,'tmp'))).toEqual([]);
  });

  it('草稿候选稳定寻址且不可变；相同字节幂等，冲突不会覆盖旧像素', async () => {
    const root=directory(), store=new LocalAssetStore(root); await store.initialize();
    const first=await store.putDraftCandidate('d','candidate',Buffer.from('first'));
    expect(await store.putDraftCandidate('d','candidate',Buffer.from('first'))).toEqual(first);
    await expect(store.putDraftCandidate('d','candidate',Buffer.from('different'))).rejects.toThrow('Immutable managed artifact');
    expect((await store.read(first.path)).toString()).toBe('first');
    expect(readdirSync(join(root,'tmp'))).toEqual([]);
  });

  it('生产回调失败时回滚临时导出，不发布半成品', async () => {
    const root=directory(), store=new LocalAssetStore(root); await store.initialize();
    await expect(store.putExportStream('p',async stream => {
      stream.write('partial'); throw new Error('producer failed');
    })).rejects.toThrow('producer failed');
    expect(readdirSync(join(root,'tmp'))).toEqual([]);
    expect(readdirSync(join(root,'exports','p'))).toEqual([]);
  });

  it('导出超过字节上限时清理临时文件，旧已发布文件保持完整', async () => {
    const root=directory(), store=new LocalAssetStore(root,{ maxExportBytes:8 }); await store.initialize();
    const first=await store.putExportStream('p',async stream => { stream.end('original'); },{ idempotencyKey:'stable' });
    await expect(store.putExportStream('p',async stream => { stream.end('larger-than-limit'); },{ idempotencyKey:'stable' })).rejects.toThrow('Export exceeds byte limit');
    expect((await store.read(first.path)).toString()).toBe('original');
    expect(readdirSync(join(root,'tmp'))).toEqual([]);
  });

  it('导出调用前已取消时不启动生产回调，也不创建临时文件', async () => {
    const root=directory(), store=new LocalAssetStore(root); await store.initialize();
    let produced=false;
    await expect(store.putExportStream('p',async () => {
      produced=true; throw new Error('producer must not start');
    },{ signal:AbortSignal.abort(new Error('cancel before export')) })).rejects.toThrow('cancel before export');
    expect(produced).toBe(false);
    expect(readdirSync(join(root,'tmp'))).toEqual([]);
    expect(readdirSync(join(root,'exports'))).toEqual([]);
  });

  it('导出异步准备期间立即取消时不启动生产回调，不留下临时文件或半成品', async () => {
    const root=directory(), store=new LocalAssetStore(root); await store.initialize();
    const controller=new AbortController();
    let produced=false;
    const writing=store.putExportStream('p',async () => {
      produced=true; throw new Error('producer must not start');
    },{ signal:controller.signal });
    const rejection=expect(writing).rejects.toThrow('cancel during export setup');
    // 调用同步执行到 mkdir 的 await；立即取消稳定覆盖监听器尚未注册的窗口。
    controller.abort(new Error('cancel during export setup'));
    await rejection;
    expect(produced).toBe(false);
    expect(readdirSync(join(root,'tmp'))).toEqual([]);
    expect(readdirSync(join(root,'exports','p'))).toEqual([]);
  });

  it('导出等待期间取消会关闭流并清理，即使生产回调仍等待也不会卡住', async () => {
    const root=directory(), store=new LocalAssetStore(root); await store.initialize();
    const controller=new AbortController();
    let started!:()=>void;
    let destination:WriteStream|undefined;
    const ready=new Promise<void>(resolve => { started=resolve; });
    const writing=store.putExportStream('p',async stream => {
      destination=stream;
      stream.write('partial'); started(); await new Promise<void>(() => undefined);
    },{ signal:controller.signal });
    const rejection=expect(writing).rejects.toThrow('cancel export');
    await ready; controller.abort(new Error('cancel export')); await rejection;
    expect(destination?.destroyed).toBe(true);
    expect(destination?.closed).toBe(true);
    expect(readdirSync(join(root,'tmp'))).toEqual([]);
    expect(readdirSync(join(root,'exports','p'))).toEqual([]);
  });

  it('取消幂等导出保留已发布内容，继续观察生产回调的迟到拒绝', async () => {
    const root=directory(), store=new LocalAssetStore(root); await store.initialize();
    const first=await store.putExportStream('p',async stream => { stream.end('original'); },{ idempotencyKey:'stable' });
    const controller=new AbortController();
    let started!:()=>void, rejectProducer!:(error:Error)=>void;
    const ready=new Promise<void>(resolve => { started=resolve; });
    const production=new Promise<void>((_resolve,reject) => { rejectProducer=reject; });
    const writing=store.putExportStream('p',async stream => {
      stream.write('partial'); started(); await production;
    },{ signal:controller.signal,idempotencyKey:'stable' });
    const rejection=expect(writing).rejects.toThrow('cancel export');
    await ready; controller.abort(new Error('cancel export')); await rejection;
    rejectProducer(new Error('late producer failure'));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect((await store.read(first.path)).toString()).toBe('original');
    expect(readdirSync(join(root,'tmp'))).toEqual([]);
    expect(readdirSync(join(root,'exports','p'))).toEqual([basename(first.path)]);
  });
});
