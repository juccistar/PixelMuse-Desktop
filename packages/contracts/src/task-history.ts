import { Type, type TSchema } from '@sinclair/typebox';
import { Job } from './business-schemas.js';
import { publicSchema } from './public-schema.js';

const define = <I extends TSchema, O extends TSchema>(input: I, output: O) => ({ input, output });
const pagination = { limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), offset: Type.Optional(Type.Integer({ minimum: 0 })) };
const nullableText = Type.Union([Type.String(), Type.Null()]);
const listingItem = Type.Object({ job: publicSchema(Job), platform: nullableText, sellingPoints: nullableText, mustIncludeWords: nullableText, bannedWords: nullableText, createdAt: Type.String() }, { additionalProperties: false });
/** 仅返回任务公开字段与明确允许的文案参数。 */
export const taskHistoryOperations = {
  listPatternListingHistory: define(Type.Object({ patternId: Type.String({ minLength: 1 }), ...pagination }, { additionalProperties: false }), Type.Object({ items: Type.Array(listingItem), total: Type.Integer({ minimum: 0 }) }, { additionalProperties: false })),
  listModelCastHistory: define(Type.Object({ modelId: Type.String({ minLength: 1 }), ...pagination }, { additionalProperties: false }), Type.Object({ items: Type.Array(publicSchema(Job)), total: Type.Integer({ minimum: 0 }) }, { additionalProperties: false })),
} as const;
