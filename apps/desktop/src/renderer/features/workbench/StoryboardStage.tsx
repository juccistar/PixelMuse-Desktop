import { App, Button, Checkbox, Input, InputNumber, Modal, Tooltip } from 'antd';
import { motion } from 'motion/react';
import { Check, Pencil, Trash2, TriangleAlert, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_PRODUCT_IMAGE_TARGETS, suitePlanningCounts, type ProductImagePlanningConfig, type ProjectImagePlanning } from '@ecomgen/contracts';
import { SuiteBlueprintEditor } from './SuiteBlueprintEditor';
import { useCreateStoryboardSuiteJob } from '../../api/hooks/useSuitePlanning';
import { useBusinessNavigate } from '../../components/businessActivity';
import type { Asset, ProjectDetail, StoryboardItem } from '../../api/adapters/projectDetail';
import { useCreateGenerationJobs } from '../../api/hooks/useGeneration';
import { useConfirmStoryboard, useDeleteStoryboardItem, useStoryboard } from '../../api/hooks/useStoryboard';
import { useCreateProductImagePlanningJob, useProjectImagePlanning, useSaveProjectImagePlanning } from '../../api/hooks/useProductImagePlanning';
import { useJob } from '../../api/hooks/useJobs';
import { useTemplateNames } from '../../api/hooks/useTemplates';
import { ModeBadge } from '../../components/ModeBadge';
import { useBusinessActive } from '../../components/businessActivity';
import type { BeforeNavigate } from '../../components/navigationGuard';
import { isApiError } from '../../api/errors';
import { transition } from '../../design/motion';
import { errorText } from '../../lib/errorText';
import { ITEM_STATUS_LABEL } from '../../lib/factClaims';
import { itemDisplayName } from '../../lib/itemName';
import { isGenerationLocked } from '../../lib/generateSelection';
import { assetPreviewUrl } from '../../lib/assetUrl';
import { randomUuid } from '../../lib/randomUuid';
import { readProjectPlanningDraft, saveProjectPlanningDraft, readPlanningIntent, keepPlanningIntent, clearPlanningIntent } from '../../lib/projectPreparation';
import { IMAGE_PURPOSE_LABEL, imagePlanningLabel, productImagePlanningIncomplete, productImagePlanningTotals, type ImagePurposeFilter } from '../../lib/productImagePlanning';
import { JobRecords } from './JobRecords';
import { SkuManagerDrawer } from './SkuManagerDrawer';
import { StoryboardInspector, type StoryboardInspectorHandle } from './StoryboardInspector';
import styles from './StoryboardLayout.module.css';

/** 检查图片规划、管理画面需求并提交所选分镜生成。 */
export function StoryboardStage({ detail, onGenerated, registerNavigationGuard }: {
  detail: ProjectDetail;
  onGenerated?: () => void;
  registerNavigationGuard?: (guard: BeforeNavigate | null) => void;
}) {
  const { notification, modal } = App.useApp();
  const active = useBusinessActive();
  const board = useStoryboard(detail.id);
  const planningQuery = useProjectImagePlanning(detail.id);
  const savePlanning = useSaveProjectImagePlanning(detail.id);
  const createPlanning = useCreateProductImagePlanningJob(detail.id);
  const livePlan = useJob(detail.id, createPlanning.data?.id);
  const confirm = useConfirmStoryboard(detail.id);
  const remove = useDeleteStoryboardItem(detail.id);
  const generate = useCreateGenerationJobs(detail.id);
  const createSuite = useCreateStoryboardSuiteJob();
  const navigate = useBusinessNavigate();
  const [suiteName, setSuiteName] = useState('');
  const suiteSubmission = useRef<{ name: string; key: string } | undefined>(undefined);
  const [saveSuiteOpen, setSaveSuiteOpen] = useState(false);
  const templateNames = useTemplateNames();
  const items = (board.data?.items ?? detail.items).filter(item => !item.planningSuperseded);
  const storyboard = board.data?.storyboard ?? detail.storyboard;
  const locked = storyboard?.status === 'CONFIRMED';
  const [editingId, setEditingId] = useState<string | null>(null);
  const [inspectorDirty, setInspectorDirty] = useState(false);
  const inspector = useRef<StoryboardInspectorHandle>(null);
  const inspectorClosing = useRef<Promise<boolean> | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [deletingSelected, setDeletingSelected] = useState(false);
  const [preview, setPreview] = useState<{ assets: Asset[]; index: number } | null>(null);
  const [purpose, setPurpose] = useState<ImagePurposeFilter>('ALL');
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [drawer, setDrawer] = useState<'sku' | 'jobs' | null>(null);
  const [skuDirty, setSkuDirty] = useState(false);
  const [draft, setDraft] = useState<ProjectImagePlanning | null>(null);
  const [instruction, setInstruction] = useState(() => readProjectPlanningDraft(detail.id).instruction);
  const changeInstruction = (value: string) => {
    setInstruction(value);
    saveProjectPlanningDraft(detail.id, { ...readProjectPlanningDraft(detail.id), instruction: value });
  };
  const submitting = useRef(false);
  const planning = draft ?? planningQuery.data;
  const totals = planning ? productImagePlanningTotals(planning, detail.candidatesPerType) : null;
  const editing = items.find(item => item.id === editingId);
  const expected = items.reduce((sum, item) => sum + item.candidateCount, 0);
  const selectedItems = items.filter(item => selectedIds.includes(item.id));
  const selectedExpected = selectedItems.reduce((sum, item) => sum + item.candidateCount, 0);
  const allSelected = items.length > 0 && selectedItems.length === items.length;
  const staleCount = items.filter(item => item.planningStale).length;
  const incomplete = planningQuery.data ? productImagePlanningIncomplete(planningQuery.data, items) : items.some(item => item.imagePlanning);
  const planJobs = detail.jobs.filter(job => job.type === 'PLAN' && !job.history);
  const pendingPlan = planJobs.some(job => ['QUEUED', 'RUNNING', 'UNKNOWN'].includes(job.status)) || detail.jobs.some(job => job.type === 'GENERATE' && job.status === 'UNKNOWN' && !job.history) || ['QUEUED', 'RUNNING', 'UNKNOWN'].includes(livePlan.data?.status ?? createPlanning.data?.status ?? '');
  const busy = savePlanning.isPending || createPlanning.isPending || confirm.isPending || generate.isPending || remove.isPending || deletingSelected;
  const generationBlocked = busy || Boolean(draft) || skuDirty || drawer === 'sku' || inspectorDirty || pendingPlan || staleCount > 0 || incomplete || planningQuery.isPending || planningQuery.isError || board.isFetching;
  const referenceAssets = new Map(detail.assets.filter(asset => asset.projectId === detail.id && asset.mimeType.startsWith('image/')).map(asset => [asset.id, asset]));

  useEffect(() => {
    setSelectedIds(current => current.filter(id => items.some(item => item.id === id)));
  }, [board.data?.items, detail.items]);

  const closeInspector = useCallback((): Promise<boolean> => {
    if (!editingId) return Promise.resolve(true);
    if (inspectorClosing.current) return inspectorClosing.current;
    const closing = (async () => {
      const saved = inspector.current ? await inspector.current.flush() : !inspectorDirty;
      if (saved) { setEditingId(null); setInspectorDirty(false); }
      return saved;
    })();
    inspectorClosing.current = closing;
    void closing.finally(() => { inspectorClosing.current = null; });
    return closing;
  }, [editingId, inspectorDirty]);
  const requestLeave = useCallback(async () => {
    if (savePlanning.isPending || createPlanning.isPending || !await closeInspector()) return false;
    if (!skuDirty && !draft) {
      setDrawer(null);
      return true;
    }
    const discard = await new Promise<boolean>(resolve => modal.confirm({
      title: '放弃未保存的图片规划修改？',
      content: 'SKU 和数量的未保存修改将丢失，已保存的规划与成图保留。',
      okText: '放弃修改', cancelText: '继续编辑',
      onOk: () => { resolve(true); }, onCancel: () => { resolve(false); },
    }));
    if (discard) { setSkuDirty(false); setDraft(null); setDrawer(null); registerNavigationGuard?.(null); }
    return discard;
  }, [skuDirty, draft, modal, savePlanning.isPending, createPlanning.isPending, registerNavigationGuard, closeInspector]);
  useEffect(() => {
    registerNavigationGuard?.(skuDirty || draft || editingId || savePlanning.isPending ? requestLeave : null);
    return () => registerNavigationGuard?.(null);
  }, [registerNavigationGuard, requestLeave, skuDirty, draft, editingId, savePlanning.isPending]);
  useEffect(() => {
    if (!skuDirty && !draft && !inspectorDirty) return;
    const preventUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', preventUnload);
    return () => window.removeEventListener('beforeunload', preventUnload);
  }, [skuDirty, draft, inspectorDirty]);

  const changeConfig = (field: Exclude<keyof ProductImagePlanningConfig, 'shareImages'>, value: number | null) => {
    if (!planning || value === null) return;
    const config = { ...planning.config, [field]: value };
    setDraft(JSON.stringify(config) === JSON.stringify(planningQuery.data?.config) ? null : { ...planning, config });
  };
  const persistCounts = async (): Promise<ProjectImagePlanning> => {
    if (!planning) throw new Error('请先读取图片规划配置');
    if (!draft) return planning;
    const result = await savePlanning.mutateAsync({ expectedRevision: draft.revision, config: draft.config, skus: draft.skus, imageGroups: draft.imageGroups });
    setDraft(null);
    return result.planning;
  };
  const saveCounts = async () => {
    try { await persistCounts(); }
    catch (error) { notification.error({ title: '图片数量未保存', description: errorText(error) }); }
  };
  const openSkus = async () => {
    if (!await closeInspector()) return;
    try { await persistCounts(); setDrawer('sku'); }
    catch (error) { notification.error({ title: '请先保存图片数量', description: errorText(error) }); }
  };
  const openTasks = async () => {
    if (drawer === 'sku' ? !await requestLeave() : !await closeInspector()) return;
    setDrawer('jobs');
  };
  const requestPlanning = async (scope: 'ALL' | 'STALE') => {
    if (submitting.current || busy || pendingPlan || drawer === 'sku') return;
    submitting.current = true;
    try {
      if (!await closeInspector()) return;
      if (scope === 'ALL' && items.some(item => item.imagePlanning)) {
        const replace = await new Promise<boolean>(resolve => modal.confirm({
          title: '重新生成全部图片规划？', content: '当前产品规划将被新版本替代，已有成图和历史版本保留。手工修改可用“更新受影响规划”保留。',
          okText: '重新规划', cancelText: '取消', onOk: () => { resolve(true); }, onCancel: () => { resolve(false); },
        }));
        if (!replace) return;
      }
      // 必须用保存回执的 canonical revision，不能用闭包中保存前的查询版本。
      const saved = await persistCounts();
      const strategy = { planningMode: 'AI' as const };
      const styleInstruction = saved.config.suiteBlueprint ? '' : (readProjectPlanningDraft(detail.id).styleInstruction ?? '').trim();
      const inputDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([saved.revision, scope, instruction.trim(), styleInstruction, strategy])));
      const fingerprint = Array.from(new Uint8Array(inputDigest), byte => byte.toString(16).padStart(2, '0')).join('');
      const previousIntent = readPlanningIntent(detail.id);
      const regenerationKey = previousIntent?.fingerprint === fingerprint ? previousIntent.regenerationKey : randomUuid();
      keepPlanningIntent(detail.id, { fingerprint, regenerationKey, instruction });
      await createPlanning.mutateAsync({ expectedRevision: saved.revision, scope, regenerationKey, ...strategy, ...(instruction.trim() ? { userInstruction: instruction.trim() } : {}), ...(styleInstruction ? { styleInstruction } : {}) });
      clearPlanningIntent(detail.id, regenerationKey);
    } catch (error) {
      notification.error({ title: '图片规划未提交', description: errorText(error) });
    } finally { submitting.current = false; }
  };
  /** 卡片与检查器共用删除限制，避免入口之间出现不同权限。 */
  const deleteDisabledReason = (item: StoryboardItem): string | undefined => {
    if (isGenerationLocked(item)) return item.status === 'GENERATED' ? '此画面已有成图，不能删除图片需求。' : '此画面正在生成，请等待任务结束后再删除。';
    if (pendingPlan) return '规划正在执行或有任务已中断，请先在任务详情处理。';
    if (busy) return '正在保存或提交操作，请稍后再删除。';
    return undefined;
  };
  const requestDelete = (item: StoryboardItem) => {
    if (deleteDisabledReason(item)) return;
    modal.confirm({ title: '取消此图片需求？', content: '此画面将从当前图片规划移除，已有成图和历史记录保留。', okText: '取消图片需求', cancelText: '保留需求', okButtonProps: { danger: true },
      onOk: async () => {
        if (editingId === item.id) {
          const pending = inspector.current?.discard();
          setEditingId(null);
          setInspectorDirty(false);
          await pending;
        } else if (!await closeInspector()) throw new Error('请先保存其他画面的修改');
        try { await remove.mutateAsync(item.id); await planningQuery.refetch(); }
        catch (error) { notification.error({ title: '分镜删除失败', description: errorText(error) }); throw error; }
      },
    });
  };
  const deleteSelected = async () => {
    if (busy || submitting.current || !selectedItems.length) return;
    submitting.current = true;
    const blocked = selectedItems.filter(item => deleteDisabledReason(item));
    const eligible = selectedItems.filter(item => !deleteDisabledReason(item));
    const failures: string[] = blocked.map(item => `${itemDisplayName(item, templateNames)}：${deleteDisabledReason(item)}`);
    setDeletingSelected(true);
    try {
      if (editingId && eligible.some(item => item.id === editingId)) {
        await inspector.current?.discard();
        setEditingId(null);
        setInspectorDirty(false);
      } else if (!await closeInspector()) {
        notification.error({ title: '无法删除所选', description: '请先保存当前画面的修改。' });
        return;
      }
      for (const item of eligible) {
        try {
          await remove.mutateAsync(item.id);
          setSelectedIds(current => current.filter(id => id !== item.id));
        } catch (error) {
          failures.push(`${itemDisplayName(item, templateNames)}：${errorText(error)}`);
        }
      }
      await planningQuery.refetch();
      if (failures.length) notification.warning({ title: '部分画面未删除', description: failures.join('；'), duration: 0 });
    } finally {
      setDeletingSelected(false);
      submitting.current = false;
    }
  };
  const onConfirmAndGenerate = async () => {
    if (!storyboard || selectedItems.length === 0 || generationBlocked || submitting.current) return;
    submitting.current = true;
    try {
      // 右栏保持可编辑；确认前等待回执，再读取最新版本，不能确认保存前的旧快照。
      if (inspector.current && !await inspector.current.flush()) return;
      const refreshed = await board.refetch();
      if (refreshed.isError || !refreshed.data?.storyboard) throw new Error('图片规划读取失败，请重试');
      const current = refreshed.data;
      const currentItems = current.items.filter(item => !item.planningSuperseded);
      if (currentItems.some(item => item.planningStale) || (planningQuery.data && productImagePlanningIncomplete(planningQuery.data, currentItems))) throw new Error('图片规划已变化，请先更新受影响规划');
      const ids = selectedIds.filter(id => currentItems.some(item => item.id === id));
      if (!ids.length) return;
      if (current.storyboard!.status !== 'CONFIRMED') await confirm.mutateAsync(current.storyboard!.version);
      await generate.mutateAsync({ storyboardItemIds: ids });
      onGenerated?.();
    } catch (error) {
      if (isApiError(error) && error.code === 'CONFLICT') {
        notification.error({ title: '分镜已被其他操作更新' });
        void board.refetch(); void planningQuery.refetch();
      } else notification.error({ title: locked ? '生成失败' : '确认失败', description: errorText(error) });
    } finally { submitting.current = false; }
  };
  const toggleSelection = (id: string) => setSelectedIds(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
  const purposeCount = (value: ImagePurposeFilter) => value === 'ALL' ? items.length : items.filter(item => (item.imagePlanning?.purpose ?? 'LEGACY') === value).length;
  const visible = items.filter(item => (purpose === 'ALL' || (item.imagePlanning?.purpose ?? 'LEGACY') === purpose) && (!selectedOnly || selectedIds.includes(item.id)));
  const planDisabled = busy || pendingPlan || !totals || totals.frameCount > MAX_PRODUCT_IMAGE_TARGETS || planningQuery.isError || drawer === 'sku' || inspectorDirty;
  const referencesFor = (item: StoryboardItem) => [...new Set([...(item.imagePlanning?.purpose === 'SKU' ? item.imagePlanning.productAssetIds : []), ...(item.referencedAssets ?? [])])].map(id => referenceAssets.get(id)).filter((asset): asset is Asset => Boolean(asset));

  return <section className={styles.boardWrap} aria-label="图片规划">
    <header className={styles.heading}>
      <div className={styles.headingCopy}><h2>图片规划</h2><span className={styles.headingCount}>检查整套画面方案，再统一生成图片</span></div>
      <div className={styles.planningActions}>{items.length ? <Button onClick={() => setSaveSuiteOpen(true)}>保存为套图</Button> : null}<Button onClick={() => void openSkus()} disabled={!planning || busy}>管理 SKU</Button><Button loading={createPlanning.isPending} disabled={planDisabled || !totals?.frameCount} onClick={() => void requestPlanning('ALL')}>{items.length ? '重做整套方案' : '生成图片规划'}</Button></div>
    </header>
    <div className={styles.workspace}>
    <div className={styles.planningMain}>
    <JobRecords detail={detail} open={drawer === 'jobs'} onOpenChange={open => { if (open) void openTasks(); else setDrawer(current => current === 'jobs' ? null : current); }}/>
    {planning && totals ? <details className={styles.planningControls} open={items.length === 0 || Boolean(draft)}><summary>图片需求 · {totals.frameCount} 个画面{draft ? ' · 数量未保存' : ''}<span>调整数量与规划要求</span></summary><section aria-label="图片数量">
      <div className={styles.countFields}>
        <label>主图 <InputNumber aria-label="主图数量" min={0} max={12} precision={0} value={planning.config.mainCount} disabled={busy || drawer === 'sku' || Boolean(planning.config.suiteBlueprint)} onChange={value => changeConfig('mainCount', value)}/> 张</label>
        <div className={styles.skuCount}><strong>SKU {totals.skuCount} 个 · {totals.groupCount} 组图片</strong><label>每组 <InputNumber aria-label="每组 SKU 图片数" min={planning.config.suiteBlueprint ? 0 : 1} max={4} precision={0} value={planning.config.suiteBlueprint ? planning.config.suiteBlueprint.shots.filter(shot => shot.purpose === 'SKU').length : planning.config.skuImagesPerGroup} disabled={busy || drawer === 'sku' || Boolean(planning.config.suiteBlueprint)} onChange={value => changeConfig('skuImagesPerGroup', value)}/> 张</label></div>
        <label>详情图 <InputNumber aria-label="详情图数量" min={0} max={24} precision={0} value={planning.config.detailCount} disabled={busy || drawer === 'sku' || Boolean(planning.config.suiteBlueprint)} onChange={value => changeConfig('detailCount', value)}/> 张</label>
        <div className={styles.planningActions}>
          {draft ? <Button loading={savePlanning.isPending} disabled={busy} onClick={() => void saveCounts()}>保存数量</Button> : null}
          {staleCount > 0 || incomplete ? <Button disabled={planDisabled} onClick={() => void requestPlanning('STALE')}>更新受影响规划</Button> : null}
        </div>
      </div>
      {planning.config.suiteBlueprint ? <details><summary>编辑套图镜头（数量由镜头决定）</summary><SuiteBlueprintEditor value={planning.config.suiteBlueprint} onChange={blueprint => setDraft({ ...planning, config: { ...planning.config, suiteBlueprint: blueprint, ...suitePlanningCounts(blueprint) } })}/></details> : null}
      <p className={styles.planningTotal} aria-live="polite">{totals.frameCount} 个画面 · 每画面 {detail.candidatesPerType} 个候选 · 预计生成 {totals.candidateCount} 张{draft ? ' · 数量未保存' : ''}{planning.config.shareImages ? ' · 仅明确分组的 SKU 共图' : ''}</p>
      <details className={styles.planningInstruction}><summary>规划要求（可选）</summary><Input.TextArea aria-label="图片规划要求" value={instruction} maxLength={4000} autoSize={{ minRows: 2, maxRows: 4 }} onChange={event => changeInstruction(event.target.value)} placeholder="说明本次图片的重点、构图或风格要求"/></details>
      {totals.frameCount > MAX_PRODUCT_IMAGE_TARGETS ? <p role="alert">单次最多 {MAX_PRODUCT_IMAGE_TARGETS} 个画面，请减少数量或参与的 SKU。</p> : null}
    </section></details> : <p role={planningQuery.isError ? 'alert' : 'status'}>{planningQuery.isError ? '图片规划配置读取失败' : '正在读取图片规划配置…'}{planningQuery.isError ? <Button onClick={() => void planningQuery.refetch()}>重新读取</Button> : null}</p>}
    <div className={styles.filterBar}>
      <div role="tablist" aria-label="图片用途" className={styles.purposeTabs}>
        {(['ALL', 'MAIN', 'SKU', 'DETAIL', 'LEGACY'] as const).filter(value => value !== 'LEGACY' || purposeCount(value) > 0).map(value => <button key={value} type="button" role="tab" aria-selected={purpose === value} onClick={() => setPurpose(value)}>{value === 'ALL' ? '全部' : IMAGE_PURPOSE_LABEL[value]} {purposeCount(value)}</button>)}
      </div>
      <div className={styles.filterSummary}>{totals ? <span>{totals.skuCount} 个 SKU · {totals.groupCount} 组图片 · 预计 {expected} 张候选</span> : null}<Checkbox checked={selectedOnly} onChange={event => setSelectedOnly(event.target.checked)}>仅看已选</Checkbox></div>
    </div>
    {(staleCount > 0 || incomplete || pendingPlan || draft || skuDirty || inspectorDirty) ? <p className={styles.blockingHint} role="status">{pendingPlan ? '规划正在执行或有任务已中断，请在任务详情处理后继续。' : draft || skuDirty ? '有未保存修改，请先保存后更新图片规划。' : inspectorDirty ? '分镜修改尚未保存，请等待保存完成。' : `${staleCount ? `${staleCount} 个画面待更新。` : ''}${incomplete ? '图片规划尚未覆盖当前全部目标。' : ''}更新完成后才能确认生成。`}</p> : null}
    {items.length === 0 ? <div className={styles.placeholder}><h3>还没有图片规划</h3><p>设置图片数量和实际 SKU，再点击“生成图片规划”。完成规划后选择画面，确认后再生图。</p></div> : <>
      <p className={styles.previewHint}>方案预览 · 参考素材与文字方案，确认后生图</p>
      <div className={styles.boardScroll}>
        {!visible.length ? <p className={styles.headingCount}>当前筛选没有画面，其他用途中的选择仍保留。</p> : null}
        <motion.div className={styles.board} data-locked={locked} animate={locked ? { opacity: [0.96, 1] } : { opacity: 1 }} transition={transition.fast}>
          {visible.map(item => <StoryboardCard key={item.id} item={item} label={itemDisplayName(item, templateNames)} number={String(items.indexOf(item) + 1).padStart(2, '0')} references={referencesFor(item)} onPreview={(assets, index) => setPreview({ assets, index })} selected={item.id === editingId} checked={selectedIds.includes(item.id)} onSelect={() => { if (drawer === 'sku' || editingId === item.id) return; void closeInspector().then(saved => { if (saved) setEditingId(item.id); }); }} onToggle={() => toggleSelection(item.id)} onDelete={() => requestDelete(item)} deleteDisabledReason={deleteDisabledReason(item)}/>)}
        </motion.div>
      </div>
    </>}
    </div>
    <aside className={styles.inspectorPanel} aria-label="画面检查器" hidden={!active}>
      {editing ? <>
        <header className={styles.inspectorHeader}><h3>{String(items.indexOf(editing) + 1).padStart(2, '0')} {itemDisplayName(editing, templateNames)}</h3><Button type="text" aria-label="关闭画面检查器" icon={<X size={18}/>} onClick={() => void closeInspector()}/></header>
        <div className={styles.inspectorScroll}><StoryboardInspector ref={inspector} key={editing.id} projectId={detail.id} item={editing} templates={templateNames} references={referencesFor(editing)} onPreview={(assets, index) => setPreview({ assets, index })} onDirtyChange={setInspectorDirty}/></div>
        <div className={styles.inspectorActions}><Tooltip title={deleteDisabledReason(editing)}><span><Button danger disabled={Boolean(deleteDisabledReason(editing))} aria-description={deleteDisabledReason(editing)} loading={remove.isPending} onClick={() => requestDelete(editing)}>取消此图片需求</Button></span></Tooltip></div>
      </> : <div className={styles.inspectorEmpty}><Pencil size={24} strokeWidth={1.5}/><h3>检查画面方案</h3><p>点击左侧方案，查看使用素材、调整画面要求与生图参数。</p></div>}
    </aside>
    </div>
    {items.length ? <footer className={styles.confirmBar}>
        <div className={styles.selectionSummary} aria-live="polite"><strong>{selectedItems.length} 个已选分镜</strong><span>共 {items.length} 个 · 预计 {selectedExpected}/{expected} 张候选</span></div>
        <div className={styles.confirmActions}><Button danger loading={deletingSelected} disabled={busy || !selectedItems.length} onClick={() => void deleteSelected()}>删除所选</Button><Button className={styles.selectAllAction} onClick={() => setSelectedIds(allSelected ? [] : items.map(item => item.id))}>{allSelected ? '取消全选' : '全选'}</Button><Button type="primary" className={styles.selectedGenerateAction} loading={confirm.isPending || generate.isPending} disabled={!storyboard || !selectedItems.length || generationBlocked} onClick={() => void onConfirmAndGenerate()}>确认并生成</Button></div>
      </footer> : null}
    <Modal open={saveSuiteOpen} title="保存为套图" okText="创建草稿" cancelText="取消" confirmLoading={createSuite.isPending} onCancel={() => setSaveSuiteOpen(false)} onOk={() => void (async () => { if (!suiteName.trim()) { notification.warning({ title: '请输入套图名称' }); return; } if (!await closeInspector()) return; try { const name = suiteName.trim(); if (suiteSubmission.current?.name !== name) suiteSubmission.current = { name, key: randomUuid() }; await createSuite.mutateAsync({ projectId: detail.id, name, regenerationKey: suiteSubmission.current.key }); suiteSubmission.current = undefined; setSaveSuiteOpen(false); notification.success({ title: '套图草稿任务已创建', description: '请在套图工坊查看并确认抽离商品事实后的草稿。' }); void navigate('/suite-forge'); } catch (error) { notification.error({ title: '创建套图草稿失败', description: errorText(error) }); } })()}>
      <p>将生成可复用的套图草稿，需在套图工坊检查并确认。</p><Input aria-label="套图名称" value={suiteName} maxLength={60} onChange={event => setSuiteName(event.target.value)}/>
    </Modal>
    <Modal open={Boolean(preview)} title="参考素材预览" footer={null} onCancel={() => setPreview(null)} destroyOnHidden>
      {preview && preview.assets[preview.index] ? <div className={styles.previewViewer} onKeyDown={event => {
        if (event.key === 'ArrowLeft') setPreview({ ...preview, index: Math.max(0, preview.index - 1) });
        if (event.key === 'ArrowRight') setPreview({ ...preview, index: Math.min(preview.assets.length - 1, preview.index + 1) });
      }}>
        <img src={assetPreviewUrl(preview.assets[preview.index]!)} alt={preview.assets[preview.index]!.originalName || '项目图片'}/>
        <div><Button disabled={preview.index === 0} onClick={() => setPreview({ ...preview, index: preview.index - 1 })}>上一张</Button><span>{preview.index + 1} / {preview.assets.length}</span><Button disabled={preview.index === preview.assets.length - 1} onClick={() => setPreview({ ...preview, index: preview.index + 1 })}>下一张</Button></div>
      </div> : null}
    </Modal>
    {planningQuery.data ? <SkuManagerDrawer open={drawer === 'sku'} planning={planningQuery.data} assets={detail.assets} saving={savePlanning.isPending} onDirtyChange={setSkuDirty} onClose={() => setDrawer(null)} onSave={async input => { await savePlanning.mutateAsync(input); setDraft(null); }}/>: null}
  </section>;
}

function StoryboardCard({ item, label, number, references, onPreview, selected, checked, onSelect, onToggle, onDelete, deleteDisabledReason }: {
  item: StoryboardItem; label: string; number: string; references: Asset[]; onPreview: (assets: Asset[], index: number) => void; selected: boolean; checked: boolean; onSelect: () => void; onToggle: () => void; onDelete: () => void; deleteDisabledReason?: string;
}) {
  const risks = item.riskFlags.length;
  const [unavailableIds, setUnavailableIds] = useState<string[]>([]);
  const available = references.filter(asset => !unavailableIds.includes(asset.id));
  return <div className={styles.shotCardWrap} data-storyboard-item-id={item.id} data-purpose={item.imagePlanning?.purpose ?? 'LEGACY'}>
    <button type="button" className={styles.shotPick} role="checkbox" aria-checked={checked} aria-label={`选择${label}`} title={checked ? '取消选择' : '选择分镜'} onClick={onToggle}>{checked ? <Check size={15} strokeWidth={2.5} aria-hidden/> : null}</button>
    <div role="button" tabIndex={0} className={styles.shotCard} data-selected={selected} data-picked={checked} aria-label={`${label} 分镜`} onClick={onSelect} onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onSelect(); } }}>
      <span className={styles.shotHeading}><span className={styles.shotNumber}>{number}</span><span className={styles.shotType}>{label}</span><Pencil size={14} aria-hidden/></span>
      <span className={styles.shotBody}>{available.length ? <button type="button" className={styles.shotReference} aria-label={`预览参考素材：${available[0]!.originalName || '项目图片'}`} onClick={event => { event.stopPropagation(); onPreview(available, 0); }}><img src={assetPreviewUrl(available[0]!)} alt={`参考素材：${available[0]!.originalName || '项目图片'}`} loading="lazy" decoding="async" onError={() => setUnavailableIds(current => [...current, available[0]!.id])}/><span>参考素材{available.length > 1 ? ` · ${available.length} 张` : ''}</span></button> : <span className={styles.shotPlaceholder} aria-hidden><strong>{number}</strong><span>规划分镜</span></span>}<span className={styles.shotInstruction} title={item.promptInstruction}><strong>画面要求</strong>{item.promptInstruction || '尚未填写画面要求'}</span></span>
      {item.planningSource ? <span className={styles.skuAssociation}>{item.planningSource.kind === 'SUITE' ? '套图规划' : '模型自主规划'} · {item.planningSource.intent} · 参考：{item.planningSource.referenceIntent}</span> : null}
      {item.imagePlanning ? <span className={styles.skuAssociation}>{imagePlanningLabel(item.imagePlanning)}</span> : null}
      <span className={styles.shotMeta}><span className={styles.scopeChip}>{item.imageAspectRatio ?? 'AUTO'}</span><span className={styles.scopeChip}>{item.candidateCount} 张候选</span><ModeBadge mode={item.mode}/><span className={styles.statusPill}>{item.planningStale ? '待更新' : ITEM_STATUS_LABEL[item.status]}</span></span>
      {risks > 0 ? <span className={styles.riskMark} aria-label={`${risks} 条风险`} title={item.riskFlags.join('；')}><TriangleAlert size={14} strokeWidth={1.75} aria-hidden/><span>{risks} 条风险 · {item.riskFlags[0]}</span></span> : null}
    </div>
    <div className={styles.shotActions}><Tooltip title={deleteDisabledReason}><span><button type="button" className={styles.shotDelete} aria-label={`删除${label}`} aria-description={deleteDisabledReason} disabled={Boolean(deleteDisabledReason)} onClick={onDelete}><Trash2 size={14} aria-hidden/>删除</button></span></Tooltip></div>
  </div>;
}
