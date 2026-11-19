/** v4 唯一新增的采集来源表；升级与空库使用同一份 DDL。 */
export const COLLECTION_PROVENANCE_SQL = `
CREATE TABLE desktop_asset_provenance (
  asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  page_url TEXT NOT NULL,
  title TEXT NOT NULL,
  collected_at TEXT NOT NULL
);
`;
/** v5 应用设置、价格与不可级联删除的用量快照。 */
export const APPLICATION_SETTINGS_USAGE_SQL = `
CREATE TABLE desktop_application_settings (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  settings_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE desktop_model_pricing (
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  pricing_json TEXT NOT NULL,
  PRIMARY KEY(provider_id,model_id)
);
CREATE TABLE desktop_usage_records (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  entry_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  UNIQUE(job_id,request_key)
);
CREATE INDEX idx_desktop_usage_started ON desktop_usage_records(started_at,id);
`;
/** v6 恢复游标由核心迁移管理，旧 v5 可尚未创建此维护表。 */
export const USAGE_RECOVERY_SQL = `
CREATE TABLE desktop_usage_recovery (
  lane TEXT PRIMARY KEY CHECK(lane IN ('pending','history')),
  runtime_rowid INTEGER NOT NULL CHECK(runtime_rowid>=0),
  request_offset INTEGER NOT NULL CHECK(request_offset>=0)
);
`;
/** 修订结果由首候选保存，同一画面的其他候选复用。 */
export const GENERATION_PROMPTS_SQL = `
CREATE TABLE desktop_generation_prompts (
  owner_job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;
/** v12 批次只组织既有任务，状态仍由任务记录提供。 */
export const SUITE_PLANNING_BATCH_SQL = `
CREATE TABLE desktop_suite_planning_batches (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
/** v7 项目图片目录；SKU 身份与产品引用按原子快照保存。 */
export const PRODUCT_IMAGE_PLANNING_TABLE_SQL = `
CREATE TABLE desktop_project_image_planning (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision>=1),
  config_json TEXT NOT NULL,
  skus_json TEXT NOT NULL,
  image_groups_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
/** 历史分镜默认未关联规划；保留所有原 ID、内容、状态与产物。 */
export const PRODUCT_IMAGE_PLANNING_COLUMNS_SQL = `
ALTER TABLE storyboard_items ADD COLUMN image_planning_json TEXT;
ALTER TABLE storyboard_items ADD COLUMN planning_stale INTEGER NOT NULL DEFAULT 0 CHECK(planning_stale IN (0,1));
ALTER TABLE storyboard_items ADD COLUMN planning_superseded INTEGER NOT NULL DEFAULT 0 CHECK(planning_superseded IN (0,1));
`;
/** v8 采用版本与详情顺序；仅保存公开 ID，不保存素材或 Provider 数据。 */
export const PROJECT_WORKBENCH_SQL = `
CREATE TABLE desktop_project_workbench (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision>=1),
  adoptions_json TEXT NOT NULL,
  detail_order_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
// JSON 只在有效且结构完整时展开；异常记录必须保持 UNKNOWN。
const verifiedRuntime = (jobId: string) => `EXISTS (
  SELECT 1 FROM desktop_job_runtime runtime WHERE runtime.job_id=${jobId}
  AND CASE WHEN json_valid(runtime.payload) THEN CASE WHEN
    json_extract(runtime.payload,'$.version')=1
    AND json_type(runtime.payload,'$.requests')='array'
    AND json_type(runtime.payload,'$.requestHistory')='array'
    AND json_type(runtime.payload,'$.reviews')='array'
  THEN
    json_array_length(runtime.payload,'$.requestHistory')>0
    AND NOT EXISTS (SELECT 1 FROM json_each(runtime.payload,'$.requests') r
      WHERE r.type<>'object' OR COALESCE(json_extract(CASE WHEN r.type='object' THEN r.value ELSE '{}' END,'$.state'),'')<>'COMPLETED')
    AND NOT EXISTS (SELECT 1 FROM json_each(runtime.payload,'$.requestHistory') h
      WHERE CASE WHEN h.type='object' THEN
        COALESCE(json_extract(h.value,'$.state'),'')<>'VERIFIED_FAILED'
        OR COALESCE(json_type(h.value,'$.descriptor.requestKey'),'')<>'text'
        OR COALESCE(json_extract(h.value,'$.descriptor.requestKey'),'')=''
        OR COALESCE(json_type(h.value,'$.startedAt'),'')<>'text'
        OR COALESCE(json_extract(h.value,'$.startedAt'),'')=''
        OR NOT EXISTS (SELECT 1 FROM json_each(runtime.payload,'$.reviews') review
          WHERE CASE WHEN review.type='object' THEN
            json_extract(review.value,'$.requestKey')=json_extract(h.value,'$.descriptor.requestKey')
            AND json_extract(review.value,'$.requestStartedAt')=json_extract(h.value,'$.startedAt')
            AND json_extract(review.value,'$.outcome') IN ('NOT_EXECUTED','FAILED')
            AND json_type(review.value,'$.encryptedEvidence')='text'
            AND length(json_extract(review.value,'$.encryptedEvidence'))>0
            AND json_type(review.value,'$.recordedAt')='text'
            AND length(json_extract(review.value,'$.recordedAt'))>0
          ELSE 0 END)
      ELSE 1 END)
  ELSE 0 END ELSE 0 END
)`;
const verifiedJob = (jobId: string) => `EXISTS (SELECT 1 FROM jobs verified_job
  WHERE verified_job.id=${jobId} AND verified_job.status='FAILED' AND verified_job.preserved_history=0
  AND CASE WHEN json_valid(verified_job.error_json) THEN json_extract(verified_job.error_json,'$.code')='VERIFIED_EXTERNAL_FAILURE' ELSE 0 END
  AND ${verifiedRuntime('verified_job.id')})`;
/** v9 仅允许有完整人工审计的未知请求终结为失败。 */
export const VERIFIED_FAILURE_TRIGGERS_SQL = `
CREATE TRIGGER desktop_unknown_no_retry BEFORE UPDATE ON jobs
WHEN OLD.status='UNKNOWN' AND (NEW.retryable<>0 OR (NEW.status<>'UNKNOWN' AND NOT (
  NEW.status='FAILED' AND NEW.preserved_history=0
  AND CASE WHEN json_valid(NEW.error_json) THEN COALESCE(json_extract(NEW.error_json,'$.code'),'')='VERIFIED_EXTERNAL_FAILURE' ELSE 0 END
  AND ${verifiedRuntime('OLD.id')}
)))
BEGIN SELECT RAISE(ABORT,'Unknown external outcome requires reconciliation'); END;
CREATE TRIGGER desktop_unknown_pipeline_no_retry BEFORE UPDATE ON pattern_pipeline_steps
WHEN (OLD.status='UNKNOWN' OR EXISTS(SELECT 1 FROM jobs WHERE id=OLD.job_id AND status='UNKNOWN'))
  AND (NEW.status IN ('PENDING','QUEUED','RUNNING','FAILED','CANCELLED') OR NEW.job_id IS NOT OLD.job_id OR (OLD.status='UNKNOWN' AND NEW.status<>'UNKNOWN'))
  AND NOT (OLD.status='UNKNOWN' AND NEW.status='FAILED' AND NEW.job_id IS OLD.job_id
    AND CASE WHEN json_valid(NEW.error_json) THEN COALESCE(json_extract(NEW.error_json,'$.code'),'')='VERIFIED_EXTERNAL_FAILURE' ELSE 0 END
    AND ${verifiedJob('OLD.job_id')})
BEGIN SELECT RAISE(ABORT,'Unknown pipeline outcome requires reconciliation'); END;
CREATE TRIGGER desktop_unknown_slot_no_retry BEFORE UPDATE ON draft_slots
WHEN (OLD.status='UNKNOWN' OR EXISTS(SELECT 1 FROM jobs WHERE id=OLD.job_id AND status='UNKNOWN'))
  AND (NEW.status IN ('QUEUED','RUNNING','FAILED','CANCELLED') OR NEW.job_id IS NOT OLD.job_id OR NEW.attempt<>OLD.attempt OR (OLD.status='UNKNOWN' AND NEW.status<>'UNKNOWN'))
  AND NOT (OLD.status='UNKNOWN' AND NEW.status='FAILED' AND NEW.job_id IS OLD.job_id AND NEW.attempt=OLD.attempt
    AND CASE WHEN json_valid(NEW.error_json) THEN COALESCE(json_extract(NEW.error_json,'$.code'),'')='VERIFIED_EXTERNAL_FAILURE' ELSE 0 END
    AND ${verifiedJob('OLD.job_id')})
BEGIN SELECT RAISE(ABORT,'Unknown draft outcome requires reconciliation'); END;
`;
// v10 中断记录只证明用户选择，不能将未知结果称作已核实失败。
const interruptedRuntime = (jobId: string, action: string) => `EXISTS (
  SELECT 1 FROM desktop_job_runtime runtime WHERE runtime.job_id=${jobId}
  AND CASE WHEN json_valid(runtime.payload) THEN CASE WHEN
    json_extract(runtime.payload,'$.version')=1
    AND json_type(runtime.payload,'$.attempt')='integer' AND json_extract(runtime.payload,'$.attempt')>=0
    AND json_type(runtime.payload,'$.requests')='array'
    AND json_type(runtime.payload,'$.requestHistory')='array'
    AND json_type(runtime.payload,'$.interruptions')='array'
  THEN
    NOT EXISTS (SELECT 1 FROM json_each(runtime.payload,'$.requests') r
      WHERE CASE WHEN r.type='object' THEN COALESCE(json_extract(r.value,'$.state'),'')<>'COMPLETED' ELSE 1 END)
    AND EXISTS (SELECT 1 FROM json_each(runtime.payload,'$.interruptions') i
      WHERE CASE WHEN i.type='object' THEN
        json_extract(i.value,'$.action')=${action}
        AND json_type(i.value,'$.recordedAt')='text' AND length(json_extract(i.value,'$.recordedAt'))>0
        AND json_type(i.value,'$.attempt')='integer' AND json_extract(i.value,'$.attempt')=json_extract(runtime.payload,'$.attempt')
        AND CASE WHEN json_type(i.value,'$.requests')='array' THEN json_array_length(i.value,'$.requests')>0
          AND NOT EXISTS (SELECT 1 FROM json_each(i.value,'$.requests') ir WHERE CASE WHEN ir.type='object' THEN
            COALESCE(json_type(ir.value,'$.requestKey'),'')<>'text' OR length(json_extract(ir.value,'$.requestKey'))=0
            OR COALESCE(json_type(ir.value,'$.startedAt'),'')<>'text' OR length(json_extract(ir.value,'$.startedAt'))=0
            OR (json_type(ir.value,'$.usageKey') IS NOT NULL AND (json_type(ir.value,'$.usageKey')<>'text' OR length(json_extract(ir.value,'$.usageKey'))=0))
            OR NOT EXISTS (SELECT 1 FROM json_each(runtime.payload,'$.requestHistory') h WHERE CASE WHEN h.type='object' THEN
              json_extract(h.value,'$.state')='UNKNOWN' AND json_extract(h.value,'$.descriptor.requestKey')=json_extract(ir.value,'$.requestKey')
              AND json_extract(h.value,'$.startedAt')=json_extract(ir.value,'$.startedAt')
              AND json_extract(h.value,'$.usageKey') IS json_extract(ir.value,'$.usageKey') ELSE 0 END)
          ELSE 1 END) ELSE 0 END
      ELSE 0 END)
    AND NOT EXISTS (SELECT 1 FROM json_each(runtime.payload,'$.requestHistory') h WHERE CASE WHEN h.type='object' THEN
      CASE WHEN json_extract(h.value,'$.state')='UNKNOWN' THEN
        COALESCE(json_type(h.value,'$.descriptor.requestKey'),'')<>'text' OR COALESCE(length(json_extract(h.value,'$.descriptor.requestKey')),0)=0
        OR COALESCE(json_type(h.value,'$.startedAt'),'')<>'text' OR COALESCE(length(json_extract(h.value,'$.startedAt')),0)=0
        OR (json_type(h.value,'$.usageKey') IS NOT NULL AND (json_type(h.value,'$.usageKey')<>'text' OR COALESCE(length(json_extract(h.value,'$.usageKey')),0)=0))
        OR NOT EXISTS (
        SELECT 1 FROM json_each(runtime.payload,'$.interruptions') i, json_each(CASE WHEN i.type='object' AND json_type(i.value,'$.requests')='array' THEN i.value ELSE '{"requests":[]}' END,'$.requests') ir
        WHERE CASE WHEN i.type='object' AND ir.type='object' THEN
          json_extract(i.value,'$.action') IN ('RETRY','END') AND json_type(i.value,'$.recordedAt')='text' AND length(json_extract(i.value,'$.recordedAt'))>0
          AND json_type(i.value,'$.attempt')='integer' AND json_extract(i.value,'$.attempt')>=0
          AND json_extract(ir.value,'$.requestKey')=json_extract(h.value,'$.descriptor.requestKey')
          AND json_extract(ir.value,'$.startedAt')=json_extract(h.value,'$.startedAt')
          AND json_extract(ir.value,'$.usageKey') IS json_extract(h.value,'$.usageKey') ELSE 0 END)
      WHEN json_extract(h.value,'$.state')='VERIFIED_FAILED' THEN NOT EXISTS (
        SELECT 1 FROM json_each(CASE WHEN json_type(runtime.payload,'$.reviews')='array' THEN runtime.payload ELSE '{"reviews":[]}' END,'$.reviews') review
        WHERE CASE WHEN review.type='object' THEN json_extract(review.value,'$.requestKey')=json_extract(h.value,'$.descriptor.requestKey')
          AND json_extract(review.value,'$.requestStartedAt')=json_extract(h.value,'$.startedAt')
          AND json_extract(review.value,'$.outcome') IN ('NOT_EXECUTED','FAILED')
          AND json_type(review.value,'$.encryptedEvidence')='text' AND length(json_extract(review.value,'$.encryptedEvidence'))>0
          AND json_type(review.value,'$.recordedAt')='text' AND length(json_extract(review.value,'$.recordedAt'))>0 ELSE 0 END)
      ELSE 1 END ELSE 1 END)
  ELSE 0 END ELSE 0 END
)`;
const interruptedJob = (jobId: string, status: string, error: string) => `EXISTS (SELECT 1 FROM jobs j WHERE j.id=${jobId} AND j.status=${status} AND j.preserved_history=0
  AND CASE WHEN json_valid(j.error_json) THEN json_extract(j.error_json,'$.code')=${error} ELSE 0 END
  AND ${interruptedRuntime('j.id', `CASE WHEN ${status}='FAILED' THEN 'RETRY' ELSE 'END' END`)})`;
/** v10 保留 v9 审计路径，并要求主动中断具有匹配请求身份的记录。 */
export const INTERRUPTION_TRIGGERS_SQL = `
CREATE TRIGGER desktop_unknown_no_retry BEFORE UPDATE ON jobs
WHEN OLD.status='UNKNOWN' AND (NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.storyboard_item_id IS NOT OLD.storyboard_item_id OR NEW.type IS NOT OLD.type OR NEW.input_json IS NOT OLD.input_json OR NEW.request_fingerprint IS NOT OLD.request_fingerprint OR NEW.provider_id IS NOT OLD.provider_id OR NEW.model_id IS NOT OLD.model_id OR NEW.retryable<>0 OR (NEW.status<>'UNKNOWN' AND NOT (
  NEW.preserved_history=0 AND OLD.preserved_history=0 AND (
    (NEW.status='FAILED' AND CASE WHEN json_valid(NEW.error_json) THEN COALESCE(json_extract(NEW.error_json,'$.code'),'')='VERIFIED_EXTERNAL_FAILURE' ELSE 0 END AND ${verifiedRuntime('OLD.id')}) OR
    (NEW.status IN ('FAILED','CANCELLED') AND CASE WHEN json_valid(NEW.error_json) THEN COALESCE(json_extract(NEW.error_json,'$.code'),'')=CASE NEW.status WHEN 'FAILED' THEN 'INTERRUPTED_RETRY' ELSE 'INTERRUPTED_ENDED' END ELSE 0 END
      AND ${interruptedRuntime('OLD.id', "CASE NEW.status WHEN 'FAILED' THEN 'RETRY' ELSE 'END' END")})
  ))))
BEGIN SELECT RAISE(ABORT,'Unknown external outcome requires reconciliation'); END;
CREATE TRIGGER desktop_unknown_pipeline_no_retry BEFORE UPDATE ON pattern_pipeline_steps
WHEN (OLD.status='UNKNOWN' OR EXISTS(SELECT 1 FROM jobs WHERE id=OLD.job_id AND status='UNKNOWN'))
 AND (NEW.status IN ('PENDING','QUEUED','RUNNING','FAILED','CANCELLED') OR NEW.job_id IS NOT OLD.job_id OR NEW.id IS NOT OLD.id OR NEW.pipeline_id IS NOT OLD.pipeline_id OR NEW.step IS NOT OLD.step OR NEW.position IS NOT OLD.position OR (OLD.status='UNKNOWN' AND NEW.status<>'UNKNOWN'))
 AND NOT (OLD.status='UNKNOWN' AND NEW.job_id IS OLD.job_id AND NEW.id IS OLD.id AND NEW.pipeline_id IS OLD.pipeline_id AND NEW.step IS OLD.step AND NEW.position IS OLD.position AND (
   (NEW.status='FAILED' AND CASE WHEN json_valid(NEW.error_json) THEN COALESCE(json_extract(NEW.error_json,'$.code'),'')='VERIFIED_EXTERNAL_FAILURE' ELSE 0 END AND ${verifiedJob('OLD.job_id')}) OR
   (NEW.status IN ('FAILED','CANCELLED') AND CASE WHEN json_valid(NEW.error_json) THEN COALESCE(json_extract(NEW.error_json,'$.code'),'')=CASE NEW.status WHEN 'FAILED' THEN 'INTERRUPTED_RETRY' ELSE 'INTERRUPTED_ENDED' END ELSE 0 END AND ${interruptedJob('OLD.job_id','NEW.status',"CASE NEW.status WHEN 'FAILED' THEN 'INTERRUPTED_RETRY' ELSE 'INTERRUPTED_ENDED' END")})))
BEGIN SELECT RAISE(ABORT,'Unknown pipeline outcome requires reconciliation'); END;
CREATE TRIGGER desktop_unknown_slot_no_retry BEFORE UPDATE ON draft_slots
WHEN (OLD.status='UNKNOWN' OR EXISTS(SELECT 1 FROM jobs WHERE id=OLD.job_id AND status='UNKNOWN'))
 AND (NEW.status IN ('QUEUED','RUNNING','FAILED','CANCELLED') OR NEW.job_id IS NOT OLD.job_id OR NEW.attempt<>OLD.attempt OR NEW.batch_id IS NOT OLD.batch_id OR NEW.slot_index IS NOT OLD.slot_index OR (OLD.status='UNKNOWN' AND NEW.status<>'UNKNOWN'))
 AND NOT (OLD.status='UNKNOWN' AND NEW.job_id IS OLD.job_id AND NEW.attempt=OLD.attempt AND NEW.batch_id IS OLD.batch_id AND NEW.slot_index IS OLD.slot_index AND (
   (NEW.status='FAILED' AND CASE WHEN json_valid(NEW.error_json) THEN COALESCE(json_extract(NEW.error_json,'$.code'),'')='VERIFIED_EXTERNAL_FAILURE' ELSE 0 END AND ${verifiedJob('OLD.job_id')}) OR
   (NEW.status IN ('FAILED','CANCELLED') AND CASE WHEN json_valid(NEW.error_json) THEN COALESCE(json_extract(NEW.error_json,'$.code'),'')=CASE NEW.status WHEN 'FAILED' THEN 'INTERRUPTED_RETRY' ELSE 'INTERRUPTED_ENDED' END ELSE 0 END AND ${interruptedJob('OLD.job_id','NEW.status',"CASE NEW.status WHEN 'FAILED' THEN 'INTERRUPTED_RETRY' ELSE 'INTERRUPTED_ENDED' END")})))
BEGIN SELECT RAISE(ABORT,'Unknown draft outcome requires reconciliation'); END;
`;
/** 桌面当前领域结构，不包含旧 Web 历史迁移链。 */
export const CURRENT_SCHEMA_SQL = `
${COLLECTION_PROVENANCE_SQL}
${APPLICATION_SETTINGS_USAGE_SQL}
${USAGE_RECOVERY_SQL}
${PRODUCT_IMAGE_PLANNING_TABLE_SQL}
${SUITE_PLANNING_BATCH_SQL}
${GENERATION_PROMPTS_SQL}
${PROJECT_WORKBENCH_SQL}
    CREATE TABLE providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      reasoning_protocol TEXT NOT NULL DEFAULT 'openai',
      encrypted_api_key TEXT NOT NULL,
      models_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE search_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      base_url TEXT NOT NULL,
      encrypted_api_key TEXT,
      priority INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT,
      product_description TEXT,
      verified_facts_json TEXT NOT NULL DEFAULT '[]',
      prohibited_claims_json TEXT NOT NULL DEFAULT '[]',
      brand_guidelines_json TEXT NOT NULL DEFAULT '{}',
      platform_targets_json TEXT NOT NULL,
      target_market TEXT,
      copy_language TEXT,
      prompt_language TEXT NOT NULL DEFAULT 'CHINESE',
      reasoning_provider_id TEXT,
      reasoning_model_id TEXT,
      image_provider_id TEXT,
      image_model_id TEXT,
      default_mode TEXT NOT NULL,
      image_resolution TEXT NOT NULL DEFAULT '1K',
      image_aspect_ratio TEXT NOT NULL DEFAULT 'AUTO',
      candidates_per_type INTEGER NOT NULL DEFAULT 1,
      web_research_enabled INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      planning_revision INTEGER NOT NULL DEFAULT 0,
      segmentation_provider_id TEXT,
      segmentation_model_id TEXT,
      segmentation_protocol TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (reasoning_provider_id) REFERENCES providers(id),
      FOREIGN KEY (image_provider_id) REFERENCES providers(id)
    );
    CREATE TABLE assets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      role TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      hash TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      byte_size INTEGER,
      width INTEGER,
      height INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE storyboards (
      project_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      status TEXT NOT NULL,
      campaign_style_lock TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE storyboard_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      storyboard_version INTEGER NOT NULL,
      asset_type TEXT NOT NULL,
      display_name TEXT NOT NULL,
      shot_role TEXT,
      template_variant TEXT,
      candidate_count INTEGER NOT NULL DEFAULT 1,
      image_provider_id TEXT,
      image_model_id TEXT,
      image_resolution TEXT,
      image_aspect_ratio TEXT,
      referenced_assets_json TEXT NOT NULL DEFAULT '[]',
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      prompt_instruction TEXT NOT NULL,
      compiled_prompt TEXT,
      fact_claims_json TEXT NOT NULL,
      risk_flags_json TEXT NOT NULL,
      image_planning_json TEXT,
      planning_source_json TEXT,
      planning_stale INTEGER NOT NULL DEFAULT 0 CHECK(planning_stale IN (0,1)),
      planning_superseded INTEGER NOT NULL DEFAULT 0 CHECK(planning_superseded IN (0,1)),
      sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      storyboard_item_id TEXT,
      type TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED','UNKNOWN')),
      progress INTEGER NOT NULL,
      retryable INTEGER NOT NULL CHECK(status<>'UNKNOWN' OR retryable=0),
      preserved_history INTEGER NOT NULL DEFAULT 0 CHECK(preserved_history IN (0,1)),
      input_json TEXT NOT NULL,
      request_fingerprint TEXT,
      provider_id TEXT,
      model_id TEXT,
      estimated_cost_json TEXT,
      actual_cost_json TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      provider_task_id TEXT,
      error_json TEXT,
      progress_detail_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (storyboard_item_id) REFERENCES storyboard_items(id) ON DELETE SET NULL
    );
    CREATE TABLE copywriting_results (
      job_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      target TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE web_research_audits (
      job_id TEXT PRIMARY KEY,
      availability TEXT NOT NULL,
      invocation_count INTEGER NOT NULL DEFAULT 0,
      successful_attempt_count INTEGER NOT NULL DEFAULT 0,
      failed_attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );
    CREATE TABLE web_research_attempts (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      query TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      result_count INTEGER NOT NULL,
      error_message TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );
    CREATE TABLE outputs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      storyboard_item_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      candidate_index INTEGER NOT NULL DEFAULT 1,
      generation_batch_id TEXT,
      generation_key TEXT,
      generation_snapshot_json TEXT,
      storage_path TEXT NOT NULL,
      hash TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      created_at TEXT NOT NULL,
      parent_output_id TEXT,
      root_output_id TEXT,
      edit_session_id TEXT,
      edit_turn_id TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (storyboard_item_id) REFERENCES storyboard_items(id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );
    CREATE TABLE planning_config_snapshots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source_job_id TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (source_job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );
    CREATE TABLE exports (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      status TEXT NOT NULL,
      storage_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );
    CREATE TABLE edit_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      current_output_id TEXT NOT NULL,
      status TEXT NOT NULL,
      memory_summary_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (current_output_id) REFERENCES outputs(id)
    );
    CREATE TABLE edit_turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      base_output_id TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT NOT NULL,
      annotations_json TEXT NOT NULL DEFAULT '{}',
      edit_mask_path TEXT,
      edit_mask_hash TEXT,
      protect_mask_path TEXT,
      protect_mask_hash TEXT,
      reference_asset_ids_json TEXT NOT NULL DEFAULT '[]',
      reference_selections_json TEXT NOT NULL DEFAULT '[]',
      plan_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES edit_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (base_output_id) REFERENCES outputs(id)
    );
    CREATE TABLE edit_reference_assets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      turn_id TEXT,
      storage_path TEXT NOT NULL,
      hash TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      purpose TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (session_id) REFERENCES edit_sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_assets_project_created ON assets(project_id, created_at);
    CREATE INDEX idx_storyboard_items_project_sort ON storyboard_items(project_id, storyboard_version, sort_order);
    CREATE INDEX idx_jobs_project_status_updated ON jobs(project_id, status, updated_at);
    CREATE INDEX idx_outputs_project_created ON outputs(project_id, created_at);
    CREATE INDEX idx_outputs_root_created ON outputs(root_output_id, created_at);
    CREATE INDEX idx_exports_project_updated ON exports(project_id, updated_at);
    CREATE INDEX idx_edit_turns_project_updated ON edit_turns(project_id, updated_at);
    CREATE TABLE user_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      default_size TEXT NOT NULL DEFAULT '1024x1024',
      supports_image_reference INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE user_suites (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      l1 TEXT NOT NULL,
      l2 TEXT NOT NULL,
      leaf TEXT NOT NULL,
      product_family TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE suite_forge_results (
      job_id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      suite_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );
    CREATE TABLE models (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      spec_json TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      reference_face_path TEXT,
      reference_face_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE model_portraits (
      id TEXT PRIMARY KEY,
      model_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      hash TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      provider_id TEXT NOT NULL,
      image_model_id TEXT NOT NULL,
      aspect_ratio TEXT NOT NULL,
      selected INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_model_portraits_model_created ON model_portraits(model_id, created_at DESC);


    CREATE TABLE layer_plans (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      output_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      output_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      elements_json TEXT NOT NULL DEFAULT '[]',
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE layer_exports (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      output_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      plan_id TEXT,
      status TEXT NOT NULL,
      include_background INTEGER NOT NULL DEFAULT 0,
      psd_storage_path TEXT,
      layer_files_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX idx_layer_plans_job ON layer_plans(job_id);
    CREATE INDEX idx_layer_plans_output ON layer_plans(output_id, created_at DESC);
    CREATE UNIQUE INDEX idx_layer_exports_job ON layer_exports(job_id);
    CREATE INDEX idx_layer_exports_output ON layer_exports(output_id, created_at DESC);


    CREATE TABLE patterns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_job_id TEXT,
      source_asset_hash TEXT,
      source_draft_candidate_id TEXT,
      parent_pattern_id TEXT,
      storage_path TEXT,
      file_hash TEXT,
      width INTEGER,
      height INTEGER,
      tags_json TEXT NOT NULL DEFAULT '[]',
      tileable_status TEXT NOT NULL DEFAULT 'NONE',
      tileable_score REAL,
      tileable_checked_with TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (parent_pattern_id) REFERENCES patterns(id) ON DELETE SET NULL
    );
    CREATE INDEX idx_patterns_created ON patterns(created_at DESC);
    -- source_job_id：每个花型任务的指纹复用判定与断点续跑都按它查；file_hash：资产库缩略图按 hash 找回花型。
    CREATE INDEX idx_patterns_source_job ON patterns(source_job_id);
    CREATE INDEX idx_patterns_file_hash ON patterns(file_hash);
    CREATE TABLE print_packs (
      id TEXT PRIMARY KEY,
      pattern_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      spec_id TEXT NOT NULL,
      spec_version TEXT NOT NULL,
      status TEXT NOT NULL,
      files_json TEXT,
      manifest_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (pattern_id) REFERENCES patterns(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX idx_print_packs_job ON print_packs(job_id);
    CREATE INDEX idx_print_packs_pattern ON print_packs(pattern_id, created_at DESC);
    CREATE TABLE pattern_listing_results (
      job_id TEXT PRIMARY KEY,
      pattern_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      content_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (pattern_id) REFERENCES patterns(id) ON DELETE CASCADE
    );
    -- 成包流水线：一条流水线是「图案 × 品类规格 × 平台」的一次串联执行，步骤各自对应一个任务行。
    -- pattern_id 可空：从花型墙的来源动作（提取/起稿/上传）起链时，花型要等 SOURCE 步骤完成才存在；
    -- 因此外键用 SET NULL 而不是 CASCADE——删花型不该连流水线历史一起抹掉（用户仍要看到它产过什么）。
    CREATE TABLE pattern_pipelines (
      id TEXT PRIMARY KEY,
      pattern_id TEXT,
      spec_id TEXT NOT NULL,
      spec_version TEXT NOT NULL,
      layout TEXT NOT NULL,
      repeat_layout TEXT NOT NULL,
      listing_platform TEXT NOT NULL,
      listing_provider_id TEXT NOT NULL,
      listing_model_id TEXT NOT NULL,
      listing_hints_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      block_reason TEXT,
      request_fingerprint TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (pattern_id) REFERENCES patterns(id) ON DELETE SET NULL
    );
    CREATE INDEX idx_pattern_pipelines_pattern ON pattern_pipelines(pattern_id, created_at DESC);
    CREATE INDEX idx_pattern_pipelines_fingerprint ON pattern_pipelines(request_fingerprint);
    -- 步骤表：position 决定推进顺序，不依赖枚举顺序；job_id 是唯一反查键（worker 靠它从完成的任务找回流水线）。
    CREATE TABLE pattern_pipeline_steps (
      id TEXT PRIMARY KEY,
      pipeline_id TEXT NOT NULL,
      step TEXT NOT NULL,
      position INTEGER NOT NULL,
      status TEXT NOT NULL,
      job_id TEXT,
      detail_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (pipeline_id) REFERENCES pattern_pipelines(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX idx_pattern_pipeline_steps_job ON pattern_pipeline_steps(job_id) WHERE job_id IS NOT NULL;
    CREATE INDEX idx_pattern_pipeline_steps_pipeline ON pattern_pipeline_steps(pipeline_id, position);


    CREATE TABLE pattern_drafts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      compose_type TEXT NOT NULL,
      conditions_json TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 1,
      selected_candidate_id TEXT,
      compare_candidate_id TEXT,
      archived_at TEXT,
      -- 参考图编号的发号器：只增不减，删除参考图不回收编号，因此编号允许出现空档。
      next_media_ordinal INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_pattern_drafts_updated ON pattern_drafts(archived_at, updated_at DESC);
    CREATE TABLE draft_media (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      role TEXT NOT NULL,
      source TEXT NOT NULL,
      source_pattern_id TEXT,
      storage_path TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      original_name TEXT NOT NULL,
      notes TEXT,
      -- 仅参考图有编号；蒙版为 NULL，不占用编号。
      ordinal INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (draft_id) REFERENCES pattern_drafts(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_draft_media_draft ON draft_media(draft_id, created_at);
    CREATE TABLE draft_batches (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      parent_candidate_id TEXT,
      provider_id TEXT,
      image_model_id TEXT,
      candidate_count INTEGER NOT NULL DEFAULT 1,
      instruction TEXT,
      snapshot_json TEXT NOT NULL,
      client_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (draft_id) REFERENCES pattern_drafts(id) ON DELETE CASCADE
    );
    -- 同 key 且同 payload 复用批次；同 key 异 payload 由 API 判定为冲突。唯一约束是这条规则的持久化兜底。
    CREATE UNIQUE INDEX idx_draft_batches_client_key ON draft_batches(draft_id, client_key);
    CREATE INDEX idx_draft_batches_draft ON draft_batches(draft_id, created_at);
    CREATE TABLE draft_slots (
      batch_id TEXT NOT NULL,
      slot_index INTEGER NOT NULL,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      job_id TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (batch_id, slot_index),
      FOREIGN KEY (batch_id) REFERENCES draft_batches(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_draft_slots_job ON draft_slots(job_id);
    CREATE TABLE draft_candidates (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      slot_index INTEGER NOT NULL,
      parent_candidate_id TEXT,
      storage_path TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      transform TEXT NOT NULL,
      tileable_horizontal REAL,
      tileable_vertical REAL,
      has_alpha INTEGER NOT NULL DEFAULT 0,
      tileable_status TEXT NOT NULL DEFAULT 'NONE',
      tileable_score REAL,
      tileable_checked_with TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (draft_id) REFERENCES pattern_drafts(id) ON DELETE CASCADE,
      FOREIGN KEY (batch_id) REFERENCES draft_batches(id) ON DELETE CASCADE
    );
    -- 一个槽位成功产物至多一份：迟到产物或并发写入触发唯一冲突而不是产生第二份候选。
    CREATE UNIQUE INDEX idx_draft_candidates_slot ON draft_candidates(batch_id, slot_index);
    CREATE INDEX idx_draft_candidates_draft ON draft_candidates(draft_id, created_at);

CREATE UNIQUE INDEX idx_patterns_source_draft_candidate ON patterns(source_draft_candidate_id) WHERE source_draft_candidate_id IS NOT NULL;
CREATE UNIQUE INDEX idx_outputs_generation_key_unique ON outputs(generation_key) WHERE generation_key IS NOT NULL;
CREATE INDEX idx_outputs_generation_batch ON outputs(project_id,generation_batch_id,created_at);
CREATE INDEX idx_planning_config_snapshots_project_created ON planning_config_snapshots(project_id,created_at DESC);
CREATE INDEX idx_assets_hash ON assets(hash);
CREATE INDEX idx_outputs_hash ON outputs(hash);
CREATE UNIQUE INDEX idx_model_portraits_selected ON model_portraits(model_id) WHERE selected=1;
CREATE INDEX idx_edit_reference_assets_session ON edit_reference_assets(session_id,created_at);
CREATE INDEX idx_jobs_queue ON jobs(status,created_at,id);
CREATE INDEX idx_jobs_fingerprint ON jobs(project_id,request_fingerprint,created_at DESC);
CREATE TABLE desktop_job_runtime (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE desktop_resources (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE desktop_cleanup_queue (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER desktop_history_no_execution_insert BEFORE INSERT ON jobs
WHEN NEW.preserved_history=1 AND (NEW.status IN ('QUEUED','RUNNING') OR NEW.retryable<>0)
BEGIN SELECT RAISE(ABORT,'Preserved desktop history cannot execute'); END;
CREATE TRIGGER desktop_history_no_execution_update BEFORE UPDATE ON jobs
WHEN OLD.preserved_history=1 AND (NEW.preserved_history<>1 OR NEW.status IN ('QUEUED','RUNNING') OR NEW.retryable<>0 OR NEW.input_json<>OLD.input_json OR NEW.request_fingerprint IS NOT OLD.request_fingerprint)
BEGIN SELECT RAISE(ABORT,'Preserved desktop history cannot execute or mutate its input'); END;
${INTERRUPTION_TRIGGERS_SQL}
`;
