import { describe, expect, it } from 'vitest';
import { adaptOutput } from '../api/adapters/projectDetail';
import { OUTPUT_FIXTURE } from '../test/fixtures';
import { outputRevision } from './outputMetadata';
import { groupOutputsByGenerationBatch } from './review';

describe('public revision display and retry counting', () => {
  it('keeps retry markers and freeform instructions from the safe public field only', () => {
    const retry = adaptOutput({ ...OUTPUT_FIXTURE, revision: 'retry' })!;
    const revised = adaptOutput({ ...OUTPUT_FIXTURE, revision: '把背景改为米色' })!;
    const privateOnly = adaptOutput({ ...OUTPUT_FIXTURE, generationSnapshot: { revision: 'retry', encryptedApiKey: 'private' } })!;
    expect(outputRevision(retry)).toBe('retry');
    expect(outputRevision(revised)).toBe('把背景改为米色');
    expect(outputRevision(privateOnly)).toBeUndefined();
    expect(privateOnly).not.toHaveProperty('generationSnapshot');
    const groups = groupOutputsByGenerationBatch([], [retry, revised, privateOnly], []);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.retryCount).toBe(1);
  });
});
