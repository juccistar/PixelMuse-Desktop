import type { ProjectImagePlanning } from '@ecomgen/domain';
import type { SqliteDatabase } from '../database.js';
import { json, parse, type Row } from './internal.js';

/** 项目工作台持久记录；不包含下载临时选择或本地路径。 */
export interface ProjectWorkbenchRecord {
  projectId: string; revision: number; adoptions: Array<{ targetId: string; outputId: string }>;
  detailOrder: string[]; updatedAt: string | null;
}

/** 项目目录仓储；连接由门面注入，可与分镜标记和 revision 在同一事务组合。 */
export class ProductImagePlanningRepository {
  public constructor(private readonly db: SqliteDatabase) {}
  public getProjectWorkbench(projectId: string): ProjectWorkbenchRecord {
    const row = this.db.prepare('SELECT * FROM desktop_project_workbench WHERE project_id=?').get(projectId) as Row | undefined;
    return row ? { projectId, revision: Number(row.revision), adoptions: parse(row.adoptions_json), detailOrder: parse(row.detail_order_json), updatedAt: String(row.updated_at) } : { projectId, revision: 0, adoptions: [], detailOrder: [], updatedAt: null };
  }
  public saveProjectWorkbench(state: ProjectWorkbenchRecord): ProjectWorkbenchRecord {
    this.db.prepare(`INSERT INTO desktop_project_workbench(project_id,revision,adoptions_json,detail_order_json,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,adoptions_json=excluded.adoptions_json,detail_order_json=excluded.detail_order_json,updated_at=excluded.updated_at`)
      .run(state.projectId, state.revision, json(state.adoptions), json(state.detailOrder), state.updatedAt);
    return this.getProjectWorkbench(state.projectId);
  }
  public getProjectImagePlanning(projectId: string): ProjectImagePlanning | undefined {
    const row = this.db.prepare('SELECT * FROM desktop_project_image_planning WHERE project_id=?').get(projectId) as Row | undefined;
    return row ? { projectId: String(row.project_id), revision: Number(row.revision), config: parse(row.config_json), skus: parse(row.skus_json), imageGroups: parse(row.image_groups_json), updatedAt: String(row.updated_at) } : undefined;
  }
  /** CAS 在命令事务内校验；本方法保留传入的版本与业务快照，不隐式加版本。 */
  public saveProjectImagePlanning(state: ProjectImagePlanning): ProjectImagePlanning {
    if (!Number.isSafeInteger(state.revision) || state.revision < 1 || !state.updatedAt) throw new Error('Persisted image planning requires a positive revision and timestamp');
    this.db.prepare(`INSERT INTO desktop_project_image_planning(project_id,revision,config_json,skus_json,image_groups_json,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,config_json=excluded.config_json,skus_json=excluded.skus_json,image_groups_json=excluded.image_groups_json,updated_at=excluded.updated_at`)
      .run(state.projectId, state.revision, json(state.config), json(state.skus), json(state.imageGroups), state.updatedAt);
    return this.getProjectImagePlanning(state.projectId)!;
  }
}
