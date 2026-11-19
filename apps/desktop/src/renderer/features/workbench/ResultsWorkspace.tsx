import { App, Button, Checkbox, Modal, Radio, Select } from "antd";
import { resolveProductImageTargets } from '@ecomgen/contracts';
import { useProjectImagePlanning } from '../../api/hooks/useProductImagePlanning';
import { useProjectExports, useProjectWorkbench, useSaveProjectWorkbench } from '../../api/hooks/useProjectWorkbench';
import { buildTargetReviewCards } from '../../lib/review';
import { formatDateTime } from '../../lib/format';
import { useBusinessNavigate } from '../../components/businessActivity';
import { ChevronDown, ChevronUp, Download } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { exportDownloadUrl, type Output, type ProjectDetail } from "../../api/adapters/projectDetail";
import { useCreateExportJob, useExport } from "../../api/hooks/useExport";
import { useCreateGenerationJobs } from "../../api/hooks/useGeneration";
import { outputPreviewUrl, outputThumbnailUrl } from "../../lib/assetUrl";
import { errorText } from "../../lib/errorText";
import { randomUuid } from "../../lib/randomUuid";
import { ResourceSaveButton } from "../../components/ResourceSaveButton";
import { useBusinessActive } from '../../components/businessActivity';
import { imagePlanningLabel } from '../../lib/productImagePlanning';
import { ReviewStage } from "./ReviewStage";
import { JobRecords } from './JobRecords';
import styles from "./workbench.module.css";
import layoutStyles from "./ResultsLayout.module.css";
/** 长图宽度档位：值即 LongImageExportConfig.targetWidth。 */
const LONG_IMAGE_WIDTH_OPTIONS = [
    { value: 750, label: "手机端详情页 · 750px" },
    { value: 790, label: "PC 端详情页 · 790px" },
    { value: 1200, label: "高清 · 1200px" },
];
export function ResultsWorkspace({ detail, }: {
    detail: ProjectDetail;
}) {
    const { notification } = App.useApp();
    const businessActive = useBusinessActive();
    const generate = useCreateGenerationJobs(detail.id);
    const navigate = useBusinessNavigate();
    const backToPlanning = () => { void navigate(`/projects/${detail.id}?view=storyboard`); };
    const planning = useProjectImagePlanning(detail.id);
    const workbench = useProjectWorkbench(detail.id);
    const saveWorkbench = useSaveProjectWorkbench(detail.id);
    const exports = useProjectExports(detail.id);
    const targets = useMemo(() => planning.data && (planning.data.revision > 0 || detail.items.some(item => item.imagePlanning)) ? resolveProductImageTargets(planning.data) : [], [planning.data, detail.items]);
    const cards = useMemo(() => buildTargetReviewCards(detail.items, detail.outputs, detail.jobs, targets), [detail.items, detail.outputs, detail.jobs, targets]);
    const adoptions = workbench.data?.adoptions ?? [];
    const adoptedIds = adoptions.map(entry => entry.outputId).filter(id => detail.outputs.some(output => output.id === id));
    const [recordsOpen, setRecordsOpen] = useState(false);
    const [orderOpen, setOrderOpen] = useState(false);
    const [detailOrder, setDetailOrder] = useState<string[]>([]);
    const saveLock = useRef(false);
    const detailCards = [...new Map(cards.filter(card => !card.context || card.context.purpose === 'DETAIL').map(card => [card.targetId, card])).values()];
    const orderedDetailIds = [...(workbench.data?.detailOrder ?? []).filter(id => detailCards.some(card => card.targetId === id)), ...detailCards.map(card => card.targetId).filter(id => !workbench.data?.detailOrder.includes(id))];
    const saveState = async (nextAdoptions: typeof adoptions, nextOrder: string[]) => {
        if (!workbench.data || saveLock.current) return false;
        saveLock.current = true;
        try {
            await saveWorkbench.mutateAsync({ expectedRevision: workbench.data.revision, adoptions: nextAdoptions, detailOrder: nextOrder });
            return true;
        } catch (error) {
            notification.error({ title: '保存采用与顺序失败', description: errorText(error) });
            return false;
        } finally { saveLock.current = false; }
    };
    const adopt = (targetId: string, outputId: string | null) => {
        void saveState([...adoptions.filter(entry => entry.targetId !== targetId), ...(outputId ? [{ targetId, outputId }] : [])], workbench.data?.detailOrder ?? []);
    };
    // 提交回执不确定时保留本次点击身份；重试桥接不能变成第二次付费意图。
    const regenerationKeys = useRef(new Map<string, string>());
    const regenerate = async (itemId: string, generationConfig: import('../../api/serializeGenerationBody').GenerationJobInput['generationConfig'], generationBatchId?: string) => {
        const intent = `${detail.id}:${itemId}`;
        const regenerationKey = regenerationKeys.current.get(intent) ?? randomUuid();
        regenerationKeys.current.set(intent, regenerationKey);
        const jobs = await generate.mutateAsync({ storyboardItemIds: [itemId], revision: 'retry', regenerationKey, generationBatchId, generationConfig });
        regenerationKeys.current.delete(intent);
        return jobs;
    };
    const createExport = useCreateExportJob(detail.id);
    const [activeExportId, setActiveExportId] = useState<string | undefined>(undefined);
    const [selectedOutputIds, setSelectedOutputIds] = useState<string[]>([]);
    // 导出方式与长图选项在弹窗内选择，确认后随请求一次性提交
    const [exportOpen, setExportOpen] = useState(false);
    const [exportOutputIds, setExportOutputIds] = useState<string[]>([]);
    const openExport = (ids: string[], mode: 'zip' | 'longImage') => {
        setExportOutputIds(ids);
        setExportMode(mode);
        setStitchOrder([]);
        setExportOpen(true);
    };
    const [exportMode, setExportMode] = useState<"zip" | "longImage">("zip");
    const [longImageWidth, setLongImageWidth] = useState<750 | 790 | 1200>(750);
    const [longImageSlices, setLongImageSlices] = useState(false);
    // 拼接顺序状态：默认按分镜序，用户在导出弹窗调整后保留。
    const [stitchOrder, setStitchOrder] = useState<string[]>([]);
    // 拖拽排序用 pointer 事件自管：原生 DnD 做不了插入占位与容器边缘自动滚动。
    // 指针捕获挂在滚动容器上，被拖项 display:none 也不会丢失捕获。
    const screensRef = useRef<HTMLDivElement | null>(null);
    const screenRefs = useRef(new Map<string, HTMLElement>());
    const dragRef = useRef<{
        id: string;
        fromIndex: number;
        pointerId: number;
        startY: number;
        started: boolean;
        edgeDelta: number;
        clientY: number;
    } | null>(null);
    const autoscrollRef = useRef<number | null>(null);
    const [dragSourceId, setDragSourceId] = useState<string | null>(null);
    const [insertIndex, setInsertIndex] = useState<number | null>(null);
    const [dragHeight, setDragHeight] = useState(0);
    const liveExport = useExport(activeExportId);
    const record = liveExport.data;
    const packing = createExport.isPending || record?.status === "QUEUED" || record?.status === "RUNNING";
    const readyUrl = record?.status === "SUCCEEDED" ? exportDownloadUrl(record) : null;
    // 默认拼接顺序与 Worker 回退规则一致：分镜顺序（items 即 sort_order）优先，再按候选序。
    const defaultStitchOrder = useMemo(() => {
        const persisted = workbench.data?.detailOrder ?? [];
        const targetOrder = [...persisted, ...detail.items.map(item => item.imagePlanning?.targetId ?? item.id).filter(id => !persisted.includes(id))];
        const itemRank = new Map(targetOrder.map((id, index) => [id, index] as const));
        return detail.outputs
            .filter((output) => exportOutputIds.includes(output.id))
            .slice()
            .sort((a, b) => (itemRank.get(a.imagePlanning?.targetId ?? a.storyboardItemId) ?? Number.MAX_SAFE_INTEGER) - (itemRank.get(b.imagePlanning?.targetId ?? b.storyboardItemId) ?? Number.MAX_SAFE_INTEGER) || (a.candidateIndex ?? 0) - (b.candidateIndex ?? 0))
            .map((output) => output.id);
    }, [detail.items, detail.outputs, exportOutputIds, workbench.data?.detailOrder]);
    const outputById = useMemo(() => new Map(detail.outputs.map((output) => [output.id, output] as const)), [detail.outputs]);
    const longImagePreviewOutputs = stitchOrder
        .map((id) => outputById.get(id))
        .filter((output): output is Output => Boolean(output));
    // 选择变化时保留用户已调整的顺序，新增/删除的屏按默认序增减。
    useEffect(() => {
        setStitchOrder((current) => {
            const selected = new Set(exportOutputIds);
            const kept = current.filter((id) => selected.has(id));
            const keptSet = new Set(kept);
            const additions = defaultStitchOrder.filter((id) => selected.has(id) && !keptSet.has(id));
            return [...kept, ...additions];
        });
    }, [exportOutputIds, defaultStitchOrder]);
    useEffect(() => {
        if (record?.status === 'SUCCEEDED' || record?.status === 'FAILED') void exports.refetch();
    }, [record?.id, record?.status, exports.refetch]);
    useEffect(() => {
        const available = new Set(detail.outputs.map((output) => output.id));
        setSelectedOutputIds((current) => current.filter((id) => available.has(id)));
    }, [detail.outputs]);
    useEffect(() => {
        if (record?.status === "FAILED")
            notification.error({ title: "打包失败，请重新下载" });
    }, [record?.status, notification]);
    const moveScreen = (from: number, to: number) => {
        setStitchOrder((current) => {
            if (to < 0 || to >= current.length)
                return current;
            const next = current.slice();
            const [moved] = next.splice(from, 1);
            next.splice(to, 0, moved!);
            return next;
        });
    };
    const computeInsertIndex = (id: string, clientY: number) => {
        // 全程用视口坐标比较各屏中点：offsetTop 依赖 offsetParent（容器未定位时会混入弹窗到
        // 页面顶部的偏移，导致下移阈值虚高、不跟手），而 rect 随内容滚动移动，逐帧重算天然正确。
        // index 是完整列表里"该项之后"的槽位（渲染侧直接比对完整列表下标）；提交时再换算回
        // 去除被拖项的下标，两套坐标系不混用——混用会让下方所有落点显示偏高一格且到不了末尾。
        let index = 0;
        longImagePreviewOutputs.forEach((output, itemIndex) => {
            if (output.id === id)
                return;
            const element = screenRefs.current.get(output.id);
            if (!element)
                return;
            const rect = element.getBoundingClientRect();
            if (clientY > rect.top + rect.height / 2)
                index = itemIndex + 1;
        });
        setInsertIndex(index);
    };
    // 指针停在边缘不动时也要持续滚动，所以用 rAF 循环驱动并在每帧重算插入位。
    const driveAutoscroll = () => {
        if (autoscrollRef.current != null)
            return;
        const step = () => {
            autoscrollRef.current = null;
            const drag = dragRef.current;
            const container = screensRef.current;
            if (!drag || !drag.started || drag.edgeDelta === 0 || !container)
                return;
            container.scrollTop += drag.edgeDelta;
            computeInsertIndex(drag.id, drag.clientY);
            autoscrollRef.current = requestAnimationFrame(step);
        };
        autoscrollRef.current = requestAnimationFrame(step);
    };
    const beginScreenDrag = (event: React.PointerEvent<HTMLElement>, index: number, id: string) => {
        if (event.button !== 0)
            return;
        dragRef.current = { id, fromIndex: index, pointerId: event.pointerId, startY: event.clientY, started: false, edgeDelta: 0, clientY: event.clientY };
        setDragHeight(event.currentTarget.offsetHeight);
    };
    const moveScreenDrag = (event: React.PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId)
            return;
        drag.clientY = event.clientY;
        const container = screensRef.current;
        if (!container)
            return;
        if (!drag.started) {
            if (Math.abs(event.clientY - drag.startY) < 4)
                return;
            drag.started = true;
            setDragSourceId(drag.id);
            setInsertIndex(drag.fromIndex);
            // 捕获只在真正开始拖动后建立：pointerdown 就捕获会让箭头按钮收不到 click（pointerup 被重定向到容器）。
            try {
                container.setPointerCapture(drag.pointerId);
            }
            catch { /* 捕获失败时仍可用箭头按钮排序 */ }
        }
        computeInsertIndex(drag.id, event.clientY);
        // 贴近容器上下缘按距离加速滚动，解决长列表拖拽够不到远处目标的问题
        const rect = container.getBoundingClientRect();
        const edge = 44;
        if (event.clientY < rect.top + edge)
            drag.edgeDelta = -Math.min(16, (rect.top + edge - event.clientY) / 2.5);
        else if (event.clientY > rect.bottom - edge)
            drag.edgeDelta = Math.min(16, (event.clientY - (rect.bottom - edge)) / 2.5);
        else
            drag.edgeDelta = 0;
        if (drag.edgeDelta !== 0)
            driveAutoscroll();
    };
    const endScreenDrag = (commit: boolean) => {
        const drag = dragRef.current;
        dragRef.current = null;
        if (autoscrollRef.current != null) {
            cancelAnimationFrame(autoscrollRef.current);
            autoscrollRef.current = null;
        }
        if (drag?.started && commit && insertIndex != null && insertIndex !== drag.fromIndex) {
            // insertIndex 是完整列表槽位；moveScreen 的目标下标在去除被拖项后的数组上取值
            moveScreen(drag.fromIndex, insertIndex > drag.fromIndex ? insertIndex - 1 : insertIndex);
        }
        setDragSourceId(null);
        setInsertIndex(null);
    };
    useEffect(() => () => {
        if (autoscrollRef.current != null)
            cancelAnimationFrame(autoscrollRef.current);
    }, []);
    const download = async (ids: string[], mode: 'zip' | 'longImage' = exportMode) => {
        if (ids.length === 0) {
            notification.error({ title: "没有可下载的成图" });
            return;
        }
        try {
            if (mode === 'longImage') {
                const orderedTargets = [...new Set(stitchOrder.flatMap(id => {
                    const output = outputById.get(id);
                    const targetId = output?.imagePlanning?.targetId ?? output?.storyboardItemId;
                    return targetId && detailCards.some(card => card.targetId === targetId) ? [targetId] : [];
                }))];
                const nextOrder = [...orderedTargets, ...orderedDetailIds.filter(id => !orderedTargets.includes(id))];
                if (JSON.stringify(nextOrder) !== JSON.stringify(workbench.data?.detailOrder ?? [])) {
                    if (!await saveState(adoptions, nextOrder)) return;
                }
            }
            const bundle = await createExport.mutateAsync({
                // 长图模式提交用户调整后的拼接顺序；顺序参与指纹，调整后再导出会生成新任务。
                outputIds: mode === "longImage" ? stitchOrder : ids,
                platformTargets: detail.platformTargets,
                ...(mode === "longImage"
                    ? { longImage: { targetWidth: longImageWidth, ...(longImageSlices ? { sliceHeight: 960 } : {}) } }
                    : {}),
            });
            if (bundle.export)
                setActiveExportId(bundle.export.id);
            void exports.refetch();
        }
        catch (error) {
            notification.error({ title: "导出失败", description: errorText(error) });
        }
    };
    return (<div className={layoutStyles.workspace}>
      <header className={layoutStyles.heading}>
        <div><h1>成图与修改 <small>{cards.length} 个画面</small></h1><p className={layoutStyles.summary}>已采用 {adoptions.length} · 待选择 {cards.filter(card => card.outputs.length && !adoptions.some(entry => entry.targetId === card.targetId)).length} · 失败 {cards.filter(card => card.status === 'FAILED').length} · 未生成 {cards.filter(card => card.status === 'EMPTY').length}</p></div>
        <div className={layoutStyles.exportControls}>
          <Button onClick={() => { setRecordsOpen(true); void exports.refetch(); }}>导出记录</Button>
          <Button disabled={!selectedOutputIds.length} onClick={() => openExport(selectedOutputIds, 'zip')}>更多导出</Button>
          <Button type="primary" icon={<Download size={16}/>} disabled={!adoptedIds.length || !workbench.data} loading={packing} onClick={() => void download(adoptedIds, 'zip')}>下载已采用图片（{adoptedIds.length}）</Button>
        </div>
      </header>
      <JobRecords detail={detail} />

      <div className={layoutStyles.toolbar}>
        <span className={layoutStyles.selectedCount}>已选 {selectedOutputIds.length} 张</span>
        <Button size="small" onClick={() => setSelectedOutputIds(detail.outputs.map((output) => output.id))} disabled={detail.outputs.length === 0}>全选图片</Button>
        <Button size="small" onClick={() => setSelectedOutputIds([])} disabled={selectedOutputIds.length === 0}>清空选择</Button>
        <div className={layoutStyles.exportControls}>
          {packing ? <span className={styles.hint}>打包中…</span> : null}
          {readyUrl ? (<ResourceSaveButton size="small" className={styles.downloadLink} resourceUrl={readyUrl}>
              保存 ZIP
            </ResourceSaveButton>) : null}
          <Button size="small" type="primary" icon={<Download size={14} strokeWidth={1.75}/>} loading={packing} disabled={selectedOutputIds.length === 0} onClick={() => openExport(selectedOutputIds, 'zip')}>
            打包下载
          </Button>
        </div>
      </div>

      {workbench.isError ? <p role="alert">采用状态加载失败：{errorText(workbench.error)} <Button size="small" onClick={() => void workbench.refetch()}>重试</Button></p> : null}
      {planning.isError ? <p role="alert">图片目标加载失败：{errorText(planning.error)} <Button size="small" onClick={() => void planning.refetch()}>重试</Button></p> : null}
      <ReviewStage detail={detail} targets={targets} adoptions={adoptions} onAdopt={adopt} adopting={saveWorkbench.isPending || !workbench.data} onBackToPlanning={backToPlanning} selectedOutputIds={selectedOutputIds} onSelectionChange={setSelectedOutputIds} onRetryItem={regenerate}/>
      <footer className={layoutStyles.footer}>
        <Button onClick={backToPlanning}>返回图片规划</Button>
        <div className={layoutStyles.exportControls}>
          <Button disabled={!workbench.data || saveWorkbench.isPending || !detailCards.length} onClick={() => { setDetailOrder(orderedDetailIds); setOrderOpen(true); }}>详情顺序</Button>
          <Button disabled={!orderedDetailIds.some(id => adoptions.some(entry => entry.targetId === id)) || packing} onClick={() => openExport(orderedDetailIds.flatMap(id => adoptions.filter(entry => entry.targetId === id).map(entry => entry.outputId)), 'longImage')}>长图导出</Button>
        </div>
      </footer>
      <Modal title="详情顺序" open={orderOpen && businessActive} onCancel={() => setOrderOpen(false)} confirmLoading={saveWorkbench.isPending} okText="保存顺序" cancelText="取消" onOk={() => { void saveState(adoptions, detailOrder).then(saved => { if (saved) setOrderOpen(false); }); }}>
        <p>按此顺序导出已采用的详情图。未采用的画面保留位置。</p>
        <ol className={layoutStyles.orderList}>{detailOrder.map((id, index) => {
          const card = detailCards.find(entry => entry.targetId === id);
          const move = (delta: number) => setDetailOrder(current => { const next = [...current]; const [moved] = next.splice(index, 1); next.splice(index + delta, 0, moved!); return next; });
          return <li key={id}><span>{card?.item?.displayName || `详情图 ${index + 1}`}</span><Button size="small" aria-label={`上移详情 ${index + 1}`} disabled={index === 0} onClick={() => move(-1)}><ChevronUp size={14}/></Button><Button size="small" aria-label={`下移详情 ${index + 1}`} disabled={index === detailOrder.length - 1} onClick={() => move(1)}><ChevronDown size={14}/></Button></li>;
        })}</ol>
      </Modal>
      <Modal title="导出记录" open={recordsOpen && businessActive} onCancel={() => setRecordsOpen(false)} footer={null}>
        {exports.isPending ? <p>加载导出记录…</p> : exports.isError ? <p role="alert">{errorText(exports.error)} <Button onClick={() => void exports.refetch()}>重试</Button></p> : !exports.data?.items.length ? <p>暂无导出记录</p> : <ul className={layoutStyles.exportList}>{exports.data.items.map(item => <li key={item.id}><div><strong>{item.longImage ? '详情长图' : '图片 ZIP'} · {item.outputIds.length} 张</strong><small>{formatDateTime(item.createdAt)} · {({ SUCCEEDED: '已完成', FAILED: '失败', QUEUED: '排队中', RUNNING: '导出中', CANCELLED: '已取消' } as Record<string, string>)[item.status] ?? item.status}</small></div>{item.status === 'SUCCEEDED' && item.downloadUrl ? <ResourceSaveButton resourceUrl={item.downloadUrl}>保存文件</ResourceSaveButton> : null}</li>)}</ul>}
      </Modal>

      <Modal title="打包下载" open={exportOpen && businessActive} onCancel={() => setExportOpen(false)} onOk={() => {
            setExportOpen(false);
            void download(exportOutputIds);
        }} okText="开始导出" cancelText="取消" okButtonProps={{ loading: packing }} width={680} destroyOnHidden>
        <div className={styles.exportDialog}>
          <div className={styles.exportDialogForm}>
            <Radio.Group value={exportMode} onChange={(event) => setExportMode(event.target.value as "zip" | "longImage")} className={styles.exportDialogModes}>
              <Radio value="zip">
                <span className={styles.exportModeTitle}>逐张打包</span>
                <span className={styles.exportModeDesc}>每张成图单独成文件（ZIP），适合平台逐图上传</span>
              </Radio>
              <Radio value="longImage">
                <span className={styles.exportModeTitle}>合成长图</span>
                <span className={styles.exportModeDesc}>按分镜顺序纵向拼接为一张详情页长图，随 ZIP 一并交付</span>
              </Radio>
            </Radio.Group>
            {exportMode === "longImage" ? (<div className={styles.exportDialogFields}>
                <div className={styles.exportDialogField}>
                  <span className={styles.exportDialogLabel}>图片宽度</span>
                  <Select value={longImageWidth} onChange={(value) => setLongImageWidth(value as 750 | 790 | 1200)} options={LONG_IMAGE_WIDTH_OPTIONS}/>
                </div>
                <Checkbox checked={longImageSlices} onChange={(event) => setLongImageSlices(event.target.checked)}>
                  同时导出切片（按屏边界切，不裁穿画面）
                </Checkbox>
              </div>) : null}
            <p className={styles.exportDialogHint}>
              已选 {exportOutputIds.length} 张成图{exportMode === "longImage" ? `，将按分镜顺序合成为 ${longImagePreviewOutputs.length} 屏长图` : ""}。
            </p>
          </div>
          {exportMode === "longImage" && longImagePreviewOutputs.length > 0 ? (<div className={styles.exportDialogPreview} aria-label="长图预览">
              <p className={styles.exportDialogLabel}>拼接顺序预览</p>
              <div ref={screensRef} className={styles.exportDialogScreens} role="list" aria-label="长图各屏，可拖拽或用按钮调整顺序" data-sorting={dragSourceId != null ? "true" : undefined} onPointerMove={moveScreenDrag} onPointerUp={() => endScreenDrag(true)} onPointerCancel={() => endScreenDrag(false)} onLostPointerCapture={() => endScreenDrag(true)}>
                {longImagePreviewOutputs.map((output, index) => (<Fragment key={output.id}>
                    {dragSourceId != null && insertIndex === index ? (<div className={styles.exportDialogScreenPlaceholder} style={dragHeight > 0 ? { height: dragHeight } : undefined}/>) : null}
                    <figure role="listitem" ref={(element) => {
                    if (element)
                        screenRefs.current.set(output.id, element);
                    else
                        screenRefs.current.delete(output.id);
                }} className={styles.exportDialogScreen} data-hidden={dragSourceId === output.id ? "true" : undefined} onPointerDown={(event) => beginScreenDrag(event, index, output.id)}>
                      <span className={styles.exportDialogScreenIndex}>{index + 1}</span>
                      <figcaption className={styles.hint}>{imagePlanningLabel(output.imagePlanning)}</figcaption>
                      {/* 预览用 512px 缩略图；编辑产物等缺缩略图时回退原图。 */}
                      <img src={outputThumbnailUrl(output) ?? outputPreviewUrl(output)} alt={`第 ${index + 1} 屏`} draggable={false} loading="lazy" decoding="async" onError={(event) => {
                    const image = event.currentTarget;
                    if (image.dataset.fallback)
                        return;
                    image.dataset.fallback = "1";
                    image.src = outputPreviewUrl(output);
                }}/>
                      <div className={styles.exportDialogScreenTools}>
                        <button type="button" disabled={index === 0} onClick={() => moveScreen(index, index - 1)} aria-label={`上移第 ${index + 1} 屏`}>
                          <ChevronUp size={13} strokeWidth={2.5}/>
                        </button>
                        <button type="button" disabled={index === longImagePreviewOutputs.length - 1} onClick={() => moveScreen(index, index + 1)} aria-label={`下移第 ${index + 1} 屏`}>
                          <ChevronDown size={13} strokeWidth={2.5}/>
                        </button>
                      </div>
                    </figure>
                  </Fragment>))}
                {dragSourceId != null && insertIndex === longImagePreviewOutputs.length ? (<div className={styles.exportDialogScreenPlaceholder} style={dragHeight > 0 ? { height: dragHeight } : undefined}/>) : null}
              </div>
            </div>) : null}
        </div>
      </Modal>
    </div>);
}
