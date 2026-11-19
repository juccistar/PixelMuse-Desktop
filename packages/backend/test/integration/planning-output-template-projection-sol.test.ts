import { describe, expect, it } from 'vitest';
import { ECOM_DETAILS_IMAGE_SOURCE, ECOM_TEMPLATES } from '@ecomgen/ecom-skill';
import { operations } from '@ecomgen/contracts';
import { Value } from '@sinclair/typebox/value';
import { projectPublic } from '../../src/commands/support.js';
import { integrationFixtures } from './fixtures.js';

const { directory, open } = integrationFixtures();

describe('planning template output through the default Backend', () => {
  it('projects every built-in template to its declared public DTO without losing declared content', async () => {
    const backend = await open({ dataDir: await directory(), masterKey: Buffer.alloc(32, 31).toString('base64'), version: 'planning-template-projection' });
    const raw = { source: ECOM_DETAILS_IMAGE_SOURCE, items: ECOM_TEMPLATES };
    const schema = operations.listEcomDetailsImageTemplates.output;
    const errors = [...Value.Errors(schema, raw)];
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every(error => /\/items\/\d+\/(examples|anti_ai_tips|supports_image_reference|productOccupancy|whitespace|camera)$/.test(error.path))).toBe(true);

    const result = await backend.invoke('listEcomDetailsImageTemplates', {});
    expect(Value.Check(schema, result)).toBe(true);
    expect(result.source).toEqual(ECOM_DETAILS_IMAGE_SOURCE);
    expect(result.items).toHaveLength(ECOM_TEMPLATES.length);
    expect(result).toEqual(projectPublic(schema, raw));
    for (const [index, item] of result.items.entries()) {
      const source = ECOM_TEMPLATES[index]!;
      expect(item).toEqual({ id: source.id, upstreamNumber: source.upstreamNumber, name: source.name,
        keywords: source.keywords, trigger_phrases: source.trigger_phrases, prompt_template: source.prompt_template,
        defaults: source.defaults, category_tips: source.category_tips, defaultSize: source.defaultSize, variants: source.variants });
    }
    await expect(backend.invoke('listEcomDetailsImageTemplates', { unexpected: true } as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
