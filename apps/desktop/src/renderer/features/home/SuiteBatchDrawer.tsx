import { App, Button, Checkbox, Drawer, Input, Select } from 'antd';
import { useRef, useState } from 'react';
import { resourceUrlFor, type SuitePlanningBlueprint } from '@ecomgen/contracts';
import type { Project } from '../../api/adapters/projectDetail';
import { useSuitePlanningBatchActions, useSuitePlanningBatches, useSuitePlanningBlueprint } from '../../api/hooks/useSuitePlanning';
import { useBusinessActive, useBusinessNavigate } from '../../components/businessActivity';
import { errorText } from '../../lib/errorText';
import { randomUuid } from '../../lib/randomUuid';
import { JOB_STATUS_LABEL } from '../../lib/factClaims';
import { formatDateTime } from '../../lib/format';
import { SuitePickerDialog } from '../workbench/SuitePickerDialog';

export function SuiteBatchDrawer({ open, onClose, projects }: { open: boolean; onClose: () => void; projects: Project[] }) {
  const { notification, modal } = App.useApp();
  const navigate = useBusinessNavigate();
  const active = useBusinessActive();
  const batches = useSuitePlanningBatches(open && active);
  const actions = useSuitePlanningBatchActions();
  const lookup = useSuitePlanningBlueprint();
  const [picker, setPicker] = useState(false);
  const [blueprint, setBlueprint] = useState<SuitePlanningBlueprint>();
  const [selected, setSelected] = useState<string[]>([]);
  const [referenceSourceProjectId, setReferenceSourceProjectId] = useState<string>();
  const [instruction, setInstruction] = useState('');
  const [batchId, setBatchId] = useState<string>();
  const submission = useRef<{ fingerprint: string; key: string } | undefined>(undefined);
  const batch = batches.data?.items.find(item => item.id === batchId) ?? batches.data?.items[0];
  const choose = async (shots: string[]) => {
    const ids = [...new Set(shots.map(shot => shot.split('::')[0]).filter(Boolean))];
    if (ids.length !== 1) { notification.warning({ title: '请选择一个完整套图' }); return; }
    try { setBlueprint(await lookup.mutateAsync(ids[0]!)); } catch (error) { notification.error({ title: '读取套图失败', description: errorText(error) }); }
  };
  const create = async () => {
    if (!blueprint || !selected.length) { notification.warning({ title: '请选择套图和商品项目' }); return; }
    const fingerprint = JSON.stringify([blueprint, selected, referenceSourceProjectId, instruction.trim()]);
    if (submission.current?.fingerprint !== fingerprint) submission.current = { fingerprint, key: randomUuid() };
    try { const result = await actions.create.mutateAsync({ regenerationKey: submission.current.key, suiteBlueprint: blueprint, projectIds: selected, ...(referenceSourceProjectId ? { referenceSourceProjectId } : {}), ...(instruction.trim() ? { userInstruction: instruction.trim() } : {}) }); setBatchId(result.id); submission.current = undefined; }
    catch (error) { notification.error({ title: '批量规划未提交', description: errorText(error) }); }
  };
  const generate = () => {
    if (!batch) return;
    modal.confirm({ title: '生成已就绪商品？', content: '将为已完成规划的商品提交生图任务。', okText: '确认生成', cancelText: '取消', onOk: async () => { try { await actions.generate.mutateAsync(batch.id); } catch (error) { notification.error({ title: '提交生成失败', description: errorText(error) }); throw error; } } });
  };
  return <><Drawer title="套图批量创作" open={open && active} onClose={onClose} size={620}>
    <p>为每个商品分别规划，检查结果后再确认生成。请先在各项目上传商品图。</p>
    <Button loading={lookup.isPending} onClick={() => setPicker(true)}>选择套图</Button>
    {blueprint ? <div><h3>{blueprint.suiteName}</h3><p>主图 {blueprint.shots.filter(shot => shot.purpose === 'MAIN').length} · 详情 {blueprint.shots.filter(shot => shot.purpose === 'DETAIL').length} · 每 SKU 组 {blueprint.shots.filter(shot => shot.purpose === 'SKU').length} 张</p><ul>{blueprint.shots.map(shot => <li key={shot.shotId}>{shot.purpose === 'MAIN' ? '主图' : shot.purpose === 'SKU' ? 'SKU 图' : '详情图'} · {shot.displayName} · {shot.intent}</li>)}</ul><p>套图参考图 {blueprint.referenceAssets?.length ?? 0} 张</p>{blueprint.referenceAssets?.map(asset => <img key={`${asset.projectId}:${asset.assetId}`} src={resourceUrlFor({ kind: 'ASSET', id: asset.assetId })} alt="套图参考图" style={{ width: 72, height: 72, objectFit: 'cover', marginRight: 8 }}/>)}</div> : null}
    <h3>商品项目</h3><Checkbox.Group value={selected} onChange={values => setSelected(values as string[])} options={projects.map(project => ({ label: project.name, value: project.id }))}/>
    <h3>共享参考来源（可选）</h3><Select style={{ width: '100%' }} allowClear placeholder="不选择时使用各商品自身参考图" value={referenceSourceProjectId} onChange={setReferenceSourceProjectId} options={projects.map(project => ({ label: project.name, value: project.id }))}/><p>仅共享来源项目的参考图，不共享商品图。</p>
    <Input.TextArea aria-label="批量规划补充说明" placeholder="补充说明（可选）" value={instruction} onChange={event => setInstruction(event.target.value)}/>
    <Button type="primary" style={{ marginTop: 12 }} loading={actions.create.isPending} onClick={() => void create()}>提交批量规划</Button>
    <h3>批次进度</h3>
    {batches.isError ? <p role="alert">批次读取失败：{errorText(batches.error)} <Button onClick={() => void batches.refetch()}>重试</Button></p> : null}
    {batches.data?.items.length ? <Select aria-label="选择批次" style={{ width: '100%' }} value={batch?.id} onChange={setBatchId} options={batches.data.items.map(item => ({ value: item.id, label: `${item.suiteBlueprint.suiteName} · ${formatDateTime(item.createdAt)}` }))}/> : <p>暂无批次</p>}
    {batch ? <><ul>{batch.entries.map(entry => <li key={entry.projectId}><strong>{entry.projectName}</strong> · 规划 {entry.planStatus ? JOB_STATUS_LABEL[entry.planStatus] : '待提交'} {entry.planProgress ?? 0}% · {entry.sceneCount} 个画面 / 每画面 {entry.candidateCount} 个候选 · 生成 {entry.generationCompleted}/{entry.generationTotal}{entry.ready ? ' · 已就绪' : ''}{entry.error ? <span role="alert"> · {entry.error}</span> : null} <Button type="link" onClick={() => { onClose(); void navigate(`/projects/${entry.projectId}?view=setup`); }}>打开商品</Button></li>)}</ul><Button loading={actions.retry.isPending} onClick={() => void actions.retry.mutateAsync(batch.id).catch(error => notification.error({ title: '重试失败', description: errorText(error) }))}>重试失败商品</Button> <Button type="primary" disabled={!batch.entries.some(entry => entry.ready)} loading={actions.generate.isPending} onClick={generate}>生成已就绪商品</Button></> : null}
  </Drawer><SuitePickerDialog singleSuite open={picker && active} value={[]} onChange={shots => void choose(shots)} onClose={() => setPicker(false)}/></>;
}
