import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { GeneratedFileSchema } from '@ecomgen/contracts';
import { PRODUCT_IMAGE_CONTEXT_FIXTURE } from '../test/fixtures';
import { outputFileName } from './downloadImage';
import { imagePlanningLabel } from './productImagePlanning';

// 使用真正的宿主输入schema，避免宽松fake保存接口掩盖长SKU标签失败。
describe('单图保存文件名边界', () => {
  it('两项最长SKU名称共图时仍满足原生文件名限制', () => {
    const groupId = '11111111-2222-4333-8444-000000000003';
    const context = { ...PRODUCT_IMAGE_CONTEXT_FIXTURE, purpose: 'SKU' as const, imageGroupId: groupId, targetId: `SKU:${groupId}:1`, skus: [
      { id: '11111111-2222-4333-8444-000000000001', name: '甲'.repeat(120), code: 'SKU-A', attributes: [], productAssetIds: [] },
      { id: '11111111-2222-4333-8444-000000000002', name: '乙'.repeat(120), code: 'SKU-B', attributes: [], productAssetIds: [] },
    ] };
    const label = `${imagePlanningLabel(context)} · 规格产品主图`;
    expect(label.length).toBeGreaterThan(240);
    const filename = outputFileName({ id: 'fallback', mimeType: 'image/png' }, label);
    expect(filename.startsWith('SKU 图')).toBe(true);
    expect(filename.endsWith('.png')).toBe(true);
    expect(Value.Check(GeneratedFileSchema.properties.name, filename)).toBe(true);
  });

  it.each([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp']])('为%s保留扩展名且不截断emoji', (mimeType, extension) => {
    const filename = outputFileName({ id: 'fallback', mimeType }, `SKU ${'🧵'.repeat(200)}`);
    expect(filename.length).toBeLessThanOrEqual(240);
    expect(filename.endsWith(`.${extension}`)).toBe(true);
    const base = filename.slice(0, -extension.length - 1);
    expect(base).toMatch(/^SKU (?:🧵)+$/u);
    expect(Value.Check(GeneratedFileSchema.properties.name, filename)).toBe(true);
  });

  it('清理原生不接受的控制字符和路径分隔符，空名称使用输出身份', () => {
    const filename = outputFileName({ id: 'output-id', mimeType: 'image/png' }, 'SKU/黑色\nM\u0000');
    expect(filename).toBe('SKU 黑色 M.png');
    expect(Value.Check(GeneratedFileSchema.properties.name, filename)).toBe(true);
    expect(outputFileName({ id: 'output-id', mimeType: 'image/jpeg' }, '  ')).toBe('output-id.jpg');
  });
});
