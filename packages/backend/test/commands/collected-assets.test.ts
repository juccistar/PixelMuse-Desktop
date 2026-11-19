import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { EcomRepository, LocalAssetStore, openDatabase } from '@ecomgen/core';
import { collectionHostOperations, sanitizeCollectionPageUrl, type CollectionHostInput } from '@ecomgen/contracts';
import { Value } from '@sinclair/typebox/value';
import { createCollectedAssetHandlers } from '../../src/commands/collected-assets.js';
import type { CommandContext } from '../../src/runtime/ports.js';
import { RuntimeStore } from '../../src/runtime/state.js';
import { ResourceRegistry } from '../../src/runtime/resources.js';

describe('collected assets on real SQLite and image storage', () => {
  let root: string, db: ReturnType<typeof openDatabase>, context: CommandContext, handlers: ReturnType<typeof createCollectedAssetHandlers>, png: Buffer;
  let events: unknown[];
  const source = { platform:'Shopify',pageUrl:'https://shop.example/products/cup?id=123&token=DO_NOT_STORE&utm_source=test#SECRET_FRAGMENT',title:'商品标题',collectedAt:'2026-11-06T12:00:00.000Z' };
  const input = (bytes = png): CollectionHostInput<'host.importCollectedAsset'> => ({ requestId:randomUUID(),projectId:'project',file:{name:'remote-name.png',mimeType:'image/png',base64:bytes.toString('base64')},source });
  const run = (data = input()) => handlers['host.importCollectedAsset'](data);
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(),'collection-import-')); db = openDatabase(join(root,'test.sqlite'));
    const repository = new EcomRepository(db); const storage = new LocalAssetStore(root); await storage.initialize();
    const store = new RuntimeStore(db); const resources = new ResourceRegistry(store, storage); events=[];
    db.prepare('INSERT INTO projects(id,name,verified_facts_json,platform_targets_json,default_mode,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('project','商品','["已验证原事实"]','["AMAZON"]','PIXEL_PROTECTED',source.collectedAt,source.collectedAt);
    context = {repository,storage,resources,signal:new AbortController().signal,transaction:<T>(cb:()=>T)=>store.transaction(cb),events:{publish:(event:unknown)=>{events.push(event);}},clock:()=>source.collectedAt,idFactory:randomUUID} as unknown as CommandContext;
    handlers = createCollectedAssetHandlers(context,db);
    png = await sharp({create:{width:32,height:24,channels:3,background:'#b67a34'}}).png().toBuffer();
  });
  afterEach(async () => { if(db?.open)db.close(); await rm(root,{recursive:true,force:true}); });
  it('fully decodes, fixes STYLE_REFERENCE and atomically publishes sanitized provenance and resources', async () => {
    const imported = await run(); expect(imported.status).toBe('IMPORTED');
    const asset=context.repository.getAsset(imported.assetId)!;
    expect(asset).toMatchObject({role:'STYLE_REFERENCE',width:32,height:24,originalName:'采集参考图.png',byteSize:png.length});
    expect(context.repository.getProject('project')).toMatchObject({verifiedFacts:['已验证原事实'],defaultMode:'PIXEL_PROTECTED'});
    expect(await context.resources.resolve({kind:'ASSET',id:asset.id})).toMatchObject({hash:asset.hash,mimeType:'image/png'});
    const sources=await handlers['host.collectionSources']({projectId:'project'});
    expect(sources.items).toEqual([{assetId:asset.id,platform:'Shopify',pageUrl:'https://shop.example/products/cup?id=123',title:'商品标题',collectedAt:source.collectedAt}]);
    expect(Value.Check(collectionHostOperations['host.collectionSources'].output,sources)).toBe(true);
    expect(JSON.stringify(sources)).not.toMatch(/DO_NOT_STORE|SECRET_FRAGMENT|remote-name|base64/);
    expect(events).toContainEqual({topic:'assets',projectId:'project'});
  });
  it.each([
    '/%61uth/PATH_CREDENTIAL_SECRET', '/%2561uth/PATH_CREDENTIAL_SECRET',
    '/products%2f%61uth%2fPATH_CREDENTIAL_SECRET', '/products%252f%2561uth%252fPATH_CREDENTIAL_SECRET',
    '/products%5csession%5cPATH_CREDENTIAL_SECRET', '/%6fauth/callback/PATH_CREDENTIAL_SECRET',
    '/%2574oken/PATH_CREDENTIAL_SECRET', '/login%3fPATH_CREDENTIAL_SECRET',
    '/%E0%A4/PATH_CREDENTIAL_SECRET', `/%25${'25'.repeat(9)}61uth/PATH_CREDENTIAL_SECRET`,
    ...Array.from({ length: 11 }, (_, depth) => {
      let parameter = ';jsessionid=PATH_CREDENTIAL_SECRET';
      for (let level = 0; level < depth; level++) parameter = encodeURIComponent(parameter);
      return `/products/cup${parameter}`;
    }),
  ].flatMap(path => [{ path, sanitized: false }, { path, sanitized: true }]))('never persists encoded auth secrets, before or after SQLite restart: %j', async ({ path, sanitized }) => {
    const raw = `https://shop.example${path}?id=123&token=QUERY_CREDENTIAL_SECRET#FRAGMENT_CREDENTIAL_SECRET`;
    const imported = await run({ ...input(), source: { ...source, pageUrl: sanitized ? sanitizeCollectionPageUrl(raw) : raw } });
    expect(imported.status).toBe('IMPORTED');
    expect(db.prepare('SELECT page_url FROM desktop_asset_provenance').all()).toEqual([{ page_url: 'https://shop.example/' }]);
    db.close();
    const databaseBytes = await readFile(join(root, 'test.sqlite'));
    for (const secret of ['PATH_CREDENTIAL_SECRET', 'QUERY_CREDENTIAL_SECRET', 'FRAGMENT_CREDENTIAL_SECRET']) expect(databaseBytes.includes(Buffer.from(secret))).toBe(false);
    db = openDatabase(join(root, 'test.sqlite'));
    const restarted = createCollectedAssetHandlers({ ...context, repository: new EcomRepository(db) }, db);
    expect((await restarted['host.collectionSources']({ projectId: 'project' })).items).toEqual([
      { assetId: imported.assetId, platform: source.platform, pageUrl: 'https://shop.example/', title: source.title, collectedAt: source.collectedAt },
    ]);
  });
  it.each([
    { name: '18-character Chinese product', path: `/products/${'杯'.repeat(18)}`, sanitized: false },
    { name: 'encoded 18-character Chinese product', path: `/products/${encodeURIComponent('杯'.repeat(18))}`, sanitized: false },
    { name: '160-character Chinese product', path: `/products/${'杯'.repeat(160)}`, sanitized: true },
    { name: 'long multi-segment product', path: `/${Array(15).fill('a'.repeat(150)).join('/')}`, sanitized: true },
  ])('persists the complete cleaned source or explicit origin across restart: $name', async ({ path, sanitized }) => {
    const raw = `https://shop.example${path}?id=123&token=QUERY_CREDENTIAL_SECRET#FRAGMENT_CREDENTIAL_SECRET`;
    const actual = new URL(`https://shop.example${path}?id=123`).href;
    const expected = actual.length <= 2048 ? actual : 'https://shop.example/';
    const imported = await run({ ...input(), source: { ...source, pageUrl: sanitized ? sanitizeCollectionPageUrl(raw) : raw } });
    expect(db.prepare('SELECT page_url FROM desktop_asset_provenance').all()).toEqual([{ page_url: expected }]);
    expect((await handlers['host.collectionSources']({ projectId: 'project' })).items[0]!.pageUrl).toBe(expected);
    db.close();
    const bytes = await readFile(join(root, 'test.sqlite'));
    expect(bytes.includes(Buffer.from('QUERY_CREDENTIAL_SECRET'))).toBe(false);
    expect(bytes.includes(Buffer.from('FRAGMENT_CREDENTIAL_SECRET'))).toBe(false);
    db = openDatabase(join(root, 'test.sqlite'));
    const restarted = createCollectedAssetHandlers({ ...context, repository: new EcomRepository(db) }, db);
    expect((await restarted['host.collectionSources']({ projectId: 'project' })).items[0]).toMatchObject({ assetId: imported.assetId, pageUrl: expected });
  });
  it('preserves role/source of duplicates, including concurrent downloads of the same image', async () => {
    const results=await Promise.all([run(),run()]);
    expect(results.map(result=>result.status).sort()).toEqual(['ALREADY_PRESENT','IMPORTED']);
    expect(results[0]!.assetId).toBe(results[1]!.assetId); expect(context.repository.listAssets('project')).toHaveLength(1);
    db.prepare("UPDATE assets SET role='PRODUCT_TRUTH' WHERE id=?").run(results[0]!.assetId);
    const repeated=await run({...input(),source:{...source,title:'不能覆盖原来源'}});
    expect(repeated).toEqual({assetId:results[0]!.assetId,status:'ALREADY_PRESENT'});
    expect(context.repository.getAsset(repeated.assetId)!.role).toBe('PRODUCT_TRUTH');
    expect((await handlers['host.collectionSources']({projectId:'project'})).items[0]!.title).toBe('商品标题');
  });
  it('does not attach a source to an existing local asset', async () => {
    const {createHash}=await import('node:crypto');
    const stored=await context.storage.putAsset('project','local.png',png);
    const local=context.repository.createAsset({projectId:'project',role:'PRODUCT_TRUTH',storagePath:stored.path,hash:createHash('sha256').update(png).digest('hex'),originalName:'local.png',mimeType:'image/png',width:32,height:24});
    expect(await run()).toEqual({assetId:local.id,status:'ALREADY_PRESENT'});
    expect((await handlers['host.collectionSources']({projectId:'project'})).items).toEqual([]);
  });
  it('rejects damaged, mismatched and truncated images before creating domain records', async () => {
    await expect(run(input(Buffer.from('bad-image')))).rejects.toMatchObject({code:'INVALID_IMAGE'});
    await expect(run({...input(),file:{...input().file,mimeType:'image/jpeg'}})).rejects.toMatchObject({code:'INVALID_IMAGE'});
    await expect(run(input(png.subarray(0,png.length-20)))).rejects.toMatchObject({code:'INVALID_IMAGE'});
    expect(context.repository.listAssets('project')).toEqual([]);
  });
  it('rechecks reference capacity after asynchronous writes and never adds product truth', async () => {
    for(let n=0;n<6;n++) context.repository.createAsset({projectId:'project',role:'STYLE_REFERENCE',storagePath:`assets/existing-${n}.png`,hash:`existing-${n}`,originalName:'old.png',mimeType:'image/png',width:1,height:1});
    await expect(run()).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    expect(context.repository.listAssets('project')).toHaveLength(6);
    db.prepare('DELETE FROM assets WHERE project_id=?').run('project');
    const put=context.storage.putAsset.bind(context.storage);
    vi.spyOn(context.storage,'putAsset').mockImplementation(async (...args)=>{
      const stored=await put(...args);
      for(let n=0;n<6;n++) context.repository.createAsset({projectId:'project',role:'STYLE_REFERENCE',storagePath:`assets/raced-${n}.png`,hash:`raced-${n}`,originalName:'raced.png',mimeType:'image/png',width:1,height:1});
      return stored;
    });
    await expect(run()).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    expect(context.repository.listAssets('project')).toHaveLength(6);
    expect(db.prepare('SELECT * FROM desktop_asset_provenance').all()).toEqual([]);
  });
  it('rolls back asset and resource registration when provenance insertion fails', async () => {
    db.exec("CREATE TRIGGER fixture_provenance_failure BEFORE INSERT ON desktop_asset_provenance BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
    await expect(run()).rejects.toMatchObject({code:'COLLECTION_IMPORT_FAILED'});
    expect(context.repository.listAssets('project')).toEqual([]);
    expect(db.prepare("SELECT id FROM desktop_resources WHERE id LIKE 'ASSET:%'").all()).toEqual([]);
    expect(db.prepare('SELECT * FROM desktop_asset_provenance').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM desktop_cleanup_queue').all()).toHaveLength(1);
  });
  it('rejects project deletion while an import is writing and registers staged cleanup', async () => {
    const put=context.storage.putAsset.bind(context.storage);
    vi.spyOn(context.storage,'putAsset').mockImplementation(async (...args)=>{const stored=await put(...args);db.prepare('DELETE FROM projects WHERE id=?').run('project');return stored;});
    await expect(run()).rejects.toMatchObject({code:'NOT_FOUND'});
    expect(db.prepare('SELECT * FROM assets').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM desktop_cleanup_queue').all()).toHaveLength(1);
  });
  it('cancels active writes and rejects a late delivery with the cancelled request identity', async () => {
    const data=input(); const put=context.storage.putAsset.bind(context.storage);
    vi.spyOn(context.storage,'putAsset').mockImplementation(async (...args)=>{const stored=await put(...args);await handlers['host.cancelCollectionImport']({requestId:data.requestId});return stored;});
    await expect(run(data)).rejects.toMatchObject({code:'CANCELLED'});
    await expect(run(data)).rejects.toMatchObject({code:'CANCELLED'});
    expect(context.repository.listAssets('project')).toEqual([]);
  });
  it('makes bounded local JPEG previews and sources survive restart and cascade on delete', async () => {
    const preview=await handlers['host.previewCollectionImage']({file:input().file});
    expect(Value.Check(collectionHostOperations['host.previewCollectionImage'].output,preview)).toBe(true);
    const metadata=await sharp(Buffer.from(preview.dataUrl.split(',')[1]!,'base64')).metadata(); expect(metadata.format).toBe('jpeg'); expect(metadata.width).toBe(32);
    const imported=await run(); db.close(); db=openDatabase(join(root,'test.sqlite'));
    const restarted=createCollectedAssetHandlers({...context,repository:new EcomRepository(db)},db);
    expect((await restarted['host.collectionSources']({projectId:'project'})).items[0]!.assetId).toBe(imported.assetId);
    db.prepare('DELETE FROM assets WHERE id=?').run(imported.assetId);
    expect((await restarted['host.collectionSources']({projectId:'project'})).items).toEqual([]);
  });
});
