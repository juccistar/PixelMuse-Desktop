import type { SqliteDatabase } from './database.js';

/** 历史输入只供查看，不作为 v3 执行快照。含内部路径/密文，不可直接通过 IPC 返回。 */
export interface PreservedDesktopJobHistory {
  jobId: string;
  sourceVersion: number;
  kind: string;
  originalStatus: string;
  requestState: string;
  snapshotJson: string;
  resultJson: string | null;
  resultName: string | null;
  artifactPath: string | null;
  originalError: string | null;
  originalJobJson: string;
  migrationNote: string;
}

/** 原分镜版本的完整可读历史；dataJson 保留原始字节。 */
export interface StoryboardVersionRecord {
  id: string;
  projectId: string;
  version: number;
  sourceJobId: string | null;
  sourceVersion: number;
  confirmed: boolean;
  dataJson: string;
  createdAt: string;
}

/** 只读历史查询，和业务仓库使用同一连接。 */
export class DesktopHistoryRepository {
  public constructor(private readonly db: SqliteDatabase) {}

  public getPreservedJobHistory(jobId: string): PreservedDesktopJobHistory | undefined {
    const row = this.db.prepare('SELECT * FROM desktop_job_history WHERE job_id=?').get(jobId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return { jobId: String(row.job_id), sourceVersion: Number(row.source_version), kind: String(row.kind), originalStatus: String(row.original_status), requestState: String(row.request_state), snapshotJson: String(row.snapshot_json), resultJson: row.result_json == null ? null : String(row.result_json), resultName: row.result_name == null ? null : String(row.result_name), artifactPath: row.artifact_path == null ? null : String(row.artifact_path), originalError: row.original_error == null ? null : String(row.original_error), originalJobJson: String(row.original_job_json), migrationNote: String(row.migration_note) };
  }

  public listStoryboardVersions(projectId: string): StoryboardVersionRecord[] {
    return (this.db.prepare('SELECT * FROM storyboard_versions WHERE project_id=? ORDER BY version DESC').all(projectId) as Record<string, unknown>[]).map(row => ({ id: String(row.id), projectId: String(row.project_id), version: Number(row.version), sourceJobId: row.source_job_id == null ? null : String(row.source_job_id), sourceVersion: Number(row.source_version), confirmed: Boolean(row.confirmed), dataJson: String(row.data_json), createdAt: String(row.created_at) }));
  }

  public getPreservedProjectHistory(projectId: string): { sourceVersion: number; projectJson: string; settingsJson: string | null } | undefined {
    const row = this.db.prepare('SELECT * FROM desktop_project_history WHERE project_id=?').get(projectId) as Record<string, unknown> | undefined;
    return row ? { sourceVersion: Number(row.source_version), projectJson: String(row.project_json), settingsJson: row.settings_json == null ? null : String(row.settings_json) } : undefined;
  }
}
