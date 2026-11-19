import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Input } from '@ecomgen/contracts';
import { FakeDesktop } from '../../test/fake-desktop';
import { GENERATE_JOB_FIXTURE, OUTPUT_FIXTURE, PROJECT_ID } from '../../test/fixtures';
import { renderWithProviders } from '../../test/render';
import { LayersPanel } from './LayersPanel';
const plan = { id:'11111111-2222-4333-8444-555555555555',projectId:PROJECT_ID,outputId:OUTPUT_FIXTURE.id,jobId:GENERATE_JOB_FIXTURE.id,outputHash:'hash',status:'SUCCEEDED',elements:[{id:'title',name:'标题',source:'auto',bbox:null},{id:'leaf',name:'叶片',source:'auto',bbox:null}],createdAt:OUTPUT_FIXTURE.createdAt,updatedAt:OUTPUT_FIXTURE.createdAt,error:null };
const layerExport = {id:'22222222-2222-4333-8444-555555555555',projectId:PROJECT_ID,outputId:OUTPUT_FIXTURE.id,jobId:GENERATE_JOB_FIXTURE.id,status:'SUCCEEDED',includeBackground:true,psdDownloadUrl:'ecomgen-resource://LAYER_PSD/22222222-2222-4333-8444-555555555555',layerFiles:[],error:null,createdAt:OUTPUT_FIXTURE.createdAt,updatedAt:OUTPUT_FIXTURE.createdAt};
let desktop: FakeDesktop;
const notFound=()=>{throw Object.assign(new Error('没有既有记录'),{code:'NOT_FOUND'});};
beforeEach(()=>{ desktop=new FakeDesktop().install();desktop.on('getLayerPlan',notFound);desktop.on('getLayerExport',notFound);desktop.on('listLayerExports',()=>({exports:[]})); });
function setup() { return renderWithProviders(<LayersPanel outputId={OUTPUT_FIXTURE.id} outputUrl={`ecomgen-resource://OUTPUT/${OUTPUT_FIXTURE.id}`} manualElements={[{id:'manual',name:'手动画框',bbox:{x:0.1,y:0.2,width:0.3,height:0.4}}]} boxError={null} maxElements={32} segmentationKey="" segmentationOptions={[]} onSegmentationKeyChange={vi.fn()} onRenameManual={vi.fn()} onRemoveManual={vi.fn()} onHover={vi.fn()} onExit={vi.fn()} />); }
describe('原版自动/人工分层 · 具名 IPC',()=>{
  it('识别元素与手动画框联合选择，绑定具体 plan 后提交导出并原生保存 PSD',async()=>{
    let captured: Input<'createLayerExport'>|undefined;
    desktop.on('createLayerPlan',()=>({...plan,reused:false}));
    desktop.on('createLayerExport',input=>{captured=input;return {job:{...GENERATE_JOB_FIXTURE,type:'LAYER_EXPORT'},layerExport,reused:false};});
    const user=userEvent.setup();setup();await user.click(await screen.findByRole('button',{name:'智能识别'}));
    await user.click(await screen.findByLabelText('选择元素 叶片'));
    await user.click(screen.getByRole('button',{name:'生成图层文件'}));
    await waitFor(()=>expect(captured).toMatchObject({outputId:OUTPUT_FIXTURE.id,planId:plan.id,includeBackground:true,elements:[{id:'title',source:'auto'},{id:'manual',source:'manual',bbox:{x:0.1,y:0.2,width:0.3,height:0.4}}]}));
    await user.click(await screen.findByRole('button',{name:'下载 PSD'}));
    await waitFor(()=>expect(desktop.api.saveArtifact).toHaveBeenCalledWith({kind:'LAYER_PSD',id:layerExport.id}));
  });
  it('识别失败如实展示领域错误，保留按钮供显式重试',async()=>{
    desktop.on('createLayerPlan',()=>{throw Object.assign(new Error('推理模型不支持视觉'),{code:'CAPABILITY_UNSUPPORTED'});});
    const user=userEvent.setup();setup();await user.click(await screen.findByRole('button',{name:'智能识别'}));
    expect(await screen.findByText('推理模型不支持视觉')).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'智能识别'})).toBeEnabled();
  });
  it('UNKNOWN 显示中断并禁用另开识别或导出',async()=>{
    desktop.on('getLayerPlan',()=>({...plan,status:'UNKNOWN'}));setup();
    expect(await screen.findByText(/任务已中断/)).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'智能识别'})).toBeDisabled();
    expect(screen.getByRole('button',{name:'生成图层文件'})).toBeDisabled();
  });
  it.each([
    ['识别', 'RETRY', '重试任务'], ['识别', 'END', '结束任务'],
    ['导出', 'RETRY', '重试任务'], ['导出', 'END', '结束任务'],
  ] as const)('%s中断可直接%s并重读结果',async(kind,action,label)=>{
    let status = 'UNKNOWN';
    desktop.on(kind === '识别' ? 'getLayerPlan' : 'getLayerExport',()=>({... (kind === '识别' ? plan : layerExport),status}));
    desktop.on('getJobActions',()=>({cancel:{available:false,reason:null},retry:{available:true,reason:null},end:{available:true,reason:null}}));
    desktop.on('getJobRecovery',()=>({canRecover:false,recoveryReason:'无完整回执'}));
    desktop.on('resolveJobInterruptions',()=>{status=action==='RETRY'?'SUCCEEDED':'CANCELLED';return {items:[{jobId:GENERATE_JOB_FIXTURE.id,status:action==='RETRY'?'RETRIED':'ENDED',reason:null}]};});
    const user=userEvent.setup();setup();
    const button=await screen.findByRole('button',{name:label});
    await waitFor(()=>expect(button).toBeEnabled());
    await user.click(button);
    await waitFor(()=>expect(screen.queryByText(/任务已中断/)).not.toBeInTheDocument());
    expect(desktop.api.invoke).toHaveBeenCalledWith('resolveJobInterruptions',{jobId:GENERATE_JOB_FIXTURE.id,action});
    expect(vi.mocked(desktop.api.invoke).mock.calls.filter(([operation])=>operation==='resolveJobInterruptions')).toHaveLength(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox',{name:'核实依据'})).not.toBeInTheDocument();
    expect(desktop.api.invoke).not.toHaveBeenCalledWith('createLayerPlan',expect.anything());
    expect(desktop.api.invoke).not.toHaveBeenCalledWith('createLayerExport',expect.anything());
    if(kind==='导出'&&action==='RETRY') expect(screen.getByRole('button',{name:'下载 PSD'})).toBeEnabled();
    if(kind==='识别'&&action==='END') expect(screen.getByRole('button',{name:'智能识别'})).toBeEnabled();
  });
});
