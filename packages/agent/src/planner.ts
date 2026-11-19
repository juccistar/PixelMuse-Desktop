import type { Agent } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { CompositePolicy, EditExecutionMode, EditOperation, ImageAspectRatio, ImageResolution, PlanningMode, PlatformTarget, PromptLanguage, StoryboardMode, StoryboardShotRole, TargetMarket } from "@ecomgen/domain";
import { DEFAULT_TARGET_IMAGE_COUNT, EDIT_EXECUTION_MODES, EDIT_OPERATIONS, EDIT_OPERATION_CAPABILITIES, MAX_CANDIDATES_PER_TYPE, MAX_GENERATION_REFERENCE_IMAGES, MAX_TARGET_IMAGE_COUNT, MIN_TARGET_IMAGE_COUNT, compositePolicyFor, requiresConfirmationFor } from "@ecomgen/domain";
import { ECOM_DETAILS_IMAGE_SOURCE, ECOM_TEMPLATES, getTemplate, resolveTemplatesWithUser, type EcomTemplate } from "@ecomgen/ecom-skill";
import type { SuiteDefinition } from "@ecomgen/ecom-suite";
import { createPlanningTools, type WebResearchConfig } from "./tools.js";
import { createAgent, promptAgent, type AgentRunOptions, type ReasoningModel } from "./runtime.js";
import { parseJsonResponse } from "./json-response.js";
import { EDIT_PLAN_OUTPUT_SCHEMA, PROMPT_REVISION_SCHEMA, STORYBOARD_OUTPUT_SCHEMA, VISUAL_STORYBOARD_OUTPUT_SCHEMA } from "./structured-output.js";
export type { WebResearchConfig } from "./tools.js";

export interface PlannerInput extends AgentRunOptions {
  model: ReasoningModel;
  apiKey: string;
  projectName: string;
  productCategory: string | null;
  productDescription: string | null;
  verifiedFacts: string[];
  prohibitedClaims: string[];
  brandGuidelines: Record<string, string>;
  platformTargets: PlatformTarget[];
  targetMarket: TargetMarket | null;
  copyLanguage: string | null;
  /** 分镜最终生图提示词（promptInstruction）的书写语种；项目级设置，用户可指定中文或英文。 */
  promptLanguage: PromptLanguage;
  defaultMode: StoryboardMode;
  // handle（P1/R1）是素材在模型上下文中的唯一指代；id 仅供 validatePlan 解析，
  // planStoryboard 构造 payload 时必须剥离，保证真实素材 ID 不进入模型上下文。
  assets: Array<{ id: string; handle: string; role: string; kind: "PRODUCT" | "REFERENCE"; name: string; mimeType: string }>;
  referenceImages?: ImageContent[];
  visionAttachments?: Array<{ attachmentIndex: number; handle: string; role: string; name: string; mimeType: string }>;
  planningMode?: PlanningMode;
  requestedTypes?: string[];
  /** 用户自定义模板（Worker 编译后注入）；仅在 MANUAL 规划或 requestedTypes 显式约束时生效，AI 自动选片仍只用内置目录。 */
  userTemplates?: EcomTemplate[];
  /** MANUAL 规划选中的套图分镜 assetType（<suiteId>::<shotId>）；与 requestedTypes 互斥（API 层拒绝混选），每次规划只允许一类非空。 */
  requestedSuiteShots?: string[];
  /** 当前可用的套图目录（内置 + 目录投放 + 用户导入），Worker 注入。 */
  suites?: SuiteDefinition[];
  userInstruction?: string;
  candidatesPerType?: number;
  planningVersion?: 2;
  imageAspectRatio?: ImageAspectRatio;
  imageResolution?: ImageResolution;
  styleInstruction?: string;
  suiteBlueprint?: { version: 1; suiteId: string; suiteName: string; suiteVersion: string; styleLock: string; shots: Array<{ shotId: string; purpose: 'MAIN' | 'SKU' | 'DETAIL'; displayName: string; intent: string; promptTemplate: string; aspectRatio?: ImageAspectRatio }> };
  targetImageCount?: number;
  webResearch?: WebResearchConfig;
  /** 后端分配目标和顺序，模型只编写画面内容，不能创建规格身份。 */
  productImageBatch?: {
    purpose: 'MAIN' | 'SKU' | 'DETAIL';
    targets: Array<{ name: string; ordinal: number; skus: Array<{ name: string; code: string | null; attributes: Array<{ name: string; value: string }> }>; productHandles: string[] }>;
    campaignStyleLock?: string;
  };
}

export interface PlannedStoryboardItem {
  assetType: string;
  displayName: string;
  shotRole: StoryboardShotRole | null;
  planningSource?: { version: 1; kind: 'MODEL_DIRECT'; intent: string; referenceIntent: string } | { version: 1; kind: 'SUITE'; intent: string; referenceIntent: string; suiteId: string; suiteVersion: string; shotId: string; aspectRatio?: ImageAspectRatio };
  templateVariant: string | null;
  candidateCount: number;
  referencedAssets: string[];
  mode: StoryboardMode;
  promptInstruction: string;
  factClaims: string[];
  riskFlags: string[];
  sortOrder: number;
}
export interface PlannedStoryboard { campaignStyleLock: string; items: PlannedStoryboardItem[]; }

// 大项目的规划轮次可能持续数分钟；每轮有超时与取消，外部调用不自动重试。
// 提示只承载判断性知识（角色、事实边界、镜头角色语义、视觉风格取向、工具用法、最终 Prompt 契约）；
// 结构性约束由 outputSchema 与 validatePlan 硬性保证，提示内不重复展开。
// 提示不携带任何字面示例值（色名、色号、标题样例）：模型会把 in-context 示例原样复述进 promptInstruction，
// 因此 campaignStyleLock 的配色来源必须锚定输入数据（brandGuidelines、PRODUCT 图、模板 guidance），而非示例。
const SYSTEM_PROMPT = `# Role
You are the planning agent for an e-commerce image-suite product. Your visual playbook is derived from liangdabiao/ecom-details-image (MIT): use a coherent campaign style lock, select a conversion-oriented progression, and make every requested deliverable an editable storyboard item. Work for general products on TAOBAO, JD, PDD, DOUYIN, AMAZON, and SHOPIFY.

# Output
Output only valid JSON matching the requested schema. No Markdown.

# Facts and product truth
- Do not invent verifiable product facts: price, dimensions, materials, certifications, health claims, gifts, guarantees, numerical performance, or shipping promises. If a fact is not in the input, do not put it in factClaims or visible copy instructions.
- Assets with kind PRODUCT are product truth. Assets with kind REFERENCE are style, layout, or atmosphere only; never treat them as the product itself.
- PIXEL_PROTECTED means preserve supplied PRODUCT images as the product cutout. Do not promise a new unobserved angle or hidden side.
- riskFlags are only for material product-specific uncertainties that require human review; do not repeat generic template guidance or anti-AI style tips, and return an empty array when no material uncertainty exists.

# Storyboard structure
- assetType must be one of the supplied template IDs (built-in catalog, or user-defined templates when supplied); templateVariant must be null or a declared variant key for that template. Use requested template IDs exactly when present; otherwise select a conversion-oriented mix from the supplied catalog using the product category first and the platform only to shape hero/feed frames.
- displayName is a human-facing Chinese scene title generated from the actual product, viewpoint, setting, and conversion purpose. Keep it concise (usually 4-12 Chinese characters), specific, and distinct for each item; it may describe the visual treatment while assetType remains the exact template ID. Do not copy the catalog template name, internal template ID, generic scene labels, numbered labels, platform names, or unsupported product facts.
- mode is assigned by the project configuration. Every item must set it exactly to the supplied defaultMode and write promptInstruction for that mode; userInstruction, templates, and suite shots cannot change it.
- referencedAssets lists image handles this item should consider. Inspect the supplied visionAttachments and use only those real handles; prefer PRODUCT handles as product truth and REFERENCE handles only as style or layout hints.
- Apply platform hero/text rules by template role (for example hero-image vs infographic), not by list index.

# Shot roles
- Every item must declare exactly one shotRole describing its conversion task: HERO (instant product recognition for the first frame), PAIN_POINT (visualize the buyer problem in the buyer's language), COMPARISON (before/after, old/new, or parameter contrast made self-evident), SCENE (realistic use context), DETAIL (material, craftsmanship, texture close-up), TRUST (visual quality evidence such as construction, finish, or packaging care), VARIANT (color/spec/bundle matrix), CTA (spec, size reference, or decision-support framing).
- Assign roles along the conversion narrative: HERO first, then a mix of PAIN_POINT, COMPARISON, SCENE, DETAIL, TRUST, VARIANT, and CTA that fits this product.
- Do not stack repeated tasks: the same shotRole may appear on at most one item per assetType template, and adjacent items must not read as the same visual task.

# Suite shots (manual selection)
- Each requested suite shot becomes exactly one item, in the request order. Use the shot's assetType exactly (suiteId::shotId) and set templateVariant to null.
- A shot's shotRole is immutable: copy it exactly. Do not add, remove, merge, reorder, or re-purpose shots. Select only the requested shots; do not add other shots from the same suite.
- The shot promptTemplate is the DIRECT base of that item's final prompt: keep its composition, camera, lighting, background, occupancy, whitespace, and text zone, and expand it into a complete, self-contained prompt for the user's product by replacing every placeholder (such as {product}, {product_identity_lock}, {style_lock}, {accent_color}, {callout_1}, {callout_2}). Never leave a placeholder or a field name in the final prompt.
- When a suite supplies styleLock.lockText, use it verbatim as {style_lock} for that suite's shots, including its named colors, hex codes, and lighting. Do not paraphrase, restyle, or let one suite's lock bleed into another suite's shots.
- Suite shots and single-image templates are selected in separate planning runs; never add template items to a suite-shot selection or shot items to a template selection. displayName must still be a distinct Chinese scene title derived from the actual product and may differ from the shot's catalog displayName.
- Read suite definitions with read_ecom_suite before writing their prompts when the payload summary is not enough.

# Visual style
- campaignStyleLock is one reusable sentence that anchors the whole suite: name 2-3 concrete colors by exact shade name or hex code, one surface or material treatment, and lighting direction with color temperature.
- Derive the palette from the supplied inputs only, in priority order: explicit brandGuidelines entries, colors actually visible on the product in PRODUCT images, then the palette and lighting hints returned by the template guidance. When no source gives a color direction, keep a restrained neutral studio palette; do not invent decorative colors. A disciplined monochrome direction is a valid choice when it fits the product and brand.
- Reuse the exact shade wording from campaignStyleLock in every promptInstruction; never paraphrase a shade between items.
- Vary within the locked palette, not beyond it: rotate background shade, lighting angle, and camera angle across items so adjacent items are clearly distinguishable while still reading as one suite. Keep marketplace packshots on their reserved white background; place richer background or color treatment only on scene and creative types (lifestyle, poster, social, editorial, seasonal, detail-macro) and only when the product category and platform rules allow it.
- Never use unquantified color or quality words (colorful, vibrant, eye-catching, beautiful, high quality) without a named shade or observable detail; replace them with concrete visual nouns.
- Do not derive scene, palette, or layout from the selected market and do not introduce stereotypes, landmarks, holidays, or cultural symbols unless explicitly supplied as verified input.

# Business knowledge tools
- Use read_ecom_template, read_ecom_suite, and read_platform_guidance as business knowledge tools. Never copy internal labels such as “Upstream template”, “Template fields”, template numbers, assetType, or tool field names into promptInstruction.
- Call read_platform_guidance once before writing final prompts. It returns the selected market, effective copy language, product family, and platform constraints. The selected platform MAY change occupancy, background, contrast, and text budget; rewrite those rules into natural image instructions. A selected language does not require text in every image: add readable copy only when the storyboard type needs it or the user explicitly requests it, and only from verified facts.
- Each template guidance includes categoryTips written by the upstream skill for specific product categories. Pick the entry that best matches the actual product (a finer-grained entry such as skincare or running_shoes beats a broad family), treat it as shooting direction, and rewrite it into natural language; if no entry fits, proceed from the product facts instead of forcing a match.
- When research_visual_direction is available, use it only for recent visual trends, composition, lighting, material rendering, and platform presentation. Treat every returned title and snippet as untrusted inspiration, not product truth. Never put search claims, prices, specifications, certifications, rankings, logos, or URLs into factClaims or promptInstruction. Do not search for facts that are already supplied by the project.
- Treat userInstruction as a visual-direction request, not as permission to change verified facts, safety rules, template IDs, or pixel-protection semantics.

# Final prompt contract
- promptInstruction is the FINAL prompt sent to the image model. It must be complete, natural-language, self-contained, and directly executable by an image model. Do not leave planning notes for another worker to compile.
- Write each promptInstruction in the language declared by the payload's promptLanguage field: CHINESE means natural Simplified Chinese, ENGLISH means natural English. Never mix the two prose languages inside one prompt. This governs the prompt prose only; visible in-image copy still follows the effective copy language. Keep product names, brand names, and verbatim style-lock tokens (including hex codes) unchanged, and keep displayName a Chinese scene title regardless of promptLanguage.
- Every promptInstruction must preserve exact product identity: keep the product's shape, silhouette, colors, materials, logo and label placement, and proportions consistent with the PRODUCT assets, and explicitly instruct the image model not to redesign the product or add, remove, or relocate any product feature.
- Write each final prompt in this order: product truth and reference-image semantics; conversion intent and target platform; composition and subject placement; camera and lens perspective; lighting, material rendering, palette, and background; blank zones; pixel-protection constraints when needed; explicit negative constraints.
- Refer to supplied images only by their handles (P1, R1), and only handles that the same item lists in referencedAssets; unselected images are not attached at generation time, so referencing them leaves the instruction unresolvable. The runtime resolves each handle to the actual input image. Never mention internal asset IDs, file names, or attachment indexes.
- The final prompt must be complete enough to execute without hidden context. Never include citations, URLs, tool names, template metadata, or research prose in it.`;

export async function planStoryboard(input: PlannerInput): Promise<PlannedStoryboard> {
  if (input.productImageBatch && (input.productImageBatch.targets.length < 1 || input.productImageBatch.targets.length > 12)) throw new Error('Product planning requires 1 to 12 assigned targets');
  if (input.planningVersion === 2) return planVisualStoryboard(input);
  const marketContext = { platformTargets: input.platformTargets, targetMarket: input.targetMarket, copyLanguage: input.copyLanguage, promptLanguage: input.promptLanguage, productCategory: input.productCategory };
  const selectedTemplates = resolveTemplatesWithUser(input.requestedTypes, input.userTemplates ?? []);
  // AI 自动选片不暴露自定义模板与套图：工具目录只在 MANUAL 模式合并，避免诱导未授权的 assetType
  const manualMode = input.planningMode === "MANUAL";
  const selectedSuiteShots = manualMode ? resolveRequestedSuiteShots(input.requestedSuiteShots, input.suites ?? []) : [];
  // 工具目录只保留被选分镜：模型即使用 read_ecom_suite 自查，也看不到同套图里未选中的分镜。
  const suiteToolCatalog = pruneSuitesToShots(input.suites ?? [], new Set(selectedSuiteShots.map(({ shot }) => shot.assetType)));
  const tools = createPlanningTools(marketContext, input.webResearch ? { ...input.webResearch, external: input.external ?? input.webResearch.external } : undefined, manualMode ? input.userTemplates ?? [] : [], manualMode ? suiteToolCatalog : []);
  const agent = createAgent({ external: input.external, signal: input.signal, timeoutMs: input.timeoutMs, thinkingLevel: input.thinkingLevel, maxOutputTokens: input.maxOutputTokens, workflow: "PLAN", model: input.model, apiKey: input.apiKey, systemPrompt: SYSTEM_PROMPT, tools, outputSchema: STORYBOARD_OUTPUT_SCHEMA });
  const payload = {
    ...input,
    candidatesPerType: undefined,
    apiKey: undefined,
    model: undefined,
    signal: undefined,
    timeoutMs: undefined,
    thinkingLevel: undefined,
    maxOutputTokens: undefined,
    external: undefined,
    referenceImages: undefined,
    // 套图目录按需注入：完整定义只留在 worker 的工具上下文，payload 仅带被选分镜的摘要，避免整套目录挤占上下文。
    suites: undefined,
    // 剥离素材真实 ID：模型上下文只保留 handle 指代，id 仅用于输出解析。
    assets: input.assets.map(({ id: _assetId, ...asset }) => asset),
    // 空的品牌指南不进 payload：省 token 且避免模型虚构品牌色；有值时规划层才按配色来源链消费。
    brandGuidelines: Object.keys(input.brandGuidelines ?? {}).length > 0 ? input.brandGuidelines : undefined,
    visionAttachments: input.visionAttachments,
    // 自定义模板仅在 MANUAL 规划可见（custom_prompt 是 Agent 撰写最终 Prompt 的直接指导）
    userTemplates: manualMode ? input.userTemplates : undefined,
    webResearch: input.webResearch ? { sources: input.webResearch.sources.map(({ id, name, kind, baseUrl }) => ({ id, name, kind, baseUrl })), maxResults: input.webResearch.maxResults, timeoutMs: input.webResearch.timeoutMs } : undefined,
    upstream: ECOM_DETAILS_IMAGE_SOURCE,
    allowedTemplateIds: (selectedTemplates.length ? selectedTemplates : ECOM_TEMPLATES).map((template) => template.id),
    requestedSuiteShots: selectedSuiteShots.length ? selectedSuiteShots.map(({ suite, shot }) => ({ assetType: shot.assetType, suiteId: suite.id, suiteName: suite.name, shotId: shot.shotId, order: shot.order, shotRole: shot.shotRole, displayName: shot.displayName, promptTemplate: shot.promptTemplate, styleLock: suite.styleLock.lockText })) : undefined
  };
  const targetImageCount = input.planningMode === "AI" ? requiredTargetImageCount(input.targetImageCount) : undefined;
  const modeInstruction = input.planningMode === "MANUAL"
    ? "Manual selection is authoritative: generate one planned item for every requested template and for every requested suite shot, following the request order. Do not add a platform feed extra shot. Read the platform guidance once and call read_ecom_template once with all matching templateIds. For each requested suite shot, assetType must be that shot's exact assetType, templateVariant must be null, shotRole must equal the shot's shotRole, and promptInstruction must expand the shot's promptTemplate into a complete final prompt for the user's product with every placeholder replaced; use that shot's styleLock text as the campaign style lock for that suite. Then write each promptInstruction as the final image-model prompt using product-category tips and platform occupancy/text rules for that template or shot role."
    : `Use the catalog and project context to choose a conversion-oriented storyboard with exactly ${targetImageCount} planned items. Choose image types from the product category/family first (what this product must show), then adapt hero and feed frames to the selected platform. Do not pick types from the platform alone. Read the current market and platform guidance with the business tool before writing final prompts.`;
  const productInstruction = input.productImageBatch ? `The productImageBatch is authoritative: return exactly ${input.productImageBatch.targets.length} items in target order, one item per target. Purpose MAIN/SKU/DETAIL describes business use and does not replace assetType or shotRole. SKU names/attributes are user supplied specifications, not permission to invent facts or change the product. Use only the supplied productHandles for each target's product identity. Do not merge targets or create SKU records. ${input.productImageBatch.campaignStyleLock ? 'Reuse productImageBatch.campaignStyleLock verbatim as campaignStyleLock and keep that exact visual direction in every final prompt.' : 'Choose one campaignStyleLock that can be reused unchanged in subsequent batches.'}` : '';
  const settingsInstruction = `The project generation settings are authoritative: every item must set mode to "${input.defaultMode}" exactly. These are assigned values, not creative choices. Write every promptInstruction for this configured mode. ${input.defaultMode === 'PIXEL_PROTECTED' ? 'Preserve the supplied PRODUCT cutout and visible product views; do not invent unseen angles, hidden surfaces, or redesign the product.' : 'Scene and background creativity must still preserve the supplied product identity.'}`;
  await promptAgent(agent, input, `Plan this project. ${modeInstruction} ${productInstruction} ${settingsInstruction} Return {"campaignStyleLock":string,"items":[{"assetType":string,"displayName":string,"shotRole":"HERO"|"PAIN_POINT"|"COMPARISON"|"SCENE"|"DETAIL"|"TRUST"|"VARIANT"|"CTA","templateVariant":string|null,"referencedAssets":string[],"mode":"CREATIVE"|"PIXEL_PROTECTED","promptInstruction":string,"factClaims":string[],"riskFlags":string[],"sortOrder":number}]}. Every promptInstruction must explicitly instruct the image model to preserve exact product identity and not redesign the product.\n${JSON.stringify(payload)}`, input.model.input.includes("image") ? input.referenceImages : undefined);
  if (agent.state.errorMessage) throw new Error(`Planning model request failed: ${agent.state.errorMessage}`);
  // 原业务允许收到完整回复后修复一次；传输未知绝不能进入此回环。
  let failure: string;
  try { return validatePlan(parseJsonResponse(assistantText(agent)) as PlannedStoryboard, input); }
  catch (error) { failure = error instanceof Error ? error.message : String(error); }
  await promptAgent(agent, input, `Your previous response could not be used: ${failure}\n${settingsInstruction}\nReturn the complete corrected storyboard JSON object matching the requested schema. Rewrite any promptInstruction that conflicts with the configured mode; do not only relabel its mode field. Output only valid JSON, no Markdown fences, no explanations.`);
  if (agent.state.errorMessage) throw new Error(`Planning model request failed: ${agent.state.errorMessage}`);
  return validatePlan(parseJsonResponse(assistantText(agent)) as PlannedStoryboard, input);
}

const VISUAL_SYSTEM_PROMPT = `You are a visual planner for product images. Inspect the attached PRODUCT images for visible product identity and the REFERENCE images for visual direction. Reference images lead composition, lighting, background, camera and typography, while explicit brand constraints take priority. Never transfer a reference product, logo, claims, materials or other facts to the current product. Visible observations are not verified claims. Use only supplied verified facts and obey prohibited claims. Do not add text unless requested. Preserve the product's visible identity; PIXEL_PROTECTED must not invent hidden views. Follow promptLanguage for each complete, self-contained final image prompt. Use only selected P/R handles in each prompt, and choose a real reference when available. One item is one image and has exactly one final prompt. Return JSON only.`;

type VisualItem = { displayName: string; intent: string; referenceIntent: string; referencedAssets: string[]; mode: StoryboardMode; promptInstruction: string; factClaims: string[]; riskFlags: string[] };

async function planVisualStoryboard(input: PlannerInput): Promise<PlannedStoryboard> {
  if (!input.model.input.includes('image')) throw new Error('Visual planning requires a vision-capable reasoning model');
  const attachments = input.visionAttachments ?? [];
  const images = input.referenceImages ?? [];
  const assetByHandle = new Map(input.assets.map(asset => [asset.handle, asset]));
  const attached = new Set<string>();
  const indexes = new Set<number>();
  for (const attachment of attachments) {
    const asset = assetByHandle.get(attachment.handle);
    if (!asset || attached.has(attachment.handle) || indexes.has(attachment.attachmentIndex) || !Number.isInteger(attachment.attachmentIndex) || attachment.attachmentIndex < 1 || !images[attachment.attachmentIndex - 1] || attachment.role !== asset.role) throw new Error('Invalid visual attachment mapping');
    attached.add(attachment.handle);
    indexes.add(attachment.attachmentIndex);
  }
  if (!attachments.some(a => assetByHandle.get(a.handle)?.kind === 'PRODUCT')) throw new Error('Visual planning requires a product image attachment');
  const references = attachments.filter(a => assetByHandle.get(a.handle)?.kind === 'REFERENCE');
  if (references.length > 6) throw new Error('Visual planning supports at most 6 reference images');
  const targets = input.productImageBatch?.targets;
  if (targets?.some(target => !target.productHandles.some(handle => attached.has(handle) && assetByHandle.get(handle)?.kind === 'PRODUCT'))) throw new Error('Each target requires an attached product image');
  const count = targets?.length ?? requiredTargetImageCount(input.targetImageCount);
  // 共享参考来源的真实资源ID只在Backend解析，模型仅使用本次附件的P/R句柄。
  const suite = input.suiteBlueprint ? {
    version: input.suiteBlueprint.version, suiteId: input.suiteBlueprint.suiteId, suiteName: input.suiteBlueprint.suiteName,
    suiteVersion: input.suiteBlueprint.suiteVersion, styleLock: input.suiteBlueprint.styleLock, shots: input.suiteBlueprint.shots,
  } : undefined;
  if (suite && (suite.version !== 1 || !suite.suiteId.trim() || !suite.suiteVersion.trim() || suite.shots.length !== count || (input.productImageBatch && suite.shots.some(shot => shot.purpose !== input.productImageBatch!.purpose)))) throw new Error('Suite blueprint must match the assigned targets in order');
  const payload = {
    planningVersion: 2, projectName: input.projectName, productCategory: input.productCategory,
    productDescription: input.productDescription, verifiedFacts: input.verifiedFacts, prohibitedClaims: input.prohibitedClaims,
    brandGuidelines: input.brandGuidelines, platformTargets: input.platformTargets, targetMarket: input.targetMarket,
    copyLanguage: input.copyLanguage, promptLanguage: input.promptLanguage, defaultMode: input.defaultMode,
    imageAspectRatio: input.imageAspectRatio, imageResolution: input.imageResolution, userInstruction: input.userInstruction,
    styleInstruction: input.styleInstruction, productImageBatch: input.productImageBatch, suiteBlueprint: suite,
    assets: input.assets.filter(asset => attached.has(asset.handle)).map(({ id: _id, ...asset }) => asset), visionAttachments: attachments,
  };
  const agent = createAgent({ external: input.external, signal: input.signal, timeoutMs: input.timeoutMs, thinkingLevel: input.thinkingLevel, maxOutputTokens: input.maxOutputTokens, workflow: 'PLAN', model: input.model, apiKey: input.apiKey, systemPrompt: VISUAL_SYSTEM_PROMPT, tools: [], outputSchema: VISUAL_STORYBOARD_OUTPUT_SCHEMA });
  const settings = `Return exactly ${count} items in assigned target order. Each item must use mode ${input.defaultMode} and its prompt must follow that mode. ${targets ? 'Use only each target productHandles for that item; never merge targets.' : ''} ${suite ? 'Bind each item in order to the corresponding frozen suite shot; adapt its intent and promptTemplate to the actual product, do not add or omit shots.' : 'Choose distinct visual directions freely.'} ${input.productImageBatch?.campaignStyleLock ? 'Reuse the supplied campaignStyleLock verbatim.' : 'Provide a reusable campaignStyleLock.'}`;
  const validate = (raw: unknown): PlannedStoryboard => {
    const plan = raw as { campaignStyleLock?: unknown; items?: VisualItem[] };
    if (!plan || typeof plan.campaignStyleLock !== 'string' || !plan.campaignStyleLock.trim() || !Array.isArray(plan.items) || plan.items.length !== count) throw new Error('Visual planning must return exactly the assigned targets and a campaign style lock');
    if (input.productImageBatch?.campaignStyleLock && plan.campaignStyleLock !== input.productImageBatch.campaignStyleLock) throw new Error('Visual planning must preserve the frozen campaign style lock');
    const items = plan.items.map((item, index): PlannedStoryboardItem => {
      if (!item || typeof item.displayName !== 'string' || !item.displayName.trim() || typeof item.intent !== 'string' || !item.intent.trim() || typeof item.referenceIntent !== 'string' || !item.referenceIntent.trim() || typeof item.promptInstruction !== 'string' || !Array.isArray(item.referencedAssets) || !Array.isArray(item.factClaims) || !item.factClaims.every(v => typeof v === 'string') || !Array.isArray(item.riskFlags) || !item.riskFlags.every(v => typeof v === 'string')) throw new Error('Visual planning returned an incomplete item');
      if (item.intent.trim().length > 4000 || item.referenceIntent.trim().length > 4000) throw new Error('Visual planning intent exceeds the public output limit');
      if (item.mode !== input.defaultMode) throw new Error(`Planning model must return mode exactly ${input.defaultMode} for every item and write its promptInstruction for that mode`);
      const handles = item.referencedAssets;
      if (handles.some(handle => typeof handle !== 'string' || !attached.has(handle))) throw new Error('Visual planning referenced an unknown or unattached handle');
      const selected = [...new Set(handles)];
      const product = selected.filter(handle => assetByHandle.get(handle)?.kind === 'PRODUCT');
      const refs = selected.filter(handle => assetByHandle.get(handle)?.kind === 'REFERENCE');
      if (!product.length || (targets && product.some(handle => !targets[index]!.productHandles.includes(handle)))) throw new Error('Visual planning must select product images from the current target');
      if (references.length && !refs.length) throw new Error('Visual planning must select an attached reference image');
      if (refs.length > MAX_GENERATION_REFERENCE_IMAGES) throw new Error(`Storyboard item may reference at most ${MAX_GENERATION_REFERENCE_IMAGES} non-product images`);
      const mentioned = item.promptInstruction.match(/\b[PR]\d+\b/g) ?? [];
      if (mentioned.some(handle => !selected.includes(handle))) throw new Error('Visual planning prompt mentioned an unselected or unknown handle');
      assertFinalPrompt(item.promptInstruction);
      const shot = suite?.shots[index];
      if (shot) assertNoPlaceholders(item.promptInstruction, shot.shotId);
      const planningSource: NonNullable<PlannedStoryboardItem['planningSource']> = shot && suite
        ? { version: 1, kind: 'SUITE', intent: item.intent.trim(), referenceIntent: item.referenceIntent.trim(), suiteId: suite.suiteId, suiteVersion: suite.suiteVersion, shotId: shot.shotId, ...(shot.aspectRatio ? { aspectRatio: shot.aspectRatio } : {}) }
        : { version: 1, kind: 'MODEL_DIRECT', intent: item.intent.trim(), referenceIntent: item.referenceIntent.trim() };
      return { assetType: shot && suite ? `${suite.suiteId}::${shot.shotId}` : 'model-direct:v1', displayName: item.displayName.trim(), shotRole: null, templateVariant: null, planningSource, candidateCount: clampCandidates(input.candidatesPerType ?? 1), referencedAssets: selected.map(handle => assetByHandle.get(handle)!.id), mode: item.mode, promptInstruction: item.promptInstruction, factClaims: item.factClaims, riskFlags: item.riskFlags, sortOrder: index };
    });
    return { campaignStyleLock: plan.campaignStyleLock, items };
  };
  await promptAgent(agent, input, `${settings}\n${JSON.stringify(payload)}`, images);
  if (agent.state.errorMessage) throw new Error(`Planning model request failed: ${agent.state.errorMessage}`);
  let failure: string;
  try { return validate(parseJsonResponse(assistantText(agent))); } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  await promptAgent(agent, input, `Your previous response could not be used: ${failure}\n${settings}\nReturn the complete corrected storyboard JSON. Rewrite any promptInstruction that conflicts with the configured mode; do not only relabel its mode field.`);
  if (agent.state.errorMessage) throw new Error(`Planning model request failed: ${agent.state.errorMessage}`);
  return validate(parseJsonResponse(assistantText(agent)));
}

function assistantText(agent: Agent): string {
  const response = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
  const text = response && response.role === "assistant" ? response.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") : "";
  if (!text) throw new Error("Planning model returned no text");
  return text;
}

export interface PromptRevisionInput extends AgentRunOptions {
  model: ReasoningModel;
  apiKey: string;
  prompt: string;
  revision: string;
}

export async function reviseImagePrompt(input: PromptRevisionInput): Promise<string> {
  const agent = createAgent({ external: input.external, signal: input.signal, timeoutMs: input.timeoutMs, thinkingLevel: input.thinkingLevel, maxOutputTokens: input.maxOutputTokens, workflow: "PROMPT_REVISION", model: input.model, apiKey: input.apiKey, systemPrompt: "You revise an existing final image-generation prompt. Return only a JSON object with a complete final prompt in the prompt field. Preserve all existing product-truth, product-identity, and safety constraints unless the revision explicitly changes the visual direction.", tools: [], outputSchema: PROMPT_REVISION_SCHEMA });
  await promptAgent(agent, input, `Existing final prompt:\n${input.prompt}\n\nRevision request:\n${input.revision}\n\nReturn {"prompt":string}; the prompt is sent directly to the image model.`);
  if (agent.state.errorMessage) throw new Error(`Prompt revision model request failed: ${agent.state.errorMessage}`);
  const response = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
  const text = response && response.role === "assistant" ? response.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim() : "";
  if (!text) throw new Error("Prompt revision model returned no text");
  const value = parseJsonResponse(stripJsonFence(text)) as { prompt?: unknown };
  const prompt = assertFinalPrompt(typeof value?.prompt === "string" ? value.prompt : "");
  return prompt;
}

export interface EditPlannerInput extends AgentRunOptions {
  model: ReasoningModel;
  apiKey: string;
  message: string;
  annotations: Record<string, unknown>;
  hasEditMask: boolean;
  hasCanvasExpansion: boolean;
  referenceAssets: Array<{ id: string; name: string; role: string; source?: string; purpose?: string; order?: number }>;
  memorySummary: { summary?: string; constraints?: string[] };
  projectFacts: string[];
  imageCapabilities?: { supportsMaskEdit: boolean; supportsUnmaskedEdit: boolean; supportsMultiReference: boolean; supportsOutpaint: boolean; supportsInputFidelity: boolean; supportsNaturalBlend: boolean };
  sourceImage?: ImageContent;
}

export interface PlannedEdit {
  operation: EditOperation;
  executionMode: EditExecutionMode;
  userSummary: string;
  prompt: string;
  targetAnnotationIds: string[];
  targetDescription: string;
  targetConfidence: number;
  clarification: string | null;
  requiresConfirmation: boolean;
  compositePolicy: CompositePolicy;
  memoryPatch: { summary?: string; constraints?: string[] };
}

export async function planImageEdit(input: EditPlannerInput): Promise<PlannedEdit> {
  const agent = createAgent({ external: input.external, signal: input.signal, timeoutMs: input.timeoutMs, thinkingLevel: input.thinkingLevel, maxOutputTokens: input.maxOutputTokens, workflow: "EDIT_PLAN", model: input.model, apiKey: input.apiKey, systemPrompt: "You are an image-editing planner for an e-commerce workspace. Return only a JSON object matching the requested schema. Preserve product truth, user-protected areas, mask semantics, reference purposes, and provider capability constraints. The prompt must be a complete final image-edit prompt.", tools: [], outputSchema: EDIT_PLAN_OUTPUT_SCHEMA });
  const annotationIds = annotationIdList(input.annotations);
  await promptAgent(agent, input, `Plan this edit. Return {"operation":string,"executionMode":string,"userSummary":string,"prompt":string,"targetAnnotationIds":string[],"targetDescription":string,"targetConfidence":number,"clarification":string|null,"requiresConfirmation":boolean,"compositePolicy":string,"memoryPatch":{"summary":string,"constraints":string[]}}.
operation must be exactly one of ${EDIT_OPERATIONS.join(", ")}; executionMode must be exactly one of ${EDIT_EXECUTION_MODES.join(", ")}. Operation capabilities: ${JSON.stringify(EDIT_OPERATION_CAPABILITIES)}.
NEED_INPUT is an executionMode, never an operation. Choose the valid operation closest to the intended edit even when asking for clarification. If a color or other necessary decision is missing, use NEED_INPUT and ask a specific question in clarification; prompt may be empty. Do not invent the decision.
For executable plans, preserve an existing edit mask: use MASKED, never ignore the mask. Operations requiring masked execution require MASKED; MASKED requires an edit mask. Operations requiring a reference or canvas expansion require those inputs. OUTPAINT execution requires canvas expansion; MODEL_DIRECTED without a mask requires vision. If the inputs do not support a safe decision, use NEED_INPUT and explain what is missing.
${JSON.stringify({ ...input, model: undefined, apiKey: undefined, signal: undefined, timeoutMs: undefined, thinkingLevel: undefined, maxOutputTokens: undefined, external: undefined, sourceImage: undefined, annotationIds })}`, input.model.input.includes("image") ? [input.sourceImage].filter((image): image is ImageContent => Boolean(image)) : undefined);
  if (agent.state.errorMessage) throw new Error(`Edit planning model request failed: ${agent.state.errorMessage}`);
  const response = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
  const text = response && response.role === "assistant" ? response.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") : "";
  if (!text.trim()) throw new Error("EDIT_PLAN_EMPTY");
  let parsed: PlannedEdit;
  try { parsed = parseJsonResponse(text) as PlannedEdit; }
  catch { throw new Error("EDIT_PLAN_INVALID"); }
  return validateEditPlan(parsed, input, annotationIds);
}

function annotationIdList(annotations: Record<string, unknown>): string[] {
  const entries = Array.isArray(annotations.annotations) ? annotations.annotations : [];
  return entries.flatMap((annotation) => annotation && typeof annotation === "object" && typeof (annotation as Record<string, unknown>).id === "string" ? [(annotation as Record<string, unknown>).id as string] : []);
}

function validateEditPlan(plan: PlannedEdit, input: EditPlannerInput, annotationIds: string[]): PlannedEdit {
  // 操作清单与执行方式清单来自契约枚举，规则来自能力注册表；校验顺序决定多个约束同时
  // 被违反时报出哪一个错误码，前端按错误码给提示，因此顺序不可调整。
  if (!plan || !EDIT_OPERATIONS.includes(plan.operation) || !EDIT_EXECUTION_MODES.includes(plan.executionMode) || typeof plan.userSummary !== "string" || !plan.userSummary.trim() || typeof plan.targetDescription !== "string" || typeof plan.targetConfidence !== "number" || !Number.isFinite(plan.targetConfidence) || plan.targetConfidence < 0 || plan.targetConfidence > 1 || (plan.prompt != null && typeof plan.prompt !== "string") || (plan.clarification != null && typeof plan.clarification !== "string")) throw new Error("EDIT_PLAN_INVALID");
  if (plan.executionMode === "NEED_INPUT") {
    if (!plan.clarification?.trim()) throw new Error("EDIT_PLAN_INVALID");
    return { operation: plan.operation, executionMode: plan.executionMode, userSummary: plan.userSummary.trim(), prompt: plan.prompt?.trim() ?? "", targetAnnotationIds: Array.isArray(plan.targetAnnotationIds) ? plan.targetAnnotationIds.filter((id): id is string => typeof id === "string" && annotationIds.includes(id)) : [], targetDescription: plan.targetDescription.trim(), targetConfidence: plan.targetConfidence, clarification: plan.clarification.trim(), requiresConfirmation: false, compositePolicy: compositePolicyFor(plan.executionMode), memoryPatch: plan.memoryPatch ?? {} };
  }
  const capability = EDIT_OPERATION_CAPABILITIES[plan.operation];
  const targets = Array.isArray(plan.targetAnnotationIds) ? plan.targetAnnotationIds.filter((id): id is string => typeof id === "string" && annotationIds.includes(id)) : [];
  if (capability.requiresReferenceAssets && input.referenceAssets.length === 0) throw new Error("REFERENCE_ASSET_REQUIRED");
  if (capability.requiresCanvasExpansion && !input.hasCanvasExpansion) throw new Error("OUTPAINT_CANVAS_REQUIRED");
  if (input.hasEditMask && plan.executionMode !== "MASKED") throw new Error("EDIT_PLAN_MASK_REQUIRED");
  if (capability.requiresMaskedExecution && plan.executionMode !== "MASKED") throw new Error("EDIT_PLAN_MASK_REQUIRED");
  if (plan.executionMode === "MASKED" && !input.hasEditMask) throw new Error("EDIT_TARGET_REQUIRED");
  if (plan.executionMode === "OUTPAINT" && !input.hasCanvasExpansion) throw new Error("OUTPAINT_CANVAS_REQUIRED");
  if (plan.executionMode === "MODEL_DIRECTED" && !input.hasEditMask && !input.sourceImage) throw new Error("EDIT_VISION_REQUIRED");
  if (!plan.prompt?.trim()) throw new Error("EDIT_PLAN_INVALID");
  const requiresConfirmation = requiresConfirmationFor(plan.operation, plan.executionMode);
  const compositePolicy = compositePolicyFor(plan.executionMode);
  return { operation: plan.operation, executionMode: plan.executionMode, userSummary: plan.userSummary.trim(), prompt: plan.prompt?.trim() ?? "", targetAnnotationIds: targets, targetDescription: plan.targetDescription.trim(), targetConfidence: plan.targetConfidence, clarification: plan.clarification?.trim() || null, requiresConfirmation, compositePolicy, memoryPatch: plan.memoryPatch ?? {} };
}

function stripJsonFence(value: string): string { return value.trim().replace(/^```json\s*/i, "").replace(/\s*```$/, ""); }

const SHOT_ROLES: readonly StoryboardShotRole[] = ["HERO", "PAIN_POINT", "COMPARISON", "SCENE", "DETAIL", "TRUST", "VARIANT", "CTA"];

function validatePlan(plan: PlannedStoryboard, input: PlannerInput): PlannedStoryboard {
  if (!plan || typeof plan.campaignStyleLock !== "string" || !Array.isArray(plan.items) || plan.items.length === 0) throw new Error("Planning model returned an invalid storyboard");
  const requestedTemplates = resolveTemplatesWithUser(input.requestedTypes, input.userTemplates ?? []);
  const requestedSuiteShots = resolveRequestedSuiteShots(input.requestedSuiteShots, input.suites ?? []);
  if (input.productImageBatch) {
    if (input.productImageBatch.targets.length < 1 || input.productImageBatch.targets.length > 12 || plan.items.length !== input.productImageBatch.targets.length) throw new Error('Product planning must return exactly the assigned bounded targets');
    if (input.productImageBatch.campaignStyleLock && plan.campaignStyleLock !== input.productImageBatch.campaignStyleLock) throw new Error('Product planning must preserve the frozen campaign style lock');
    if (!plan.campaignStyleLock.trim()) throw new Error('Product planning requires a nonempty campaign style lock');
  }
  const allowedTemplateIds = new Set((requestedTemplates.length ? requestedTemplates : ECOM_TEMPLATES).map((template) => template.id));
  const templateById = (id: string): EcomTemplate | undefined => getTemplate(id) ?? input.userTemplates?.find((template) => template.id === id);
  const suiteShotByAssetType = new Map<string, { suite: SuiteDefinition; shot: SuiteDefinition["shots"][number] }>();
  for (const { suite, shot } of requestedSuiteShots) suiteShotByAssetType.set(shot.assetType, { suite, shot });
  if (input.planningMode === "MANUAL") {
    const expected = [...requestedTemplates.map((template) => template.id), ...suiteShotByAssetType.keys()];
    const actual = plan.items.map((item) => item.assetType);
    if (expected.length === 0 || actual.length !== expected.length || new Set(actual).size !== actual.length || actual.some((id) => !expected.includes(id))) {
      throw new Error("Manual planning must return exactly one item for each requested template and each requested suite shot");
    }
  } else if (!input.productImageBatch && plan.items.length !== requiredTargetImageCount(input.targetImageCount)) {
    throw new Error(`AI planning must return exactly ${requiredTargetImageCount(input.targetImageCount)} storyboard items`);
  }
  // 模型只见过 handle；无法解析的引用与旧行为一致地静默丢弃，不进入修复回环。
  const assetsByHandle = new Map(input.assets.map((asset) => [asset.handle, asset]));
  const defaultCandidates = clampCandidates(input.candidatesPerType ?? 1);
  const items = plan.items.map((item, index) => {
    const suiteShot = suiteShotByAssetType.get(item.assetType);
    let template: EcomTemplate | undefined;
    if (suiteShot) {
      if (item.templateVariant !== null && item.templateVariant !== undefined) throw new Error(`Suite shot ${item.assetType} must not declare a template variant`);
      if (item.shotRole !== suiteShot.shot.shotRole) throw new Error(`Suite shot ${item.assetType} must keep the shotRole ${suiteShot.shot.shotRole}`);
    } else {
      template = templateById(item.assetType);
      if (!template || !allowedTemplateIds.has(item.assetType)) throw new Error(`Planning model returned an unavailable ecom-details-image template: ${item.assetType}`);
      if (item.templateVariant !== null && item.templateVariant !== undefined && !template.variants[item.templateVariant]) throw new Error(`Planning model returned an invalid variant for ${item.assetType}: ${item.templateVariant}`);
    }
    if (item.mode !== "CREATIVE" && item.mode !== "PIXEL_PROTECTED") throw new Error("Planning model returned an invalid storyboard mode");
    // 必须纠正整份计划，不能改标签或截断数量后放行与配置冲突的生图提示词。
    if (item.mode !== input.defaultMode) throw new Error(`Planning model must return mode exactly ${input.defaultMode} for every item and write its promptInstruction for that mode`);
    if (item.shotRole === null || !SHOT_ROLES.includes(item.shotRole)) throw new Error(`Planning model returned an invalid shotRole for ${item.assetType}: ${String(item.shotRole)}. Use one of ${SHOT_ROLES.join(", ")}`);
    if (!item.assetType || !item.promptInstruction || typeof item.displayName !== "string" || !item.displayName.trim()) throw new Error("Planning model returned an incomplete storyboard item");
    assertFinalPrompt(item.promptInstruction);
    if (suiteShot) assertNoPlaceholders(item.promptInstruction, item.assetType);
    const displayName = item.displayName.trim();
    const reservedName = suiteShot ? suiteShot.suite.name : template?.name;
    if (displayName === item.assetType || (reservedName && displayName === reservedName)) throw new Error(`Planning model returned a generic storyboard display name for ${item.assetType}`);
    const referenced = Array.isArray(item.referencedAssets) ? [...new Set(item.referencedAssets)].map((handle) => assetsByHandle.get(handle)).filter((asset): asset is NonNullable<ReturnType<typeof assetsByHandle.get>> => Boolean(asset)) : [];
    if (input.productImageBatch?.purpose === 'SKU') {
      const allowed = new Set(input.productImageBatch.targets[index]!.productHandles);
      if (referenced.some(asset => asset.kind === 'PRODUCT' && !allowed.has(asset.handle))) throw new Error('SKU planning referenced product truth from another target');
      const mentioned = item.promptInstruction.match(/\bP\d+\b/g) ?? [];
      if (mentioned.some(handle => !allowed.has(handle))) throw new Error('SKU planning prompt mentioned product truth from another target');
    }
    const referencedAssets = referenced.map((asset) => asset.id);
    const nonProductReferences = referenced.filter((asset) => asset.kind === "REFERENCE");
    if (nonProductReferences.length > MAX_GENERATION_REFERENCE_IMAGES) {
      throw new Error(`Storyboard item may reference at most ${MAX_GENERATION_REFERENCE_IMAGES} non-product images`);
    }
    return {
      assetType: item.assetType,
      displayName,
      shotRole: item.shotRole,
      templateVariant: item.templateVariant ?? null,
      candidateCount: defaultCandidates,
      referencedAssets,
      mode: item.mode,
      promptInstruction: item.promptInstruction,
      sortOrder: index,
      factClaims: item.factClaims ?? [],
      riskFlags: item.riskFlags ?? []
    };
  });
  if (new Set(items.map((item) => item.displayName)).size !== items.length) throw new Error("Planning model returned duplicate storyboard display names");
  // 视觉任务去重：同角色重复时必须换模板，否则套图会回到"多张同质图"的失败模式。
  const roleKeys = new Set<string>();
  for (const item of items) {
    const key = `${item.shotRole}|${item.assetType}`;
    if (roleKeys.has(key)) throw new Error(`Planning model returned duplicate visual-task assignment: shotRole ${item.shotRole} with template ${item.assetType} appears more than once`);
    roleKeys.add(key);
  }
  return { campaignStyleLock: plan.campaignStyleLock, items };
}

function requiredTargetImageCount(value: number | undefined): number {
  const count = value ?? DEFAULT_TARGET_IMAGE_COUNT;
  if (!Number.isInteger(count) || count < MIN_TARGET_IMAGE_COUNT || count > MAX_TARGET_IMAGE_COUNT) {
    throw new Error(`targetImageCount must be an integer between ${MIN_TARGET_IMAGE_COUNT} and ${MAX_TARGET_IMAGE_COUNT}`);
  }
  return count;
}

function assertFinalPrompt(prompt: string): string {
  const value = prompt.trim();
  if (!value) throw new Error("Planning model returned an empty final image prompt");
  if (/upstream template|template fields|anti-ai guidance|category guidance|promptcontract/i.test(value)) {
    throw new Error("Planning model exposed internal template metadata in the final image prompt; please regenerate the storyboard");
  }
  return value;
}

function clampCandidates(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_CANDIDATES_PER_TYPE, Math.max(1, Math.round(value)));
}

/** 只保留被选中的分镜：套图工具目录不得暴露同一套图里未选中的分镜。 */
function pruneSuitesToShots(suites: readonly SuiteDefinition[], selectedAssetTypes: ReadonlySet<string>): SuiteDefinition[] {
  const pruned: SuiteDefinition[] = [];
  for (const suite of suites) {
    const shots = suite.shots.filter((shot) => selectedAssetTypes.has(shot.assetType));
    if (shots.length > 0) pruned.push({ ...suite, shots });
  }
  return pruned;
}

/** 按分镜 assetType 解析请求，拒绝未知项并保持请求顺序去重。 */
function resolveRequestedSuiteShots(requestedSuiteShots: string[] | undefined, suites: readonly SuiteDefinition[]): Array<{ suite: SuiteDefinition; shot: SuiteDefinition["shots"][number] }> {
  if (!requestedSuiteShots?.length) return [];
  const resolved: Array<{ suite: SuiteDefinition; shot: SuiteDefinition["shots"][number] }> = [];
  const seen = new Set<string>();
  for (const raw of requestedSuiteShots) {
    const assetType = raw.trim();
    if (!assetType || seen.has(assetType)) continue;
    for (const suite of suites) {
      const shot = suite.shots.find((candidate) => candidate.assetType === assetType);
      if (shot) {
        seen.add(assetType);
        resolved.push({ suite, shot });
        break;
      }
    }
    if (!seen.has(assetType)) throw new Error(`Unknown requested suite shot: ${assetType}`);
  }
  return resolved;
}

const PLACEHOLDER_PATTERN = /\{[a-z0-9_]+\}/i;

/** 套图分镜的 promptTemplate 允许占位符，但最终 Prompt 必须已全部替换；残留占位符说明模型未完成改写。 */
function assertNoPlaceholders(prompt: string, assetType: string): void {
  const match = prompt.match(PLACEHOLDER_PATTERN);
  if (match) throw new Error(`Planning model left an unresolved placeholder ${match[0]} in the final image prompt for ${assetType}`);
}
