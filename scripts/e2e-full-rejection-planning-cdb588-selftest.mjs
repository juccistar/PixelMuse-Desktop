import assert from 'node:assert/strict';
import test from 'node:test';
import { assertDomainRejection, Blocked, RendererRejection } from './e2e-full-harness.mjs';
import { plan } from './e2e-full-business.mjs';

const rejection = (message, code) => new RendererRejection({ message, code });
test('known domain messages match only their expected operation', () => {
  for (const [operation, message] of [
    ['uploadAsset', '相同图片已上传到项目'],
    ['uploadAsset', '项目最多上传 6 张参考图'],
    ['testProviderConnection', 'modelId is not declared by the selected provider'],
    ['createPlanningJob', 'PIXEL_PROTECTED planning requires at least one PRODUCT_TRUTH image'],
    ['confirmStoryboard', '分镜已被其他修改更新（当前版本 2），请刷新后重试'],
    ['retryJob', '此任务不能重试；未知外部结果必须先核实。'],
    ['notAnOperation', '不支持的操作'],
    ['createProvider', '请求参数不符合契约'],
  ]) assert.doesNotThrow(() => assertDomainRejection(operation, rejection(message)));
  assert.throws(() => assertDomainRejection('uploadAsset', rejection('modelId is not declared by the selected provider')));
  assert.throws(() => assertDomainRejection('createPlanningJob', rejection('Unrelated conflict')));
  assert.throws(() => assertDomainRejection('updateProject', rejection('不支持的操作')));
});

test('explicit patterns remain mandatory and never fall back to the default', () => {
  const duplicate = rejection('相同图片已上传到项目');
  assert.doesNotThrow(() => assertDomainRejection('uploadAsset', duplicate, /^相同图片已上传到项目$/));
  assert.throws(() => assertDomainRejection('uploadAsset', duplicate, /^must reject for another reason$/));
  assert.throws(() => assertDomainRejection('uploadAsset', rejection('请求参数不符合契约'), /^相同图片已上传到项目$/));
});

test('transport, assertion and unavailable-command failures cannot pass even a permissive pattern', () => {
  for (const error of [new Error('相同图片已上传到项目'), new Error('Target page, context or browser has been closed'), new Blocked('COMMAND_UNAVAILABLE')]) {
    assert.throws(() => assertDomainRejection('uploadAsset', error, /./), actual => actual === error);
  }
});

test('infrastructure codes and messages are rejected even when an explicit pattern matches', () => {
  for (const code of ['INTERNAL_ERROR', 'COMMAND_UNAVAILABLE', 'BACKEND_UNAVAILABLE', 'LOCAL_OPERATION_FAILED', 'INVALID_RESPONSE', 'PRIVATE_OUTPUT']) {
    assert.throws(() => assertDomainRejection('uploadAsset', rejection('相同图片已上传到项目', code), /./));
  }
  for (const message of ['本地操作失败，请重试或查看诊断日志。', '操作失败，请重试。', '此业务命令尚未接入执行模块。', 'connection reset', 'Target page, context or browser has been closed']) {
    assert.throws(() => assertDomainRejection('uploadAsset', rejection(message), /./));
  }
});

function planningContext() {
  const calls = [];
  return { calls, async invoke(operation, input) {
    calls.push({ operation, input });
    return operation === 'createPlanningJob' ? { id: 'synthetic-job' } : { storyboard: { version: 1 }, items: [{ id: 'synthetic-item' }] };
  }, async waitJob(id) { assert.equal(id, 'synthetic-job'); }, check(value) { assert.ok(value); } };
}
test('AI planning gets its default count and preserves explicit valid or invalid values', async () => {
  for (const extra of [{}, { targetImageCount: 2 }, { targetImageCount: 0 }, { targetImageCount: undefined }]) {
    const c = planningContext(); await plan(c, { id: 'synthetic-project' }, extra);
    assert.equal(c.calls[0].input.planningMode, 'AI');
    assert.equal(c.calls[0].input.targetImageCount, Object.hasOwn(extra, 'targetImageCount') ? extra.targetImageCount : 1);
    assert.ok(c.calls[0].input.regenerationKey);
  }
});
test('MANUAL planning omits an implicit count and preserves explicitly invalid fields', async () => {
  const c = planningContext();
  await plan(c, { id: 'synthetic-project' }, { planningMode: 'MANUAL', requestedTypes: ['hero-image'] });
  assert.equal(Object.hasOwn(c.calls[0].input, 'targetImageCount'), false);
  const invalid = planningContext();
  await plan(invalid, { id: 'synthetic-project' }, { planningMode: 'MANUAL', requestedTypes: ['hero-image'], targetImageCount: 1 });
  assert.equal(invalid.calls[0].input.targetImageCount, 1);
});
