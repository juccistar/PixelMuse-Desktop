import type { SearchSourceRecord } from "@ecomgen/core";
import type { SearchSourceKind } from "@ecomgen/contracts";
import { ApiError } from "./support.js";
import { missing } from "./helpers.js";
import { parseBody } from "./support.js";
import { enumValue, readBoolean, readOptionalText, readPriority, readText, searchSourceBaseUrl } from "./input-normalizers.js";
import type { Input } from '@ecomgen/contracts';
import { bodyOf, readImageInput, readSingleImageInput, type CommandFlow, type CommandScope } from './support.js';
function publicSearchSource(value: SearchSourceRecord): object { const { encryptedApiKey, ...source } = value; return { ...source, hasApiKey: Boolean(encryptedApiKey) }; }
export function searchSourcesCommands(ctx: CommandScope) {
const { repository, secrets } = ctx;
return {
listSearchSources: function* (command: Input<'listSearchSources'>): CommandFlow<unknown> { return ({ items: repository.listSearchSources().map(publicSearchSource), nextCursor: null }); },
createSearchSource: function* (command: Input<'createSearchSource'>): CommandFlow<unknown> {
    const body = bodyOf(command, []);
    const kind = enumValue<SearchSourceKind>(body.kind, ["brave", "tavily", "searxng"], "kind");
    const apiKey = readOptionalText(body.apiKey);
    if (kind !== "searxng" && !apiKey)
        throw new ApiError("VALIDATION_ERROR", "apiKey is required for this search source");
    const record = repository.saveSearchSource({ name: readText(body.name, "name"), kind, baseUrl: searchSourceBaseUrl(kind, readOptionalText(body.baseUrl)), encryptedApiKey: apiKey ? secrets.encrypt(apiKey) : null, priority: readPriority(body.priority), enabled: body.enabled === undefined ? true : readBoolean(body.enabled, "enabled") });
    return publicSearchSource(record);
},
updateSearchSource: function* (command: Input<'updateSearchSource'>): CommandFlow<unknown> {
    const id = readText(command.sourceId, "sourceId");
    const current = repository.getSearchSource(id);
    if (!current)
        missing("search source", id);
    const body = bodyOf(command, ["sourceId"]);
    const kind = body.kind === undefined ? current.kind : enumValue<SearchSourceKind>(body.kind, ["brave", "tavily", "searxng"], "kind");
    const apiKey = readOptionalText(body.apiKey);
    const encryptedApiKey = apiKey ? secrets.encrypt(apiKey) : current.encryptedApiKey;
    if (kind !== "searxng" && !encryptedApiKey)
        throw new ApiError("VALIDATION_ERROR", "apiKey is required for this search source");
    return publicSearchSource(repository.saveSearchSource({ id, name: readOptionalText(body.name) ?? current.name, kind, baseUrl: searchSourceBaseUrl(kind, readOptionalText(body.baseUrl) ?? current.baseUrl), encryptedApiKey, priority: body.priority === undefined ? current.priority : readPriority(body.priority), enabled: body.enabled === undefined ? current.enabled : readBoolean(body.enabled, "enabled") }));
},
deleteSearchSource: function* (command: Input<'deleteSearchSource'>): CommandFlow<unknown> {
    const id = readText(command.sourceId, "sourceId");
    if (!repository.deleteSearchSource(id))
        missing("search source", id);
    return null;
}
};
}
