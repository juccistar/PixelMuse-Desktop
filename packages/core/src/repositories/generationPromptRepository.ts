import type { SqliteDatabase } from '../database.js';
import { now, type Row } from './internal.js';

/** 同画面修订后冻结的共享提示词。 */
export interface GenerationPromptRecord { ownerJobId: string; prompt: string; createdAt: string }
export class GenerationPromptRepository {
  public constructor(private readonly db: SqliteDatabase) {}
  public getGenerationPrompt(ownerJobId: string): GenerationPromptRecord | undefined {
    const row = this.db.prepare('SELECT * FROM desktop_generation_prompts WHERE owner_job_id=?').get(ownerJobId) as Row | undefined;
    return row ? { ownerJobId: String(row.owner_job_id), prompt: String(row.prompt), createdAt: String(row.created_at) } : undefined;
  }
  public saveGenerationPrompt(input: Pick<GenerationPromptRecord, 'ownerJobId' | 'prompt'>): GenerationPromptRecord {
    this.db.prepare('INSERT INTO desktop_generation_prompts(owner_job_id,prompt,created_at) VALUES(?,?,?) ON CONFLICT(owner_job_id) DO NOTHING').run(input.ownerJobId, input.prompt, now());
    const existing = this.getGenerationPrompt(input.ownerJobId)!;
    if (existing.prompt !== input.prompt) throw new Error('Generation prompt conflicts with saved result');
    return existing;
  }
}
