import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ streamMock: vi.fn(), options: undefined as { onPayload?: (payload: unknown, model: { id: string; baseUrl: string }) => unknown; streamFn?: (...args: unknown[]) => unknown; initialState?: { thinkingLevel?: string; systemPrompt?: string; model?: { compat?: Record<string, unknown>; reasoning?: boolean }; tools?: Array<{ name: string; execute: (id: string, params: unknown) => Promise<unknown> }> } } | undefined, prompt: "", images: [] as unknown[], errorMessage: undefined as string | undefined, simulateResearchFailure: false, itemCount: 1, referencedAssets: [] as string[], editResponse: undefined as Record<string, unknown> | undefined, responseText: undefined as string | undefined, promptCount: 0, firstResponseText: undefined as string | undefined }));

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    public state = { messages: [] as Array<{ role: string; content: Array<{ type: string; text?: string }> }>, errorMessage: captured.errorMessage };

    public constructor(options: { onPayload?: (payload: unknown, model: { id: string; baseUrl: string }) => unknown; streamFn?: (...args: unknown[]) => unknown; initialState?: { thinkingLevel?: string; tools?: Array<{ name: string; execute: (id: string, params: unknown) => Promise<unknown> }> } }) {
      captured.options = options;
    }

    public async prompt(message: string, images?: unknown[]): Promise<void> {
      if (captured.errorMessage) return;
      captured.prompt = message;
      captured.images = images ?? [];
      captured.promptCount += 1;
      if (message.includes("Plan this edit")) {
        this.state.messages = [{ role: "assistant", content: [{ type: "text", text: captured.responseText ?? JSON.stringify(captured.editResponse ?? { operation: "NATURAL_FUSION", executionMode: "MODEL_DIRECTED", userSummary: "直接编辑", prompt: "edit", targetAnnotationIds: [], targetDescription: "主要商品", targetConfidence: 0.9, clarification: null, requiresConfirmation: true, compositePolicy: "PROVIDER_RESULT", memoryPatch: {} }) }] }];
        return;
      }
      if (captured.simulateResearchFailure) {
        const researchTool = captured.options?.initialState?.tools?.find((tool) => tool.name === "research_visual_direction");
        try { await researchTool?.execute("research-call", { query: "product photography lighting" }); } catch { /* Pi 将工具错误返回给模型并继续规划。 */ }
      }
      const plan = { campaignStyleLock: "clean", items: Array.from({ length: captured.itemCount }, (_, index) => ({ assetType: "hero-image", displayName: index === 0 ? "整机斜侧展示首图" : `展示场景${index + 1}`, shotRole: index === 0 ? "HERO" : "SCENE", templateVariant: null, candidateCount: 1, referencedAssets: captured.referencedAssets, mode: "CREATIVE", promptInstruction: "hero", factClaims: [], riskFlags: [], sortOrder: index })) };
      const text = captured.promptCount === 1 && captured.firstResponseText !== undefined ? captured.firstResponseText : captured.responseText ?? JSON.stringify(plan);
      this.state.messages = [{ role: "assistant", content: [{ type: "text", text }] }];
    }
  },
}));

vi.mock("@earendil-works/pi-ai/api/openai-completions.lazy", () => ({
  openAICompletionsApi: () => ({ stream: captured.streamMock }),
}));

import { getBuiltinSuite } from "@ecomgen/ecom-suite";
import { COMPOSITE_POLICIES, EDIT_EXECUTION_MODES, EDIT_OPERATIONS } from "@ecomgen/domain";

import { planImageEdit, planStoryboard, reviseImagePrompt, type EditPlannerInput, type PlannerInput } from "./planner.js";
import { EDIT_PLAN_OUTPUT_SCHEMA, STORYBOARD_OUTPUT_SCHEMA, VISUAL_STORYBOARD_OUTPUT_SCHEMA } from "./structured-output.js";

/** mock 捕获对象跨用例共享，统一复位才能保证任一用例失败都不会影响后续用例。 */
beforeEach(() => {
  captured.options = undefined;
  captured.prompt = "";
  captured.images = [];
  captured.errorMessage = undefined;
  captured.simulateResearchFailure = false;
  captured.itemCount = 1;
  captured.referencedAssets = [];
  captured.editResponse = undefined;
  captured.responseText = undefined;
  captured.promptCount = 0;
  captured.firstResponseText = undefined;
  captured.streamMock.mockReset();
});

const input: PlannerInput = {
  model: {
    id: "model", name: "model", api: "openai-completions", provider: "provider" as never,
    baseUrl: "https://custom-gateway.example/v1", reasoning: true, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 8_000,
    compat: { maxTokensField: "max_tokens", thinkingFormat: "qwen", supportsDeveloperRole: false },
  },
  apiKey: "secret",
  projectName: "tablet",
  productCategory: null,
  productDescription: null,
  verifiedFacts: [],
  prohibitedClaims: [],
  brandGuidelines: {},
  platformTargets: ["TAOBAO"],
  targetMarket: null,
  copyLanguage: null,
  promptLanguage: "CHINESE",
  defaultMode: "CREATIVE",
  assets: [],
  planningMode: "AI",
  requestedTypes: ["hero-image"],
  candidatesPerType: 1,
  targetImageCount: 1,
};

describe("planStoryboard", () => {
  it("uses the resolved thinking level for the planning model", async () => {
    await planStoryboard(input);

    expect(captured.options?.initialState?.thinkingLevel).toBe("medium");
  });

  it("为每轮流式请求注入超时与显式输出上限并禁止自动重试", async () => {
    await planStoryboard({ ...input, thinkingLevel: "auto", maxOutputTokens: 16_384 });
    const streamFn = captured.options?.streamFn;
    expect(typeof streamFn).toBe("function");
    captured.streamMock.mockReset().mockReturnValueOnce("events");
    const returned = streamFn?.({ id: "model" }, { messages: [] }, { temperature: 0.2 });
    expect(returned).toBe("events");
    expect(captured.streamMock).toHaveBeenCalledWith({ id: "model" }, { messages: [] }, { temperature: 0.2, signal: undefined, timeoutMs: 240_000, maxTokens: 16_384, maxRetries: 0 });
  });

  it("adds strict JSON Schema only when the model advertises structured output", async () => {
    await planStoryboard(input);
    const payload = { messages: [] };
    expect(captured.options?.onPayload?.(payload, { id: "model", baseUrl: "https://custom-gateway.example/v1", api: "openai-completions", provider: "provider", ecomgenSupportsStructuredOutput: true } as never)).toMatchObject({ response_format: { type: "json_schema", json_schema: { strict: true } } });
    expect(captured.options?.onPayload?.(payload, { id: "qwen-plus", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" })).toBe(payload);
  });

  it("uses the reasoning model for manual selections and marks them as authoritative", async () => {
    await planStoryboard({ ...input, planningMode: "MANUAL", requestedTypes: ["hero-image"] });

    expect(captured.prompt).toContain("Manual selection is authoritative");
    expect(captured.prompt).toContain("Do not add a platform feed extra shot");
    const result = await planStoryboard({ ...input, planningMode: "MANUAL", requestedTypes: ["hero-image"] });
    expect(result.items[0]?.displayName).toBe("整机斜侧展示首图");
  });

  it("expands requested suite shots one by one and rejects unresolved placeholders", async () => {
    const suite = getBuiltinSuite("suite-neiyijiajufu-banbeiyi")!;
    const shots = suite.shots.slice(0, 2);
    captured.responseText = JSON.stringify({ campaignStyleLock: "clean", items: shots.map((shot, index) => ({ assetType: shot.assetType, displayName: `套图分镜 ${index + 1}`, shotRole: shot.shotRole, templateVariant: null, candidateCount: 1, referencedAssets: [], mode: "CREATIVE", promptInstruction: "A complete final prompt with no placeholders.", factClaims: [], riskFlags: [], sortOrder: index })) });
    const result = await planStoryboard({ ...input, planningMode: "MANUAL", requestedTypes: [], requestedSuiteShots: shots.map((shot) => shot.assetType), suites: [suite] });
    expect(result.items.map((item) => item.assetType)).toEqual(shots.map((shot) => shot.assetType));

    captured.responseText = JSON.stringify({ campaignStyleLock: "clean", items: [{ assetType: shots[0]!.assetType, displayName: "套图分镜 1", shotRole: shots[0]!.shotRole, templateVariant: null, candidateCount: 1, referencedAssets: [], mode: "CREATIVE", promptInstruction: "hero {product}", factClaims: [], riskFlags: [], sortOrder: 0 }] });
    await expect(planStoryboard({ ...input, planningMode: "MANUAL", requestedTypes: [], requestedSuiteShots: [shots[0]!.assetType], suites: [suite] })).rejects.toThrow(/placeholder/);
  });

  it("要求 AI 返回指定数量的分镜，并拒绝数量不符的结果", async () => {
    captured.itemCount = 2;
    const result = await planStoryboard({ ...input, targetImageCount: 2 });
    expect(captured.prompt).toContain("exactly 2 planned items");
    expect(result.items).toHaveLength(2);

    captured.itemCount = 1;
    await expect(planStoryboard({ ...input, targetImageCount: 2 })).rejects.toThrow("AI planning must return exactly 2 storyboard items");
  });

  it('按后端目标数量规划并沿用视觉锁，拒绝漏项和视觉锁漂移', async () => {
    const target = { name: '用户规格', ordinal: 1, skus: [{ name: '用户规格', code: null, attributes: [{ name: '容量', value: '用户输入' }] }], productHandles: ['P2'] };
    const productInput: PlannerInput = { ...input, assets: [{ id: 'only-product', handle: 'P2', role: 'PRODUCT_TRUTH', kind: 'PRODUCT', name: 'product.png', mimeType: 'image/png' }], productImageBatch: { purpose: 'SKU', targets: [target], campaignStyleLock: 'clean' } };
    captured.referencedAssets = ['P2'];
    const result = await planStoryboard(productInput);
    expect(result.items[0]?.referencedAssets).toEqual(['only-product']);
    expect(captured.prompt).toContain('one item per target');
    expect(captured.prompt).not.toContain('only-product');
    await expect(planStoryboard({ ...productInput, productImageBatch: { ...productInput.productImageBatch!, campaignStyleLock: 'a different lock' } })).rejects.toThrow('preserve the frozen campaign style lock');
    await expect(planStoryboard({ ...productInput, productImageBatch: { ...productInput.productImageBatch!, targets: [target, { ...target, ordinal: 2 }] } })).rejects.toThrow('exactly the assigned bounded targets');
  });

  it('拒绝SKU目标引用或提示词提及其他商品，且超界批次在请求前失败', async () => {
    const productImageBatch: NonNullable<PlannerInput['productImageBatch']> = { purpose: 'SKU', targets: [{ name: '仅商品二', ordinal: 1, skus: [], productHandles: ['P2'] }] };
    const assets: PlannerInput['assets'] = ['P1', 'P2'].map(handle => ({ id: `private-${handle}`, handle, role: 'PRODUCT_TRUTH', kind: 'PRODUCT', name: `${handle}.png`, mimeType: 'image/png' }));
    captured.referencedAssets = ['P1'];
    await expect(planStoryboard({ ...input, assets, productImageBatch })).rejects.toThrow('another target');
    captured.referencedAssets = ['P2'];
    captured.responseText = JSON.stringify({ campaignStyleLock: 'clean', items: [{ assetType: 'hero-image', displayName: '用户商品特写', shotRole: 'HERO', templateVariant: null, candidateCount: 1, referencedAssets: ['P2'], mode: 'CREATIVE', promptInstruction: 'Use P1 as the product', factClaims: [], riskFlags: [] }] });
    await expect(planStoryboard({ ...input, assets, productImageBatch })).rejects.toThrow('another target');
    const before = captured.promptCount;
    await expect(planStoryboard({ ...input, assets, productImageBatch: { ...productImageBatch, targets: Array.from({ length: 13 }, () => productImageBatch.targets[0]!) } })).rejects.toThrow('1 to 12 assigned targets');
    expect(captured.promptCount).toBe(before);
  });

  it.each([
    ['AI', 'CREATIVE'], ['AI', 'PIXEL_PROTECTED'],
    ['MANUAL', 'CREATIVE'], ['MANUAL', 'PIXEL_PROTECTED'],
    ['SUITE', 'CREATIVE'], ['SUITE', 'PIXEL_PROTECTED'],
  ] as const)('%s规划固定候选数并遵循%s模式', async (selection, defaultMode) => {
    const suite = getBuiltinSuite('suite-neiyijiajufu-banbeiyi')!;
    const shot = suite.shots[0]!;
    const suiteMode = selection === 'SUITE';
    captured.responseText = JSON.stringify({ campaignStyleLock: 'clean', items: [{
      assetType: suiteMode ? shot.assetType : 'hero-image', displayName: '商品主体展示',
      shotRole: suiteMode ? shot.shotRole : 'HERO', templateVariant: null, candidateCount: 3,
      referencedAssets: [], mode: defaultMode, promptInstruction: 'Preserve the exact supplied product identity and visible view.',
      factClaims: [], riskFlags: [], sortOrder: 0,
    }] });
    const result = await planStoryboard({ ...input, defaultMode, candidatesPerType: 3,
      planningMode: selection === 'AI' ? 'AI' : 'MANUAL', requestedTypes: suiteMode ? [] : ['hero-image'],
      ...(suiteMode ? { requestedSuiteShots: [shot.assetType], suites: [suite] } : {}),
    });
    expect(result.items[0]).toMatchObject({ candidateCount: 3, mode: defaultMode });
    expect(captured.promptCount).toBe(1);
    expect(captured.prompt).toContain(`mode to "${defaultMode}" exactly`);
    expect(captured.prompt).not.toContain('candidateCount');
    expect(captured.options?.initialState?.systemPrompt).not.toContain('candidatesPerType');
    expect(captured.options?.initialState?.systemPrompt).toContain('exactly to the supplied defaultMode');
    if (defaultMode === 'PIXEL_PROTECTED') expect(captured.prompt).toContain('do not invent unseen angles');
  });

  it('候选数只在本地赋值，不改变规划请求', async () => {
    const first = await planStoryboard({ ...input, candidatesPerType: 1 });
    const prompt = captured.prompt;
    const system = captured.options?.initialState?.systemPrompt;
    const second = await planStoryboard({ ...input, candidatesPerType: 3 });
    expect(captured.prompt).toBe(prompt);
    expect(captured.options?.initialState?.systemPrompt).toBe(system);
    expect(first.items[0]?.candidateCount).toBe(1);
    expect(second.items[0]?.candidateCount).toBe(3);
  });

  it.each(['CREATIVE', 'PIXEL_PROTECTED'] as const)('配置%s时拒绝模型自行切换另一模式', async defaultMode => {
    const mode = defaultMode === 'CREATIVE' ? 'PIXEL_PROTECTED' : 'CREATIVE';
    captured.responseText = JSON.stringify({ campaignStyleLock: 'clean', items: [{
      assetType: 'hero-image', displayName: '商品主体展示', shotRole: 'HERO', templateVariant: null,
      candidateCount: 1, referencedAssets: [], mode, promptInstruction: 'Preserve the product.',
    }] });
    await expect(planStoryboard({ ...input, defaultMode })).rejects.toThrow(`mode exactly ${defaultMode}`);
    expect(captured.promptCount).toBe(2);
  });

  it('候选数和模式冲突时要求重写完整方案，一次纠正后才接受', async () => {
    const item = { assetType: 'hero-image', displayName: '商品主体展示', shotRole: 'HERO', templateVariant: null, referencedAssets: [] };
    captured.firstResponseText = JSON.stringify({ campaignStyleLock: 'clean', items: [{ ...item, candidateCount: 1, mode: 'CREATIVE', promptInstruction: 'Invent a new hidden product view.' }] });
    captured.responseText = JSON.stringify({ campaignStyleLock: 'clean', items: [{ ...item, candidateCount: 3, mode: 'PIXEL_PROTECTED', promptInstruction: 'Keep the supplied product cutout and visible view unchanged; edit the background only.' }] });
    const result = await planStoryboard({ ...input, candidatesPerType: 3, defaultMode: 'PIXEL_PROTECTED' });
    expect(captured.promptCount).toBe(2);
    expect(captured.prompt).toContain('mode to "PIXEL_PROTECTED" exactly');
    expect(captured.prompt).not.toContain('candidateCount');
    expect(captured.prompt).toContain('Rewrite any promptInstruction that conflicts with the configured mode');
    expect(captured.prompt).toContain('do not only relabel its mode field');
    expect(result.items[0]).toMatchObject({ candidateCount: 3, mode: 'PIXEL_PROTECTED', promptInstruction: 'Keep the supplied product cutout and visible view unchanged; edit the background only.' });
  });

  it("keeps market guidance tool-only and out of the planning user message", async () => {
    await planStoryboard({ ...input, platformTargets: ["AMAZON"], targetMarket: "JAPAN", copyLanguage: null });

    expect(captured.prompt).not.toContain("platformGuidance");
    expect(captured.prompt).not.toContain("ja-JP");
    expect(captured.prompt).not.toContain("日本");
    expect(captured.prompt).toContain("product category/family first");
  });

  it("carries the final-prompt language into the payload and mandates it in the system prompt", async () => {
    await planStoryboard({ ...input, promptLanguage: "ENGLISH" });

    expect(captured.prompt).toContain('"promptLanguage":"ENGLISH"');
    // 只锚定字段名，不断言提示词原文：措辞可改，语种强制必须存在
    expect(captured.options?.initialState?.systemPrompt).toContain("promptLanguage");
  });

  it("passes handle-based visual attachments and resolves referenced handles to asset ids", async () => {
    captured.referencedAssets = ["P1", "R1"];
    const result = await planStoryboard({
      ...input,
      model: { ...input.model, input: ["text", "image"] },
      referenceImages: [
        { type: "image", mimeType: "image/png", data: "product-bytes" },
        { type: "image", mimeType: "image/jpeg", data: "style-bytes" },
      ],
      visionAttachments: [
        { attachmentIndex: 1, handle: "P1", role: "PRODUCT_TRUTH", name: "product.png", mimeType: "image/png" },
        { attachmentIndex: 2, handle: "R1", role: "STYLE_REFERENCE", name: "style.jpg", mimeType: "image/jpeg" },
      ],
      assets: [
        { id: "product-1", handle: "P1", role: "PRODUCT_TRUTH", kind: "PRODUCT", name: "product.png", mimeType: "image/png" },
        { id: "style-1", handle: "R1", role: "STYLE_REFERENCE", kind: "REFERENCE", name: "style.jpg", mimeType: "image/jpeg" },
      ],
    });
    expect(captured.images).toHaveLength(2);
    expect(captured.prompt).toContain("visionAttachments");
    expect(captured.prompt).toContain("P1");
    expect(captured.prompt).not.toContain("product-1");
    expect(result.items[0]?.referencedAssets).toEqual(["product-1", "style-1"]);
  });

  it("rejects a storyboard item that references more than four non-product images", async () => {
    captured.referencedAssets = ["R1", "R2", "R3", "R4", "R5"];
    await expect(planStoryboard({
      ...input,
      assets: captured.referencedAssets.map((handle, index) => ({ id: `reference-${index + 1}`, handle, role: "STYLE_REFERENCE", kind: "REFERENCE" as const, name: `${handle}.png`, mimeType: "image/png" })),
    })).rejects.toThrow("at most 4 non-product images");
  });

  it("preserves the Agent error when no assistant text is produced", async () => {
    captured.errorMessage = "provider timed out";

    await expect(planStoryboard(input)).rejects.toThrow("provider timed out");
  });

  it("extracts JSON when the planning model adds a natural-language preamble", async () => {
    const plan = { campaignStyleLock: "clean", items: [{ assetType: "hero-image", displayName: "整机斜侧展示首图", shotRole: "HERO", templateVariant: null, candidateCount: 1, referencedAssets: [], mode: "CREATIVE", promptInstruction: "hero", factClaims: [], riskFlags: [], sortOrder: 0 }] };
    captured.responseText = "I have all the details.\\n```json\\n" + JSON.stringify(plan) + "\\n```";
    await expect(planStoryboard(input)).resolves.toMatchObject({ campaignStyleLock: "clean" });
  });

  it("完整回复的规划校验失败后仅修复一次", async () => {
    captured.firstResponseText = "I have all the details.";
    await expect(planStoryboard(input)).resolves.toMatchObject({ campaignStyleLock: "clean" });
    expect(captured.promptCount).toBe(2);
  });

  it("第二次规划回复仍无效时如实失败，不再追加模型轮次", async () => {
    captured.firstResponseText = "I have all the details.";
    captured.responseText = "still invalid";
    await expect(planStoryboard(input)).rejects.toThrow();
    expect(captured.promptCount).toBe(2);
  });

  it("continues planning when visual research fails", async () => {
    captured.simulateResearchFailure = true;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("search unavailable"));
    try {
      const result = await planStoryboard({ ...input, webResearch: { sources: [{ id: "brave", name: "Brave", kind: "brave", baseUrl: "https://search.example.test", apiKey: "secret" }], maxResults: 1 } });
      expect(result.items[0]?.promptInstruction).toBe("hero");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("拒绝非法 shotRole 与重复 角色×模板 组合", async () => {
    const base = { templateVariant: null, candidateCount: 1, referencedAssets: [], mode: "CREATIVE", factClaims: [], riskFlags: [], sortOrder: 0 };
    const cases: Array<[unknown[], RegExp]> = [
      [[{ assetType: "hero-image", displayName: "整机斜侧展示首图", shotRole: "WOW", promptInstruction: "hero", ...base }], /invalid shotRole/],
      [[
        { assetType: "hero-image", displayName: "整机斜侧展示首图", shotRole: "HERO", promptInstruction: "hero", ...base },
        { assetType: "hero-image", displayName: "整机斜侧场景图", shotRole: "HERO", promptInstruction: "scene", ...base, sortOrder: 1 },
      ], /duplicate visual-task/],
    ];
    for (const [items, expected] of cases) {
      // 两轮都返回同样的违规结果，让最终的校验错误原样抛出
      captured.promptCount = 0;
      captured.firstResponseText = captured.responseText = JSON.stringify({ campaignStyleLock: "clean", items });
      await expect(planStoryboard({ ...input, targetImageCount: items.length })).rejects.toThrow(expected);
    }
  });
});

describe('新版视觉规划', () => {
  const visualInput: PlannerInput = {
    ...input, planningVersion: 2, requestedTypes: undefined, platformTargets: [],
    model: { ...input.model, input: ['text', 'image'] }, imageAspectRatio: '4:5', imageResolution: '2K',
    assets: [
      { id: 'product', handle: 'P1', role: 'PRODUCT_TRUTH', kind: 'PRODUCT', name: 'p.png', mimeType: 'image/png' },
      { id: 'reference', handle: 'R1', role: 'STYLE_REFERENCE', kind: 'REFERENCE', name: 'r.png', mimeType: 'image/png' },
    ],
    visionAttachments: [
      { attachmentIndex: 1, handle: 'P1', role: 'PRODUCT_TRUTH', name: 'p.png', mimeType: 'image/png' },
      { attachmentIndex: 2, handle: 'R1', role: 'STYLE_REFERENCE', name: 'r.png', mimeType: 'image/png' },
    ],
    referenceImages: [{ type: 'image', mimeType: 'image/png', data: 'p' }, { type: 'image', mimeType: 'image/png', data: 'r' }],
  };
  const item = (index: number) => ({ displayName: `画面${index}`, intent: `意图${index}`, referenceIntent: 'R1 光线', referencedAssets: ['P1', 'R1'], mode: 'CREATIVE', promptInstruction: 'Preserve P1 and use lighting from R1.', factClaims: [], riskFlags: [] });
  it('schema 不含候选数，六个目标只有六份提示词', async () => {
    expect(JSON.stringify(STORYBOARD_OUTPUT_SCHEMA)).not.toContain('candidateCount');
    expect(JSON.stringify(VISUAL_STORYBOARD_OUTPUT_SCHEMA)).not.toContain('candidateCount');
    captured.responseText = JSON.stringify({ campaignStyleLock: 'clean', items: Array.from({ length: 6 }, (_, i) => item(i)) });
    const batch = { purpose: 'MAIN' as const, targets: Array.from({ length: 6 }, (_, i) => ({ name: `target${i}`, ordinal: i, skus: [], productHandles: ['P1'] })) };
    const result = await planStoryboard({ ...visualInput, productImageBatch: batch, candidatesPerType: 2 });
    expect(result.items).toHaveLength(6);
    expect(result.items.every(i => i.candidateCount === 2 && i.planningSource?.kind === 'MODEL_DIRECT')).toBe(true);
    expect(captured.options?.initialState?.tools).toEqual([]);
    expect(captured.prompt).toContain('"imageAspectRatio":"4:5"');
    expect(captured.prompt).toContain('"imageResolution":"2K"');
    expect(captured.prompt).not.toContain('candidatesPerType');
    expect(captured.options?.initialState?.systemPrompt).toContain('Never transfer a reference product');
    const prompt = captured.prompt;
    await planStoryboard({ ...visualInput, productImageBatch: batch, candidatesPerType: 3 });
    expect(captured.prompt).toBe(prompt);
  });
  it('拒绝缺失视觉能力、未选参考、未知句柄和跨目标商品', async () => {
    await expect(planStoryboard({ ...visualInput, model: input.model })).rejects.toThrow('vision-capable');
    for (const changed of [
      { ...item(1), referencedAssets: ['P1'] },
      { ...item(1), referencedAssets: ['P1', 'R1', 'R9'] },
      { ...item(1), promptInstruction: 'Use P2 with R1.' },
    ]) {
      captured.responseText = JSON.stringify({ campaignStyleLock: 'clean', items: [changed] });
      await expect(planStoryboard(visualInput)).rejects.toThrow();
    }
  });
  it('套图按冻结镜头顺序绑定，重复 shotId 可用于不同目标', async () => {
    const shots = Array.from({ length: 2 }, () => ({ shotId: 'sku', purpose: 'SKU' as const, displayName: '规格', intent: '展示规格', promptTemplate: 'Show {product}', aspectRatio: '1:1' as const }));
    captured.responseText = JSON.stringify({ campaignStyleLock: 'clean', items: [item(1), item(2)] });
    const result = await planStoryboard({ ...visualInput, productImageBatch: { purpose: 'SKU', targets: shots.map((_, i) => ({ name: `${i}`, ordinal: i, skus: [], productHandles: ['P1'] })) }, suiteBlueprint: { version: 1, suiteId: 'suite', suiteName: '套图', suiteVersion: '3', styleLock: 'clean', shots } });
    expect(result.items.map(i => i.assetType)).toEqual(['suite::sku', 'suite::sku']);
    expect(result.items[0]?.planningSource).toMatchObject({ kind: 'SUITE', suiteId: 'suite', suiteVersion: '3', shotId: 'sku', aspectRatio: '1:1' });
    expect(captured.options?.initialState?.tools).toEqual([]);
    expect(captured.prompt).not.toContain('allowedTemplateIds');
  });
  it('模式不匹配后只纠正一次', async () => {
    captured.firstResponseText = JSON.stringify({ campaignStyleLock: 'clean', items: [{ ...item(1), mode: 'PIXEL_PROTECTED' }] });
    captured.responseText = JSON.stringify({ campaignStyleLock: 'clean', items: [item(1)] });
    const result = await planStoryboard(visualInput);
    expect(result.items[0]?.mode).toBe('CREATIVE');
    expect(captured.promptCount).toBe(2);
    expect(captured.prompt).toContain('Rewrite any promptInstruction');
  });
});

describe("reviseImagePrompt", () => {
  it("uses a structured object for prompt revision", async () => {
    captured.responseText = JSON.stringify({ prompt: "revised image prompt" });
    await expect(reviseImagePrompt({ model: input.model, apiKey: "secret", prompt: "original image prompt", revision: "make it brighter" })).resolves.toBe("revised image prompt");
    expect(captured.options?.onPayload).toBeTypeOf("function");
  });
});

const editInput: EditPlannerInput = {
  model: { ...input.model, input: ["text", "image"] },
  apiKey: "secret",
  message: "调整目标对象外观",
  annotations: {},
  hasEditMask: false,
  hasCanvasExpansion: false,
  referenceAssets: [],
  memorySummary: {},
  projectFacts: [],
  imageCapabilities: { supportsMaskEdit: true, supportsUnmaskedEdit: true, supportsMultiReference: true, supportsOutpaint: true, supportsInputFidelity: true, supportsNaturalBlend: true },
  sourceImage: { type: "image", mimeType: "image/png", data: "encoded" }
};

describe("planImageEdit", () => {
  // 给模型的 JSON schema 是 Record<string, unknown>，TypeScript 无法约束它与契约枚举同步；
  // 手抄一份时新增操作会静默失配（校验层认、模型层不认，或反之）。
  it("输出 schema 的枚举与契约枚举同源", () => {
    const properties = EDIT_PLAN_OUTPUT_SCHEMA.schema.properties as Record<string, { enum?: string[] }>;
    expect(properties.operation?.enum).toEqual([...EDIT_OPERATIONS]);
    expect(properties.executionMode?.enum).toEqual([...EDIT_EXECUTION_MODES]);
    expect(properties.compositePolicy?.enum).toEqual([...COMPOSITE_POLICIES]);
  });

  it("无蒙版且目标明确时选择模型自行判断范围", async () => {
    captured.editResponse = { operation: "NATURAL_FUSION", executionMode: "MODEL_DIRECTED", userSummary: "调整目标对象外观", prompt: "edit", targetAnnotationIds: [], targetDescription: "主要商品", targetConfidence: 0.9, clarification: null, requiresConfirmation: false, compositePolicy: "PROVIDER_RESULT", memoryPatch: {} };
    const result = await planImageEdit(editInput);
    expect(result.executionMode).toBe("MODEL_DIRECTED");
    expect(result.requiresConfirmation).toBe(true);
  });

  it("严格蒙版和歧义计划必须要求用户补充", async () => {
    captured.editResponse = { operation: "NATURAL_FUSION", executionMode: "NEED_INPUT", userSummary: "需要确认目标", prompt: "", targetAnnotationIds: [], targetDescription: "多个可能目标", targetConfidence: 0.4, clarification: "请确认要修改哪一个目标。", requiresConfirmation: false, compositePolicy: "PROVIDER_RESULT", memoryPatch: {} };
    const result = await planImageEdit({ ...editInput, hasEditMask: true });
    expect(result.executionMode).toBe("NEED_INPUT");
    expect(result.clarification).toContain("请确认");
  });

  it("提示列出契约枚举和蒙版规则，非法回复不自动修复", async () => {
    captured.editResponse = { operation: "CHANGE_ASPECT_RATIO", executionMode: "OUTPAINT", userSummary: "调整", prompt: "edit", targetDescription: "target", targetConfidence: 1 };
    await expect(planImageEdit({ ...editInput, hasEditMask: true })).rejects.toThrow("EDIT_PLAN_INVALID");
    for (const value of [...EDIT_OPERATIONS, ...EDIT_EXECUTION_MODES]) expect(captured.prompt).toContain(value);
    expect(captured.promptCount).toBe(1);
    captured.responseText = "not json";
    await expect(planImageEdit(editInput)).rejects.toThrow("EDIT_PLAN_INVALID");
    captured.responseText = "";
    await expect(planImageEdit(editInput)).rejects.toThrow("EDIT_PLAN_EMPTY");
  });

  it("可执行计划不能忽略选区", async () => {
    captured.editResponse = { operation: "NATURAL_FUSION", executionMode: "MODEL_DIRECTED", userSummary: "调整", prompt: "edit", targetDescription: "target", targetConfidence: 1 };
    await expect(planImageEdit({ ...editInput, hasEditMask: true })).rejects.toThrow("EDIT_PLAN_MASK_REQUIRED");
  });
});
