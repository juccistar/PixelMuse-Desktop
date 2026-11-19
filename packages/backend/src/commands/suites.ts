import { randomBytes } from "node:crypto";
import type { SuiteCatalog, SuiteListQuery } from "@ecomgen/core";
import { SUITE_PAGE_SIZE_DEFAULT, SUITE_PAGE_SIZE_MAX } from "@ecomgen/core";
import type { SuiteOrigin } from "@ecomgen/ecom-suite";
import { SUITE_TAXONOMY } from "@ecomgen/ecom-suite";
import { MAX_REQUESTED_SUITE_SHOTS, validateEcomSuiteFile } from "@ecomgen/contracts";
import { ApiError } from "./support.js";
import { missing } from "./helpers.js";
import { parseBody } from "./support.js";
import { readOptionalTextArray, readText } from "./input-normalizers.js";
import type { Input } from '@ecomgen/contracts';
import { bodyOf, readImageInput, readSingleImageInput, type CommandFlow, type CommandScope } from './support.js';
const SUITE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const MAX_SUITE_IDS_QUERY = 24;
export function suiteIdForImport(requested: string | undefined, catalog: SuiteCatalog): string {
    if (requested) {
        if (!requested.startsWith("custom-suite-") || !SUITE_ID_PATTERN.test(requested))
            throw new ApiError("VALIDATION_ERROR", "Imported suite id must start with custom-suite- and use lowercase letters, digits, dot, dash or underscore");
        if (catalog.getSuite(requested))
            throw new ApiError("CONFLICT", `Suite id already exists: ${requested}`);
        return requested;
    }
    let id = `custom-suite-${randomBytes(4).toString("hex")}`;
    while (catalog.getSuite(id))
        id = `custom-suite-${randomBytes(4).toString("hex")}`;
    return id;
}
export function assertValidSuiteDocument(value: unknown): void {
    const result = validateEcomSuiteFile(value);
    if (!result.ok)
        throw new ApiError("VALIDATION_ERROR", "Invalid suite document", result.errors.map((reason) => ({ path: "/", reason })));
}
export function parseSuiteListQuery(query: unknown): SuiteListQuery {
    const source = (query ?? {}) as Record<string, unknown>;
    const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
    const rawLimit = typeof source.limit === "number" ? String(source.limit) : text(source.limit);
    const parsedLimit = rawLimit === undefined ? undefined : Number.parseInt(rawLimit, 10);
    if (rawLimit !== undefined && !Number.isFinite(parsedLimit))
        throw new ApiError("VALIDATION_ERROR", "limit must be an integer");
    const ids = text(source.ids)?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
    if (ids.length > MAX_SUITE_IDS_QUERY)
        throw new ApiError("VALIDATION_ERROR", `ids supports at most ${MAX_SUITE_IDS_QUERY} suite IDs`);
    return {
        q: text(source.q),
        l1: text(source.l1),
        l2: text(source.l2),
        origin: parseSuiteOrigin(text(source.origin)),
        ids: ids.length ? [...new Set(ids)] : undefined,
        cursor: text(source.cursor) ?? null,
        limit: parsedLimit === undefined ? SUITE_PAGE_SIZE_DEFAULT : Math.min(Math.max(parsedLimit, 1), SUITE_PAGE_SIZE_MAX)
    };
}
function parseSuiteOrigin(value: string | undefined): SuiteOrigin | undefined {
    if (value === undefined)
        return undefined;
    if (value !== "builtin" && value !== "user")
        throw new ApiError("VALIDATION_ERROR", "origin must be builtin or user");
    return value;
}
export function resolveRequestedSuiteShots(requested: unknown, catalog: SuiteCatalog): string[] {
    const assetTypes = readOptionalTextArray(requested) ?? [];
    if (assetTypes.length === 0)
        return [];
    if (assetTypes.length > MAX_REQUESTED_SUITE_SHOTS)
        throw new ApiError("VALIDATION_ERROR", `requestedSuiteShots supports at most ${MAX_REQUESTED_SUITE_SHOTS} shots`);
    const resolved: string[] = [];
    for (const assetType of assetTypes) {
        if (!catalog.resolveShot(assetType))
            throw new ApiError("VALIDATION_ERROR", `requestedSuiteShots contains an unknown suite shot: ${assetType}`);
        if (!resolved.includes(assetType))
            resolved.push(assetType);
    }
    return resolved;
}
export function suitesCommands(ctx: CommandScope) {
const { repository, catalog: suiteCatalog } = ctx;
return {
listSuites: function* (command: Input<'listSuites'>): CommandFlow<unknown> { return suiteCatalog.pageSummaries(parseSuiteListQuery(command)); },
listSuiteCategories: function* (command: Input<'listSuiteCategories'>): CommandFlow<unknown> { return ({ l1: [...SUITE_TAXONOMY.l1], l2: SUITE_TAXONOMY.l2 }); },
refreshSuites: function* (command: Input<'refreshSuites'>): CommandFlow<unknown> {
    yield suiteCatalog.refresh();
    return suiteCatalog.pageSummaries();
},
getSuite: function* (command: Input<'getSuite'>): CommandFlow<unknown> {
    const id = readText(command.suiteId, "suiteId");
    const suite = suiteCatalog.getSuite(id);
    if (!suite)
        missing("suite", id);
    return suite;
},
createUserSuite: function* (command: Input<'createUserSuite'>): CommandFlow<unknown> {
    const body = bodyOf(command, []);
    assertValidSuiteDocument(body);
    const id = suiteIdForImport(body.id, suiteCatalog);
    const record = repository.saveUserSuite({ id, name: body.name, l1: body.category.l1, l2: body.category.l2, leaf: body.category.leaf, productFamily: body.productFamily ?? null, payload: { ...body, id } });
    suiteCatalog.upsertUserSuite(record);
    const suite = suiteCatalog.getSuite(id);
    if (!suite)
        throw new ApiError("INTERNAL_ERROR", "Suite was saved but could not be indexed");
    return suite;
},
updateUserSuite: function* (command: Input<'updateUserSuite'>): CommandFlow<unknown> {
    const id = readText(command.suiteId, "suiteId");
    if (!repository.getUserSuite(id))
        missing("user suite", id);
    const body = bodyOf(command, ["suiteId"]);
    assertValidSuiteDocument(body);
    const record = repository.saveUserSuite({ id, name: body.name, l1: body.category.l1, l2: body.category.l2, leaf: body.category.leaf, productFamily: body.productFamily ?? null, payload: { ...body, id } });
    suiteCatalog.upsertUserSuite(record);
    const suite = suiteCatalog.getSuite(id);
    if (!suite)
        missing("suite", id);
    return suite;
},
deleteUserSuite: function* (command: Input<'deleteUserSuite'>): CommandFlow<unknown> {
    const id = readText(command.suiteId, "suiteId");
    if (!repository.getUserSuite(id))
        throw new ApiError("CONFLICT", "Only user-imported suites can be deleted");
    repository.deleteUserSuite(id);
    suiteCatalog.removeUserSuite(id);
    return null;
}
};
}
