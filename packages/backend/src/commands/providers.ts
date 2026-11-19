import { GeminiImageProvider, OpenAiCompatibleImageProvider, ProviderError, SeedreamLayerizeProvider, createSegmentationProvider, discoverProviderModels, probeReasoning, type PromptSegmentationProtocol, } from "@ecomgen/providers";
import type { ProviderRecord } from "@ecomgen/core";
import type { ReasoningProtocolProfile } from "@ecomgen/contracts";
import { ApiError } from "./support.js";
import { clearInvalidApplicationDefaults } from './application-settings.js';
import { missing } from "./helpers.js";
import { parseBody } from "./support.js";
import { enumValue, normalizeModels, readOptionalText, readText } from "./input-normalizers.js";
import type { Input } from '@ecomgen/contracts';
import { bodyOf, readImageInput, readSingleImageInput, type CommandFlow, type CommandScope } from './support.js';
function publicProvider(value: ProviderRecord): object { const { encryptedApiKey, ...provider } = value; return { ...provider, hasApiKey: Boolean(encryptedApiKey) }; }
export function providersCommands(ctx: CommandScope) {
const { repository, secrets, events } = ctx;
return {
testProviderConnection: function* (command: Input<'testProviderConnection'>): CommandFlow<unknown> {
    const provider = repository.getProvider(command.providerId);
    if (!provider) missing('provider', command.providerId);
    const kind = command.kind ?? 'image';
    const model = provider.models.find(m => m.id === command.modelId);
    if (!model) throw new ApiError('VALIDATION_ERROR', 'modelId is not declared by the selected provider');
    if (kind === 'image' && !model.imageApiKind || kind === 'segmentation' && !model.segmentationProtocol || kind === 'reasoning' && (model.imageApiKind || model.segmentationProtocol)) throw new ApiError('CAPABILITY_UNSUPPORTED', '模型不支持所选用途。');
    const apiKey = secrets.decrypt(provider.encryptedApiKey);
    try {
        if (kind === 'segmentation') {
            const probe = model.segmentationProtocol === 'seedream_layerize'
                ? yield new SeedreamLayerizeProvider({baseUrl:provider.baseUrl,apiKey}).probe()
                : yield createSegmentationProvider(model.segmentationProtocol as PromptSegmentationProtocol,{baseUrl:provider.baseUrl,apiKey}).probe();
            return {ok:true,providerId:provider.id,modelId:model.id,kind,...probe,modelAvailable:null};
        }
        // 连通性探测只读模型目录，不以付费推理或生图伪装成连接测试。
        const probe = yield discoverProviderModels({baseUrl:provider.baseUrl,apiKey});
        return {ok:true,providerId:provider.id,modelId:model.id,kind,latencyMs:probe.latencyMs,models:probe.models,modelAvailable:probe.models.includes(model.id)};
    } catch (error) { if (error instanceof ProviderError) throw new ApiError('PROVIDER_ERROR','服务连接测试失败。'); throw error; }
},
listProviders: function* (command: Input<'listProviders'>): CommandFlow<unknown> { return ({ items: repository.listProviders().map(publicProvider), nextCursor: null }); },
createProvider: function* (command: Input<'createProvider'>): CommandFlow<unknown> {
    const body = bodyOf(command, []);
    const models = normalizeModels(body.models);
    const apiKey = readText(body.apiKey, "apiKey");
    const reasoningProtocol = enumValue<ReasoningProtocolProfile>(body.reasoningProtocol ?? "openai", ["openai", "dashscope_qwen", "openai_responses"], "reasoningProtocol");
    const record = repository.saveProvider({ name: readText(body.name, "name"), baseUrl: readText(body.baseUrl, "baseUrl"), reasoningProtocol, encryptedApiKey: secrets.encrypt(apiKey), models });
    yield ctx.events.publish({ topic: "providers" });
    return publicProvider(record);
},
updateProvider: function* (command: Input<'updateProvider'>): CommandFlow<unknown> {
    const id = readText(command.providerId, "providerId");
    const current = repository.getProvider(id);
    if (!current)
        missing("provider", id);
    const body = bodyOf(command, ["providerId"]);
    const reasoningProtocol = body.reasoningProtocol === undefined ? current.reasoningProtocol : enumValue<ReasoningProtocolProfile>(body.reasoningProtocol, ["openai", "dashscope_qwen", "openai_responses"], "reasoningProtocol");
    const record = repository.saveProvider({ id, name: readOptionalText(body.name) ?? current.name, baseUrl: readOptionalText(body.baseUrl) ?? current.baseUrl, reasoningProtocol, encryptedApiKey: body.apiKey ? secrets.encrypt(readText(body.apiKey, "apiKey")) : current.encryptedApiKey, models: body.models ? normalizeModels(body.models) : current.models });
    clearInvalidApplicationDefaults(ctx);
    yield ctx.events.publish({ topic: "providers" });
    return publicProvider(record);
},
discoverProviderModels: function* (command: Input<'discoverProviderModels'>): CommandFlow<unknown> {
    const body = bodyOf(command, []);
    let baseUrl = readOptionalText(body.baseUrl);
    let apiKey = readOptionalText(body.apiKey);
    if (body.providerId !== undefined) {
        const providerId = readText(body.providerId, "providerId");
        const provider = repository.getProvider(providerId);
        if (!provider)
            missing("provider", providerId);
        baseUrl = baseUrl ?? provider.baseUrl;
        apiKey = apiKey ?? secrets.decrypt(provider.encryptedApiKey);
    }
    if (!baseUrl)
        throw new ApiError("VALIDATION_ERROR", "baseUrl is required when providerId is absent");
    if (!apiKey)
        throw new ApiError("VALIDATION_ERROR", "apiKey is required when providerId is absent");
    try {
        return yield discoverProviderModels({ baseUrl, apiKey });
    }
    catch (error) {
        if (error instanceof ProviderError)
            throw new ApiError("PROVIDER_ERROR", error.message);
        throw error;
    }
}
};
}
