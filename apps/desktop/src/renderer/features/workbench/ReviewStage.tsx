import { useBusinessActive } from '../../components/businessActivity';
import { App, Button, Image, InputNumber, Modal, Select } from "antd";
import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Download, LoaderCircle, Maximize2, Minus, Plus, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import type { Job, Output, ProjectDetail, StoryboardItem } from "../../api/adapters/projectDetail";
import { useProviders } from "../../api/hooks/useProviders";
import { ManageModelsButton } from '../settings/settingsNavigation';
import { useStoryboard } from "../../api/hooks/useStoryboard";
import { useTemplateNames } from "../../api/hooks/useTemplates";
import { ModeBadge } from "../../components/ModeBadge";
import { downloadOriginal, outputFileName } from "../../lib/downloadImage";
import { errorText } from "../../lib/errorText";
import { outputPreviewUrl, outputThumbnailUrl } from "../../lib/assetUrl";
import { itemDisplayName } from "../../lib/itemName";
import { imagePlanningLabel, IMAGE_PURPOSE_LABEL, type ImagePurposeFilter } from '../../lib/productImagePlanning';
import { buildTargetReviewCards, groupOutputsByGenerationBatch } from "../../lib/review";
import type { ProductImageTarget } from '@ecomgen/contracts';
import { formatDateTime } from "../../lib/format";
import { outputRevision } from '../../lib/outputMetadata';
import styles from "./workbench.module.css";
import stackStyles from "./ReviewStack.module.css";
import layoutStyles from "./ResultsLayout.module.css";
import type { GenerationJobInput } from "../../api/serializeGenerationBody";
import { IMAGE_OUTPUT_FORMATS, IMAGE_QUALITIES, imageParamSupportFor } from "@ecomgen/contracts";
import { RESOLUTION_LABEL } from "../../lib/roles";
import { ASPECT_SELECT_OPTIONS, renderAspectOption } from "./aspectOptions";
import { modelOptions } from "../../lib/modelOptions";
import { EditImageWorkspace } from "./EditImageWorkspace";
/** 在看图序列里前后移动一格；首尾相接，序列不足两张或当前不在序列里时保持原地。 */
function stepThrough(sequence: readonly string[], currentId: string | null, delta: number): string | null {
    const index = currentId ? sequence.indexOf(currentId) : -1;
    if (index < 0 || sequence.length < 2)
        return currentId;
    return sequence[(index + delta + sequence.length) % sequence.length] ?? currentId;
}
/** 预览层图片的半宽，由 usePreviewNavOffset 写入；样式靠它把 antd 的翻页按钮贴到图片两侧。 */
const PREVIEW_IMAGE_HALF = "--ecomgen-preview-image-half";
/**
 * antd 预览的翻页按钮固定在视口两缘（各 8px），窄图两侧会空出几百像素。
 * 预览打开后量图片的布局宽度（offsetWidth 不含 transform，缩放时按钮不会跟着跑到视口外），
 * 写进 CSS 变量收拢按钮；量不到时保持未设置，样式按视口比例估算。
 */
function usePreviewNavOffset(open: boolean): void {
    useEffect(() => {
        if (!open)
            return;
        let observer: ResizeObserver | undefined;
        let cancelled = false;
        const measure = () => {
            const image = document.querySelector<HTMLImageElement>(".ant-image-preview-img");
            const root = document.querySelector<HTMLElement>(".ant-image-preview");
            if (!image || !root || image.offsetWidth === 0)
                return;
            root.style.setProperty(PREVIEW_IMAGE_HALF, `${image.offsetWidth / 2}px`);
        };
        // 预览层是独立 portal：打开当帧还没排版，等两帧再量。切换图片与图片解码完成都会改变布局宽度。
        const frame = requestAnimationFrame(() => requestAnimationFrame(() => {
            if (cancelled)
                return;
            measure();
            const image = document.querySelector<HTMLImageElement>(".ant-image-preview-img");
            if (!image || typeof ResizeObserver === "undefined")
                return;
            observer = new ResizeObserver(measure);
            observer.observe(image);
        }));
        window.addEventListener("resize", measure);
        return () => {
            cancelled = true;
            cancelAnimationFrame(frame);
            observer?.disconnect();
            window.removeEventListener("resize", measure);
        };
    }, [open]);
}
/** 左右方向键翻图；输入控件里不拦截，避免抢走 Select 与输入框的按键。 */
function useArrowNavigation(enabled: boolean, onPrev: () => void, onNext: () => void): void {
    const businessActive = useBusinessActive();
    useEffect(() => {
        if (!businessActive || !enabled)
            return;
        const handleKeyDown = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            if (target?.isContentEditable || (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)))
                return;
            if (event.key === "ArrowLeft") {
                event.preventDefault();
                onPrev();
            }
            else if (event.key === "ArrowRight") {
                event.preventDefault();
                onNext();
            }
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [businessActive, enabled, onPrev, onNext]);
}
export function ReviewStage({ detail, selectedOutputIds, onSelectionChange, onRetryItem, targets = [], adoptions = [], onAdopt, adopting = false, onBackToPlanning }: {
    detail: ProjectDetail;
    targets?: ProductImageTarget[];
    adoptions?: Array<{ targetId: string; outputId: string }>;
    onAdopt?: (targetId: string, outputId: string | null) => void;
    adopting?: boolean;
    onBackToPlanning?: () => void;
    selectedOutputIds: string[];
    onSelectionChange: (ids: string[]) => void;
    onRetryItem: (itemId: string, generationConfig: NonNullable<GenerationJobInput["generationConfig"]>, generationBatchId?: string) => Promise<Job[]> | void;
}) {
    const { notification } = App.useApp();
    const board = useStoryboard(detail.id);
    const providers = useProviders();
    const templateNames = useTemplateNames();
    // 当前分镜查询不含被替代版本；成图仍须保留其原分镜与冻结语义。
    const items = useMemo(() => Array.from(new Map([...detail.items, ...(board.data?.items ?? [])].map(item => [item.id, item])).values()), [detail.items, board.data?.items]);
    const businessActive = useBusinessActive();
    const originalOutputs = useMemo(() => detail.outputs.filter((output) => !output.editSessionId), [detail.outputs]);
    const editedOutputs = useMemo(() => detail.outputs.filter((output) => Boolean(output.editSessionId)), [detail.outputs]);
    const batches = useMemo(() => groupOutputsByGenerationBatch(items, originalOutputs, detail.jobs), [originalOutputs, items, detail.jobs]);
    const editedByRoot = useMemo(() => {
        const grouped = new Map<string, Output[]>();
        for (const output of editedOutputs) {
            const rootId = output.rootOutputId ?? output.parentOutputId;
            if (!rootId)
                continue;
            const bucket = grouped.get(rootId) ?? [];
            bucket.push(output);
            grouped.set(rootId, bucket.sort((left, right) => left.createdAt.localeCompare(right.createdAt)));
        }
        return grouped;
    }, [editedOutputs]);
    const [purpose, setPurpose] = useState<ImagePurposeFilter>('ALL');
    const [onlyPending, setOnlyPending] = useState(false);
    const [downloadingId, setDownloadingId] = useState<string | null>(null);
    const [lightboxId, setLightboxId] = useState<string | null>(null);
    const [previewOpen, setPreviewOpen] = useState(false);
    const [previewIndex, setPreviewIndex] = useState(0);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [versionRootId, setVersionRootId] = useState<string | null>(null);
    // ref 在 React 更新前锁住连点；任务提交后继续用持久化任务状态显示进度。
    const retryLocks = useRef(new Set<string>());
    const [submittingItems, setSubmittingItems] = useState<ReadonlySet<string>>(new Set());
    const [submittedJobs, setSubmittedJobs] = useState<Job[]>([]);
    const effectiveJobs = useMemo(() => {
        const jobs = new Map(submittedJobs.map(job => [job.id, job]));
        for (const job of detail.jobs) {
            const submitted = jobs.get(job.id);
            jobs.set(job.id, { ...job, storyboardItemId: job.storyboardItemId ?? submitted?.storyboardItemId });
        }
        return [...jobs.values()];
    }, [detail.jobs, submittedJobs]);
    const cards = useMemo(() => buildTargetReviewCards(items, detail.outputs, effectiveJobs, targets), [items, detail.outputs, effectiveJobs, targets]);
    const visibleCards = cards.filter(card => (purpose === 'ALL' || (card.context?.purpose ?? 'LEGACY') === purpose) && (!onlyPending || !adoptions.some(adoption => adoption.targetId === card.targetId)));
    const pendingItemIds = new Set([
        ...submittingItems,
        ...effectiveJobs.filter((job) => !job.history && job.type === "GENERATE" && (job.status === "QUEUED" || job.status === "RUNNING"))
            .flatMap((job) => job.storyboardItemId ? [job.storyboardItemId] : []),
    ]);
    const unknownItemIds = new Set(effectiveJobs.filter(job => !job.history && job.type === 'GENERATE' && job.status === 'UNKNOWN').flatMap(job => job.storyboardItemId ? [job.storyboardItemId] : items.map(item => item.id)));
    const retry = async (item: StoryboardItem, generationConfig: NonNullable<GenerationJobInput["generationConfig"]>, generationBatchId?: string) => {
        if (retryLocks.current.has(item.id) || pendingItemIds.has(item.id) || unknownItemIds.has(item.id) || cards.some(card => (card.item?.id === item.id || (item.imagePlanning && card.targetId === item.imagePlanning.targetId)) && (card.status === 'PENDING' || card.status === 'UNKNOWN')))
            return;
        const model = generationConfig.imageModel;
        if (!model || !modelOptions(providers.data?.items ?? [], "image").some((option) => option.value === `${model.providerId}::${model.modelId}`)) {
            notification.error({ title: "无法重新生成", description: providers.isPending ? "模型列表正在加载，请稍后再试。" : "原生图模型未配置或已失效，请在灯箱中重新选择生图模型。" });
            return;
        }
        retryLocks.current.add(item.id);
        setSubmittingItems((current) => new Set(current).add(item.id));
        try {
            const jobs = await onRetryItem(item.id, generationConfig, generationBatchId);
            if (jobs)
                setSubmittedJobs((current) => [...current.filter((job) => job.storyboardItemId !== item.id), ...jobs.map(job => ({ ...job, storyboardItemId: item.id }))]);
        }
        catch (error) {
            notification.error({ title: "重新生成失败", description: errorText(error) });
        }
        finally {
            retryLocks.current.delete(item.id);
            setSubmittingItems((current) => new Set([...current].filter((id) => id !== item.id)));
        }
    };
    const retryOne = (item: StoryboardItem, generationBatchId?: string) => retry(item, {
        candidateCount: 1,
        imageResolution: item.imageResolution,
        imageAspectRatio: item.imageAspectRatio,
        ...(item.imageProviderId && item.imageModelId ? { imageModel: { providerId: item.imageProviderId, modelId: item.imageModelId } } : {}),
    }, generationBatchId);
    const toggleSelection = (outputId: string) => {
        onSelectionChange(selectedOutputIds.includes(outputId)
            ? selectedOutputIds.filter((id) => id !== outputId)
            : [...selectedOutputIds, outputId]);
    };
    const download = async (output: Output, label: string) => {
        setDownloadingId(output.id);
        try {
            await downloadOriginal(outputPreviewUrl(output), outputFileName(output, output.imagePlanning ? `${imagePlanningLabel(output.imagePlanning)} · ${label}` : label));
        }
        catch (error: unknown) {
            notification.error({ title: "下载原图失败", description: errorText(error) });
        }
        finally {
            setDownloadingId(null);
        }
    };
    const lightbox = detail.outputs.find((output) => output.id === lightboxId);
    const lightboxItem = items.find((item) => item.id === lightbox?.storyboardItemId);
    // 显式登记完整原图序列，收起的候选与编辑版本也能在大图中翻到。
    const previewOutputs = useMemo(() => {
        const ordered = batches.flatMap((batch) => batch.groups.flatMap((group) => group.outputs
            .flatMap((output) => [output, ...(editedByRoot.get(output.id) ?? [])])));
        const included = new Set(ordered.map((output) => output.id));
        return [...ordered, ...detail.outputs.filter((output) => !included.has(output.id))];
    }, [batches, detail.outputs, editedByRoot]);
    const outputSequence = useMemo(() => previewOutputs.map((output) => output.id), [previewOutputs]);
    const openPreview = (outputId: string) => {
        setPreviewIndex(outputSequence.indexOf(outputId));
        setPreviewOpen(true);
    };
    const stepLightbox = useCallback((delta: number) => setLightboxId((current) => stepThrough(outputSequence, current, delta)), [outputSequence]);
    const positionOf = (outputId: string | null) => {
        const index = outputId ? outputSequence.indexOf(outputId) : -1;
        return index >= 0 && outputSequence.length > 1 ? { index: index + 1, total: outputSequence.length } : undefined;
    };
    usePreviewNavOffset(previewOpen);
    if (cards.length === 0) {
        return (<div className={styles.placeholder}>
        <h2>还没有成图</h2>
        <p>确认分镜并生成后再查看结果。</p>
      </div>);
    }
    return (<div className={`${styles.lightboxStage} ${layoutStyles.gallery}`}>
      <div className={layoutStyles.filters} aria-label="成图用途筛选">
        {(['ALL', 'MAIN', 'SKU', 'DETAIL', 'LEGACY'] as const).map(value => <button key={value} type="button" data-active={purpose === value} onClick={() => setPurpose(value)}>{value === 'ALL' ? '全部' : IMAGE_PURPOSE_LABEL[value]} <span>{cards.filter(card => value === 'ALL' || (card.context?.purpose ?? 'LEGACY') === value).length}</span></button>)}
        <label><input type="checkbox" checked={onlyPending} onChange={event => setOnlyPending(event.target.checked)}/> 仅待处理</label><small>下载勾选与采用版本独立</small>
      </div>
      <Image.PreviewGroup items={previewOutputs.map((output) => ({ src: outputPreviewUrl(output) }))} preview={{ open: previewOpen && businessActive, current: previewIndex, onChange: setPreviewIndex, onOpenChange: setPreviewOpen }}>
        <div className={layoutStyles.batchGrid}>
          {visibleCards.map((card, index) => {
            const label = card.item ? itemDisplayName(card.item, templateNames) : card.context ? `${IMAGE_PURPOSE_LABEL[card.context.purpose]} ${card.context.ordinal}` : '历史成图';
            const adoptedId = adoptions.find(adoption => adoption.targetId === card.targetId)?.outputId;
            const pending = card.status === 'PENDING' || Boolean(card.item && submittingItems.has(card.item.id));
            const pendingLabel = card.pendingStatus === 'QUEUED' ? '排队中' : '生成中';
            return <div key={card.id} className={`${layoutStyles.group} ${stackStyles.group}`}>
              {card.outputs.length ? <ReviewStack outputs={card.outputs} label={label} downloadingId={downloadingId} onDownload={output => void download(output, label)} onPreview={openPreview} onOpen={setLightboxId} onEdit={setEditingId} adoptedOutputId={adoptedId} adopting={adopting} onAdopt={onAdopt ? outputId => onAdopt(card.targetId, outputId) : undefined} editedByRoot={editedByRoot} onOpenVersions={setVersionRootId} selectedOutputIds={selectedOutputIds} onToggleSelection={toggleSelection} retrying={pending} pendingLabel={pendingLabel} retryUnknown={card.status === 'UNKNOWN' || Boolean(card.item && (unknownItemIds.has(card.item.id) || card.item.planningSuperseded || card.item.planningStale))} onRetry={output => { const item = items.find(candidate => candidate.id === output.storyboardItemId); if (item) void retryOne(item, output.generationBatchId ?? output.jobId); }}/>
                : <article className={layoutStyles.emptyCard} aria-label={`${label}成图`}><div>{pending ? <span role="status" className={stackStyles.pending}><LoaderCircle size={28} className={stackStyles.spinning} aria-hidden/>{pendingLabel}</span> : <><span className={layoutStyles.emptyIcon}>{card.status === 'FAILED' ? '!' : '▧'}</span><strong>{card.status === 'FAILED' ? '生成失败' : card.status === 'UNKNOWN' ? '任务已中断' : '尚未生成'}</strong></>}
                  {!pending && card.status === 'FAILED' ? <Button onClick={() => Modal.info({ title: `${label} · 生成失败`, content: card.error || '请在任务记录查看失败原因。' })}>查看原因</Button> : null}
                  {!pending && card.status !== 'UNKNOWN' ? <Button disabled={Boolean(card.item && (card.item.planningStale || card.item.planningSuperseded))} onClick={() => { if (card.item) void retryOne(card.item); else onBackToPlanning?.(); }}>{card.item ? '生成此图' : '返回图片规划'}</Button> : null}
                </div></article>}
              <div className={layoutStyles.cardFooter}><span>{String(index + 1).padStart(2, '0')}</span><h2>{label}</h2></div>
              <p className={layoutStyles.cardPurpose}>{card.outputs.length ? imagePlanningLabel(card.outputs[0]?.imagePlanning) : card.context ? IMAGE_PURPOSE_LABEL[card.context.purpose] : '已有 / 未分类'}</p>
            </div>;
          })}
        </div>
        {!visibleCards.length ? <p className={styles.hint}>当前筛选下没有画面。</p> : null}
      </Image.PreviewGroup>

      <VersionTreeModal root={versionRootId ? detail.outputs.find((output) => output.id === versionRootId) : undefined} outputs={versionRootId ? [detail.outputs.find((output) => output.id === versionRootId), ...(editedByRoot.get(versionRootId) ?? [])].filter((output): output is Output => Boolean(output)) : []} onClose={() => setVersionRootId(null)} onOpenOutput={setEditingId} selectedOutputIds={selectedOutputIds} onToggleSelection={toggleSelection} onDownload={(output, label) => void download(output, label)} adoptions={adoptions} adopting={adopting} onAdopt={onAdopt}/>

      <LightboxModal output={lightbox} item={lightboxItem} label={lightboxItem ? itemDisplayName(lightboxItem, templateNames) : ""} position={positionOf(lightboxId)} onPrev={() => stepLightbox(-1)} onNext={() => stepLightbox(1)} onClose={() => setLightboxId(null)} downloading={lightbox ? downloadingId === lightbox.id : false} onDownload={() => {
            if (lightbox)
                void download(lightbox, lightboxItem ? itemDisplayName(lightboxItem, templateNames) : "");
        }} retrying={Boolean(lightboxItem && pendingItemIds.has(lightboxItem.id))} retryUnknown={Boolean(lightboxItem && unknownItemIds.has(lightboxItem.id))} onRetry={(generationConfig) => {
            if (lightboxItem && lightbox)
                void retry(lightboxItem, generationConfig, lightbox.generationBatchId ?? lightbox.jobId);
        }} onEdit={() => { if (lightbox)
        setEditingId(lightbox.id); }}/>
      <EditImageWorkspace projectId={detail.id} project={detail} output={detail.outputs.find((output) => output.id === editingId)} outputs={detail.outputs} assets={detail.assets} onSelectOutput={setEditingId} onClose={() => setEditingId(null)}/>
    </div>);
}
/** 同一批次与分镜的候选叠放；操作始终绑定当前可见图片。 */
function ReviewStack({ outputs, label, downloadingId, onDownload, onPreview, onOpen, onEdit, adoptedOutputId, onAdopt, adopting, editedByRoot, onOpenVersions, selectedOutputIds, onToggleSelection, retrying, pendingLabel, retryUnknown, onRetry }: {
    onEdit: (id: string) => void;
    adoptedOutputId?: string;
    onAdopt?: (outputId: string | null) => void;
    adopting?: boolean;
    outputs: Output[];
    label: string;
    downloadingId: string | null;
    onDownload: (output: Output) => void;
    onPreview: (id: string) => void;
    onOpen: (id: string) => void;
    editedByRoot: Map<string, Output[]>;
    onOpenVersions: (id: string) => void;
    selectedOutputIds: string[];
    onToggleSelection: (id: string) => void;
    retrying: boolean;
    pendingLabel: string;
    retryUnknown: boolean;
    onRetry: (output: Output) => void;
}) {
    const [currentId, setCurrentId] = useState(adoptedOutputId ?? outputs.at(-1)?.id);
    const viewingChanged = useRef(false);
    useEffect(() => {
        if (adoptedOutputId && !viewingChanged.current && outputs.some(output => output.id === adoptedOutputId)) setCurrentId(adoptedOutputId);
    }, [adoptedOutputId]);
    const viewCandidate = (id: string | undefined) => { viewingChanged.current = true; setCurrentId(id); };
    const knownIds = useRef(new Set(outputs.map((output) => output.id)));
    const [expanded, setExpanded] = useState(false);
    const filmstripId = useId();
    useEffect(() => {
        // 查询刷新和任务状态变化不打断看图；只有新增成图才翻到最前。
        const newestAdded = outputs.filter((output) => !knownIds.current.has(output.id)).at(-1);
        knownIds.current = new Set(outputs.map((output) => output.id));
        setCurrentId((current) => newestAdded?.id ?? (outputs.some((output) => output.id === current) ? current : outputs.at(-1)?.id));
    }, [outputs]);
    const foundIndex = outputs.findIndex((output) => output.id === currentId);
    const index = foundIndex >= 0 ? foundIndex : outputs.length - 1;
    const output = outputs[index];
    if (!output) return null;
    const versions = editedByRoot.get(output.id) ?? [];
    const step = (delta: number) => viewCandidate(outputs[(index + delta + outputs.length) % outputs.length]?.id);
    return <article className={stackStyles.stack} aria-label={`${label}成图`} data-output-id={output.id} data-stacked={outputs.length > 1}>
      <div className={stackStyles.photos}>
        <div className={`${styles.reviewThumb} ${stackStyles.front}`}>
          <button type="button" className={stackStyles.preview} onClick={() => onPreview(output.id)} aria-label={`预览 ${label}`}>
            <img src={outputPreviewUrl(output)} alt={label} loading="lazy" decoding="async"/>
          </button>
          {outputs.length > 1 ? <>
            <span className={stackStyles.counter} aria-label="当前候选图片">{index + 1} / {outputs.length}</span>
            <button type="button" className={`${stackStyles.arrow} ${stackStyles.previous}`} onClick={() => step(-1)} aria-label={`上一张 ${label}`}><ChevronLeft size={20} aria-hidden/></button>
            <button type="button" className={`${stackStyles.arrow} ${stackStyles.next}`} onClick={() => step(1)} aria-label={`下一张 ${label}`}><ChevronRight size={20} aria-hidden/></button>
          </> : null}
          {adoptedOutputId === output.id ? <span className={stackStyles.adopted}><Check size={12} aria-hidden/>已采用</span> : null}
          <div className={stackStyles.actions}>
            <button type="button" onClick={() => onEdit(output.id)} aria-label={`修改这张 ${label}`}>修改这张</button>
            <button type="button" onClick={() => onRetry(output)} disabled={retrying || retryUnknown} aria-label={`重新生成 ${label}`}>
              <RotateCcw size={15} aria-hidden/>
              重新生成
            </button>
            <button type="button" onClick={() => onDownload(output)} disabled={downloadingId === output.id} aria-label={`下载原图 ${label}`}><Download size={15} aria-hidden/></button>
            <button type="button" onClick={() => onOpen(output.id)} aria-label={`灯箱 ${label}`}><Maximize2 size={15} aria-hidden/></button>
            {onAdopt ? <button type="button" className={stackStyles.adoptAction} disabled={adopting} onClick={() => onAdopt(adoptedOutputId === output.id ? null : output.id)}>{adoptedOutputId === output.id ? '取消采用' : '采用此图'}</button> : null}
          </div>
        </div>
      </div>
      <div className={stackStyles.caption}>
        <label className={stackStyles.downloadSelection}><input type="checkbox" checked={selectedOutputIds.includes(output.id)} onChange={() => onToggleSelection(output.id)} aria-label={`选择下载 ${label}`}/>下载</label>
        {outputRevision(output) === 'retry' ? <span>重新生成 · {formatDateTime(output.createdAt)}</span> : <span>原始成图</span>}
        {retrying ? <span role="status" className={stackStyles.pending}><LoaderCircle size={12} className={stackStyles.spinning} aria-hidden/>{pendingLabel}</span> : retryUnknown ? <span role="status">任务已中断</span> : null}
      </div>
      {outputs.length > 1 || versions.length > 0 ? <div className={stackStyles.candidateTools}>
        {outputs.length > 1 ? <button type="button" onClick={() => setExpanded((current) => !current)} aria-expanded={expanded} aria-controls={filmstripId}>
          {expanded ? <ChevronUp size={13} aria-hidden/> : <ChevronDown size={13} aria-hidden/>}
          {expanded ? '收起候选' : '展开候选'}
        </button> : null}
        {versions.length ? <button type="button" onClick={() => onOpenVersions(output.id)}>编辑 {versions.length} 版</button> : null}
      </div> : null}
      {outputs.length > 1 ? <ol id={filmstripId} className={stackStyles.filmstrip} aria-label={`${label}全部候选`} hidden={!expanded}>
        {outputs.map((candidate, candidateIndex) => <li key={candidate.id}>
          <button type="button" className={stackStyles.candidate} onClick={() => viewCandidate(candidate.id)} aria-label={`查看候选 ${candidateIndex + 1} · ${label}`} aria-current={candidate.id === output.id ? 'true' : undefined}>
            <img src={outputThumbnailUrl(candidate) ?? outputPreviewUrl(candidate)} alt="" loading="lazy" decoding="async" onError={(event) => {
                const image = event.currentTarget;
                const original = outputPreviewUrl(candidate);
                if (image.getAttribute('src') !== original)
                    image.src = original;
            }}/>
            <span className={stackStyles.candidateNumber}>{candidateIndex + 1}</span>
            {selectedOutputIds.includes(candidate.id) ? <span className={stackStyles.candidateSelected} aria-label="已选下载"><Check size={11} aria-hidden/></span> : null}
          </button>
        </li>)}
      </ol> : null}
    </article>;
}
function LightboxModal({ output, item, label, position, onClose, onPrev, onNext, downloading, onDownload, onRetry, onEdit, retrying, retryUnknown, }: {
    output: Output | undefined;
    item: StoryboardItem | undefined;
    label: string;
    /** 当前图在灯箱序列中的位置；序列只有一张时为 undefined，此时不渲染翻页 */
    position: {
        index: number;
        total: number;
    } | undefined;
    onClose: () => void;
    onPrev: () => void;
    onNext: () => void;
    downloading: boolean;
    onDownload: () => void;
    onRetry: (generationConfig: NonNullable<GenerationJobInput["generationConfig"]>) => void;
    onEdit: () => void;
    retrying: boolean;
    retryUnknown: boolean;
}) {
    const businessActive = useBusinessActive();
    const providers = useProviders();
    const [retryOpen, setRetryOpen] = useState(false);
    const [resolution, setResolution] = useState<NonNullable<GenerationJobInput["generationConfig"]>["imageResolution"]>(item?.imageResolution ?? "1K");
    const [aspectRatio, setAspectRatio] = useState<NonNullable<GenerationJobInput["generationConfig"]>["imageAspectRatio"]>(item?.imageAspectRatio ?? "AUTO");
    const [quality, setQuality] = useState<NonNullable<GenerationJobInput["generationConfig"]>["quality"]>("high");
    const [outputFormat, setOutputFormat] = useState<NonNullable<GenerationJobInput["generationConfig"]>["outputFormat"]>(undefined);
    const [candidateCount, setCandidateCount] = useState(item?.candidateCount ?? 1);
    const [modelKey, setModelKey] = useState(item?.imageProviderId && item.imageModelId ? `${item.imageProviderId}::${item.imageModelId}` : undefined);
    const imageOptions = modelOptions(providers.data?.items ?? [], "image");
    // 所选模型真实支持的出图参数：没有可调空间的维度不渲染选择器（判定与 worker 同源）。
    const retryModelSupport = useMemo(() => {
        if (!modelKey)
            return null;
        const [providerId, modelId] = modelKey.split("::");
        const kind = providers.data?.items.find((provider) => provider.id === providerId)?.models.find((model) => model.id === modelId)?.imageApiKind ?? null;
        return imageParamSupportFor(modelId ?? "", kind as "openai_images" | "gemini" | "custom" | null);
    }, [modelKey, providers.data]);
    const defaultModelKey = item?.imageProviderId && item.imageModelId ? `${item.imageProviderId}::${item.imageModelId}` : undefined;
    const positionLabel = position ? `${position.index} / ${position.total}` : undefined;
    // 重试配置弹层压在上面时不抢方向键
    useArrowNavigation(Boolean(output && position && !retryOpen), onPrev, onNext);
    // 保留分镜冻结的模型引用；失效时由用户明确重新选择，不能暗中切换付费模型。
    const openRetry = () => {
        setResolution(item?.imageResolution ?? "1K");
        setAspectRatio(item?.imageAspectRatio ?? "AUTO");
        setQuality("high");
        setOutputFormat(undefined);
        setCandidateCount(item?.candidateCount ?? 1);
        setModelKey(defaultModelKey);
        setRetryOpen(true);
    };
    const submitRetry = () => {
        if (retryUnknown || retrying || !modelKey || !imageOptions.some(option => option.value === modelKey))
            return;
        const [providerId, modelId] = modelKey.split("::");
        if (!providerId || !modelId)
            return;
        onRetry({ imageResolution: resolution, imageAspectRatio: aspectRatio, quality, outputFormat, candidateCount, imageModel: { providerId, modelId } });
        setRetryOpen(false);
    };
    return (<>
      <Modal open={Boolean(output) && businessActive} onCancel={onClose} footer={null} width={920} title={positionLabel ? <span className={styles.lightboxTitle}>灯箱<em>{positionLabel}</em></span> : "灯箱"}>
        {output && item ? (<div className={styles.lightboxBody}>
            <Image rootClassName={styles.lightboxImage} src={output.url} alt={label}/>
            {position ? (<>
                <button type="button" className={`${styles.overlayNav} ${styles.lightboxNavPrev}`} onClick={onPrev} aria-label="上一张">
                  <ChevronLeft size={22} strokeWidth={1.75} aria-hidden/>
                </button>
                <button type="button" className={`${styles.overlayNav} ${styles.lightboxNavNext}`} onClick={onNext} aria-label="下一张">
                  <ChevronRight size={22} strokeWidth={1.75} aria-hidden/>
                </button>
              </>) : null}
            <div className={styles.lightboxMeta}>
              <p className={styles.shotType}>{label}</p>
              <p className={styles.hint}>{imagePlanningLabel(output.imagePlanning)}</p>
              <ModeBadge mode={item.mode}/>
              <p className={styles.promptPreview}>{item.promptInstruction}</p>
              <Button icon={<Download size={14} strokeWidth={1.75}/>} loading={downloading} onClick={onDownload}>
                下载原图
              </Button>
              {retryUnknown ? <p role="status">任务已中断，请在任务详情重试或结束。</p> : null}
              <Button onClick={openRetry} loading={retrying} disabled={retryUnknown}>用此分镜重新生成</Button>
              <Button type="primary" onClick={onEdit}>编辑图片</Button>
            </div>
          </div>) : null}
      </Modal>
      <Modal open={retryOpen && businessActive} title="重新生成配置" okText="开始生成" cancelText="取消" onOk={submitRetry} onCancel={() => setRetryOpen(false)} okButtonProps={{ disabled: retryUnknown || retrying || !modelKey || !imageOptions.some(option => option.value === modelKey) }}>
        <div className={styles.inspectorSettingGrid}>
          <label className={styles.fieldLabel}>图片比例<Select value={aspectRatio} options={ASPECT_SELECT_OPTIONS} optionRender={renderAspectOption} onChange={setAspectRatio}/></label>
          <label className={styles.fieldLabel}>分辨率<Select value={resolution} options={Object.entries(RESOLUTION_LABEL).map(([value, label]) => ({ value, label }))} onChange={setResolution}/></label>
          {retryModelSupport?.quality ? (<label className={styles.fieldLabel}>质量<Select value={quality} options={IMAGE_QUALITIES.map((value) => ({ value, label: { auto: "自动", low: "低", medium: "中", high: "高" }[value] }))} onChange={setQuality}/></label>) : null}
          {retryModelSupport?.outputFormat ? (<label className={styles.fieldLabel}>格式<Select allowClear placeholder="PNG（默认）" value={outputFormat} options={IMAGE_OUTPUT_FORMATS.map((value) => ({ value, label: value.toUpperCase() }))} onChange={(value) => setOutputFormat(value ?? undefined)}/></label>) : null}
          <label className={styles.fieldLabel}>候选数<InputNumber min={1} max={4} value={candidateCount} onChange={(value) => setCandidateCount(value ?? 1)}/></label>
          <label className={styles.fieldLabel}>生图模型<Select aria-label="重试生图模型" value={imageOptions.some(option => option.value === modelKey) ? modelKey : undefined} options={imageOptions} placeholder="选择生图模型" onChange={setModelKey}/></label>
          <ManageModelsButton/>
          {modelKey && !imageOptions.some(option => option.value === modelKey) ? <p role="alert">原模型已失效，请重新选择后生成。</p> : null}
        </div>
      </Modal>
    </>);
}
function VersionTreeModal({ root, outputs, onClose, onOpenOutput, selectedOutputIds, onToggleSelection, onDownload, adoptions, adopting, onAdopt }: {
    adoptions: Array<{ targetId: string; outputId: string }>;
    adopting: boolean;
    onAdopt?: (targetId: string, outputId: string | null) => void;
    root: Output | undefined;
    outputs: Output[];
    onClose: () => void;
    onOpenOutput: (outputId: string) => void;
    selectedOutputIds: string[];
    onToggleSelection: (outputId: string) => void;
    onDownload: (output: Output, label: string) => void;
}) {
    const businessActive = useBusinessActive();
    const [zoom, setZoom] = useState(1);
    const [offset, setOffset] = useState({ x: 0, y: 0 });
    const dragRef = useRef<{
        x: number;
        y: number;
        ox: number;
        oy: number;
    } | null>(null);
    const nodes = useMemo(() => {
        const byId = new Map(outputs.map((output) => [output.id, output]));
        const children = new Map<string, Output[]>();
        for (const output of outputs) {
            if (!output.parentOutputId)
                continue;
            const bucket = children.get(output.parentOutputId) ?? [];
            bucket.push(output);
            children.set(output.parentOutputId, bucket);
        }
        const level = new Map<string, number>(root ? [[root.id, 0]] : []);
        const visit = (output: Output) => {
            for (const child of children.get(output.id) ?? []) {
                level.set(child.id, (level.get(output.id) ?? 0) + 1);
                visit(child);
            }
        };
        if (root)
            visit(root);
        const rows = new Map<number, Output[]>();
        for (const output of outputs) {
            const bucket = rows.get(level.get(output.id) ?? 0) ?? [];
            bucket.push(output);
            rows.set(level.get(output.id) ?? 0, bucket);
        }
        return [...rows.entries()].flatMap(([depth, row]) => row.map((output, index) => {
            const parent = output.parentOutputId ? byId.get(output.parentOutputId) : undefined;
            const siblings = parent ? (children.get(parent.id) ?? []) : [];
            return {
                output,
                depth,
                index,
                x: 72 + index * 250,
                y: 72 + depth * 190,
                parent,
                siblingCount: siblings.length,
                siblingOrdinal: siblings.findIndex((candidate) => candidate.id === output.id) + 1,
            };
        }));
    }, [outputs, root]);
    const nodesById = useMemo(() => new Map(nodes.map((node) => [node.output.id, node])), [nodes]);
    const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => { event.currentTarget.setPointerCapture(event.pointerId); dragRef.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y }; };
    const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => { if (!dragRef.current)
        return; setOffset({ x: dragRef.current.ox + event.clientX - dragRef.current.x, y: dragRef.current.oy + event.clientY - dragRef.current.y }); };
    const pointerUp = () => { dragRef.current = null; };
    const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
        const next = Math.min(1.5, Math.max(0.65, zoom * (event.deltaY > 0 ? 0.92 : 1.08)));
        if (next === zoom)
            return;
        const rect = event.currentTarget.getBoundingClientRect();
        const pointerX = event.clientX - rect.left;
        const pointerY = event.clientY - rect.top;
        setZoom(next);
        setOffset({
            x: pointerX - ((pointerX - offset.x) * next) / zoom,
            y: pointerY - ((pointerY - offset.y) * next) / zoom,
        });
    };
    return <Modal open={Boolean(root) && businessActive} onCancel={onClose} footer={null} width="min(1100px, calc(100vw - 32px))" title="编辑版本关系">
    <div className={styles.versionTreeHeader}><div><strong>{root ? "这张图的编辑版本" : ""}</strong><span>点击图片进入编辑，拖动画布查看关系，滚轮缩放</span></div><div><button type="button" onClick={() => setZoom((value) => Math.max(0.65, value - 0.1))} aria-label="缩小"><Minus size={16}/></button><span>{Math.round(zoom * 100)}%</span><button type="button" onClick={() => setZoom((value) => Math.min(1.5, value + 0.1))} aria-label="放大"><Plus size={16}/></button></div></div>
    <div className={styles.versionTreeCanvas} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onWheel={handleWheel}>
      <div className={styles.versionTreeWorld} style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${zoom})` }}>
        <svg className={styles.versionTreeLinks} width="1000" height="650" aria-hidden>{nodes.filter((node) => node.parent).map((node) => { const parent = node.parent ? nodesById.get(node.parent.id) : undefined; return parent ? <path key={node.output.id} d={`M ${parent.x + 96} ${parent.y + 126} C ${parent.x + 96} ${parent.y + 155}, ${node.x + 96} ${node.y - 25}, ${node.x + 96} ${node.y}`}/> : null; })}</svg>
        {nodes.map((node) => { const label = node.depth === 0 ? "原图" : `V${node.depth + 1}${node.siblingCount > 1 ? ` · ${node.siblingOrdinal}` : ""}`; return <div key={node.output.id} className={styles.versionTreeNode} style={{ left: node.x, top: node.y }} onPointerDown={(event) => event.stopPropagation()}><button type="button" className={styles.versionTreeOpen} onClick={() => onOpenOutput(node.output.id)}><img src={node.output.url} alt=""/><span>{label}</span></button><label className={styles.versionTreeSelect}><input type="checkbox" checked={selectedOutputIds.includes(node.output.id)} onChange={() => onToggleSelection(node.output.id)} aria-label={`选择下载 ${label}`}/></label><button type="button" className={styles.versionTreeDownload} onClick={() => onDownload(node.output, label)} aria-label={`下载 ${label}`}><Download size={14}/></button>{onAdopt ? <Button size="small" disabled={adopting} onClick={() => onAdopt(node.output.imagePlanning?.targetId ?? node.output.storyboardItemId, adoptions.some(entry => entry.outputId === node.output.id) ? null : node.output.id)}>{adoptions.some(entry => entry.outputId === node.output.id) ? '取消采用' : '采用此图'}</Button> : null}</div>; })}
      </div>
    </div>
  </Modal>;
}
