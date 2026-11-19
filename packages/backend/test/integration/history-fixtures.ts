import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import archiver from 'archiver';
import { writePsdBuffer } from 'ag-psd';
import sharp from 'sharp';
import { SecretBox } from '@ecomgen/core';
import { suiteReply } from '../../../../scripts/full-mock-provider.mjs';
export const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const time = '2026-11-01T12:00:00.000Z';

export async function publishedFixture(root: string, version: 1 | 2, baseUrl = 'http://127.0.0.1:1/v1') {
  const key = randomBytes(32), ciphertext = new SecretBox(key).encrypt('isolated-historical-provider-key');
  const ids = Object.fromEntries(['project','provider','asset','export','layer','generated','unknown','plan','board','item','suite'].map(name => [name, randomUUID()])) as Record<'project'|'provider'|'asset'|'export'|'layer'|'generated'|'unknown'|'plan'|'board'|'item'|'suite', string>;
  const image = await sharp({ create: { width: 8, height: 6, channels: 4, background: '#bb3322' } }).png().toBuffer();
  const rgba = await sharp(image).ensureAlpha().raw().toBuffer();
  const imageData = { width: 8, height: 6, data: new Uint8ClampedArray(rgba) };
  const psd = writePsdBuffer({ width: 8, height: 6, imageData, children: [{ name: '原图', imageData }] });
  const zip = archiver('zip'); const chunks: Buffer[] = [];
  const finished = new Promise<void>((resolve, reject) => { zip.on('data', (chunk: Buffer) => chunks.push(chunk)); zip.once('end', resolve); zip.once('error', reject); });
  zip.append(image, { name: '已有图片.png' }); await zip.finalize(); await finished;
  const archive = Buffer.concat(chunks);
  await mkdir(join(root, 'assets')); await mkdir(join(root, 'exports'));
  await writeFile(join(root, 'assets', `${ids.asset}.png`), image);
  await writeFile(join(root, 'exports', `${ids.export}.zip`), archive);
  await writeFile(join(root, 'exports', `${ids.layer}.psd`), psd);
  const snapshot = `{ "version":1,"oldPayload":true,"privateSnapshot":{"storagePath":"C:/private/input.png","encryptedApiKey":"${ciphertext}"},"receipt":{"bodyBase64":"private"} }`;
  const suiteText = JSON.stringify(suiteReply({ id: 'history-suite', name: '已有套图', shotCount: 1 }), null, 2);
  const db = new Database(join(root, 'backend.sqlite'));
  try {
    // 实际发布的 desktop v1/v2 DDL，来源为基线 packages/backend/src/database.ts；不加载旧执行器。
    db.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL);
      CREATE TABLE assets(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),name TEXT NOT NULL,mimeType TEXT NOT NULL,size INTEGER NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,createdAt TEXT NOT NULL,file TEXT NOT NULL UNIQUE,sha256 TEXT NOT NULL);
      CREATE INDEX assets_project ON assets(projectId,id);
      CREATE TABLE providers(id TEXT PRIMARY KEY,name TEXT NOT NULL,protocol TEXT NOT NULL,baseUrl TEXT NOT NULL,model TEXT NOT NULL,encryptedKey TEXT NOT NULL,updatedAt TEXT NOT NULL);
      CREATE TABLE jobs(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),kind TEXT NOT NULL CHECK(kind ${version === 1 ? "='EXPORT'" : "IN ('EXPORT','PLAN','GENERATE','SEGMENT','LAYER','PATTERN','SUITE','PI_AGENT')"}),status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED'${version === 2 ? ",'UNKNOWN'" : ''})),progress REAL NOT NULL DEFAULT 0,cancelRequested INTEGER NOT NULL DEFAULT 0,error TEXT,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,resultName TEXT,fingerprint TEXT NOT NULL,snapshot TEXT NOT NULL${version === 2 ? ",requestState TEXT NOT NULL DEFAULT 'NOT_SENT' CHECK(requestState IN ('NOT_SENT','IN_FLIGHT','COMPLETED','UNKNOWN'))" : ''});
      CREATE INDEX jobs_queue ON jobs(status,createdAt,id);
      CREATE INDEX jobs_project ON jobs(projectId,createdAt);
      CREATE UNIQUE INDEX jobs_dedupe ON jobs(fingerprint) WHERE status IN ('QUEUED','RUNNING','SUCCEEDED'${version === 2 ? ",'UNKNOWN'" : ''});
      PRAGMA user_version=${version};
    `);
    if (version === 2) db.exec(`
      ALTER TABLE assets ADD COLUMN role TEXT NOT NULL DEFAULT 'STYLE_REFERENCE';
      ALTER TABLE providers ADD COLUMN reasoningProtocol TEXT NOT NULL DEFAULT 'openai';
      ALTER TABLE providers ADD COLUMN supportsVision INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE providers ADD COLUMN supportsThinking INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE providers ADD COLUMN supportsStructuredOutput INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE project_business(projectId TEXT PRIMARY KEY REFERENCES projects(id),settings TEXT NOT NULL);
      CREATE TABLE storyboards(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),jobId TEXT NOT NULL UNIQUE REFERENCES jobs(id),version INTEGER NOT NULL,confirmed INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL,UNIQUE(projectId,version));
      CREATE TABLE job_results(jobId TEXT PRIMARY KEY REFERENCES jobs(id),data TEXT NOT NULL);
    `);
    db.prepare('INSERT INTO projects VALUES(?,?,?,?,?)').run(ids.project, '已有商品', '已有描述', time, time);
    db.prepare('INSERT INTO providers(id,name,protocol,baseUrl,model,encryptedKey,updatedAt) VALUES(?,?,?,?,?,?,?)').run(ids.provider, '旧桌面服务', 'OPENAI', baseUrl, 'mock-reasoner', ciphertext, time);
    db.prepare('INSERT INTO assets(id,projectId,name,mimeType,size,width,height,createdAt,file,sha256) VALUES(?,?,?,?,?,?,?,?,?,?)').run(ids.asset, ids.project, '旧图.png', 'image/png', image.length, 8, 6, time, `assets/${ids.asset}.png`, sha(image));
    const add = (id: string, kind: string, status: string, resultName: string | null, requestState = 'NOT_SENT') => {
      db.prepare('INSERT INTO jobs(id,projectId,kind,status,progress,createdAt,updatedAt,resultName,fingerprint,snapshot,error) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, ids.project, kind, status, 25, time, time, resultName, `original-${id}`, snapshot, 'C:/private/raw-error');
      if (version === 2) db.prepare('UPDATE jobs SET requestState=? WHERE id=?').run(requestState, id);
    };
    add(ids.export, 'EXPORT', 'SUCCEEDED', '已有导出.zip');
    add(ids.unknown, version === 2 ? 'GENERATE' : 'EXPORT', version === 2 ? 'RUNNING' : 'QUEUED', null, version === 2 ? 'IN_FLIGHT' : 'NOT_SENT');
    if (version === 2) {
      add(ids.layer, 'LAYER', 'SUCCEEDED', '原图分层.psd');
      add(ids.generated, 'GENERATE', 'SUCCEEDED', null, 'COMPLETED');
      add(ids.plan, 'PLAN', 'SUCCEEDED', null, 'COMPLETED');
      add(ids.suite, 'SUITE', 'SUCCEEDED', null, 'COMPLETED');
      const board = { id: ids.board, projectId: ids.project, jobId: ids.plan, version: 1, confirmed: true, campaignStyleLock: '原始风格', items: [{ id: ids.item, assetType: 'hero-image', displayName: '已有首图', shotRole: 'HERO', candidateCount: 1, referencedAssets: [ids.asset], mode: 'CREATIVE', promptInstruction: 'original instruction', factClaims: [], riskFlags: [], sortOrder: 0 }] };
      db.prepare('INSERT INTO storyboards VALUES(?,?,?,?,?,?)').run(ids.board, ids.project, ids.plan, 1, 1, JSON.stringify(board));
      for (const [id, result] of [
        [ids.generated, { assetIds: [ids.asset], receipt: { bodyBase64: 'private' }, privateSnapshot: { encryptedApiKey: ciphertext } }],
        [ids.layer, { assetIds: [ids.asset], artifactName: '原图分层.psd' }],
        [ids.plan, { assetIds: [], storyboardId: ids.board }],
        [ids.suite, { assetIds: [], text: suiteText }],
      ] as const) db.prepare('INSERT INTO job_results VALUES(?,?)').run(id, JSON.stringify(result));
    }
  } finally { db.close(); }
  return { ids, key, ciphertext, snapshot, suiteText, image, psd, archive,
    options: { dataDir: root, masterKey: key.toString('base64'), version: 'published-migration-integration' } };
}
