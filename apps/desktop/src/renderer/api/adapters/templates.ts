import type { Output } from '@ecomgen/contracts';
type TemplatesResponse = Output<'listEcomDetailsImageTemplates'>;
export type RawEcomTemplate = TemplatesResponse["items"][number];
/** 模板适配层（缺口 13.7）：snake_case 只在此转为 camelCase，UI 不直接读 trigger_phrases。 */
export interface EcomTemplate {
    id: string;
    upstreamNumber: number;
    name: string;
    keywords: string[];
    triggerPhrases: string[];
    promptTemplate: Record<string, string>;
    defaults: Record<string, string>;
    categoryTips: Record<string, string>;
    defaultSize: "1024x1024" | "1024x1536";
}
export function adaptTemplate(raw: RawEcomTemplate): EcomTemplate {
    return {
        id: raw.id,
        upstreamNumber: raw.upstreamNumber,
        name: raw.name,
        keywords: raw.keywords,
        triggerPhrases: raw.trigger_phrases,
        promptTemplate: raw.prompt_template,
        defaults: raw.defaults,
        categoryTips: raw.category_tips,
        defaultSize: raw.defaultSize,
    };
}
export function adaptTemplates(payload: TemplatesResponse): EcomTemplate[] {
    return payload.items.map(adaptTemplate);
}
export function tipExcerpt(tips: Record<string, string>): string {
    const first = Object.values(tips)[0];
    return first ?? "";
}
