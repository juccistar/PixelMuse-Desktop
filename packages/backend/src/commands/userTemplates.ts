import { randomBytes } from "node:crypto";
import type { UserTemplateRecord } from "@ecomgen/core";
import { ApiError } from "./support.js";
import { missing } from "./helpers.js";
import { parseBody } from "./support.js";
import { enumValue, readBoolean, readText } from "./input-normalizers.js";
import type { Input } from '@ecomgen/contracts';
import { bodyOf, readImageInput, readSingleImageInput, type CommandFlow, type CommandScope } from './support.js';
function publicUserTemplate(value: UserTemplateRecord): object { return { ...value }; }
export function userTemplatesCommands(ctx: CommandScope) {
const { repository } = ctx;
return {
listUserTemplates: function* (command: Input<'listUserTemplates'>): CommandFlow<unknown> { return ({ items: repository.listUserTemplates().map(publicUserTemplate), nextCursor: null }); },
createUserTemplate: function* (command: Input<'createUserTemplate'>): CommandFlow<unknown> {
    const body = bodyOf(command, []);
    let id = `custom-${randomBytes(4).toString("hex")}`;
    if (repository.getUserTemplate(id))
        id = `custom-${randomBytes(4).toString("hex")}`;
    const record = repository.saveUserTemplate({
        id,
        name: readText(body.name, "name"),
        prompt: readText(body.prompt, "prompt"),
        defaultSize: body.defaultSize === undefined ? "1024x1024" : enumValue(body.defaultSize, ["1024x1024", "1024x1536"], "defaultSize"),
        supportsImageReference: body.supportsImageReference === undefined ? true : readBoolean(body.supportsImageReference, "supportsImageReference")
    });
    return publicUserTemplate(record);
},
updateUserTemplate: function* (command: Input<'updateUserTemplate'>): CommandFlow<unknown> {
    const id = readText(command.templateId, "templateId");
    const current = repository.getUserTemplate(id);
    if (!current)
        missing("user template", id);
    const body = bodyOf(command, ["templateId"]);
    const record = repository.saveUserTemplate({
        id,
        name: body.name === undefined ? current.name : readText(body.name, "name"),
        prompt: body.prompt === undefined ? current.prompt : readText(body.prompt, "prompt"),
        defaultSize: body.defaultSize === undefined ? current.defaultSize : enumValue(body.defaultSize, ["1024x1024", "1024x1536"], "defaultSize"),
        supportsImageReference: body.supportsImageReference === undefined ? current.supportsImageReference : readBoolean(body.supportsImageReference, "supportsImageReference")
    });
    return publicUserTemplate(record);
},
deleteUserTemplate: function* (command: Input<'deleteUserTemplate'>): CommandFlow<unknown> {
    const id = readText(command.templateId, "templateId");
    if (!repository.getUserTemplate(id))
        missing("user template", id);
    repository.deleteUserTemplate(id);
    return null;
}
};
}
