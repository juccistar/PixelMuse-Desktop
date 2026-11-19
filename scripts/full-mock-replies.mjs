const STYLE = 'Neutral ivory #F5F1E8 and charcoal #252525, matte surface, soft daylight from the left.';
const PROMPT = 'Preserve the exact product identity, shape, silhouette, colors, materials, logo and label placement, and proportions from the supplied product image. Do not redesign the product, add, remove or relocate product features. Create a complete studio product photograph with a centered subject, neutral ivory #F5F1E8 background, charcoal #252525 accents, a matte surface and soft daylight from the left. Use a natural 50mm perspective with clear edges and reserve blank space above the product. No invented facts, readable promotional text, prices, labels, extra objects, watermarks or unsupported claims.';
const ROLES = ['HERO', 'DETAIL', 'SCENE', 'TRUST', 'CTA', 'VARIANT', 'COMPARISON', 'PAIN_POINT'];

/** 显式分镜夹具；assetTypes/suiteShots 使用实际测试目录中的 ID，不编造数据库记录。 */
export function storyboardReply(options = {}) {
  if (options.items) return { campaignStyleLock: options.campaignStyleLock ?? STYLE, items: options.items };
  const shots = options.suiteShots ?? [];
  const types = shots.length ? shots.map(shot => shot.assetType) : options.assetTypes ?? ['hero-image'];
  const count = shots.length || options.targetImageCount || types.length;
  if (!Number.isSafeInteger(count) || count < 1 || count > 12 || types.length === 0) throw new RangeError('Storyboard fixture requires 1 to 12 items');
  return {
    campaignStyleLock: options.campaignStyleLock ?? shots[0]?.styleLock ?? STYLE,
    items: Array.from({ length: count }, (_, i) => ({
      assetType: types[i % types.length], displayName: `商品柔光细节${i + 1}`, shotRole: shots[i]?.shotRole ?? ROLES[i % ROLES.length],
      templateVariant: null, candidateCount: options.candidateCount ?? 1, referencedAssets: options.referencedAssets ?? [],
      mode: options.mode ?? 'CREATIVE', promptInstruction: options.prompt ?? PROMPT,
      factClaims: [], riskFlags: [], sortOrder: i,
    })),
  };
}

/** 新视觉规划样本：一目标一提示词，候选数不属于模型输出。 */
export function visualStoryboardReply(payload = {}, options = {}) {
  const targets = payload.productImageBatch?.targets;
  const count = targets?.length ?? payload.suiteBlueprint?.shots.length ?? payload.targetImageCount ?? 1;
  const product = (payload.assets ?? []).filter(asset => asset.kind === 'PRODUCT');
  const references = (payload.assets ?? []).filter(asset => asset.kind === 'REFERENCE').slice(0, 1).map(asset => asset.handle);
  return {
    campaignStyleLock: options.campaignStyleLock ?? payload.productImageBatch?.campaignStyleLock ?? payload.suiteBlueprint?.styleLock ?? STYLE,
    items: Array.from({ length: count }, (_, index) => ({
      displayName: `参考柔光画面${index + 1}`, intent: `以第${index + 1}种构图展示真实商品`,
      referenceIntent: references.length ? '借鉴所选参考图的光线、构图和背景，保留商品身份' : '用户未提供参考图，按创作要求规划',
      referencedAssets: options.referencedAssets ?? [...(targets?.[index]?.productHandles ?? product.slice(0, 1).map(asset => asset.handle)), ...references],
      mode: options.mode ?? payload.defaultMode ?? 'CREATIVE', promptInstruction: options.prompt ?? PROMPT,
      factClaims: [], riskFlags: [],
    })),
  };
}

/** 三种编辑规划均为固定协议样本，调用者负责提供与样本相符的输入和蒙版。 */
export function editPlanReply(variant = 'confirmation', overrides = {}) {
  if (!['clarification', 'confirmation', 'no-confirmation'].includes(variant)) throw new TypeError('Unknown edit fixture variant');
  const clarification = variant === 'clarification', masked = variant === 'no-confirmation';
  return {
    operation: masked ? 'PRECISE_INPAINT' : 'SCENE_ADJUST', executionMode: clarification ? 'NEED_INPUT' : masked ? 'MASKED' : 'MODEL_DIRECTED',
    userSummary: clarification ? '请补充需要调整的区域' : '保留商品细节并调整指定区域', prompt: clarification ? '' : PROMPT,
    targetAnnotationIds: [], targetDescription: '用户指定的场景区域', targetConfidence: clarification ? 0.2 : 0.96,
    clarification: clarification ? '请指出目标区域，并说明希望如何调整。' : null,
    requiresConfirmation: !clarification && !masked, compositePolicy: masked ? 'MASK_LOCKED' : 'PROVIDER_RESULT',
    memoryPatch: { summary: '保留原商品外观与保护区域。', constraints: ['Preserve exact product identity.'] }, ...overrides,
  };
}

/** 满足 Etsy/Amazon/TikTok 长度约束的 Listing 协议样本。 */
export function listingReply(platform = 'ETSY', overrides = {}) {
  if (!['ETSY', 'AMAZON', 'TIKTOK_SHOP'].includes(platform)) throw new TypeError('Unknown listing fixture platform');
  return {
    platform, title: 'Botanical Floral Artwork for Everyday Creative Projects',
    tags: platform === 'ETSY' ? Array.from({ length: 13 }, (_, i) => `floral art ${i + 1}`) : [],
    description: 'A botanical illustration with a balanced floral arrangement for your creative projects.',
    bullets: platform === 'AMAZON' ? ['Botanical artwork', 'Balanced composition', 'Floral design', 'Creative styling', 'Illustrated details'] : [],
    ...overrides,
  };
}

/** 可由 EcomSuiteFile 校验的完整套图 JSON，默认五镜。 */
export function suiteReply(options = {}) {
  const id = options.id ?? 'suite-full-mock-studio';
  const count = options.shotCount ?? 5;
  if (!Number.isSafeInteger(count) || count < 1 || count > 12) throw new RangeError('Suite fixture requires 1 to 12 shots');
  return {
    schemaVersion: 1, kind: 'ecomgen.suite', id, name: options.name ?? '柔光商品展示套图', description: '本地协议验收使用的可复用套图样本。',
    productFamily: 'general', category: { l1: '生活日用', l2: '家居用品', leaf: '日用商品', leafKeywords: ['商品', '日用'] },
    styleLock: { direction: 'neutral studio', lockText: STYLE, palette: [{ name: 'ivory', hex: '#F5F1E8' }, { name: 'charcoal', hex: '#252525' }], noDrift: ['no logos', 'no unsupported claims'] },
    shots: Array.from({ length: count }, (_, i) => ({
      shotId: `shot-${i + 1}`, order: i + 1, shotRole: ROLES[i % ROLES.length], displayName: `商品柔光场景${i + 1}`, intent: '展示商品可见外观与细节',
      assetType: `${id}::shot-${i + 1}`, mode: 'CREATIVE', aspectRatio: '1:1', resolution: '2K', camera: '50mm', lighting: 'soft daylight from left', background: 'ivory',
      props: 'none', productOccupancy: '55%', whitespace: 'top', textZone: 'bottom',
      promptTemplate: '{product}, {product_identity_lock}, {style_lock}, neutral studio photograph, preserve exact identity, no logos, no text', supportsImageReference: true,
    })),
    provenance: { sourceKind: 'viral-reference-set', sourceImageCount: 2, detached: true, notes: 'localhost protocol fixture' },
  };
}

/** 读取单条 user 消息末尾的 JSON payload；不保留图片 base64 或完整提示词日志。 */
export function requestPayload(json) {
  const messages = json?.messages ?? json?.input ?? [];
  for (const entry of [...(Array.isArray(messages) ? messages : [])].reverse()) {
    if (entry?.role !== 'user') continue;
    const content = typeof entry.content === 'string' ? entry.content : (entry.content ?? []).filter(part => part.type === 'text' || part.type === 'input_text').map(part => part.text).join('\n');
    for (let i = content.lastIndexOf('\n{'); i >= 0; i = content.lastIndexOf('\n{', i - 1)) {
      try { return JSON.parse(content.slice(i + 1)); } catch { /* 返回契约通常先于真正 payload。 */ }
    }
  }
  return {};
}

/** 结构化输出 schema 优先；无 schema 的兼容模型才按固定工作流提示识别。 */
export function requestWorkflow(json) {
  const name = json?.response_format?.json_schema?.name ?? json?.text?.format?.name;
  const names = { ecomgen_visual_storyboard: 'storyboard', ecomgen_storyboard: 'storyboard', ecomgen_product_description: 'description', ecomgen_planning_instruction: 'planning-copy', ecomgen_listing_copy: 'listing', ecomgen_prompt_revision: 'revision', ecomgen_edit_plan: 'edit-plan', ecomgen_layer_elements: 'layer-plan', ecomgen_suite_forge: 'suite-forge' };
  if (names[name]) return names[name];
  const messages = json?.messages ?? json?.input ?? [];
  const texts = [typeof json?.instructions === 'string' ? json.instructions : '', ...messages.flatMap(entry => typeof entry?.content === 'string' ? [entry.content] : Array.isArray(entry?.content) ? entry.content.flatMap(part => typeof part.text === 'string' ? [part.text] : []) : [])].join('\n');
  if (texts.includes('Reply with exactly OK.')) return 'probe';
  if (texts.includes('Existing final prompt:')) return 'revision';
  if (texts.includes('Plan this edit.')) return 'edit-plan';
  if (texts.includes('Write marketplace listing copy')) return 'listing';
  if (texts.includes('Write copy for this project.')) return requestPayload(json).target === 'PLANNING_INSTRUCTION' ? 'planning-copy' : 'description';
  if (texts.includes('List the separable physical elements')) return 'layer-plan';
  if (texts.includes('forge ONE reusable suite') || texts.includes('Abstract exactly')) return 'suite-forge';
  if (texts.includes('Plan this project.') || requestPayload(json).planningVersion === 2) return 'storyboard';
  return 'unknown';
}

/** 默认样本只服务假 Provider；精确验收应通过 replies 或 replyForRequest 显式注入。 */
export function defaultReplyForRequest(context) {
  const payload = context.payload;
  switch (context.workflow) {
    case 'probe': return { text: 'OK' };
    case 'description': return { productName: '日用商品', coreSellingPoints: ['清晰展示商品外观'], suitableAudience: '日常使用者', expectedScenarios: '日常生活' };
    case 'planning-copy': return { content: '以柔和侧光展示商品真实外观，保留原有结构、颜色和标识，背景保持简洁，不添加未确认的事实或促销文字。' };
    case 'revision': return { prompt: `${PROMPT} Apply the requested visual revision while preserving all product-truth constraints.` };
    case 'edit-plan': return editPlanReply(payload.hasEditMask ? 'no-confirmation' : 'confirmation');
    case 'layer-plan': return { elements: [{ name: '商品主体', promptEn: 'product body' }, { name: '顶部组件', promptEn: 'top component' }] };
    case 'listing': return listingReply(payload.platform);
    case 'suite-forge': return suiteReply(payload.shots ? { name: payload.name, shotCount: payload.shots.length } : {});
    case 'storyboard': {
      if (payload.planningVersion === 2) return visualStoryboardReply(payload);
      const manual = payload.planningMode === 'MANUAL';
      return storyboardReply({
        assetTypes: manual && payload.requestedTypes?.length ? payload.requestedTypes : payload.allowedTemplateIds?.slice(0, payload.targetImageCount ?? 1),
        suiteShots: manual ? payload.requestedSuiteShots : [], targetImageCount: manual ? undefined : payload.targetImageCount ?? 1,
        candidateCount: payload.candidatesPerType ?? 1, mode: payload.defaultMode ?? 'CREATIVE',
        referencedAssets: (payload.assets ?? []).filter(asset => asset.kind === 'PRODUCT' || asset.role === 'PRODUCT_TRUTH').slice(0, 1).map(asset => asset.handle),
      });
    }
    default: throw new Error('Explicit reply fixture required for an unrecognized agent request');
  }
}
