import { App, Input, Modal, Segmented } from "antd";
import { useState } from "react";
import { invoke } from '../../api/client';
import { useApplicationSettings } from '../../api/hooks/useApplicationSettings';
import { useCreatePatternDraft, type PatternDraft } from "../../api/hooks/usePatternDrafts";
import { errorText } from "../../lib/errorText";
import { DRAFT_COMPOSE_TYPE_OPTIONS } from "../patterns/shared";
/**
 * 新建起稿：只选创作类型与可选名称，随后进入专用工作台。
 * 起稿不直接产出正式花型——候选留在草稿里，只有明确「定稿入库」才写 patterns。
 */
export function StartDraftDialog({ open, onClose, onCreated }: {
    open: boolean;
    onClose: () => void;
    onCreated: (draft: PatternDraft) => void;
}) {
    const { message } = App.useApp();
    const create = useCreatePatternDraft();
    const settings = useApplicationSettings();
    const [applyingDefaults, setApplyingDefaults] = useState(false);
    const [composeType, setComposeType] = useState<"PLACEMENT" | "REPEAT">("PLACEMENT");
    const [name, setName] = useState("");
    const submit = (): void => {
        if (!settings.data || applyingDefaults) return;
        create.mutate({ composeType, ...(name.trim() ? { name: name.trim() } : {}) }, {
            onSuccess: async (draft) => {
                setApplyingDefaults(true);
                let next = draft;
                const defaults = settings.data?.defaults;
                try {
                    if (defaults) next = await invoke('updatePatternDraft', { draftId: draft.id, expectedRevision: draft.revision, conditions: { ...draft.conditions, aspectRatio: defaults.imageAspectRatio, imageResolution: defaults.imageResolution, candidateCount: defaults.candidatesPerType, ...(defaults.imageModel ? { providerId: defaults.imageModel.providerId, imageModelId: defaults.imageModel.modelId } : {}) } });
                } catch (error) { message.error(`草稿已创建，默认参数未写入：${errorText(error)}`); }
                finally { setApplyingDefaults(false); }
                setName(''); setComposeType('PLACEMENT'); onCreated(next);
            },
            onError: (error) => message.error(errorText(error)),
        });
    };
    return (<Modal title="开始 AI 起稿" open={open} onCancel={onClose} onOk={submit} okText="进入工作台" confirmLoading={create.isPending || applyingDefaults} okButtonProps={{ disabled: !settings.data || applyingDefaults }} destroyOnHidden>
      {settings.isError ? <p role="alert">创作默认设置读取失败：{errorText(settings.error)} <button type="button" onClick={() => void settings.refetch()}>重试</button></p> : null}
      <Segmented block value={composeType} options={DRAFT_COMPOSE_TYPE_OPTIONS} onChange={(value) => setComposeType(value as "PLACEMENT" | "REPEAT")}/>
      <Input style={{ marginTop: 12 }} placeholder="草稿名称（可选，进入后可重命名）" value={name} onChange={(event) => setName(event.target.value)}/>
      <p style={{ fontSize: 12, opacity: 0.65, marginTop: 12 }}>
        草稿按主题自动保存，刷新或离开后可继续；生成的候选留在草稿历史中，只有你明确「定稿入库」的那一张才会成为正式花型。
      </p>
    </Modal>);
}
