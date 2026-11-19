import { randomUUID } from "node:crypto";
import type {
  ImageAspectRatio,
  ImageResolution,
  StoryboardMode,
  StoryboardShotRole,
  ProductImagePlanningContext,
  StoryboardPlanningSource,
} from "@ecomgen/domain";
import type { SqliteDatabase } from "../database.js";
import type { ProjectRepository } from "./projectRepository.js";
import { type Row, json, now, parse } from "./internal.js";

export interface StoryboardRecord {
  projectId: string;
  version: number;
  status: "DRAFT" | "CONFIRMED";
  campaignStyleLock: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoryboardItemRecord {
  id: string;
  projectId: string;
  storyboardVersion: number;
  assetType: string;
  displayName: string;
  // 规划语义、不可变；历史行无值时为 null，由 UI 按"未标注"处理
  shotRole: StoryboardShotRole | null;
  templateVariant: string | null;
  candidateCount: number;
  imageProviderId: string | null;
  imageModelId: string | null;
  imageResolution: ImageResolution;
  imageAspectRatio: ImageAspectRatio;
  referencedAssets: string[];
  mode: StoryboardMode;
  status: "DRAFT" | "CONFIRMED" | "GENERATING" | "GENERATED";
  promptInstruction: string;
  compiledPrompt: string | null;
  factClaims: string[];
  riskFlags: string[];
  /** 历史行无规划归属，不从当前目录回填。 */
  imagePlanning?: ProductImagePlanningContext;
  planningSource?: StoryboardPlanningSource;
  planningStale?: boolean;
  planningSuperseded?: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export class StoryboardRepository {
  /** 新建分镜要继承项目的模型/分辨率默认值：注入项目仓库做存在性校验与默认值读取。 */
  public constructor(private readonly db: SqliteDatabase, private readonly projects: Pick<ProjectRepository, "getProject">) { }

  public getStoryboard(projectId: string): StoryboardRecord | undefined { const row = this.db.prepare("SELECT * FROM storyboards WHERE project_id=?").get(projectId); return row ? mapStoryboard(row as Row) : undefined; }
  public saveStoryboard(projectId: string, campaignStyleLock: string, status: StoryboardRecord["status"], items: Array<Omit<StoryboardItemRecord, "id" | "projectId" | "storyboardVersion" | "createdAt" | "updatedAt" | "imageProviderId" | "imageModelId" | "imageResolution" | "imageAspectRatio"> & Partial<Pick<StoryboardItemRecord, "imageProviderId" | "imageModelId" | "imageResolution" | "imageAspectRatio">>>): StoryboardRecord {
    const project = this.projects.getProject(projectId);
    if (!project) throw new Error(`Project not found for storyboard ${projectId}`);
    const previous = this.getStoryboard(projectId);
    const storyboard: StoryboardRecord = { projectId, version: (previous?.version ?? 0) + 1, status, campaignStyleLock, createdAt: previous?.createdAt ?? now(), updatedAt: now() };
    const write = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO storyboards (project_id,version,status,campaign_style_lock,created_at,updated_at) VALUES (@projectId,@version,@status,@campaignStyleLock,@createdAt,@updatedAt)
        ON CONFLICT(project_id) DO UPDATE SET version=excluded.version,status=excluded.status,campaign_style_lock=excluded.campaign_style_lock,updated_at=excluded.updated_at`).run(storyboard);
      const sortOffset = Number((this.db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS value FROM storyboard_items WHERE project_id=?").get(projectId) as { value: number }).value) + 1;
      const insert = this.db.prepare(`INSERT INTO storyboard_items (id,project_id,storyboard_version,asset_type,display_name,shot_role,template_variant,candidate_count,image_provider_id,image_model_id,image_resolution,image_aspect_ratio,referenced_assets_json,mode,status,prompt_instruction,compiled_prompt,fact_claims_json,risk_flags_json,image_planning_json,planning_source_json,planning_stale,planning_superseded,sort_order,created_at,updated_at)
        VALUES (@id,@projectId,@storyboardVersion,@assetType,@displayName,@shotRole,@templateVariant,@candidateCount,@imageProviderId,@imageModelId,@imageResolution,@imageAspectRatio,@referencedAssets,@mode,@status,@promptInstruction,@compiledPrompt,@factClaims,@riskFlags,@imagePlanning,@planningSource,@planningStale,@planningSuperseded,@sortOrder,@createdAt,@updatedAt)`);
      items.forEach((item, index) => insert.run({
        ...item,
        shotRole: item.shotRole ?? null,
        imageProviderId: item.imageProviderId ?? project.imageProviderId,
        imageModelId: item.imageModelId ?? project.imageModelId,
        imageResolution: item.imageResolution ?? project.imageResolution,
        imageAspectRatio: item.imageAspectRatio ?? project.imageAspectRatio,
        id: randomUUID(),
        projectId,
        storyboardVersion: storyboard.version,
        sortOrder: sortOffset + (item.sortOrder ?? index),
        referencedAssets: json(item.referencedAssets),
        factClaims: json(item.factClaims),
        riskFlags: json(item.riskFlags),
        imagePlanning: item.imagePlanning ? json(item.imagePlanning) : null,
        planningSource: item.planningSource ? json(item.planningSource) : null,
        planningStale: item.planningStale ? 1 : 0,
        planningSuperseded: item.planningSuperseded ? 1 : 0,
        createdAt: storyboard.updatedAt,
        updatedAt: storyboard.updatedAt
      }));
      const id = randomUUID();
      const data = { ...storyboard, id, items: this.listStoryboardItems(projectId).filter(item => item.storyboardVersion === storyboard.version) };
      this.db.prepare('INSERT INTO storyboard_versions(id,project_id,version,source_job_id,source_version,confirmed,data_json,created_at) VALUES(?,?,?,NULL,3,?,?,?)')
        .run(id, projectId, storyboard.version, status === 'CONFIRMED' ? 1 : 0, json(data), storyboard.updatedAt);
    }); write(); return storyboard;
  }
  public listStoryboardItems(projectId: string): StoryboardItemRecord[] { return (this.db.prepare("SELECT * FROM storyboard_items WHERE project_id=? ORDER BY sort_order").all(projectId) as Row[]).map(mapStoryboardItem); }
  public getStoryboardItem(id: string): StoryboardItemRecord | undefined { const row = this.db.prepare("SELECT * FROM storyboard_items WHERE id=?").get(id); return row ? mapStoryboardItem(row as Row) : undefined; }
  public deleteStoryboardItem(id: string): StoryboardItemRecord | undefined {
    const row = this.db.prepare("SELECT * FROM storyboard_items WHERE id=?").get(id);
    if (!row) return undefined;
    this.db.prepare("DELETE FROM storyboard_items WHERE id=?").run(id);
    return mapStoryboardItem(row as Row);
  }
  public updateStoryboardItem(id: string, patch: Partial<Pick<StoryboardItemRecord, "assetType" | "displayName" | "templateVariant" | "candidateCount" | "imageProviderId" | "imageModelId" | "imageResolution" | "imageAspectRatio" | "referencedAssets" | "mode" | "promptInstruction" | "compiledPrompt" | "status" | "sortOrder" | "factClaims" | "riskFlags" | "planningStale" | "planningSuperseded">>): StoryboardItemRecord | undefined {
    const current = this.getStoryboardItem(id); if (!current) return undefined; const next = { ...current, ...patch, planningSource: current.planningSource, updatedAt: now() };
    this.db.prepare(`UPDATE storyboard_items SET asset_type=@assetType,display_name=@displayName,template_variant=@templateVariant,candidate_count=@candidateCount,image_provider_id=@imageProviderId,image_model_id=@imageModelId,image_resolution=@imageResolution,image_aspect_ratio=@imageAspectRatio,referenced_assets_json=@referencedAssets,mode=@mode,status=@status,prompt_instruction=@promptInstruction,compiled_prompt=@compiledPrompt,fact_claims_json=@factClaims,risk_flags_json=@riskFlags,planning_stale=@planningStale,planning_superseded=@planningSuperseded,sort_order=@sortOrder,updated_at=@updatedAt WHERE id=@id`)
      .run({ ...next, referencedAssets: json(next.referencedAssets), factClaims: json(next.factClaims), riskFlags: json(next.riskFlags), planningStale: next.planningStale ? 1 : 0, planningSuperseded: next.planningSuperseded ? 1 : 0 }); return next;
  }
  public confirmStoryboard(projectId: string): StoryboardRecord | undefined {
    const current = this.getStoryboard(projectId); if (!current) return undefined;
    const updatedAt = now();
    const write = this.db.transaction(() => {
      this.db.prepare("UPDATE storyboards SET status='CONFIRMED',updated_at=? WHERE project_id=?").run(updatedAt, projectId);
      this.db.prepare("UPDATE storyboard_items SET status='CONFIRMED',updated_at=? WHERE project_id=? AND status='DRAFT' AND planning_superseded=0 AND planning_stale=0").run(updatedAt, projectId);
      const version = this.db.prepare('SELECT id FROM storyboard_versions WHERE project_id=? AND version=? AND source_version=3').get(projectId,current.version) as { id: string } | undefined;
      if (version) {
        const data = { ...current, id: version.id, status: 'CONFIRMED', updatedAt, items: this.listStoryboardItems(projectId).filter(item => item.storyboardVersion === current.version) };
        this.db.prepare('UPDATE storyboard_versions SET confirmed=1,data_json=? WHERE id=?').run(json(data),version.id);
      }
    });
    write(); return this.getStoryboard(projectId);
  }
}

function mapStoryboard(row: Row): StoryboardRecord { return { projectId: String(row.project_id), version: Number(row.version), status: row.status as StoryboardRecord["status"], campaignStyleLock: String(row.campaign_style_lock), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
function mapStoryboardItem(row: Row): StoryboardItemRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    storyboardVersion: Number(row.storyboard_version),
    assetType: String(row.asset_type),
    displayName: String(row.display_name ?? row.asset_type),
    shotRole: row.shot_role ? (String(row.shot_role) as StoryboardShotRole) : null,
    templateVariant: row.template_variant ? String(row.template_variant) : null,
    candidateCount: Number(row.candidate_count ?? 1),
    imageProviderId: row.image_provider_id ? String(row.image_provider_id) : null,
    imageModelId: row.image_model_id ? String(row.image_model_id) : null,
    imageResolution: row.image_resolution as ImageResolution,
    imageAspectRatio: row.image_aspect_ratio as ImageAspectRatio,
    referencedAssets: parse(row.referenced_assets_json ?? "[]"),
    mode: row.mode as StoryboardMode,
    status: row.status as StoryboardItemRecord["status"],
    promptInstruction: String(row.prompt_instruction),
    compiledPrompt: row.compiled_prompt ? String(row.compiled_prompt) : null,
    factClaims: parse(row.fact_claims_json),
    riskFlags: parse(row.risk_flags_json),
    ...(row.image_planning_json ? { imagePlanning: parse<ProductImagePlanningContext>(row.image_planning_json) } : {}),
    ...(row.planning_source_json ? { planningSource: parse<StoryboardPlanningSource>(row.planning_source_json) } : {}),
    planningStale: Boolean(row.planning_stale),
    planningSuperseded: Boolean(row.planning_superseded),
    sortOrder: Number(row.sort_order),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}
