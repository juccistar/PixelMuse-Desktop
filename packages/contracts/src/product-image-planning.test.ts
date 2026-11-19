import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { operations, type ProductImagePlanningContext } from './index.js';

const projectId = '11111111-1111-4111-8111-111111111111', skuId = '22222222-2222-4222-8222-222222222222';
const config = { mainCount: 1, detailCount: 0, skuImagesPerGroup: 1, shareImages: false };
const sku = { id: skuId, name: '用户规格', code: null, attributes: [{ name: 'storagePath', value: '用户自定义属性名' }], productAssetIds: [], included: true };
const context: ProductImagePlanningContext = { purpose: 'SKU', targetId: `SKU:${skuId}:1`, imageGroupId: null, ordinal: 1, sourceRevision: 2, sourceFingerprint: 'a'.repeat(64), skus: [{ id: sku.id, name: sku.name, code: sku.code, attributes: sku.attributes, productAssetIds: [] }], productAssetIds: [] };
const output = { id: projectId, storyboardItemId: skuId, jobId: projectId, hash: 'image-hash', createdAt: '2026-11-07T12:00:00.000Z' };

describe('product image planning IPC boundaries', () => {
  it('accepts arbitrary bounded attributes as data and rejects undeclared object keys or excessive combinations', () => {
    const input = { projectId, expectedRevision: 0, config, skus: [sku], imageGroups: [] };
    expect(Value.Check(operations.saveProjectImagePlanning.input, input)).toBe(true);
    expect(Value.Check(operations.saveProjectImagePlanning.input, { ...input, candidatesPerType: 2 })).toBe(false);
    expect(Value.Check(operations.saveProjectImagePlanning.input, { ...input, skus: [{ ...sku, storagePath: 'private' }] })).toBe(false);
    expect(Value.Check(operations.saveProjectImagePlanning.input, { ...input, skus: Array.from({ length: 61 }, () => sku) })).toBe(false);
    expect(Value.Check(operations.saveProjectImagePlanning.input, { ...input, config: { ...config, skuImagesPerGroup: 0 } })).toBe(false);
  });
  it('bounds optional planning requirements without allowing a second candidate-count source', () => {
    const input = { projectId, expectedRevision: 1, scope: 'STALE', userInstruction: '要求'.repeat(2000) };
    expect(Value.Check(operations.createProductImagePlanningJob.input, input)).toBe(true);
    expect(Value.Check(operations.createProductImagePlanningJob.input, { ...input, userInstruction: 'x'.repeat(4001) })).toBe(false);
    expect(Value.Check(operations.createProductImagePlanningJob.input, { ...input, candidatesPerType: 4 })).toBe(false);
    expect(Value.Check(operations.createProductImagePlanningJob.input, { ...input, scope: 'SOME' })).toBe(false);
  });
  it('allows historical unclassified outputs and explicit safe context while rejecting private evidence at every depth', () => {
    expect(Value.Check(operations.getOutput.output, output)).toBe(true);
    expect(Value.Check(operations.getOutput.output, { ...output, imagePlanning: context })).toBe(true);
    expect(Value.Check(operations.getOutput.output, { ...output, generationSnapshot: { imagePlanning: context, sealedCredential: 'private' } })).toBe(false);
    expect(Value.Check(operations.getOutput.output, { ...output, imagePlanning: { ...context, sealedCredential: 'private' } })).toBe(false);
    expect(Value.Check(operations.getOutput.output, { ...output, imagePlanning: { ...context, skus: [{ ...context.skus[0], storagePath: 'private' }] } })).toBe(false);
    expect(Value.Check(operations.getOutput.output, { ...output, imagePlanning: { ...context, sourceFingerprint: 'not-a-fingerprint' } })).toBe(false);
  });
});
