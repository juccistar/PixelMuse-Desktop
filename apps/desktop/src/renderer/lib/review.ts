import type { Job, Output, StoryboardItem } from "../api/adapters/projectDetail";
import type { ProductImagePlanningContext, ProductImageTarget } from '@ecomgen/contracts';
import { outputRevision } from './outputMetadata';
/** 结果分组：按分镜聚合，组内按创建时间排序，便于同分镜对比。 */
export interface ReviewGroup {
    item: StoryboardItem;
    outputs: Output[];
}
export function groupOutputsByItem(items: readonly StoryboardItem[], outputs: readonly Output[]): ReviewGroup[] {
    const byItem = new Map<string, Output[]>();
    for (const output of outputs) {
        const bucket = byItem.get(output.storyboardItemId) ?? [];
        bucket.push(output);
        byItem.set(output.storyboardItemId, bucket);
    }
    return items
        .filter((item) => byItem.has(item.id))
        .map((item) => ({
        item,
        outputs: (byItem.get(item.id) ?? [])
            .slice()
            .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)),
    }));
}
/** 一个计划画面及其真实候选；未生成目标也保留位置。 */
export interface TargetReviewCard {
    id: string;
    targetId: string;
    context?: ProductImagePlanningContext | ProductImageTarget;
    item?: StoryboardItem;
    outputs: Output[];
    status: 'READY' | 'FAILED' | 'PENDING' | 'UNKNOWN' | 'EMPTY';
    pendingStatus?: 'QUEUED' | 'RUNNING';
    error?: string;
    historical: boolean;
}

/** 旧图仅按冻结归属分类，不能从今天的分镜推测旧图用途。 */
export function buildTargetReviewCards(items: readonly StoryboardItem[], outputs: readonly Output[], jobs: readonly Job[], targets: readonly ProductImageTarget[] = []): TargetReviewCard[] {
    const cards = new Map<string, TargetReviewCard>();
    for (const target of targets) {
        cards.set(target.targetId, { id: target.targetId, targetId: target.targetId, context: target, item: items.find(item => item.imagePlanning?.targetId === target.targetId && !item.planningSuperseded), outputs: [], status: 'EMPTY', historical: false });
    }
    for (const output of outputs) {
        // 编辑版本在新目标卡里参与候选；旧图继续在独立版本树中保留。
        if (output.editSessionId && !output.imagePlanning && outputs.some(candidate => candidate.id === (output.rootOutputId ?? output.parentOutputId))) continue;
        const targetId = output.imagePlanning?.targetId ?? output.storyboardItemId;
        const id = output.imagePlanning?.targetId ?? `${output.generationBatchId ?? output.jobId}:${output.storyboardItemId}`;
        let card = cards.get(id);
        if (!card) {
            card = { id, targetId, context: output.imagePlanning, item: items.find(item => item.id === output.storyboardItemId), outputs: [], status: 'READY', historical: true };
            cards.set(id, card);
        }
        card.outputs.push(output);
    }
    for (const item of items) {
        if (item.planningSuperseded || [...cards.values()].some(card => card.item?.id === item.id)) continue;
        const targetId = item.imagePlanning?.targetId ?? item.id;
        if (!cards.has(targetId)) cards.set(targetId, { id: targetId, targetId, context: item.imagePlanning, item, outputs: [], status: 'EMPTY', historical: !item.imagePlanning });
    }
    return [...cards.values()].map(card => {
        const itemIds = new Set(items.filter(item => item.id === card.item?.id || (!card.historical && !item.planningSuperseded && item.imagePlanning?.targetId === card.targetId)).map(item => item.id));
        const relatedJobs = jobs.filter(job => !job.history && job.type === 'GENERATE' && ((job.storyboardItemId && itemIds.has(job.storyboardItemId)) || (!job.storyboardItemId && job.status === 'UNKNOWN'))).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
        const latest = relatedJobs[0];
        const pendingStatus = relatedJobs.some(job => job.status === 'RUNNING') ? 'RUNNING' : relatedJobs.some(job => job.status === 'QUEUED') ? 'QUEUED' : undefined;
        const status: TargetReviewCard['status'] = relatedJobs.some(job => job.status === 'UNKNOWN') ? 'UNKNOWN' : pendingStatus ? 'PENDING' : card.outputs.length ? 'READY' : latest?.status === 'FAILED' ? 'FAILED' : 'EMPTY';
        return { ...card, status, pendingStatus, outputs: card.outputs.slice().sort((left, right) => left.createdAt.localeCompare(right.createdAt)), error: typeof latest?.error?.message === 'string' ? latest.error.message : undefined };
    });
}

export interface GenerationBatchReviewGroup {
    id: string;
    createdAt: string;
    retryCount: number;
    groups: ReviewGroup[];
}
/** 首次生成按用户的一次提交聚合；编辑输出在调用方排除，重试仍保留在原批次。 */
export function groupOutputsByGenerationBatch(items: readonly StoryboardItem[], outputs: readonly Output[], jobs: readonly Job[]): GenerationBatchReviewGroup[] {
    const jobsById = new Map(jobs.map((job) => [job.id, job]));
    const buckets = new Map<string, Output[]>();
    for (const output of outputs) {
        const id = output.generationBatchId ?? output.jobId ?? output.id;
        const bucket = buckets.get(id) ?? [];
        bucket.push(output);
        buckets.set(id, bucket);
    }
    return Array.from(buckets, ([id, batchOutputs]) => {
        const jobTimes = batchOutputs.map((output) => jobsById.get(output.jobId)?.createdAt).filter((time): time is string => Boolean(time));
        const createdAt = (jobTimes.length ? jobTimes : batchOutputs.map((output) => output.createdAt)).sort()[0]!;
        return {
            id,
            createdAt,
            retryCount: batchOutputs.filter((output) => outputRevision(output) === "retry").length,
            groups: groupOutputsByItem(items, batchOutputs),
        };
    }).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
