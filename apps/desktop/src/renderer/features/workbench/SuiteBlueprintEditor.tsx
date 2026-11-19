import { Button, Input, Select } from 'antd';
import { resourceUrlFor, suitePlanningCounts, type SuitePlanningBlueprint } from '@ecomgen/contracts';
import { randomUuid } from '../../lib/randomUuid';

/** 编辑当前项目实例，镜头身份在修改时保持不变。 */
export function SuiteBlueprintEditor({ value, onChange }: { value: SuitePlanningBlueprint; onChange: (value: SuitePlanningBlueprint) => void }) {
  const update = (index: number, patch: Partial<SuitePlanningBlueprint['shots'][number]>) => onChange({ ...value, shots: value.shots.map((shot, i) => i === index ? { ...shot, ...patch } : shot) });
  const counts = suitePlanningCounts(value);
  return <div>
    <p>{value.suiteName} · 主图 {counts.mainCount} · 详情 {counts.detailCount} · 每 SKU 组 {value.shots.filter(shot => shot.purpose === 'SKU').length} 张</p>
    {value.referenceAssets?.length ? <div><p>套图参考图</p>{value.referenceAssets.map(asset => <img key={`${asset.projectId}:${asset.assetId}`} src={resourceUrlFor({ kind: 'ASSET', id: asset.assetId })} alt="套图参考图" style={{ width: 72, height: 72, objectFit: 'cover', marginRight: 8 }}/>)}</div> : null}
    <label>整体风格<Input.TextArea aria-label="套图整体风格" value={value.styleLock} onChange={event => onChange({ ...value, styleLock: event.target.value })}/></label>
    {value.shots.map((shot, index) => <div key={shot.shotId} style={{ marginTop: 12, display: 'grid', gap: 6 }}>
      <Input aria-label={`镜头 ${index + 1} 标题`} value={shot.displayName} onChange={event => update(index, { displayName: event.target.value })}/>
      <Select aria-label={`镜头 ${index + 1} 用途`} value={shot.purpose} options={[{ value: 'MAIN', label: '主图', disabled: shot.purpose !== 'MAIN' && value.shots.filter(item => item.purpose === 'MAIN').length >= 12 }, { value: 'SKU', label: 'SKU 图', disabled: shot.purpose !== 'SKU' && value.shots.filter(item => item.purpose === 'SKU').length >= 4 }, { value: 'DETAIL', label: '详情图', disabled: shot.purpose !== 'DETAIL' && value.shots.filter(item => item.purpose === 'DETAIL').length >= 24 }]} onChange={purpose => update(index, { purpose })}/>
      <Input.TextArea aria-label={`镜头 ${index + 1} 意图`} value={shot.intent} onChange={event => update(index, { intent: event.target.value })}/>
      <Input.TextArea aria-label={`镜头 ${index + 1} 创作指导`} value={shot.promptTemplate} onChange={event => update(index, { promptTemplate: event.target.value })}/>
      <Button size="small" danger onClick={() => onChange({ ...value, shots: value.shots.filter((_, i) => i !== index) })}>删除镜头</Button>
    </div>)}
    <Button style={{ marginTop: 12 }} disabled={value.shots.length >= 40} onClick={() => onChange({ ...value, shots: [...value.shots, { shotId: randomUuid(), purpose: counts.mainCount < 12 ? 'MAIN' : counts.detailCount < 24 ? 'DETAIL' : 'SKU', displayName: '新画面', intent: '展示商品', promptTemplate: '根据当前商品和镜头意图创作画面' }] })}>新增镜头</Button>
  </div>;
}
