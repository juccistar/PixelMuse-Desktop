// Electron-only, isolated fixture bootstrap/inspection. Never receives a plaintext master key.
import { createRequire } from 'node:module';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function inspectDatabase({ filename, appPackage, electronPackage, mode = 'summary', ids }) {
  const Database = createRequire(appPackage)('better-sqlite3');
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    const version = db.pragma('user_version', { simple: true });
    const integrity = db.pragma('integrity_check', { simple: true });
    const foreignKeys = db.pragma('foreign_key_check');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
    const counts = Object.fromEntries(tables.filter(name => /^[a-z_]+$/.test(name)).map(name => [name, db.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n]));
    if (mode === 'summary') return { version, integrity, foreignKeys, counts };
    if (mode === 'research') return { audit: db.prepare('SELECT job_id,availability,invocation_count,successful_attempt_count,failed_attempt_count FROM web_research_audits WHERE job_id=?').get(ids.jobId), attempts: db.prepare('SELECT source_id,source_kind,status,result_count FROM web_research_attempts WHERE job_id=? ORDER BY rowid').all(ids.jobId) };
    if (mode === 'sourcePipeline') return db.prepare("SELECT pipeline_id AS id FROM pattern_pipeline_steps WHERE job_id=? AND step='SOURCE'").get(ids.jobId);
    const provider = db.prepare('SELECT * FROM providers WHERE id=?').get(ids.provider);
    const encrypted = provider.encrypted_api_key;
    const jobs = db.prepare('SELECT id,status,retryable,preserved_history,input_json,request_fingerprint FROM jobs WHERE project_id=? ORDER BY id').all(ids.project);
    const storyboardItems = db.prepare('SELECT id FROM storyboard_items WHERE project_id=? ORDER BY id').all(ids.project);
    const { safeStorage } = createRequire(electronPackage)('electron');
    const master = Buffer.from(safeStorage.decryptString(await readFile(join(filename, '../../master-key.enc'))), 'base64');
    let decryptable;
    try {
      const bytes = Buffer.from(encrypted, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', master, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      decryptable = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString() === 'e2e-full-synthetic-v2-key';
    } finally { master.fill(0); }
    const histories = db.prepare('SELECT job_id,snapshot_json,original_status,request_state,result_json,original_job_json FROM desktop_job_history ORDER BY job_id').all();
    const storyboards = db.prepare('SELECT id,project_id,data_json FROM storyboard_versions WHERE project_id=? ORDER BY version').all(ids.project);
    const asset = db.prepare('SELECT id,storage_path,hash FROM assets WHERE id=?').get(ids.asset);
    return { version, integrity, foreignKeys, counts, providerId: provider.id, ciphertextHash: createHash('sha256').update(encrypted).digest('hex'), decryptable, jobs, histories, storyboards, storyboardItems, asset };
  } finally { db.close(); }
}

// Windows flushes Local State at orderly shutdown. Carry only the DPAPI-wrapped
// safeStorage profile key from this run's CLOSED synthetic profile, not its data.
export async function prepareIsolatedV2Profile({ fixture, sourceUserData, userData }) {
  const base = await realpath(fixture);
  if (resolve(fixture) !== base || resolve(sourceUserData) !== join(base, 'user-data') ||
      resolve(userData) !== join(base, 'migration-user-data') ||
      await realpath(sourceUserData) !== resolve(sourceUserData) ||
      await realpath(userData) !== resolve(userData)) throw new Error('Profile envelopes require separate direct fixture children');
  if (process.platform !== 'win32') return;
  const state = JSON.parse(await readFile(join(sourceUserData, 'Local State'), 'utf8'));
  const envelope = state.os_crypt?.encrypted_key;
  if (typeof envelope !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(envelope) ||
      Buffer.from(envelope, 'base64').subarray(0, 5).toString() !== 'DPAPI') throw new Error('Synthetic profile safeStorage envelope is unavailable');
  await writeFile(join(userData, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: envelope } }), { flag: 'wx', mode: 0o600 });
}

// Called only by the fixed guard loader in an already-ready real main process.
// The running Backend retains sole ownership of its own database/userData.
export async function seedIsolatedV2(config, { app, safeStorage, auditFile }) {
  if (!app.isReady()) throw new Error('Isolated v2 seed requires a ready main process');
  const fixture = await realpath(config.fixture);
  if (resolve(config.fixture) !== fixture || !(await lstat(fixture)).isDirectory() ||
      resolve(dirname(auditFile)) !== fixture) throw new Error('Seed fixture must match the current guard fixture');
  const userData = resolve(config.userData);
  const liveData = await realpath(app.getPath('userData'));
  if (userData !== join(fixture, 'migration-user-data') || liveData !== join(fixture, 'user-data') ||
      liveData.startsWith(userData + '/') || liveData.startsWith(userData + '\\') ||
      resolve(config.image) !== join(fixture, 'product.png')) throw new Error('Seed must use the separate migration fixture child');
  const origin = new URL(config.baseUrl);
  if (!globalThis.__ecomgenFullGuard?.origins.includes(origin.origin)) throw new Error('Seed provider must use the guarded fixture origin');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage unavailable for isolated v2 seed');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const Database = createRequire(join(root, 'packages/backend/package.json'))('better-sqlite3');
  // Keep the published v2 definition as a versioned test fixture; local source snapshots are not required.
  const source = await readFile(join(root, 'scripts/fixtures/desktop-v2-database.ts.fixture'), 'utf8');
  const blocks = [...source.matchAll(/db\.exec\(`([\s\S]*?)`\)/g)].map(match => match[1]);
  if (blocks.length !== 2 || !source.includes('version > 2')) throw new Error('Unexpected baseline v2 schema; fixture needs review');
  // mkdir without recursive rejects any existing directory or symlink before
  // a database, key envelope or resource can be touched.
  await mkdir(userData);
  const data = join(userData, 'data');
  await mkdir(join(data, 'assets'), { recursive: true });
  const ids = Object.fromEntries(['project', 'provider', 'asset', 'plan', 'complete', 'unknown', 'queued', 'running', 'board', 'item'].map(name => [name, randomUUID()]));
  const master = randomBytes(32);
  let encrypted;
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', master, iv);
    const ciphertext = Buffer.concat([cipher.update('e2e-full-synthetic-v2-key'), cipher.final()]);
    encrypted = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
    await writeFile(join(userData, 'master-key.enc'), safeStorage.encryptString(master.toString('base64')), { flag: 'wx', mode: 0o600 });
  } finally { master.fill(0); }
  const image = await readFile(config.image);
  const hash = createHash('sha256').update(image).digest('hex');
  const file = `assets/${ids.asset}.png`;
  await writeFile(join(data, file), image, { flag: 'wx' });
  const timestamp = '2026-11-01T12:00:00.000Z';
  const snapshot = '{ "version":1, "preserve-exact-whitespace":true, "oldPaidIntent":"do-not-execute" }';
  const board = { id: ids.board, projectId: ids.project, jobId: ids.plan, version: 1, confirmed: true, campaignStyleLock: 'synthetic v2 history', items: [{ id: ids.item, assetType: 'hero-image', displayName: 'V2 preserved item', shotRole: 'HERO', candidateCount: 1, referencedAssets: [ids.asset], mode: 'PIXEL_PROTECTED', promptInstruction: 'Preserve exact synthetic product identity and source pixels.', factClaims: [], riskFlags: [], sortOrder: 0 }] };
  const filename = join(data, 'backend.sqlite');
  await writeFile(filename, '', { flag: 'wx', mode: 0o600 });
  const db = new Database(filename, { fileMustExist: true });
  try {
    db.pragma('foreign_keys = ON');
    db.transaction(() => {
      db.exec(blocks[0]);
      db.exec(blocks[1]);
      db.prepare('INSERT INTO projects VALUES(?,?,?,?,?)').run(ids.project, 'V2 isolated migration', 'Synthetic history', timestamp, timestamp);
      db.prepare('INSERT INTO providers VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(ids.provider, 'V2 local fixture', 'OPENAI', config.baseUrl, 'mock-image', encrypted, timestamp, 'openai', 1, 0, 1);
      db.prepare('INSERT INTO assets(id,projectId,name,mimeType,size,width,height,createdAt,file,sha256,role) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(ids.asset, ids.project, 'v2.png', 'image/png', image.length, config.width, config.height, timestamp, file, hash, 'PRODUCT_TRUTH');
      db.prepare('INSERT INTO project_business VALUES(?,?)').run(ids.project, JSON.stringify({ category: 'home', verifiedFacts: ['synthetic ceramic'], prohibitedClaims: ['medical'], platformTargets: ['AMAZON'], targetMarket: 'UNITED_STATES', copyLanguage: 'en-US', promptLanguage: 'ENGLISH', reasoningProviderId: ids.provider, imageProviderId: ids.provider, defaultMode: 'PIXEL_PROTECTED' }));
      const insert = db.prepare('INSERT INTO jobs(id,projectId,kind,status,progress,createdAt,updatedAt,fingerprint,snapshot,requestState) VALUES(?,?,?,?,?,?,?,?,?,?)');
      insert.run(ids.plan, ids.project, 'PLAN', 'SUCCEEDED', 100, timestamp, timestamp, 'e2e-v2-plan-original-fingerprint', snapshot, 'COMPLETED');
      insert.run(ids.unknown, ids.project, 'GENERATE', 'UNKNOWN', 37, timestamp, timestamp, 'e2e-v2-unknown-original-fingerprint', snapshot, 'UNKNOWN');
      insert.run(ids.complete, ids.project, 'GENERATE', 'SUCCEEDED', 100, timestamp, timestamp, 'e2e-v2-complete-original-fingerprint', snapshot, 'COMPLETED');
      insert.run(ids.queued, ids.project, 'GENERATE', 'QUEUED', 0, timestamp, timestamp, 'e2e-v2-queued-original-fingerprint', snapshot, 'NOT_SENT');
      insert.run(ids.running, ids.project, 'GENERATE', 'RUNNING', 37, timestamp, timestamp, 'e2e-v2-running-original-fingerprint', snapshot, 'IN_FLIGHT');
      db.prepare('INSERT INTO storyboards VALUES(?,?,?,?,?,?)').run(ids.board, ids.project, ids.plan, 1, 1, JSON.stringify(board));
      const addResult = db.prepare('INSERT INTO job_results VALUES(?,?)');
      addResult.run(ids.plan, JSON.stringify({ storyboardId: ids.board, assetIds: [ids.asset] }));
      addResult.run(ids.complete, JSON.stringify({ jobId: ids.complete, assetIds: [ids.asset], opaqueResult: 'preserve result history' }));
    })();
    if (db.pragma('user_version', { simple: true }) !== 2) throw new Error('Baseline did not create schema v2');
  } finally { db.close(); }
  return { ids, snapshot, boardJson: JSON.stringify(board), ciphertextHash: createHash('sha256').update(encrypted).digest('hex'), imageHash: hash, file, baselineSourceHash: createHash('sha256').update(source).digest('hex') };
}
