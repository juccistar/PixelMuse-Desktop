import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { APPLICATION_SETTINGS_USAGE_SQL, COLLECTION_PROVENANCE_SQL, CURRENT_SCHEMA_SQL, USAGE_RECOVERY_SQL, PRODUCT_IMAGE_PLANNING_TABLE_SQL, PRODUCT_IMAGE_PLANNING_COLUMNS_SQL, PROJECT_WORKBENCH_SQL, INTERRUPTION_TRIGGERS_SQL, SUITE_PLANNING_BATCH_SQL, GENERATION_PROMPTS_SQL } from "./schema.js";

/** 仅 Backend owner 持有的 SQLite 连接。 */
export type SqliteDatabase = Database.Database;
/** 当前桌面领域 schema；与旧 Web schema 无兼容关系。 */
export const DESKTOP_SCHEMA_VERSION = 12;
const IDENTITY = "ecomgen-desktop-domain-v12";
type Row = Record<string, any>;

/** 由 Backend 调用一次；不启动定时器、不创建额外连接。 */
export function migrateDesktopDatabase(db: SqliteDatabase): void {
  if (db.inTransaction) throw new Error("Desktop migration requires an outermost transaction");
  const version = Number(db.pragma("user_version", { simple: true }));
  if (![0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].includes(version)) throw new Error("Unsupported desktop database version");
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(row => row.name);
  if (version >= 3) {
    const expectedIdentity = `ecomgen-desktop-domain-v${version}`;
    if (!tables.includes("desktop_schema")) throw new Error("Unrecognized desktop schema");
    const identities = db.prepare('SELECT version,identity FROM desktop_schema').all() as { version: number; identity: string }[];
    if (identities.length !== 1 || identities[0]?.version !== version || identities[0]?.identity !== expectedIdentity) throw new Error('Unrecognized desktop schema');
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND tbl_name='desktop_schema' UNION ALL SELECT 1 FROM sqlite_temp_master WHERE type='trigger' AND tbl_name='desktop_schema' LIMIT 1").get()) throw new Error('Unrecognized desktop schema identity triggers');
    for (const table of ["desktop_job_runtime", "desktop_resources", "desktop_cleanup_queue", "desktop_job_history", "desktop_project_history", "desktop_provider_history", "storyboard_versions"]) {
      if (!tables.includes(table)) throw new Error("Incomplete desktop schema");
    }
    for (const match of CURRENT_SCHEMA_SQL.matchAll(/CREATE TABLE (\w+)\s*\(([\s\S]*?)\);/g)) {
      if (version === 3 && match[1] === 'desktop_asset_provenance') continue;
      if (version < 5 && ['desktop_application_settings', 'desktop_model_pricing', 'desktop_usage_records'].includes(match[1]!)) continue;
      if (version < 6 && match[1] === 'desktop_usage_recovery') continue;
      if (version < 7 && match[1] === 'desktop_project_image_planning') continue;
      if (version < 8 && match[1] === 'desktop_project_workbench') continue;
      if (version < 12 && ['desktop_suite_planning_batches', 'desktop_generation_prompts'].includes(match[1]!)) continue;
      const actual = new Set((db.prepare(`PRAGMA table_info("${match[1]}")`).all() as { name: string }[]).map(column => column.name));
      // 先按来源版本验证；旧分镜没有 v7 业务快照列，不能要求它们已经存在。
      const required = [...match[2]!.matchAll(/^\s*(\w+)\s+(?:TEXT|INTEGER|REAL)\b/gm)].map(column => column[1]!)
        .filter(column => !(version < 7 && match[1] === 'storyboard_items' && ['image_planning_json', 'planning_stale', 'planning_superseded'].includes(column)))
        .filter(column => !(version < 12 && match[1] === 'storyboard_items' && column === 'planning_source_json'));
      if (!actual.size || required.some(column => !actual.has(column))) throw new Error("Incomplete desktop schema");
    }
    // v6 起维护游标已是完整受约束结构；升级 v7 时只验证并保留，不能重建或重置。
    if (version >= 6) validateUsageRecovery(db, false, false);
    if (version < DESKTOP_SCHEMA_VERSION) db.transaction(() => {
      if (version === 3) db.exec(COLLECTION_PROVENANCE_SQL);
      if (version < 5) db.exec(APPLICATION_SETTINGS_USAGE_SQL);
      // v5 的维护表可缺失；只兼容实际存在过的两种结构，保留游标而非重置历史扫描。
      if (version === 5) migrateV5UsageRecovery(db);
      else if (version < 5) db.exec(USAGE_RECOVERY_SQL);
      if (version < 7) {
        db.exec(PRODUCT_IMAGE_PLANNING_TABLE_SQL);
        db.exec(PRODUCT_IMAGE_PLANNING_COLUMNS_SQL);
      }
      if (version < 8) db.exec(PROJECT_WORKBENCH_SQL);
      if (version < 12) {
        db.exec('ALTER TABLE storyboard_items ADD COLUMN planning_source_json TEXT');
        db.exec(SUITE_PLANNING_BATCH_SQL);
        db.exec(GENERATION_PROMPTS_SQL);
      }
      // 只在升级至 v11 时扩展设置，v11 的用户配置必须原样保留。
      if (version < 11) {
      const settingsRow = db.prepare('SELECT settings_json FROM desktop_application_settings WHERE singleton=1').get() as { settings_json: string } | undefined;
      if (settingsRow) {
        const settings = JSON.parse(settingsRow.settings_json);
        if (!settings || typeof settings !== 'object' || Array.isArray(settings) || Object.hasOwn(settings, 'ai')) throw new Error('Invalid pre-v11 application settings');
        settings.ai = { requestTimeoutSeconds: 240, thinkingLevel: 'auto', maxOutputTokens: 16384, concurrency: 2 };
        db.prepare('UPDATE desktop_application_settings SET settings_json=? WHERE singleton=1').run(JSON.stringify(settings));
      }
      db.exec(`DROP TRIGGER desktop_unknown_no_retry; DROP TRIGGER desktop_unknown_pipeline_no_retry; DROP TRIGGER desktop_unknown_slot_no_retry;`);
      db.exec(INTERRUPTION_TRIGGERS_SQL);
      }
      if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Desktop migration found invalid references');
      const identityUpdate = db.prepare('UPDATE desktop_schema SET version=?,identity=? WHERE version=?').run(DESKTOP_SCHEMA_VERSION, IDENTITY, version);
      if (identityUpdate.changes !== 1) throw new Error('Desktop migration could not update schema identity');
      const result = db.prepare('SELECT version,identity FROM desktop_schema').all() as { version: number; identity: string }[];
      if (result.length !== 1 || result[0]?.version !== DESKTOP_SCHEMA_VERSION || result[0]?.identity !== IDENTITY) throw new Error('Desktop migration could not update schema identity');
      validateUsageRecovery(db, false, false);
      db.pragma(`user_version = ${DESKTOP_SCHEMA_VERSION}`);
    }).immediate();
    else validateUsageRecovery(db, false, false);
    return;
  }
  if (version === 0 && db.prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) throw new Error("Unversioned databases are not supported");
  if (version === 1 || version === 2) validateDesktopSource(db, tables, version);
  const foreignKeys = Number(db.pragma("foreign_keys", { simple: true }));
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      // 旧表只在此事务内短暂存在；成功后删除，避免保留第二份项目/Provider 真相。
      for (const table of tables) db.exec(`ALTER TABLE "${table}" RENAME TO "__desktop_source_${table}"`);
      db.exec(CURRENT_SCHEMA_SQL);
      db.exec(`
        CREATE TABLE desktop_schema (version INTEGER PRIMARY KEY, identity TEXT NOT NULL);
        CREATE TABLE desktop_job_history (
          job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
          source_version INTEGER NOT NULL, kind TEXT NOT NULL, original_status TEXT NOT NULL,
          request_state TEXT NOT NULL, snapshot_json TEXT NOT NULL, result_json TEXT,
          result_name TEXT, artifact_path TEXT, original_error TEXT,
          original_job_json TEXT NOT NULL, migration_note TEXT NOT NULL
        );
        CREATE TABLE desktop_project_history (
          project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
          source_version INTEGER NOT NULL, project_json TEXT NOT NULL, settings_json TEXT
        );
        CREATE TABLE desktop_provider_history (
          provider_id TEXT PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
          source_version INTEGER NOT NULL, data_json TEXT NOT NULL
        );
        CREATE TABLE storyboard_versions (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          version INTEGER NOT NULL, source_job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
          source_version INTEGER NOT NULL, confirmed INTEGER NOT NULL,
          data_json TEXT NOT NULL, created_at TEXT NOT NULL,
          UNIQUE(project_id, version)
        );
        CREATE INDEX idx_storyboard_versions_project ON storyboard_versions(project_id,version DESC);
      `);
      if (version !== 0) transformDesktopSource(db, version, tables);
      for (const table of [...tables].reverse()) db.exec(`DROP TABLE "__desktop_source_${table}"`);
      const invalid = db.pragma("foreign_key_check") as unknown[];
      if (invalid.length) throw new Error("Desktop migration found invalid references");
      db.prepare("INSERT INTO desktop_schema VALUES (?,?)").run(DESKTOP_SCHEMA_VERSION, IDENTITY);
      db.pragma(`user_version = ${DESKTOP_SCHEMA_VERSION}`);
    }).immediate();
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  }
}

function validateUsageRecovery(db: SqliteDatabase, allowRuntime: boolean, allowMissing: boolean): boolean {
  const tableName = 'desktop_usage_recovery';
  const objects = db.prepare("SELECT 'main' AS schema_name,type,name,tbl_name,sql FROM sqlite_master UNION ALL SELECT 'temp' AS schema_name,type,name,tbl_name,sql FROM sqlite_temp_master").all() as { schema_name: string; type: string; name: string; tbl_name: string; sql: string | null }[];
  const conflict = () => { throw new Error(`Malformed v${allowRuntime ? 5 : 6} desktop usage recovery schema`); };
  // 不执行或静默丢弃附着在维护表上的触发器、视图或自定义索引。
  if (objects.some(object => (object.type === 'trigger' || object.type === 'view') && (object.tbl_name === tableName || /\bdesktop_usage_recovery\b/i.test(object.sql ?? '')))) conflict();
  const named = objects.filter(object => object.name === tableName);
  if (!named.length) { if (!allowMissing) conflict(); return false; }
  if (named.length !== 1 || named[0]!.type !== 'table' || named[0]!.schema_name !== 'main') conflict();
  const normalize = (sql: string) => sql.split(/('(?:''|[^'])*')/).map((part, index) => index % 2 ? part : part.replace(/\s+/g, '').toLowerCase()).join('').replace(/;$/, '');
  const runtimeSql = 'CREATE TABLE desktop_usage_recovery (lane TEXT PRIMARY KEY, runtime_rowid INTEGER NOT NULL, request_offset INTEGER NOT NULL)';
  if (!(allowRuntime ? [runtimeSql, USAGE_RECOVERY_SQL] : [USAGE_RECOVERY_SQL]).some(sql => normalize(sql) === normalize(named[0]!.sql ?? ''))) conflict();
  const columns = db.prepare('PRAGMA table_xinfo(desktop_usage_recovery)').all();
  const expected = [
    { cid: 0, name: 'lane', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1, hidden: 0 },
    { cid: 1, name: 'runtime_rowid', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
    { cid: 2, name: 'request_offset', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
  ];
  if (JSON.stringify(columns) !== JSON.stringify(expected)) conflict();
  const indexes = db.prepare('PRAGMA index_list(desktop_usage_recovery)').all() as { origin: string }[];
  if (indexes.length !== 1 || indexes[0]!.origin !== 'pk') conflict();
  for (const object of objects.filter(object => object.type === 'table')) {
    const references = db.prepare(`PRAGMA ${object.schema_name}.foreign_key_list("${object.name.replaceAll('"', '""')}")`).all() as { table: string }[];
    if (references.some(reference => reference.table.toLowerCase() === tableName)) conflict();
  }
  if (db.prepare(`SELECT 1 FROM desktop_usage_recovery WHERE lane IS NULL OR lane NOT IN ('pending','history')
    OR typeof(runtime_rowid)<>'integer' OR runtime_rowid<0 OR typeof(request_offset)<>'integer' OR request_offset<0 LIMIT 1`).get()) conflict();
  return true;
}
function migrateV5UsageRecovery(db: SqliteDatabase): void {
  if (!validateUsageRecovery(db, true, true)) { db.exec(USAGE_RECOVERY_SQL); return; }
  db.exec('ALTER TABLE desktop_usage_recovery RENAME TO __desktop_v5_usage_recovery');
  db.exec(USAGE_RECOVERY_SQL);
  // SQLite 内部复制可完整保留 64 位游标，不经过 JavaScript 数字转换。
  db.exec(`INSERT INTO desktop_usage_recovery(lane,runtime_rowid,request_offset)
    SELECT lane,runtime_rowid,request_offset FROM __desktop_v5_usage_recovery;
    DROP TABLE __desktop_v5_usage_recovery;`);
}

/** 打开 Backend 唯一连接并显式迁移；失败会释放文件句柄。 */
export function openDatabase(filename: string): SqliteDatabase {
  if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
  const db = new Database(filename);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    migrateDesktopDatabase(db);
    return db;
  } catch (error) { db.close(); throw error; }
}

function validateDesktopSource(db: SqliteDatabase, tables: string[], version: number): void {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('trigger','view') LIMIT 1").get()) throw new Error("Unsupported executable desktop schema objects");
  const expected = version === 1 ? ["projects", "providers", "assets", "jobs"] : ["projects", "providers", "assets", "jobs", "project_business", "storyboards", "job_results"];
  if (tables.length !== expected.length || expected.some(table => !tables.includes(table))) throw new Error("Not a supported desktop v1/v2 database");
  const required: Record<string, string[]> = {
    projects: ["id", "name", "description", "createdAt", "updatedAt"],
    providers: ["id", "name", "protocol", "baseUrl", "model", "encryptedKey", "updatedAt"],
    assets: ["id", "projectId", "name", "mimeType", "size", "width", "height", "createdAt", "file", "sha256"],
    jobs: ["id", "projectId", "kind", "status", "progress", "cancelRequested", "error", "createdAt", "updatedAt", "resultName", "fingerprint", "snapshot"],
    ...(version === 2 ? { project_business: ["projectId", "settings"], storyboards: ["id", "projectId", "jobId", "version", "confirmed", "data"], job_results: ["jobId", "data"] } : {}),
  };
  if (version === 2) {
    required.assets!.push("role");
    required.providers!.push("reasoningProtocol", "supportsVision", "supportsThinking", "supportsStructuredOutput");
    required.jobs!.push("requestState");
  }
  for (const [table, columns] of Object.entries(required)) {
    const actual = (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(column => column.name);
    if (actual.length !== columns.length || columns.some(column => !actual.includes(column))) throw new Error("Not a supported desktop v1/v2 database");
  }
}

function sourceRows(db: SqliteDatabase, table: string): Row[] { return db.prepare(`SELECT * FROM "__desktop_source_${table}"`).all() as Row[]; }
function insert(db: SqliteDatabase, table: string, row: Row): void {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...columns.map(key => row[key]));
}
function json(value: unknown): string { return JSON.stringify(value); }
function parseObject(value: string): Row { const parsed = JSON.parse(value); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid desktop JSON record"); return parsed; }
function managedReference(path: string): string {
  // v2 允许平铺路径；只验证引用，不移动或复制文件。
  if (!path || path.includes("\\") || path.startsWith("/") || path.includes(":") || path.split("/").some(segment => !segment || segment === "." || segment === "..")) throw new Error("Unsafe managed file reference in desktop database");
  return path;
}
function transformDesktopSource(db: SqliteDatabase, version: number, tables: string[]): void {
  const providers = sourceRows(db, "providers");
  const providerById = new Map(providers.map(provider => [provider.id, provider]));
  for (const provider of providers) {
    insert(db, "providers", {
      id: provider.id, name: provider.name, base_url: provider.baseUrl, reasoning_protocol: provider.reasoningProtocol ?? "openai",
      encrypted_api_key: provider.encryptedKey,
      models_json: json([{ id: provider.model, supportsVision: Boolean(provider.supportsVision), supportsThinking: Boolean(provider.supportsThinking), supportsStructuredOutput: Boolean(provider.supportsStructuredOutput), supportsTools: false, imageApiKind: provider.protocol === "GEMINI" ? "gemini" : "openai_images" }]),
      created_at: provider.updatedAt, updated_at: provider.updatedAt,
    });
    insert(db, "desktop_provider_history", { provider_id: provider.id, source_version: version, data_json: json(provider) });
  }
  const rawSettings = new Map(tables.includes("project_business") ? sourceRows(db, "project_business").map(row => [row.projectId, row.settings as string]) : []);
  const settings = new Map([...rawSettings].map(([id, value]) => [id, parseObject(value)]));
  const projectSettings = new Map<string, Row>();
  for (const project of sourceRows(db, "projects")) {
    const config = settings.get(project.id) ?? {};
    projectSettings.set(project.id, config);
    const reasoning = providerById.get(config.reasoningProviderId);
    const image = providerById.get(config.imageProviderId);
    // v2 删除 Provider 不改 settings；失效选择清空，原始配置仍完整留在历史中。
    insert(db, "projects", { id: project.id, name: project.name, category: config.category ?? null, product_description: project.description,
      verified_facts_json: json(config.verifiedFacts ?? []), prohibited_claims_json: json(config.prohibitedClaims ?? []), brand_guidelines_json: json(config.brandGuidelines ?? {}),
      platform_targets_json: json(config.platformTargets ?? ["AMAZON"]), target_market: config.targetMarket ?? null, copy_language: config.copyLanguage ?? null, prompt_language: config.promptLanguage ?? "CHINESE",
      reasoning_provider_id: reasoning?.id ?? null, reasoning_model_id: reasoning?.model ?? null,
      image_provider_id: image?.id ?? null, image_model_id: image?.model ?? null,
      default_mode: config.defaultMode ?? "CREATIVE", image_resolution: config.imageResolution ?? "1K", image_aspect_ratio: config.imageAspectRatio ?? "AUTO",
      candidates_per_type: config.candidatesPerType ?? 1, web_research_enabled: config.webResearchEnabled ? 1 : 0,
      segmentation_provider_id: config.segmentationModel?.providerId ?? null, segmentation_model_id: config.segmentationModel?.modelId ?? null, segmentation_protocol: config.segmentationModel?.protocol ?? null,
      created_at: project.createdAt, updated_at: project.updatedAt,
    });
    insert(db, "desktop_project_history", { project_id: project.id, source_version: version, project_json: json(project), settings_json: rawSettings.get(project.id) ?? null });
  }
  for (const asset of sourceRows(db, "assets")) insert(db, "assets", { id: asset.id, project_id: asset.projectId, role: asset.role ?? "STYLE_REFERENCE",
    storage_path: managedReference(asset.file), hash: asset.sha256, original_name: asset.name, mime_type: asset.mimeType, byte_size: asset.size,
    width: asset.width, height: asset.height, created_at: asset.createdAt });
  const results = new Map(tables.includes("job_results") ? sourceRows(db, "job_results").map(row => [row.jobId, row.data]) : []);
  const typeMap: Record<string, string> = { EXPORT: "EXPORT", PLAN: "PLAN", PI_AGENT: "PLAN", GENERATE: "GENERATE", SEGMENT: "LAYER_EXPORT", LAYER: "LAYER_EXPORT", PATTERN: "PATTERN_DERIVE", SUITE: "SUITE_FORGE" };
  const oldJobs = sourceRows(db, "jobs");
  const projectIds = new Set(sourceRows(db, 'projects').map(project => project.id));
  if ([...settings.keys()].some(id => !projectIds.has(id)) || [...results.keys()].some(id => !oldJobs.some(job => job.id === id))) throw new Error('Orphan desktop historical record');
  for (const job of oldJobs) {
    // v2 在外部调用前持久化 IN_FLIGHT；RUNNING 也可能只进行到本地输入准备。
    const notSent = version === 2 && job.requestState === "NOT_SENT";
    const unknown = job.status === "UNKNOWN" || job.requestState === "IN_FLIGHT" || job.requestState === "UNKNOWN" || (job.status === "RUNNING" && !notSent && !["EXPORT", "LAYER", "PATTERN"].includes(job.kind));
    const status = unknown ? "UNKNOWN" : ["RUNNING", "QUEUED"].includes(job.status) ? "CANCELLED" : job.status;
    if (!typeMap[job.kind]) throw new Error("Unrecognized desktop job kind");
    const requestState = job.requestState ?? (unknown ? "UNKNOWN" : "NOT_SENT");
    const note = unknown ? "外部请求结果未知；仅保留历史，禁止自动重发。" : "桌面 v1/v2 任务快照仅作历史；不能按 v3 执行或重试。";
    insert(db, "jobs", { id: job.id, project_id: job.projectId, type: typeMap[job.kind], status, progress: job.progress,
      retryable: 0, preserved_history: 1, input_json: job.snapshot, request_fingerprint: job.fingerprint,
      cancel_requested: job.cancelRequested, provider_task_id: unknown ? "__EXTERNAL_REQUEST_STARTED__" : null,
      error_json: json({ code: unknown ? "EXTERNAL_RESULT_UNKNOWN" : "PRESERVED_DESKTOP_HISTORY", message: note, originalError: job.error }),
      created_at: job.createdAt, updated_at: job.updatedAt });
    const artifact = job.resultName && ["EXPORT", "LAYER"].includes(job.kind) ? managedReference(`exports/${job.id}.${job.kind === "LAYER" ? "psd" : "zip"}`) : null;
    insert(db, "desktop_job_history", { job_id: job.id, source_version: version, kind: job.kind, original_status: job.status, request_state: requestState,
      snapshot_json: job.snapshot, result_json: results.get(job.id) ?? null, result_name: job.resultName, artifact_path: artifact, original_error: job.error, original_job_json: json(job), migration_note: note });
    if (job.kind === "EXPORT") insert(db, "exports", { id: job.id, project_id: job.projectId, job_id: job.id, status, storage_path: artifact, created_at: job.createdAt, updated_at: job.updatedAt });
  }
  if (tables.includes("storyboards")) {
    const boards = sourceRows(db, "storyboards").sort((a, b) => a.version - b.version);
    const jobs = new Map(oldJobs.map(job => [job.id, job]));
    for (const board of boards) {
      const data = parseObject(board.data), config = projectSettings.get(board.projectId) ?? {};
      const createdAt = jobs.get(board.jobId)?.createdAt;
      if (!createdAt || jobs.get(board.jobId)?.projectId !== board.projectId || data.id !== board.id || data.projectId !== board.projectId || data.version !== board.version || !Array.isArray(data.items)) throw new Error("Invalid desktop storyboard reference");
      insert(db, "storyboard_versions", { id: board.id, project_id: board.projectId, version: board.version, source_job_id: board.jobId, source_version: version,
        confirmed: board.confirmed, data_json: board.data, created_at: createdAt });
      db.prepare(`INSERT INTO storyboards(project_id,version,status,campaign_style_lock,created_at,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(project_id) DO UPDATE SET version=excluded.version,status=excluded.status,campaign_style_lock=excluded.campaign_style_lock,updated_at=excluded.updated_at`)
        .run(board.projectId, board.version, board.confirmed ? "CONFIRMED" : "DRAFT", data.campaignStyleLock, createdAt, createdAt);
      for (const item of data.items as Row[]) insert(db, "storyboard_items", { id: item.id, project_id: board.projectId, storyboard_version: board.version,
        asset_type: item.assetType, display_name: item.displayName, shot_role: item.shotRole ?? null, template_variant: item.templateVariant ?? null,
        candidate_count: item.candidateCount, image_provider_id: providerById.get(config.imageProviderId)?.id ?? null,
        image_model_id: providerById.get(config.imageProviderId)?.model ?? null, image_resolution: config.imageResolution ?? "1K", image_aspect_ratio: config.imageAspectRatio ?? "AUTO",
        referenced_assets_json: json(item.referencedAssets), mode: item.mode, status: board.confirmed ? "CONFIRMED" : "DRAFT", prompt_instruction: item.promptInstruction,
        fact_claims_json: json(item.factClaims), risk_flags_json: json(item.riskFlags), sort_order: item.sortOrder, created_at: createdAt, updated_at: createdAt });
    }
  }
}
