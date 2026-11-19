import { Drawer } from 'antd';
import { ArrowDown, ArrowUp, Copy, ImageIcon, Plus, Trash2, X } from 'lucide-react';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { invoke } from '../../api/client';
import { qk } from '../../api/queryKeys';
import type { ProductImagePlanningConfig, ProjectImagePlanning, ProjectSku, SkuAttribute, SkuImageGroup } from '@ecomgen/contracts';
import type { Asset } from '../../api/adapters/projectDetail';
import { useBusinessActive } from '../../components/businessActivity';
import { assetPreviewUrl } from '../../lib/assetUrl';
import { errorText } from '../../lib/errorText';
import styles from './SkuManagerDrawer.module.css';

type SaveInput = { expectedRevision: number; config: ProductImagePlanningConfig; skus: ProjectSku[]; imageGroups: SkuImageGroup[] };
/** SKU 目录一次原子保存；组件只编辑草稿，不启动规划或模型。 */
export interface SkuManagerDrawerProps {
  open: boolean;
  planning: ProjectImagePlanning;
  assets: Asset[];
  saving: boolean;
  onSave: (input: SaveInput) => Promise<void>;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}

type Draft = Pick<ProjectImagePlanning, 'projectId' | 'revision' | 'config' | 'skus' | 'imageGroups'>;
type Axis = { id: string; name: string; values: string };
type Batch = { prefix: string; axes: Axis[] };
type GroupForm = { mode: 'members' | 'attributes'; editingId: string | null; name: string; memberIds: string[]; assetIds: string[]; attributeKeys: string[]; baseline: string };
type GroupPreview = { name: string; skuIds: string[]; productAssetIds: string[]; id?: string }[];
const MAX_SKUS = 60;
const MAX_ATTRIBUTES = 8;
const MAX_REFS = 6;
const signature = (value: unknown) => JSON.stringify(value);
const normalizedKey = (value: string) => value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
const clone = <T,>(value: T): T => structuredClone(value);
const fromPlanning = (planning: ProjectImagePlanning): Draft => clone({ projectId: planning.projectId, revision: planning.revision, config: planning.config, skus: planning.skus, imageGroups: planning.imageGroups });
const directorySignature = (draft: Draft) => signature({ config: draft.config, skus: draft.skus, imageGroups: draft.imageGroups });
const attributeKey = (attributes: SkuAttribute[]) => signature(attributes.map(attribute => [normalizedKey(attribute.name), attribute.value.trim()]).sort(([a = ''], [b = '']) => a.localeCompare(b)));
const groupMemberKey = (ids: string[]) => signature([...ids].sort());
const formSignature = (form: Omit<GroupForm, 'baseline'> | GroupForm) => signature({ mode: form.mode, editingId: form.editingId, name: form.name, memberIds: form.memberIds, assetIds: form.assetIds, attributeKeys: form.attributeKeys });
function newGroupForm(group?: SkuImageGroup): GroupForm {
  const form = { mode: 'members' as const, editingId: group?.id ?? null, name: group?.name ?? '', memberIds: [...(group?.skuIds ?? [])], assetIds: [...(group?.productAssetIds ?? [])], attributeKeys: [] as string[] };
  return { ...form, baseline: formSignature(form) };
}
function duplicateName(name: string): string {
  const suffix = ' 副本';
  let prefix = '';
  // 按码点截取，但仍遵守输入框和校验使用的 UTF-16 长度预算。
  for (const character of name) {
    if (prefix.length + character.length > 120 - suffix.length) break;
    prefix += character;
  }
  return prefix + suffix;
}
function canRestoreDrawerFocus(target: HTMLElement | null, drawer: HTMLElement): target is HTMLElement {
  if (!target?.isConnected || !drawer.isConnected || !drawer.contains(target) || target.matches(':disabled')) return false;
  for (let element: HTMLElement | null = target; element; element = element.parentElement) {
    if (element.hidden || element.hasAttribute('inert') || element.getAttribute('aria-hidden') === 'true') return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (element instanceof HTMLDetailsElement && !element.open && !element.querySelector('summary')?.contains(target)) return false;
  }
  return true;
}
function normalize(draft: Draft): SaveInput {
  return {
    expectedRevision: draft.revision, config: { ...draft.config },
    skus: draft.skus.map(sku => ({ ...sku, name: sku.name.trim(), code: sku.code?.trim() || null, attributes: sku.attributes.map(attribute => ({ name: attribute.name.trim(), value: attribute.value.trim() })), productAssetIds: [...sku.productAssetIds] })),
    imageGroups: draft.imageGroups.map(group => ({ ...group, name: group.name.trim(), skuIds: [...group.skuIds], productAssetIds: [...group.productAssetIds] })),
  };
}
function validate(input: SaveInput, truthIds: ReadonlySet<string>): string | null {
  if (input.skus.length > MAX_SKUS) return '最多保存 60 个 SKU，请减少规格。';
  const codes = new Set<string>();
  const ids = new Set(input.skus.map(sku => sku.id));
  if (ids.size !== input.skus.length) return 'SKU 身份重复，请关闭后重新读取目录。';
  const refsError = (refs: string[]) => refs.length > MAX_REFS || new Set(refs).size !== refs.length || refs.some(id => !truthIds.has(id));
  for (const [index, sku] of input.skus.entries()) {
    const label = `第 ${index + 1} 个 SKU`;
    if (!sku.name || sku.name.length > 120) return `${label}的名称须为 1–120 个字符。`;
    if (sku.code && (sku.code.length > 80 || codes.has(normalizedKey(sku.code)))) return 'SKU 编码须唯一且不超过 80 个字符，也可以留空。';
    if (sku.code) codes.add(normalizedKey(sku.code));
    if (sku.attributes.length > MAX_ATTRIBUTES) return `${label}最多设置 8 个规格属性。`;
    const names = new Set<string>();
    for (const attribute of sku.attributes) {
      if (!attribute.name || attribute.name.length > 40 || !attribute.value || attribute.value.length > 120) return `${label}的属性名称和值不能为空（名称最多 40 字，值最多 120 字）。`;
      if (names.has(normalizedKey(attribute.name))) return `${label}的属性名称重复。`;
      names.add(normalizedKey(attribute.name));
    }
    if (refsError(sku.productAssetIds)) return `${label}含无效产品参考；只能选择当前项目的产品真值图片，最多 6 张。`;
  }
  if (input.imageGroups.length > 60 || new Set(input.imageGroups.map(group => group.id)).size !== input.imageGroups.length) return '图片组数量超限或身份重复。';
  const members = new Set<string>();
  for (const group of input.imageGroups) {
    if (!group.name || group.name.length > 120) return '图片组名称须为 1–120 个字符。';
    if (!group.skuIds.length) return '图片组不能为空，请删除空组。';
    for (const id of group.skuIds) {
      if (!ids.has(id) || members.has(id)) return '图片组含不存在或重复分组的 SKU，请调整成员。';
      members.add(id);
    }
    if (refsError(group.productAssetIds)) return '图片组含无效产品参考；只能选择当前项目的产品真值图片，最多 6 张。';
    const effectiveReferences = group.productAssetIds.length ? group.productAssetIds : [...new Set(input.skus.filter(sku => sku.included && group.skuIds.includes(sku.id)).flatMap(sku => sku.productAssetIds))];
    if (effectiveReferences.length > MAX_REFS) return '图片组的成员合计引用超过 6 张，请为该组明确选择最多 6 张产品参考。';
  }
  return null;
}
function batchPlan(batch: Batch | null, skus: ProjectSku[]) {
  if (!batch) return { count: 0, additions: [] as { name: string; attributes: SkuAttribute[] }[], duplicates: 0, error: null as string | null };
  const axes = batch.axes.map(axis => ({ name: axis.name.trim(), values: axis.values.split(/[,，、;；\n]+/).map(value => value.trim()).filter(Boolean) }));
  const count = axes.reduce((total, axis) => total * axis.values.length, 1);
  const fail = (error: string) => ({ count, additions: [] as { name: string; attributes: SkuAttribute[] }[], duplicates: 0, error });
  if (!axes.length || axes.some(axis => !axis.name || !axis.values.length)) return fail('请填写属性名称和至少一个属性值。');
  if (axes.length > MAX_ATTRIBUTES || axes.some(axis => axis.name.length > 40 || axis.values.some(value => value.length > 120))) return fail('最多 8 个属性，名称最多 40 字，单个值最多 120 字。');
  if (new Set(axes.map(axis => normalizedKey(axis.name))).size !== axes.length) return fail('属性名称不能重复。');
  if (axes.some(axis => new Set(axis.values).size !== axis.values.length)) return fail('同一属性的值不能重复。');
  // 先计算边界再展开，不能生成大数组后截断。
  if (count > MAX_SKUS) return fail(`共 ${count} 个组合，超过单次 60 个上限，请减少属性值。`);
  let combinations: SkuAttribute[][] = [[]];
  for (const axis of axes) combinations = combinations.flatMap(attributes => axis.values.map(value => [...attributes, { name: axis.name, value }]));
  const existing = new Set(skus.map(sku => attributeKey(sku.attributes)));
  const additions = combinations.filter(attributes => !existing.has(attributeKey(attributes))).map(attributes => ({ name: [batch.prefix.trim(), ...attributes.map(attribute => attribute.value)].filter(Boolean).join(' / '), attributes }));
  if (skus.length + additions.length > MAX_SKUS) return fail(`新增后共 ${skus.length + additions.length} 个 SKU，超过 60 个上限，请减少组合或现有 SKU。`);
  if (additions.some(sku => sku.name.length > 120)) return fail('组合名称超过 120 个字符，请缩短名称前缀或属性值。');
  return { count, additions, duplicates: count - additions.length, error: null };
}

function ProductReferences({ ids, assets, label, onChange }: { ids: string[]; assets: Asset[]; label: string; onChange: (ids: string[]) => void }) {
  const allowed = new Set(assets.map(asset => asset.id));
  const invalid = ids.filter(id => !allowed.has(id));
  const first = assets.find(asset => ids.includes(asset.id));
  return <details className={styles.references}>
    <summary aria-label={`${label}产品参考`}>
      {first ? <img className={styles.thumbnail} src={assetPreviewUrl(first)} alt="" /> : <span className={styles.thumbnail}><ImageIcon size={18} aria-hidden /></span>}
      <span>{ids.length ? `${ids.length} 张参考` : '选择产品图'}</span>
    </summary>
    <div className={styles.referenceChoices} role="group" aria-label={`${label}产品参考选择`}>
      <p className={styles.hint}>仅当前项目的产品真值图片，最多 6 张。</p>
      {!assets.length ? <p className={styles.hint}>项目还没有可选产品图，请先在商品配置中添加。</p> : null}
      {assets.map((asset, index) => <label className={styles.referenceChoice} key={asset.id}>
        <input type="checkbox" aria-label={`${label}引用 ${asset.originalName || `产品图 ${index + 1}`}`} checked={ids.includes(asset.id)} disabled={!ids.includes(asset.id) && ids.length >= MAX_REFS} onChange={event => onChange(event.target.checked ? [...ids, asset.id] : ids.filter(id => id !== asset.id))} />
        <img src={assetPreviewUrl(asset)} alt="" />
        <span>{asset.originalName || `产品图 ${index + 1}`}</span>
      </label>)}
      {invalid.length ? <div className={styles.invalidReference}><p className={styles.error}>有 {invalid.length} 张不可用的产品参考，保存前请移除。</p><button type="button" onClick={() => onChange(ids.filter(id => allowed.has(id)))}>移除无效引用</button></div> : null}
    </div>
  </details>;
}

/** 可取消的 SKU 编辑抽屉；共享组必须经用户预览确认后才写入草稿。 */
export function SkuManagerDrawer({ open, planning, assets, saving, onSave, onClose, onDirtyChange }: SkuManagerDrawerProps) {
  const active = useBusinessActive();
  const [draft, setDraft] = useState<Draft>(() => fromPlanning(planning));
  const [baseline, setBaseline] = useState(() => directorySignature(fromPlanning(planning)));
  const [batch, setBatch] = useState<Batch | null>(null);
  const [groupForm, setGroupForm] = useState<GroupForm | null>(null);
  const [preview, setPreview] = useState<GroupPreview | null>(null);
  const [toolError, setToolError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<ProjectImagePlanning | null>(null);
  const [reading, setReading] = useState(false);
  const queryClient = useContext(QueryClientContext);
  const currentView = useRef({ open, projectId: planning.projectId, generation: 0 });
  if (currentView.current.open !== open || currentView.current.projectId !== planning.projectId) currentView.current.generation += 1;
  currentView.current.open = open;
  currentView.current.projectId = planning.projectId;
  const [localSaving, setLocalSaving] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const opened = useRef(false);
  const saveLock = useRef(false);
  const mounted = useRef(true);
  // portal 在业务页返回后重新挂载，需在真实按钮出现后再次执行焦点恢复。
  const [discardCancel, setDiscardCancel] = useState<HTMLButtonElement | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const discardReturnFocus = useRef<HTMLElement | null>(null);
  const restoreFocus = useRef(false);
  const dirtyCallback = useRef(onDirtyChange);
  dirtyCallback.current = onDirtyChange;
  const busy = saving || localSaving;
  const directoryDirty = directorySignature(draft) !== baseline;
  const auxiliaryDirty = Boolean(batch && (batch.prefix.trim() || batch.axes.some(axis => axis.name.trim() || axis.values.trim()))) || Boolean(groupForm && (preview || formSignature(groupForm) !== groupForm.baseline));
  const dirty = directoryDirty || auxiliaryDirty;
  const truthAssets = useMemo(() => assets.filter(asset => asset.projectId === draft.projectId && asset.role === 'PRODUCT_TRUTH' && asset.mimeType.startsWith('image/')), [assets, draft.projectId]);
  const truthIds = useMemo(() => new Set(truthAssets.map(asset => asset.id)), [truthAssets]);
  const input = normalize(draft);
  const validationError = validate(input, truthIds);
  const projectChanged = draft.projectId !== planning.projectId;
  const combos = batchPlan(batch, draft.skus);
  const included = draft.skus.filter(sku => sku.included);
  const includedIds = new Set(included.map(sku => sku.id));
  const assigned = new Set<string>();
  let groupCount = 0;
  if (draft.config.shareImages) for (const group of draft.imageGroups) {
    const members = group.skuIds.filter(id => includedIds.has(id));
    if (members.length) { groupCount++; members.forEach(id => assigned.add(id)); }
  }
  groupCount += included.filter(sku => !assigned.has(sku.id)).length;
  const attributeNames = new Map<string, string>();
  for (const sku of draft.skus) for (const attribute of sku.attributes) {
    const name = attribute.name.trim();
    const key = normalizedKey(name);
    if (key && !attributeNames.has(key)) attributeNames.set(key, name);
  }
  const resetTools = useCallback(() => { setBatch(null); setGroupForm(null); setPreview(null); setToolError(null); setDiscardOpen(false); setSaveError(null); setConflict(false); setLatest(null); setReading(false); discardReturnFocus.current = null; restoreFocus.current = false; }, []);
  useEffect(() => {
    if (open && !opened.current) {
      const next = fromPlanning(planning);
      setDraft(next); setBaseline(directorySignature(next)); resetTools();
    }
    opened.current = open;
  }, [open, planning, resetTools]);
  useEffect(() => { dirtyCallback.current?.(open && dirty); }, [dirty, open]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; dirtyCallback.current?.(false); }; }, []);
  useEffect(() => {
    if (discardOpen) {
      if (active && open) discardCancel?.focus();
      return;
    }
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    const target = discardReturnFocus.current;
    discardReturnFocus.current = null;
    if (!active || !open) return;
    const drawer = closeButton.current?.closest<HTMLElement>('[role="dialog"]');
    if (!drawer) return;
    if (canRestoreDrawerFocus(target, drawer)) target.focus();
    else if (canRestoreDrawerFocus(closeButton.current, drawer)) closeButton.current.focus();
  }, [discardOpen, active, open, discardCancel]);
  const dismissDiscard = useCallback(() => { restoreFocus.current = true; setDiscardOpen(false); }, []);
  const close = useCallback(() => {
    if (busy) return;
    if (dirty) {
      const target = document.activeElement;
      const drawer = closeButton.current?.closest('[role="dialog"]');
      discardReturnFocus.current = target instanceof HTMLElement && drawer?.contains(target) ? target : null;
      setDiscardOpen(true);
    } else onClose();
  }, [busy, dirty, onClose]);
  useEffect(() => {
    if (!open || !active) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault(); event.stopPropagation();
      if (discardOpen) dismissDiscard(); else close();
    };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [open, active, discardOpen, dismissDiscard, close]);
  const updateSku = (id: string, patch: Partial<ProjectSku>) => { setSaveError(null); setDraft(current => ({ ...current, skus: current.skus.map(sku => sku.id === id ? { ...sku, ...patch } : sku) })); };
  const changeAttributes = (sku: ProjectSku, index: number, patch: Partial<SkuAttribute>) => updateSku(sku.id, { attributes: sku.attributes.map((attribute, position) => position === index ? { ...attribute, ...patch } : attribute) });
  const moveAttribute = (sku: ProjectSku, index: number, direction: number) => {
    const attributes = [...sku.attributes];
    const target = index + direction;
    if (target < 0 || target >= attributes.length) return;
    [attributes[index], attributes[target]] = [attributes[target]!, attributes[index]!];
    updateSku(sku.id, { attributes });
  };
  const addSku = () => { setSaveError(null); setDraft(current => ({ ...current, skus: [...current.skus, { id: crypto.randomUUID(), name: '', code: null, attributes: [], productAssetIds: [], included: true }] })); };
  const removeSku = (id: string) => setDraft(current => ({ ...current, skus: current.skus.filter(sku => sku.id !== id), imageGroups: current.imageGroups.map(group => ({ ...group, skuIds: group.skuIds.filter(member => member !== id) })).filter(group => group.skuIds.length) }));
  const duplicateSku = (sku: ProjectSku) => setDraft(current => ({ ...current, skus: [...current.skus, { ...clone(sku), id: crypto.randomUUID(), name: duplicateName(sku.name), code: null }] }));
  const changeGroupForm = (patch: Partial<GroupForm>) => { setGroupForm(current => current ? { ...current, ...patch } : current); setPreview(null); setToolError(null); };
  const makePreview = () => {
    if (!groupForm) return;
    setToolError(null);
    if (groupForm.mode === 'members') {
      if (!groupForm.name.trim()) { setToolError('请填写图片组名称。'); return; }
      if (groupForm.memberIds.length < (groupForm.editingId ? 1 : 2)) { setToolError(groupForm.editingId ? '图片组至少需要 1 个成员。' : '请显式选择至少 2 个共图 SKU。'); return; }
      if (groupForm.memberIds.some(id => !draft.skus.some(sku => sku.id === id))) { setToolError('所选 SKU 已被删除，请重新选择成员。'); return; }
      if (draft.imageGroups.some(group => group.id !== groupForm.editingId && group.skuIds.some(id => groupForm.memberIds.includes(id)))) { setToolError('一个 SKU 只能属于一个图片组，请先调整已有组。'); return; }
      if (groupForm.assetIds.some(id => !truthIds.has(id))) { setToolError('请先移除图片组的无效产品参考。'); return; }
      setPreview([{ ...(groupForm.editingId ? { id: groupForm.editingId } : {}), name: groupForm.name.trim(), skuIds: [...groupForm.memberIds], productAssetIds: [...groupForm.assetIds] }]);
    } else {
      if (!groupForm.attributeKeys.length) { setToolError('请选择用于分组的属性。'); return; }
      const buckets = new Map<string, { name: string; skuIds: string[] }>();
      for (const sku of included) {
        const attributes = groupForm.attributeKeys.map(key => sku.attributes.find(attribute => normalizedKey(attribute.name) === key));
        // 缺少选定属性的 SKU 保持独立，不把缺失值猜成同外观。
        if (attributes.some(attribute => !attribute?.value.trim())) continue;
        const values = attributes.map(attribute => attribute!.value.trim());
        const key = signature(values);
        const bucket = buckets.get(key) ?? { name: groupForm.attributeKeys.map((attribute, index) => `${attributeNames.get(attribute)}：${values[index]}`).join(' / '), skuIds: [] };
        bucket.skuIds.push(sku.id); buckets.set(key, bucket);
      }
      const newGroups = new Map([...buckets.values()].filter(group => group.skuIds.length >= 2).map(group => [groupMemberKey(group.skuIds), group]));
      const groups: GroupPreview = [];
      // 相同成员集合沿用用户已确认的身份、名称、引用及顺序，重复确认不改变规划来源。
      for (const group of draft.imageGroups) if (newGroups.delete(groupMemberKey(group.skuIds))) groups.push(clone(group));
      groups.push(...[...newGroups.values()].map(group => ({ ...group, productAssetIds: [] as string[] })));
      if (!groups.length) { setToolError('没有可共用的成员组合；未匹配的 SKU 会保持独立。'); return; }
      if (groups.some(group => group.name.length > 120)) { setToolError('生成的图片组名称超过 120 字，请减少分组属性。'); return; }
      setPreview(groups);
    }
  };
  const confirmGroups = () => {
    if (!preview || !groupForm) return;
    const groups = preview.map(group => ({ ...group, id: group.id ?? crypto.randomUUID() }));
    setDraft(current => ({ ...current, imageGroups: groupForm.mode === 'attributes' ? groups : [...current.imageGroups.filter(group => group.id !== groupForm.editingId), ...groups] }));
    setGroupForm(null); setPreview(null); setToolError(null); setSaveError(null);
  };
  const save = async () => {
    if (saveLock.current || busy || conflict || projectChanged || validationError || batch || groupForm || !directoryDirty) return;
    saveLock.current = true; setLocalSaving(true); setSaveError(null);
    try {
      await onSave(clone(input));
      if (mounted.current) {
        const saved: Draft = { ...draft, config: input.config, skus: input.skus, imageGroups: input.imageGroups };
        setDraft(saved); setBaseline(directorySignature(saved)); resetTools(); dirtyCallback.current?.(false); onClose();
      }
    } catch (cause) {
      if (mounted.current) {
        setSaveError(errorText(cause));
        if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'CONFLICT') { setConflict(true); setLatest(null); }
      }
    } finally {
      saveLock.current = false;
      if (mounted.current) setLocalSaving(false);
    }
  };
  const readLatest = async () => {
    if (reading || projectChanged) return;
    const projectId = draft.projectId;
    const generation = currentView.current.generation;
    setReading(true);
    try {
      const result = await invoke('getProjectImagePlanning', { projectId });
      if (!mounted.current || !currentView.current.open || currentView.current.projectId !== projectId || currentView.current.generation !== generation) return;
      setLatest(result);
      queryClient?.setQueryData<ProjectImagePlanning>(qk.imagePlanning(projectId), current => !current || current.revision <= result.revision ? result : current);
    } catch (cause) {
      if (mounted.current && currentView.current.open && currentView.current.projectId === projectId && currentView.current.generation === generation) setSaveError(`读取最新目录失败：${errorText(cause)}`);
    } finally { if (mounted.current && currentView.current.generation === generation) setReading(false); }
  };
  const cancelTool = () => { setBatch(null); setGroupForm(null); setPreview(null); setToolError(null); };
  const toolOpen = Boolean(batch || groupForm);
  // 后台业务实例继续保留草稿，但不能留下可交互的 portal。
  if (!active) return null;
  return <Drawer open={open} title={<div className={styles.heading}><div><h2>管理 SKU</h2><p>{included.length} 个参与规格 · {groupCount} 组图片{draft.config.skuImagesPerGroup > 1 ? ` · 每组 ${draft.config.skuImagesPerGroup} 张` : ''}</p></div><button type="button" className={styles.closeButton} ref={closeButton} aria-label="关闭 SKU 管理" disabled={busy || discardOpen} onClick={close}><X size={18} aria-hidden /></button></div>} placement="right" size={650} mask={false} keyboard={false} closable={false} onClose={close} rootClassName={styles.drawer} rootStyle={{ top: 'var(--topbar-h, 60px)' }} styles={{ wrapper: { maxWidth: '100vw' } }}
    footer={<div className={styles.footer}><span className={styles.hint} aria-live="polite">{busy ? '正在保存…' : dirty ? '修改待保存' : '所有修改已保存'}</span><div className={styles.actions}><button type="button" onClick={close} disabled={busy || discardOpen}>取消</button><button type="button" className={styles.primary} onClick={() => void save()} disabled={busy || discardOpen || conflict || !directoryDirty || Boolean(validationError) || toolOpen || projectChanged}>{busy ? '正在保存…' : '保存修改'}</button></div></div>}>
    <fieldset className={styles.editor} disabled={busy || discardOpen}>
      <div className={styles.actions}><button type="button" onClick={addSku} disabled={draft.skus.length >= MAX_SKUS || toolOpen}><Plus size={15} aria-hidden />添加 SKU</button><button type="button" onClick={() => { setBatch({ prefix: '', axes: [{ id: crypto.randomUUID(), name: '', values: '' }] }); setToolError(null); }} disabled={toolOpen || draft.skus.length >= MAX_SKUS}>按规格批量创建</button><span className={styles.hint}>{draft.skus.length} / 60</span></div>
      {batch ? <section className={styles.tool} aria-label="批量创建规格">
        <div className={styles.sectionHeading}><h3>按规格批量创建</h3><button type="button" onClick={cancelTool}>取消批量创建</button></div>
        <p className={styles.hint}>属性值用逗号或换行分隔。只创建缺少的组合，不重复添加已有规格。</p>
        <label className={styles.field}>名称前缀（可选）<input aria-label="组合名称前缀" maxLength={80} value={batch.prefix} onChange={event => setBatch({ ...batch, prefix: event.target.value })} /></label>
        {batch.axes.map((axis, index) => <div className={styles.axis} key={axis.id}>
          <input aria-label={`组合属性 ${index + 1} 名称`} placeholder="属性名称" maxLength={40} value={axis.name} onChange={event => setBatch({ ...batch, axes: batch.axes.map(item => item.id === axis.id ? { ...item, name: event.target.value } : item) })} />
          <textarea aria-label={`组合属性 ${index + 1} 的值`} placeholder="输入属性值，用逗号分隔" rows={2} value={axis.values} onChange={event => setBatch({ ...batch, axes: batch.axes.map(item => item.id === axis.id ? { ...item, values: event.target.value } : item) })} />
          <button type="button" aria-label={`删除组合属性 ${index + 1}`} disabled={batch.axes.length === 1} onClick={() => setBatch({ ...batch, axes: batch.axes.filter(item => item.id !== axis.id) })}><X size={14} /></button>
        </div>)}
        <button type="button" onClick={() => setBatch({ ...batch, axes: [...batch.axes, { id: crypto.randomUUID(), name: '', values: '' }] })} disabled={batch.axes.length >= MAX_ATTRIBUTES}>添加组合属性</button>
        <p className={styles.hint} aria-live="polite">预计 {combos.count} 个组合 · 新增 {combos.additions.length} 个 · 已有 {combos.duplicates} 个不重复创建</p>
        {combos.error ? <p className={styles.error} role="status">{combos.error}</p> : null}
        <button type="button" className={styles.primary} disabled={Boolean(combos.error) || !combos.additions.length} onClick={() => { setDraft(current => ({ ...current, skus: [...current.skus, ...combos.additions.map(sku => ({ ...sku, id: crypto.randomUUID(), code: null, included: true, productAssetIds: [] }))] })); setBatch(null); setSaveError(null); }}>创建 {combos.additions.length} 个 SKU</button>
      </section> : null}
      <section className={styles.sharing} aria-label="图片共用设置">
        <label className={styles.toggle}><input type="checkbox" checked={draft.config.shareImages} disabled={toolOpen} onChange={event => { setDraft(current => ({ ...current, config: { ...current.config, shareImages: event.target.checked } })); setSaveError(null); }} />同外观规格共用图片</label>
        <p className={styles.hint}>{draft.config.shareImages ? '请显式建立图片组。开启开关不会自动判断外观；未分组的 SKU 保持独立。' : '每个参与 SKU 独立规划。已确认的图片组会保留，重新开启后生效。'}</p>
        {draft.config.shareImages ? <>
          <div className={styles.actions}><button type="button" disabled={toolOpen || draft.skus.length < 2} onClick={() => { setGroupForm(newGroupForm()); setToolError(null); }}>选择成员建立图片组</button><button type="button" disabled={toolOpen || !attributeNames.size || included.length < 2} onClick={() => { const form = { ...newGroupForm(), mode: 'attributes' as const }; setGroupForm({ ...form, baseline: formSignature(form) }); setToolError(null); }}>按属性预览分组</button></div>
          {draft.imageGroups.map(group => <div key={group.id} className={styles.group}>
            <div><strong>{group.name}</strong><p className={styles.hint}>{group.skuIds.map(id => draft.skus.find(sku => sku.id === id)?.name || '未命名 SKU').join('、')} · {group.productAssetIds.length ? `${group.productAssetIds.length} 张组参考` : '使用成员明确选择的产品参考'}</p></div>
            <div className={styles.actions}><button type="button" disabled={toolOpen} aria-label={`编辑图片组 ${group.name}`} onClick={() => setGroupForm(newGroupForm(group))}>编辑</button><button type="button" disabled={toolOpen} aria-label={`删除图片组 ${group.name}`} onClick={() => setDraft(current => ({ ...current, imageGroups: current.imageGroups.filter(item => item.id !== group.id) }))}>解散</button></div>
          </div>)}
        </> : null}
      </section>
      {groupForm ? <section className={styles.tool} aria-label="显式图片分组">
        <div className={styles.sectionHeading}><h3>{groupForm.mode === 'members' ? '选择共图成员' : '按所选属性分组'}</h3><button type="button" onClick={cancelTool}>取消分组</button></div>
        {groupForm.mode === 'members' ? <>
          <label className={styles.field}>图片组名称<input aria-label="图片组名称" maxLength={120} value={groupForm.name} onChange={event => changeGroupForm({ name: event.target.value })} /></label>
          <div className={styles.memberList} role="group" aria-label="图片组成员">{draft.skus.map((sku, index) => <label key={sku.id} className={styles.choice}><input type="checkbox" aria-label={`共图成员 ${sku.name || `SKU ${index + 1}`}`} checked={groupForm.memberIds.includes(sku.id)} disabled={draft.imageGroups.some(group => group.id !== groupForm.editingId && group.skuIds.includes(sku.id))} onChange={event => changeGroupForm({ memberIds: event.target.checked ? [...groupForm.memberIds, sku.id] : groupForm.memberIds.filter(id => id !== sku.id) })} />{sku.name || `SKU ${index + 1}`}{!sku.included ? '（不参与）' : ''}</label>)}</div>
          <ProductReferences ids={groupForm.assetIds} assets={truthAssets} label="图片组" onChange={assetIds => changeGroupForm({ assetIds })} />
        </> : <><p className={styles.hint}>仅按你选定的属性预览参与 SKU；缺少属性或未匹配的 SKU 仍独立。确认后将替换已有分组；成员未变的组保留名称和产品参考，请逐组核对外观。</p><div className={styles.attributeChoices} role="group" aria-label="分组属性">{[...attributeNames].map(([key, name]) => <label className={styles.choice} key={key}><input type="checkbox" aria-label={`按属性 ${name} 分组`} checked={groupForm.attributeKeys.includes(key)} onChange={event => changeGroupForm({ attributeKeys: event.target.checked ? [...groupForm.attributeKeys, key] : groupForm.attributeKeys.filter(item => item !== key) })} />{name}</label>)}</div></>}
        <button type="button" onClick={makePreview}>预览图片组</button>
        {toolError ? <p className={styles.error} role="alert">{toolError}</p> : null}
        {preview ? <div className={styles.preview} aria-label="图片组预览"><p>请确认以下成员外观可以共用产品图片。</p>{preview.map((group, index) => <p key={index}><strong>{group.name}</strong>：{group.skuIds.map(id => draft.skus.find(sku => sku.id === id)?.name || '未命名 SKU').join('、')}</p>)}<button type="button" className={styles.primary} onClick={confirmGroups}>确认图片分组</button></div> : null}
      </section> : null}
      <div className={styles.tableScroll} role="region" aria-label="SKU 目录" tabIndex={0}>
        <table className={styles.table}><thead><tr><th scope="col">参与</th><th scope="col">产品参考</th><th scope="col">SKU 名称 / 编码</th><th scope="col">规格属性</th><th scope="col">操作</th></tr></thead><tbody>
          {draft.skus.map((sku, index) => <tr key={sku.id} aria-label={`SKU ${index + 1}`}>
            <td><input type="checkbox" aria-label={`SKU ${index + 1} 参与规划`} checked={sku.included} disabled={toolOpen} onChange={event => updateSku(sku.id, { included: event.target.checked })} /></td>
            <td><ProductReferences ids={sku.productAssetIds} assets={truthAssets} label={`SKU ${index + 1} `} onChange={productAssetIds => updateSku(sku.id, { productAssetIds })} /></td>
            <td><div className={styles.nameFields}><input aria-label={`SKU ${index + 1} 名称`} placeholder="SKU 名称" maxLength={120} value={sku.name} disabled={toolOpen} onChange={event => updateSku(sku.id, { name: event.target.value })} /><input aria-label={`SKU ${index + 1} 编码`} placeholder="编码（可选）" maxLength={80} value={sku.code ?? ''} disabled={toolOpen} onChange={event => updateSku(sku.id, { code: event.target.value || null })} />{draft.config.shareImages && draft.imageGroups.some(group => group.skuIds.includes(sku.id)) ? <span className={styles.groupBadge}>{draft.imageGroups.find(group => group.skuIds.includes(sku.id))!.name}</span> : null}</div></td>
            <td><div className={styles.specs}>{sku.attributes.map((attribute, attributeIndex) => <div className={styles.attribute} key={attributeIndex}>
              <input aria-label={`SKU ${index + 1} 属性 ${attributeIndex + 1} 名称`} placeholder="属性" maxLength={40} value={attribute.name} disabled={toolOpen} onChange={event => changeAttributes(sku, attributeIndex, { name: event.target.value })} /><input aria-label={`SKU ${index + 1} 属性 ${attributeIndex + 1} 值`} placeholder="值" maxLength={120} value={attribute.value} disabled={toolOpen} onChange={event => changeAttributes(sku, attributeIndex, { value: event.target.value })} />
              <div className={styles.attributeActions}><button type="button" aria-label={`上移 SKU ${index + 1} 属性 ${attributeIndex + 1}`} disabled={toolOpen || attributeIndex === 0} onClick={() => moveAttribute(sku, attributeIndex, -1)}><ArrowUp size={12} /></button><button type="button" aria-label={`下移 SKU ${index + 1} 属性 ${attributeIndex + 1}`} disabled={toolOpen || attributeIndex === sku.attributes.length - 1} onClick={() => moveAttribute(sku, attributeIndex, 1)}><ArrowDown size={12} /></button><button type="button" aria-label={`删除 SKU ${index + 1} 属性 ${attributeIndex + 1}`} disabled={toolOpen} onClick={() => updateSku(sku.id, { attributes: sku.attributes.filter((_, position) => position !== attributeIndex) })}><X size={12} /></button></div>
            </div>)}<button type="button" className={styles.textButton} disabled={toolOpen || sku.attributes.length >= MAX_ATTRIBUTES} aria-label={`添加 SKU ${index + 1} 属性`} onClick={() => updateSku(sku.id, { attributes: [...sku.attributes, { name: '', value: '' }] })}>添加属性</button></div></td>
            <td><div className={styles.rowActions}><button type="button" aria-label={`复制 SKU ${index + 1}`} title="复制 SKU" disabled={toolOpen || draft.skus.length >= MAX_SKUS} onClick={() => duplicateSku(sku)}><Copy size={15} /></button><button type="button" aria-label={`删除 SKU ${index + 1}`} title="删除 SKU" disabled={toolOpen} onClick={() => removeSku(sku.id)}><Trash2 size={15} /></button></div></td>
          </tr>)}
        </tbody></table>
        {!draft.skus.length ? <p className={styles.empty}>还没有 SKU，可添加单个规格或按实际商品属性批量创建。</p> : null}
      </div>
      <p className={styles.hint}>规格修改后，受影响的未生成画面将标记为待更新；已有成图和历史规格快照保留。保存目录后，在图片规划中更新受影响规划。</p>
      {toolOpen ? <p className={styles.hint}>请先完成或取消当前批量创建 / 图片分组，再保存目录。</p> : null}
      {projectChanged ? <p className={styles.error} role="alert">项目已切换。请关闭抽屉后重新读取，当前草稿不能保存到其他项目。</p> : null}
      {planning.revision !== draft.revision && !projectChanged ? <p className={styles.hint}>目录版本已变化，保存会校验版本；发生冲突时会保留当前草稿。</p> : null}
      {validationError ? <p className={styles.error} role="status">{validationError}</p> : null}
      {saveError ? <p className={styles.error} role="alert">保存失败：{saveError}</p> : null}
      {conflict && !projectChanged ? <section className={styles.tool} aria-label="处理目录冲突">
        <h3>目录已更新，本地草稿已保留</h3>
        <p className={styles.hint}>先读取最新目录对照。载入会放弃当前未保存的修改；不会直接覆盖已保存的目录。</p>
        <button type="button" disabled={reading} onClick={() => void readLatest()}>{reading ? '正在读取…' : '读取最新目录'}</button>
        {latest ? <>
          <div className={styles.tableScroll}><table className={styles.table}><thead><tr><th>本地草稿</th><th>最新目录</th></tr></thead><tbody><tr>{[draft, latest].map((directory, index) => <td key={index}>
            <p>主图 {directory.config.mainCount} · 详情 {directory.config.detailCount} · 每组 {directory.config.suiteBlueprint ? directory.config.suiteBlueprint.shots.filter(shot => shot.purpose === 'SKU').length : directory.config.skuImagesPerGroup} 张</p>
            <p>{directory.config.shareImages ? '已启用显式共图' : '各规格独立配图'}</p>
            {directory.skus.map(sku => <p key={sku.id}><strong>{sku.name || '未命名 SKU'}</strong>{sku.code ? `（${sku.code}）` : ''} · {sku.included ? '参与' : '不参与'}<br/>{sku.attributes.map(attribute => `${attribute.name}：${attribute.value}`).join('；')} · {sku.productAssetIds.length} 张产品参考</p>)}
            {directory.imageGroups.map(group => <p key={group.id}>图片组 {group.name}：{group.skuIds.map(id => directory.skus.find(sku => sku.id === id)?.name ?? '已移除规格').join('、')} · {group.productAssetIds.length} 张组参考</p>)}
          </td>)}</tr></tbody></table></div>
          <button type="button" className={styles.primary} disabled={reading} onClick={() => { const next = fromPlanning(latest); setDraft(next); setBaseline(directorySignature(next)); resetTools(); dirtyCallback.current?.(false); }}>放弃本地草稿并载入最新目录</button>
        </> : null}
      </section> : null}
    </fieldset>
    {discardOpen ? <div className={styles.discardOverlay} role="alertdialog" aria-modal="true" aria-labelledby="sku-discard-title" aria-describedby="sku-discard-description" onKeyDown={event => { if (event.key === 'Tab') { event.preventDefault(); const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button'); const current = Array.from(buttons).indexOf(document.activeElement as HTMLButtonElement); buttons[(current + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length]?.focus(); } }}><div className={styles.discardCard}><h3 id="sku-discard-title">放弃未保存的 SKU 修改？</h3><p id="sku-discard-description">当前目录和未确认的组合 / 图片组草稿将被丢弃。</p><div className={styles.actions}><button type="button" ref={setDiscardCancel} onClick={dismissDiscard}>继续编辑</button><button type="button" className={styles.primary} onClick={() => { const next = fromPlanning(planning); setDraft(next); setBaseline(directorySignature(next)); resetTools(); dirtyCallback.current?.(false); onClose(); }}>放弃修改</button></div></div></div> : null}
  </Drawer>;
}
