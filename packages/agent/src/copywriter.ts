import type { ImageContent } from "@earendil-works/pi-ai";
import type { CopywritingTarget, PlatformTarget, TargetMarket } from "@ecomgen/domain";
import { createAgent, promptAgent, type AgentRunOptions, type ReasoningModel } from "./runtime.js";
import { parseJsonResponse } from "./json-response.js";
import { latestAssistantText, requiredText } from "./model-reply.js";
import { COPYWRITING_DESCRIPTION_SCHEMA, COPYWRITING_INSTRUCTION_SCHEMA } from "./structured-output.js";

export interface CopywritingInput extends AgentRunOptions {
  target: CopywritingTarget;
  model: ReasoningModel;
  apiKey: string;
  projectName: string;
  productCategory: string | null;
  productDescription: string | null;
  verifiedFacts: string[];
  prohibitedClaims: string[];
  platformTargets: PlatformTarget[];
  targetMarket: TargetMarket | null;
  copyLanguage: string | null;
  // 素材只以 handle（P1/R1）进入模型上下文，避免数据库 ID 泄漏进提示词。
  assets: Array<{ handle: string; role: string; name: string; mimeType: string }>;
  referenceImages: ImageContent[];
}

export interface CopywritingResult {
  target: CopywritingTarget;
  content: string;
}

const SYSTEM_PROMPT = `You are an e-commerce copywriting agent. You receive project facts and visual attachments.

Critical rules:
- Output only valid JSON matching the requested schema. No Markdown fences or explanations.
- Attachments marked PRODUCT_TRUTH are the actual product. Other roles are reference material for style, layout, packaging, or atmosphere only; never identify them as the product.
- Do not invent product facts, numerical specifications, materials, certifications, prices, discounts, rankings, health claims, guarantees, shipping promises, or gifts.
- Use verifiedFacts only when they are explicitly supplied. Do not turn uncertain visual observations into factual claims.
- Respect prohibitedClaims completely. Do not paraphrase or imply them.
- For PRODUCT_DESCRIPTION, return a concise, natural product description with a product name, core selling points, suitable audience, and expected scenarios. Keep the final formatted content within 400 characters.
- For PLANNING_INSTRUCTION, return a concise, directly usable visual-planning instruction covering composition, style, lighting, product presentation, and exclusions. Do not add product facts. Keep it within 4000 characters.`;

// 原业务保留一次超长压缩；每轮独立记账，网络错误不触发压缩。
/** 使用 Pi Agent 将项目事实和带角色的视觉输入转换为可编辑文案。 */
export async function writeCopywriting(input: CopywritingInput): Promise<CopywritingResult> {
  const outputSchema = input.target === "PRODUCT_DESCRIPTION" ? COPYWRITING_DESCRIPTION_SCHEMA : COPYWRITING_INSTRUCTION_SCHEMA;
  const agent = createAgent({ external: input.external, signal: input.signal, timeoutMs: input.timeoutMs, thinkingLevel: input.thinkingLevel, maxOutputTokens: input.maxOutputTokens, workflow: "COPYWRITE", model: input.model, apiKey: input.apiKey, systemPrompt: SYSTEM_PROMPT, tools: [], outputSchema });
  const schema = input.target === "PRODUCT_DESCRIPTION"
    ? '{"productName":string,"coreSellingPoints":string[],"suitableAudience":string,"expectedScenarios":string}'
    : '{"content":string}';
  const payload = {
    target: input.target,
    projectName: input.projectName,
    productCategory: input.productCategory,
    productDescription: input.productDescription,
    verifiedFacts: input.verifiedFacts,
    prohibitedClaims: input.prohibitedClaims,
    platformTargets: input.platformTargets,
    targetMarket: input.targetMarket,
    copyLanguage: input.copyLanguage,
    visualAttachments: input.assets.map((asset, index) => ({ attachmentIndex: index + 1, ...asset })),
  };
  await promptAgent(agent, input, 
    `Write copy for this project. Return ${schema}.\n${JSON.stringify(payload)}`,
    input.model.input.includes("image") ? input.referenceImages : undefined,
  );
  if (agent.state.errorMessage) throw new Error(`Copywriting model request failed: ${agent.state.errorMessage}`);
  try {
    return validateCopywriting(input.target, parseJsonResponse(latestAssistantText(agent.state.messages, "Copywriting")));
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("Copywriting model returned content longer than")) throw error;
    const limit = input.target === "PRODUCT_DESCRIPTION" ? 500 : 3800;
    await promptAgent(agent, input, `Your previous result is too long. Rewrite it with the same JSON schema and the same facts, shortening every field so the final formatted content stays within ${limit} characters. Return only the JSON.`);
    if (agent.state.errorMessage) throw new Error(`Copywriting model request failed: ${agent.state.errorMessage}`);
    return validateCopywriting(input.target, parseJsonResponse(latestAssistantText(agent.state.messages, "Copywriting")));
  }
}


// 产品描述的 Prompt 目标是 400 字符（产品期望的简洁度），但 LLM 对字符计数不可靠，
// 硬护栏放宽到 600 作为容差带：严重超限才触发一次压缩。
const PRODUCT_DESCRIPTION_LIMIT = 600;

export function validateCopywriting(target: CopywritingTarget, value: unknown): CopywritingResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Copywriting model returned an invalid result");
  const record = value as Record<string, unknown>;
  if (target === "PRODUCT_DESCRIPTION") {
    const productName = requiredText(record.productName, "productName", "Copywriting");
    const sellingPoints = Array.isArray(record.coreSellingPoints)
      ? record.coreSellingPoints.map((item) => requiredText(item, "coreSellingPoints", "Copywriting"))
      : [];
    if (sellingPoints.length === 0) throw new Error("Copywriting model returned no core selling points");
    const content = [
      `产品名称：${productName}`,
      "核心卖点：",
      ...sellingPoints.map((item) => `- ${item}`),
      `适用人群：${requiredText(record.suitableAudience, "suitableAudience", "Copywriting")}`,
      `期望场景：${requiredText(record.expectedScenarios, "expectedScenarios", "Copywriting")}`,
    ].join("\n");
    return { target, content: checkedLength(content, PRODUCT_DESCRIPTION_LIMIT) };
  }
  return { target, content: checkedLength(requiredText(record.content, "content", "Copywriting"), 4000) };
}


function checkedLength(value: string, maxLength: number): string {
  if (value.length > maxLength) throw new Error(`Copywriting model returned content longer than ${maxLength} characters`);
  return value;
}
