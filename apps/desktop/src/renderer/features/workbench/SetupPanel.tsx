import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { App, AutoComplete, Button, Input, InputNumber, Popover, Select, Switch, Tooltip } from "antd";
import { ChevronDown, Globe2, History, Images, Languages, Layers3, MapPin, Package, SlidersHorizontal, Sparkles, Store, Type, WandSparkles } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { saveSuiteShots } from "../../lib/suiteSelection";
import type { ProjectDetail, PromptLanguage, TargetMarket, UpdateProjectInput } from "../../api/adapters/projectDetail";
import { useApplyPlanningConfigSnapshot, usePlanningConfigSnapshots } from "../../api/hooks/usePlanningConfigSnapshots";
import { createPortal } from 'react-dom';
import { useCreateProductImagePlanningJob, useProjectImagePlanning, useSaveProjectImagePlanning } from '../../api/hooks/useProductImagePlanning';
import { readProjectPlanningDraft, saveProjectPlanningDraft, readPlanningIntent, keepPlanningIntent, clearPlanningIntent } from '../../lib/projectPreparation';
import { productImagePlanningTotals } from '../../lib/productImagePlanning';
import { SkuManagerDrawer } from './SkuManagerDrawer';
import { useCopywritingResult, useCreateCopywritingJob, type CopywritingTarget } from "../../api/hooks/useCopywriting";
import { useJob, useRetryJob } from "../../api/hooks/useJobs";
import { useHealth } from "../../api/hooks/useHealth";
import { useProviders } from "../../api/hooks/useProviders";
import { useUpdateProject } from "../../api/hooks/useProjects";
import { ManageModelsButton } from '../settings/settingsNavigation';
import { useBusinessActive } from '../../components/businessActivity';
import { errorText } from "../../lib/errorText";
import { formatDateTime } from "../../lib/format";
import { COPY_LANGUAGE_AUTOCOMPLETE_OPTIONS, copyLanguageLabel, copyLanguageOptionMatches, resolveCopyLanguage } from "../../lib/copyLanguage";
import { saveImageTypes } from "../../lib/imageTypes";
import { jobErrorText } from "../../lib/jobError";
import { modelOptions } from "../../lib/modelOptions";
import { randomUuid } from "../../lib/randomUuid";
import { canResubmitPlan, isActiveJob, latestPlanJob } from "../../lib/planJob";
import { PLATFORM_LABEL, RESOLUTION_LABEL } from "../../lib/roles";
import { ASPECT_SELECT_OPTIONS, renderAspectOption } from "./aspectOptions";
import { SuitePickerDialog } from "./SuitePickerDialog";
import { MAX_PRODUCT_IMAGE_TARGETS, suitePlanningCounts, type ProductImagePlanningConfig, type SuitePlanningBlueprint } from "@ecomgen/contracts";
import { useSuitePlanningBlueprint } from '../../api/hooks/useSuitePlanning';
import { SuiteBlueprintEditor } from './SuiteBlueprintEditor';
import styles from "./workbench.module.css";
type SetupCopywritingTarget = Exclude<CopywritingTarget, "LISTING">;
type ProjectField = keyof UpdateProjectInput;
type ProjectWrites = { tail: Promise<unknown>; intents: Map<ProjectField, symbol> };
// 只保存写入顺序与意图令牌，不缓存业务值；同一查询客户端内跨项目访问共享。
const projectWrites = new WeakMap<QueryClient, Map<string, ProjectWrites>>();
function writesFor(client: QueryClient, projectId: string): ProjectWrites {
    let projects = projectWrites.get(client);
    if (!projects) {
        projects = new Map();
        projectWrites.set(client, projects);
    }
    let writes = projects.get(projectId);
    if (!writes) {
        writes = { tail: Promise.resolve(), intents: new Map() };
        projects.set(projectId, writes);
    }
    return writes;
}
function toLines(value: string[] | null | undefined): string {
    return (value ?? []).join("\n");
}
/** Provider 引用可空（删除后置空）：null 时返回空串让下拉回到占位状态，而不是显示 "null::null"。 */
function modelKey(providerId: string | null, modelId: string | null): string {
    return providerId && modelId ? `${providerId}::${modelId}` : "";
}
function splitLines(value: string): string[] {
    return value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}
const MARKET_OPTIONS: Array<{
    value: Exclude<TargetMarket, null>;
    label: string;
}> = [
    { value: "CHINA_MAINLAND", label: "中国大陆" }, { value: "HONG_KONG", label: "香港" },
    { value: "MACAU", label: "澳门" }, { value: "TAIWAN", label: "台湾" },
    { value: "UNITED_STATES", label: "美国" }, { value: "UNITED_KINGDOM", label: "英国" },
    { value: "GERMANY", label: "德国" }, { value: "FRANCE", label: "法国" },
    { value: "ITALY", label: "意大利" }, { value: "SPAIN", label: "西班牙" },
    { value: "JAPAN", label: "日本" }, { value: "SOUTH_KOREA", label: "韩国" },
];
// 快照弹层与面板卡片同为 bg-2，叠放时区分度不足；用 bg-3 + 描边抬升一级，保持 1px 边框不扩缩布局
const snapshotPopoverStyle: CSSProperties = {
    background: "var(--bg-3)",
    border: "1px solid var(--line-2)",
};
/** 离开准备或提交规划前等待所有配置落库。 */
export interface SetupPanelHandle { flush: () => Promise<boolean> }
interface SetupPanelProps {
    detail: ProjectDetail;
    footerContainer?: HTMLElement | null;
    onPlanned?: () => void;
}
export const SetupPanel = forwardRef<SetupPanelHandle, SetupPanelProps>(function SetupPanel(props, ref) {
    return <ProjectSetupPanel key={props.detail.id} {...props} ref={ref}/>;
});
const ProjectSetupPanel = forwardRef<SetupPanelHandle, SetupPanelProps>(function ProjectSetupPanel({ detail, footerContainer, onPlanned }, ref) {
    const businessActive = useBusinessActive();
    const [snapshotPopoverOpen, setSnapshotPopoverOpen] = useState(false);
    const { notification } = App.useApp();
    const updateProject = useUpdateProject(detail.id);
    const providers = useProviders();
    const health = useHealth();
    const createPlan = useCreateProductImagePlanningJob(detail.id);
    const planningQuery = useProjectImagePlanning(detail.id);
    const savePlanning = useSaveProjectImagePlanning(detail.id);
    const [configDraft, setConfigDraft] = useState<ProductImagePlanningConfig | null>(null);
    const [skuOpen, setSkuOpen] = useState(false);
    const [skuDirty, setSkuDirty] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const submittingRef = useRef(false);
    const flushRef = useRef<Promise<boolean> | null>(null);
    const savedPlanningRef = useRef<typeof planningQuery.data>(undefined);
    const preparationDraft = useMemo(() => readProjectPlanningDraft(detail.id), [detail.id]);
    const planningDirectory = planningQuery.data;
    const effectivePlanning = planningDirectory ? { ...planningDirectory, config: configDraft ?? planningDirectory.config } : undefined;
    const planningSnapshots = usePlanningConfigSnapshots(detail.id);
    const applyPlanningSnapshot = useApplyPlanningConfigSnapshot(detail.id);
    const createCopywriting = useCreateCopywritingJob(detail.id);
    const retryJob = useRetryJob(detail.id);
    const stored = useMemo(() => preparationDraft.requestedTypes, [detail.id]);
    const storedSuiteShots = useMemo(() => preparationDraft.requestedSuiteShots, [detail.id]);
    const [name, setName] = useState(detail.name);
    const [description, setDescription] = useState(detail.productDescription ?? "");
    const [facts, setFacts] = useState(toLines(detail.verifiedFacts));
    const [claims, setClaims] = useState(toLines(detail.prohibitedClaims));
    const [selectionMode, setSelectionMode] = useState<"AI" | "MANUAL" | "SUITE">("AI");
    const [modeTouched, setModeTouched] = useState(false);
    const [styleInstruction, setStyleInstruction] = useState(preparationDraft.styleInstruction ?? '');
    const [pickingStyle, setPickingStyle] = useState(false);
    const blueprintRequest = useSuitePlanningBlueprint();
    useEffect(() => { if (!modeTouched && planningQuery.data) setSelectionMode(planningQuery.data.config.suiteBlueprint ? 'SUITE' : 'AI'); }, [modeTouched, planningQuery.data]);
    const setBlueprint = (blueprint: SuitePlanningBlueprint) => {
        if (effectivePlanning) setConfigDraft({ ...effectivePlanning.config, suiteBlueprint: blueprint, ...suitePlanningCounts(blueprint) });
    };
    const chooseSuite = async (shots: string[]) => {
        const ids = [...new Set(shots.map(shot => shot.split('::')[0]).filter(Boolean))];
        if (ids.length !== 1) { notification.warning({ title: '请选择一个完整套图' }); return; }
        try {
            const blueprint = await blueprintRequest.mutateAsync(ids[0]!);
            if (pickingStyle) setStyleInstruction(blueprint.styleLock);
            else setBlueprint(blueprint);
        } catch (error) { notification.error({ title: '读取套图失败', description: errorText(error) }); }
    };
    const selectMode = (mode: 'AI' | 'SUITE') => {
        setModeTouched(true); setSelectionMode(mode);
        if (mode === 'AI' && effectivePlanning?.config.suiteBlueprint) {
            const { suiteBlueprint: _blueprint, ...config } = effectivePlanning.config;
            setConfigDraft({ ...config, mainCount: config.mainCount || config.detailCount || effectivePlanning.skus.some(sku => sku.included) ? config.mainCount : 1 });
        }
    };
    const [selected, setSelected] = useState<string[]>(stored);
    const [selectedSuiteShots, setSelectedSuiteShots] = useState<string[]>(storedSuiteShots);
    const [suitePickerOpen, setSuitePickerOpen] = useState(false);
    const [instruction, setInstruction] = useState(preparationDraft.instruction);
    const [activeJobId, setActiveJobId] = useState<string | undefined>(undefined);
    const [preparingInstruction, setPreparingInstruction] = useState(false);
    const preparingInstructionRef = useRef(false);
    const [savingCopyDescription, setSavingCopyDescription] = useState(false);
    const [handledCopywritingId, setHandledCopywritingId] = useState<string>();
    const [activeCopywritingJob, setActiveCopywritingJob] = useState<{
        id: string;
        target: SetupCopywritingTarget;
        requestVersion: number;
        editVersion: number;
        lifetime: number;
    } | undefined>(undefined);
    const [copyLanguage, setCopyLanguage] = useState(copyLanguageLabel(detail.copyLanguage));
    const [savedCopyLanguage, setSavedCopyLanguage] = useState(detail.copyLanguage ?? "");
    const [promptLanguage, setPromptLanguage] = useState<PromptLanguage>(detail.promptLanguage);
    const [platformTarget, setPlatformTarget] = useState<keyof typeof PLATFORM_LABEL | undefined>(detail.platformTargets[0]);
    const [targetMarket, setTargetMarket] = useState(detail.targetMarket ?? undefined);
    const [defaultMode, setDefaultMode] = useState(detail.defaultMode);
    const [reasoningKeyDraft, setReasoningKeyDraft] = useState(modelKey(detail.reasoningProviderId, detail.reasoningModelId));
    const [imageKeyDraft, setImageKeyDraft] = useState(modelKey(detail.imageProviderId, detail.imageModelId));
    const [imageResolution, setImageResolution] = useState(detail.imageResolution);
    const [imageAspectRatio, setImageAspectRatio] = useState(detail.imageAspectRatio);
    const [candidatesPerType, setCandidatesPerType] = useState(detail.candidatesPerType);
    const totals = effectivePlanning ? productImagePlanningTotals(effectivePlanning, candidatesPerType) : null;
    useEffect(() => {
        saveProjectPlanningDraft(detail.id, { selectionMode, requestedTypes: selected, requestedSuiteShots: selectedSuiteShots, instruction, styleInstruction });
    }, [detail.id, selectionMode, selected, selectedSuiteShots, instruction, styleInstruction]);
    const candidateRef = useRef(detail.candidatesPerType);
    const candidatePending = useRef(false);
    const writes = writesFor(useQueryClient(), detail.id);
    const markEdit = (field: ProjectField) => { writes.intents.set(field, Symbol()); };
    const handledCopywritingJobs = useRef(new Set<string>());
    const copywritingLifetime = useRef(0);
    const copywritingRequests = useRef(0);
    const copyTargets = useRef({
        PRODUCT_DESCRIPTION: { version: 0, value: description },
        PLANNING_INSTRUCTION: { version: 0, value: instruction },
    });
    const descriptionDirty = useRef(false);
    useEffect(() => {
        copywritingLifetime.current++;
        return () => { copywritingLifetime.current++; };
    }, []);
    const changeCopyText = (target: SetupCopywritingTarget, value: string) => {
        const draft = copyTargets.current[target];
        draft.version++;
        draft.value = value;
        if (target === "PRODUCT_DESCRIPTION") {
            descriptionDirty.current = true;
            setDescription(value);
        }
        else {
            setInstruction(value);
        }
    };
    useEffect(() => setName(detail.name), [detail.name]);
    useEffect(() => {
        const value = detail.productDescription ?? "";
        // 较早一次保存触发的重查不能覆盖用户随后输入的草稿。
        if (!descriptionDirty.current && copyTargets.current.PRODUCT_DESCRIPTION.value !== value) {
            changeCopyText("PRODUCT_DESCRIPTION", value);
            descriptionDirty.current = false;
        }
    }, [detail.productDescription]);
    const factsDirty = useRef(false);
    const claimsDirty = useRef(false);
    useEffect(() => { if (!factsDirty.current) setFacts(toLines(detail.verifiedFacts)); }, [detail.verifiedFacts]);
    useEffect(() => { if (!claimsDirty.current) setClaims(toLines(detail.prohibitedClaims)); }, [detail.prohibitedClaims]);
    useEffect(() => {
        const next = detail.copyLanguage ?? "";
        setCopyLanguage(copyLanguageLabel(next));
        setSavedCopyLanguage(next);
    }, [detail.copyLanguage]);
    useEffect(() => setPromptLanguage(detail.promptLanguage), [detail.promptLanguage]);
    useEffect(() => setPlatformTarget(detail.platformTargets[0]), [detail.platformTargets]);
    useEffect(() => setTargetMarket(detail.targetMarket ?? undefined), [detail.targetMarket]);
    useEffect(() => setDefaultMode(detail.defaultMode), [detail.defaultMode]);
    useEffect(() => setReasoningKeyDraft(modelKey(detail.reasoningProviderId, detail.reasoningModelId)), [detail.reasoningProviderId, detail.reasoningModelId]);
    useEffect(() => setImageKeyDraft(modelKey(detail.imageProviderId, detail.imageModelId)), [detail.imageProviderId, detail.imageModelId]);
    useEffect(() => setImageResolution(detail.imageResolution), [detail.imageResolution]);
    useEffect(() => setImageAspectRatio(detail.imageAspectRatio), [detail.imageAspectRatio]);
    useEffect(() => {
        if (candidatePending.current)
            return;
        candidateRef.current = detail.candidatesPerType;
        setCandidatesPerType(detail.candidatesPerType);
    }, [detail.candidatesPerType]);
    const save = async (body: UpdateProjectInput, failureTitle: string, shouldSave?: () => boolean, rollback?: () => void) => {
        const lifetime = copywritingLifetime.current;
        const fields = Object.keys(body) as ProjectField[];
        // 自动写入借用当前用户意图，不能先撤销用户保存、再因组件卸载而放弃自身。
        const intents = new Map(fields.map(field => {
            if (!shouldSave)
                markEdit(field);
            return [field, writes.intents.get(field)] as const;
        }));
        const isCurrent = (field: ProjectField) => writes.intents.get(field) === intents.get(field);
        const pending = writes.tail.catch(() => undefined).then(async () => {
            if (shouldSave && !shouldSave())
                return false;
            // 较新访问可以撤销同一字段尚未发出的旧写入，但不能丢弃其他字段。
            const current = Object.fromEntries(fields.filter(isCurrent).map(field => [field, body[field]])) as UpdateProjectInput;
            if (Object.keys(current).length === 0)
                return false;
            try {
                await updateProject.mutateAsync(current);
                return true;
            }
            catch (error) {
                if (copywritingLifetime.current === lifetime && fields.every(isCurrent)) {
                    rollback?.();
                    notification.error({ title: failureTitle, description: errorText(error) });
                }
                return false;
            }
        });
        // 等待响应也涵盖提交前延迟；后续访问不能在旧提交完成前先落库。
        writes.tail = pending;
        return pending;
    };
    const saveDescription = async (value: string, failureTitle: string, shouldSave?: () => boolean) => {
        const version = copyTargets.current.PRODUCT_DESCRIPTION.version;
        const lifetime = copywritingLifetime.current;
        const saved = await save({ productDescription: value || null }, failureTitle, shouldSave);
        if (saved && copywritingLifetime.current === lifetime && copyTargets.current.PRODUCT_DESCRIPTION.version === version)
            descriptionDirty.current = false;
        return saved;
    };
    const saveOptimistic = async <T,>(next: T, setValue: (value: T) => void, previous: T, body: UpdateProjectInput, failureTitle: string) => {
        setValue(next);
        await save(body, failureTitle, undefined, () => setValue(previous));
    };
    const changeCandidates = (delta: number) => {
        const next = Math.min(4, Math.max(1, candidateRef.current + delta));
        if (next === candidateRef.current)
            return;
        candidateRef.current = next;
        candidatePending.current = true;
        setCandidatesPerType(next);
        const lifetime = copywritingLifetime.current;
        const pending = save({ candidatesPerType: next }, "保存出图数失败", undefined, () => {
            candidateRef.current = detail.candidatesPerType;
            setCandidatesPerType(detail.candidatesPerType);
        });
        const intent = writes.intents.get("candidatesPerType");
        void pending.then(() => {
            if (copywritingLifetime.current === lifetime && writes.intents.get("candidatesPerType") === intent)
                candidatePending.current = false;
        });
    };
    const commitName = async () => {
        const trimmed = name.trim();
        if (!trimmed || trimmed === detail.name) {
            setName(detail.name);
            return;
        }
        await save({ name: trimmed }, "保存名称失败");
    };
    const commitCopyLanguage = (value: string) => {
        const next = resolveCopyLanguage(value);
        setCopyLanguage(copyLanguageLabel(next));
        if (next === savedCopyLanguage)
            return;
        setSavedCopyLanguage(next);
        void save({ copyLanguage: next || null }, "保存文案语种失败");
    };
    const seedJob = latestPlanJob(detail.jobs);
    const liveJob = useJob(detail.id, activeJobId ?? seedJob?.id);
    const job = liveJob.data ?? seedJob;
    const planning = isActiveJob(job) || job?.status === "UNKNOWN";
    const productCount = detail.assets.filter((asset) => asset.role === "PRODUCT_TRUTH" && asset.mimeType.startsWith("image/")).length;
    const pixelProtectionUnavailable = defaultMode === "PIXEL_PROTECTED" && productCount === 0;
    const copywritingJobQuery = useJob(detail.id, activeCopywritingJob?.id);
    const copywritingJob = copywritingJobQuery.data;
    const copywritingResult = useCopywritingResult(activeCopywritingJob?.id, copywritingJob?.status === "SUCCEEDED");
    const reasoningOptions = modelOptions(providers.data?.items ?? [], "reasoning");
    const imageOptions = modelOptions(providers.data?.items ?? [], "image");
    const reasoningKey = reasoningKeyDraft;
    const imageKey = imageKeyDraft;
    const webResearchAvailable = health.data?.webResearchAvailable === true;
    const configuredReasoningModel = providers.data?.items
        .find((provider) => provider.id === detail.reasoningProviderId)
        ?.models.find((model) => model.id === detail.reasoningModelId);
    const copywritingUnavailableReason = productCount === 0
        ? "请先上传至少一张产品图"
        : providers.data && !configuredReasoningModel
            ? "推理模型未配置或已失效，请在下方重新选择"
            : configuredReasoningModel && !configuredReasoningModel.supportsVision
                ? "当前推理模型不支持图片识别"
                : undefined;
    const copywritingActive = createCopywriting.isPending || (Boolean(activeCopywritingJob) && !copywritingJob) || copywritingJob?.status === "QUEUED" || copywritingJob?.status === "RUNNING";
    const descriptionResultPending = activeCopywritingJob?.target === "PRODUCT_DESCRIPTION" && copywritingJob?.status === "SUCCEEDED" && !copywritingResult.isError && handledCopywritingId !== activeCopywritingJob.id;
    const existingDescriptionJob = detail.jobs.some(job => job.projectId === detail.id && !job.history && job.type === "COPYWRITE" && job.copywritingTarget === "PRODUCT_DESCRIPTION" && (job.status === "QUEUED" || job.status === "RUNNING"));
    const instructionBlocked = copywritingActive || existingDescriptionJob || descriptionResultPending || savingCopyDescription || preparingInstruction;
    const splitKey = (value: string) => {
        const [providerId, modelId] = value.split("::");
        return { providerId: providerId!, modelId: modelId! };
    };
    const startCopywriting = async (target: SetupCopywritingTarget) => {
        if (copywritingUnavailableReason) {
            notification.warning({ title: copywritingUnavailableReason });
            return;
        }
        if (preparingInstructionRef.current || (target === "PLANNING_INSTRUCTION" && instructionBlocked)) return;
        const lifetime = copywritingLifetime.current;
        if (target === "PLANNING_INSTRUCTION") {
            preparingInstructionRef.current = true;
            setPreparingInstruction(true);
            try {
                await writes.tail;
                if (copywritingLifetime.current !== lifetime) return;
                if (descriptionDirty.current) {
                    const saved = await saveDescription(copyTargets.current.PRODUCT_DESCRIPTION.value.trim(), "保存描述失败");
                    if (!saved || descriptionDirty.current || copywritingLifetime.current !== lifetime) return;
                }
            } finally {
                preparingInstructionRef.current = false;
                if (copywritingLifetime.current === lifetime) setPreparingInstruction(false);
            }
        }
        const requestVersion = ++copywritingRequests.current;
        const editVersion = copyTargets.current[target].version;
        setActiveCopywritingJob(undefined);
        try {
            const created = await createCopywriting.mutateAsync({ target, regenerationKey: randomUuid() });
            if (copywritingLifetime.current === lifetime && copywritingRequests.current === requestVersion)
                setActiveCopywritingJob({ id: created.id, target, requestVersion, editVersion, lifetime });
        }
        catch (error) {
            if (copywritingLifetime.current === lifetime && copywritingRequests.current === requestVersion)
                notification.error({ title: "AI 帮写提交失败", description: errorText(error) });
        }
    };
    const canAdoptCopywriting = (request: NonNullable<typeof activeCopywritingJob>) =>
        copywritingLifetime.current === request.lifetime &&
        copywritingRequests.current === request.requestVersion &&
        copyTargets.current[request.target].version === request.editVersion;
    useEffect(() => {
        if (!copywritingResult.data || !activeCopywritingJob || handledCopywritingJobs.current.has(activeCopywritingJob.id))
            return;
        handledCopywritingJobs.current.add(activeCopywritingJob.id);
        setHandledCopywritingId(activeCopywritingJob.id);
        if (copywritingResult.data.jobId !== activeCopywritingJob.id || copywritingResult.data.projectId !== detail.id ||
            copywritingResult.data.target !== activeCopywritingJob.target || !canAdoptCopywriting(activeCopywritingJob))
            return;
        const { target } = activeCopywritingJob;
        changeCopyText(target, copywritingResult.data.content);
        if (target === "PRODUCT_DESCRIPTION") {
            // 排队期间也可能继续编辑或提交下一轮帮写，实际写入前再次检查。
            const adoptedRequest = { ...activeCopywritingJob, editVersion: copyTargets.current[target].version };
            setSavingCopyDescription(true);
            void saveDescription(copywritingResult.data.content, "保存 AI 商品描述失败", () => canAdoptCopywriting(adoptedRequest)).finally(() => {
                if (copywritingLifetime.current === adoptedRequest.lifetime) setSavingCopyDescription(false);
            });
        }
    }, [activeCopywritingJob, copywritingResult.data]);
    useEffect(() => {
        if (!copywritingJob || copywritingJob.status !== "FAILED" || handledCopywritingJobs.current.has(copywritingJob.id))
            return;
        handledCopywritingJobs.current.add(copywritingJob.id);
        notification.error({ title: "AI 帮写失败", description: jobErrorText(copywritingJob) ?? "生成服务未返回文案" });
    }, [copywritingJob, notification]);
    const persistCounts = async () => {
        if (!planningDirectory) throw new Error('图片需求尚未读取，请稍后重试');
        if (!configDraft) return planningDirectory;
        const result = await savePlanning.mutateAsync({ expectedRevision: planningDirectory.revision, config: configDraft, skus: planningDirectory.skus, imageGroups: planningDirectory.imageGroups });
        setConfigDraft(null);
        return result.planning;
    };
    const flush = (): Promise<boolean> => {
        if (flushRef.current) return flushRef.current;
        const pending = (async () => {
            if (skuDirty) {
                notification.warning({ title: '请先保存或取消 SKU 修改' });
                return false;
            }
            const body: UpdateProjectInput = {};
            if (name.trim() && name.trim() !== detail.name) body.name = name.trim();
            if (descriptionDirty.current || description.trim() !== (detail.productDescription ?? '')) body.productDescription = description.trim() || null;
            if (facts !== toLines(detail.verifiedFacts)) body.verifiedFacts = splitLines(facts);
            if (claims !== toLines(detail.prohibitedClaims)) body.prohibitedClaims = splitLines(claims);
            const language = resolveCopyLanguage(copyLanguage);
            if (language !== (detail.copyLanguage ?? '')) body.copyLanguage = language || null;
            if (await writes.tail === false) {
                // 本次提交不能越过失败的保存；下一次明确提交可使用已回滚的界面配置。
                writes.tail = Promise.resolve();
                notification.warning({ title: '制作配置尚未保存', description: '请检查当前配置后重新提交规划。' });
                return false;
            }
            if (Object.keys(body).length && !await save(body, '制作配置未保存')) return false;
            try {
                savedPlanningRef.current = await persistCounts();
                saveProjectPlanningDraft(detail.id, { selectionMode, requestedTypes: selected, requestedSuiteShots: selectedSuiteShots, instruction, styleInstruction });
                return true;
            } catch (error) {
                notification.error({ title: '图片需求未保存', description: errorText(error) });
                return false;
            }
        })();
        flushRef.current = pending;
        void pending.finally(() => { flushRef.current = null; });
        return pending;
    };
    useImperativeHandle(ref, () => ({ flush }));
    const submitPlan = async () => {
        if (submittingRef.current || planning || skuOpen) return;
        if (pixelProtectionUnavailable) { notification.error({ title: '请先上传至少一张产品图' }); return; }
        if (selectionMode === 'SUITE' && !effectivePlanning?.config.suiteBlueprint?.shots.length) { notification.error({ title: '请选择包含镜头的套图' }); return; }
        if (!totals?.frameCount || totals.frameCount > MAX_PRODUCT_IMAGE_TARGETS) { notification.error({ title: `请配置 1–${MAX_PRODUCT_IMAGE_TARGETS} 个画面` }); return; }
        submittingRef.current = true;
        setSubmitting(true);
        try {
            if (!await flush()) return;
            const current = savedPlanningRef.current;
            if (!current) throw new Error('图片需求读取失败');
            const strategy = { planningMode: 'AI' as const };
            const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([current.revision, 'ALL', instruction.trim(), styleInstruction.trim(), strategy])));
            const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
            const previous = readPlanningIntent(detail.id);
            const regenerationKey = previous?.fingerprint === fingerprint ? previous.regenerationKey : randomUuid();
            keepPlanningIntent(detail.id, { fingerprint, regenerationKey, instruction });
            const created = await createPlan.mutateAsync({
                expectedRevision: current.revision,
                scope: 'ALL',
                ...strategy,
                userInstruction: instruction.trim() || undefined,
                ...(selectionMode === 'AI' && styleInstruction.trim() ? { styleInstruction: styleInstruction.trim() } : {}),
                regenerationKey,
            });
            clearPlanningIntent(detail.id, regenerationKey);
            if (selected.length) saveImageTypes(detail.id, selected);
            if (selectedSuiteShots.length) saveSuiteShots(detail.id, selectedSuiteShots);
            setActiveJobId(created.id);
            if (created.reused) notification.info({ title: '已使用已有规划', description: '当前配置与已有规划相同，已复用任务。' });
            onPlanned?.();
        } catch (error) {
            notification.error({ title: '规划提交失败', description: errorText(error) });
        } finally {
            submittingRef.current = false;
            setSubmitting(false);
        }
    };
    const applySnapshot = async (snapshotId: string) => {
        if (!await flush()) return;
        const lifetime = copywritingLifetime.current;
        const descriptionVersion = ++copyTargets.current.PRODUCT_DESCRIPTION.version;
        const instructionVersion = ++copyTargets.current.PLANNING_INSTRUCTION.version;
        try {
            const { snapshot } = await applyPlanningSnapshot.mutateAsync(snapshotId);
            if (copywritingLifetime.current !== lifetime)
                return;
            const { project, planning } = snapshot.payload;
            setName(project.name);
            if (copyTargets.current.PRODUCT_DESCRIPTION.version === descriptionVersion) {
                changeCopyText("PRODUCT_DESCRIPTION", project.productDescription ?? "");
                descriptionDirty.current = false;
            }
            setFacts(toLines(project.verifiedFacts));
            setClaims(toLines(project.prohibitedClaims));
            setCopyLanguage(copyLanguageLabel(project.copyLanguage));
            setSavedCopyLanguage(project.copyLanguage ?? "");
            setPromptLanguage(project.promptLanguage ?? "CHINESE");
            setPlatformTarget(project.platformTargets[0]);
            setTargetMarket(project.targetMarket ?? undefined);
            setDefaultMode(project.defaultMode);
            setReasoningKeyDraft(modelKey(project.reasoningProviderId, project.reasoningModelId));
            setImageKeyDraft(modelKey(project.imageProviderId, project.imageModelId));
            setImageResolution(project.imageResolution);
            setImageAspectRatio(project.imageAspectRatio);
            candidateRef.current = project.candidatesPerType;
            setCandidatesPerType(project.candidatesPerType);
            const snapshotShots = planning.requestedSuiteShots ?? [];
            setSelectionMode(effectivePlanning?.config.suiteBlueprint ? "SUITE" : "AI");
            setSelected(planning.requestedTypes);
            setSelectedSuiteShots(snapshotShots);
            if (copyTargets.current.PLANNING_INSTRUCTION.version === instructionVersion)
                changeCopyText("PLANNING_INSTRUCTION", planning.userInstruction ?? "");
            if (planning.requestedTypes.length > 0)
                saveImageTypes(detail.id, planning.requestedTypes);
            if (snapshotShots.length > 0)
                saveSuiteShots(detail.id, snapshotShots);
            notification.success({ title: "已套用最近配置", description: "图片数量与 SKU 以当前图片需求为准。" });
        }
        catch (error) {
            notification.error({ title: "套用配置失败", description: errorText(error) });
        }
    };
    const footer = <div className={styles.preparationFooter}>
      <div><strong>{totals ? `${totals.frameCount} 个画面 · 每画面 ${candidatesPerType} 个候选 · 预计 ${totals.candidateCount} 张` : '正在读取图片需求'}</strong><p>{productCount ? `商品图已就绪 · ${productCount} 张` : '请先上传商品图'} · {submitting || updateProject.isPending || savePlanning.isPending ? '正在保存配置' : '配置将于规划前保存'}</p>
        {(job?.status === 'FAILED' || job?.status === 'UNKNOWN') && jobErrorText(job) ? <p className={styles.jobError}>{jobErrorText(job)}</p> : null}
        {planning ? <p>{job?.status === 'UNKNOWN' ? '任务结果待确认，请在任务记录中处理' : '正在规划画面…'}</p> : null}
      </div>
      <div className={styles.preparationFooterActions}>
        {canResubmitPlan(job) && job?.status === 'FAILED' ? <Button disabled={pixelProtectionUnavailable || submitting} loading={retryJob.isPending} onClick={() => job && void flush().then(async saved => { if (!saved) return; const next = await retryJob.mutateAsync(job.id); setActiveJobId(next.id); onPlanned?.(); }).catch(error => notification.error({ title: '重试规划失败', description: errorText(error) }))}>重试规划</Button> : null}
        <Button type="primary" size="large" disabled={pixelProtectionUnavailable || skuOpen || planningQuery.isPending || planningQuery.isError || planning || !totals?.frameCount || totals.frameCount > MAX_PRODUCT_IMAGE_TARGETS} loading={submitting} onClick={() => void submitPlan()}>AI 一键规划 →</Button>
      </div>
    </div>;
    return (<div className={`${styles.setup} ${styles.preparationSetup}`}>
      <header className={styles.preparationConfigHeader}><h2>制作配置</h2></header>
      <div className={styles.preparationConfigBody} inert={submitting}>
      <section className={styles.preparationProduct}><h3>商品信息</h3>
      <label className={styles.fieldLabel}>商品名称
      <Input aria-label="项目名称" className={styles.nameInput} value={name} maxLength={80} onChange={(event) => { markEdit("name"); setName(event.target.value); }} onBlur={() => void commitName()}/>
      </label>
        <label className={styles.fieldLabel}>
          创作目标
          <div className={styles.aiTextArea}>
            <Input.TextArea aria-label="商品描述" rows={3} maxLength={400} value={description} placeholder="描述产品特点、目标人群和使用场景；具体可宣称参数请填写在下方。" onChange={(event) => { markEdit("productDescription"); changeCopyText("PRODUCT_DESCRIPTION", event.target.value); }} onBlur={() => {
            const next = description.trim();
            if (next === (detail.productDescription ?? "") && !descriptionDirty.current)
                return;
            void saveDescription(next, "保存描述失败");
        }}/>
            <AiWriteButton label="AI 帮写商品描述" disabled={Boolean(copywritingUnavailableReason) || copywritingActive || preparingInstruction} loading={copywritingActive && activeCopywritingJob?.target === "PRODUCT_DESCRIPTION"} reason={copywritingUnavailableReason} onClick={() => void startCopywriting("PRODUCT_DESCRIPTION")}/>
          </div>
        </label>
      </section>
      {copywritingJob?.status === 'SUCCEEDED' && copywritingResult.isError ? <p role="alert" className={styles.jobError}>帮写已完成，但读取结果失败。原内容已保留。<Button size="small" loading={copywritingResult.isFetching} onClick={() => void copywritingResult.refetch()}>重新读取帮写结果</Button></p> : null}
      <section className={styles.preparationDemand}><h3>图片需求</h3>
        {effectivePlanning ? <>
          <div className={styles.preparationCounts}>
            <label className={styles.fieldLabel}>主图<InputNumber aria-label="主图数量" min={0} max={12} precision={0} value={effectivePlanning.config.mainCount} disabled={Boolean(effectivePlanning.config.suiteBlueprint)} onChange={value => { if (value !== null) setConfigDraft({ ...effectivePlanning.config, mainCount: value }); }}/></label>
            <label className={styles.fieldLabel}>SKU 图<InputNumber aria-label="SKU 图片数量" value={totals?.skuImageCount ?? 0} readOnly controls={false}/></label>
            <label className={styles.fieldLabel}>详情图<InputNumber aria-label="详情图数量" min={0} max={24} precision={0} value={effectivePlanning.config.detailCount} disabled={Boolean(effectivePlanning.config.suiteBlueprint)} onChange={value => { if (value !== null) setConfigDraft({ ...effectivePlanning.config, detailCount: value }); }}/></label>
          </div>
          {effectivePlanning.config.suiteBlueprint ? <p>套图数量由下方镜头清单决定，请在“生成策略”中编辑镜头。</p> : null}
          <div className={styles.preparationSku}><strong>SKU</strong><span>{totals?.skuCount ?? 0} 个规格 · {totals?.groupCount ?? 0} 组图片</span><Button size="small" loading={savePlanning.isPending} onClick={() => void flush().then(saved => { if (saved) setSkuOpen(true); })}>管理 SKU</Button></div>
          {totals && totals.frameCount > MAX_PRODUCT_IMAGE_TARGETS ? <p className={styles.jobError}>总画面不能超过 {MAX_PRODUCT_IMAGE_TARGETS} 个，请调整数量或 SKU。</p> : null}
        </> : <p>{planningQuery.isError ? '图片需求读取失败' : '正在读取图片需求…'}{planningQuery.isError ? <Button size="small" onClick={() => void planningQuery.refetch()}>重试读取</Button> : null}</p>}
      </section>
      <div className={styles.preparationQuickConfig}>
          <label className={styles.fieldLabel}>
            <span className={styles.fieldLabelTitle}><Store size={13} strokeWidth={1.75} aria-hidden/>目标平台</span>
            <Select aria-label="目标平台" allowClear placeholder="请选择目标平台" value={platformTarget} options={(Object.entries(PLATFORM_LABEL) as Array<[
        keyof typeof PLATFORM_LABEL,
        string
    ]>).map(([value, label]) => ({ value, label }))} onChange={(value: keyof typeof PLATFORM_LABEL | undefined) => void saveOptimistic<keyof typeof PLATFORM_LABEL | undefined>(value, setPlatformTarget, platformTarget, { platformTargets: value ? [value] : [] }, "保存平台失败")}/>
          </label>          <label className={styles.fieldLabel}>
            <span className={styles.fieldLabelTitle}><Languages size={13} strokeWidth={1.75} aria-hidden/>文案语种</span>
            <AutoComplete aria-label="文案语种" allowClear value={copyLanguage || undefined} options={COPY_LANGUAGE_AUTOCOMPLETE_OPTIONS} placeholder="请选择或输入文案语种" filterOption={(input, option) => copyLanguageOptionMatches(input, String(option?.value ?? ""))} onChange={(value) => setCopyLanguage(value)} onSelect={(value) => commitCopyLanguage(value)} onBlur={() => commitCopyLanguage(copyLanguage)} onClear={() => commitCopyLanguage("")}/>
          </label>          <label className={styles.fieldLabel}>
            图片比例
            <Select aria-label="图片比例" value={imageAspectRatio} options={ASPECT_SELECT_OPTIONS} optionRender={renderAspectOption} onChange={(value) => void saveOptimistic(value, setImageAspectRatio, imageAspectRatio, { imageAspectRatio: value }, "保存比例失败")}/>
          </label>
      </div>
      <Section title="生成策略" icon={<Layers3 size={14} strokeWidth={1.75} aria-hidden/>}>
        <div className={styles.kindToggle} role="group" aria-label="规划方式">
          <button type="button" data-active={selectionMode === 'AI'} onClick={() => selectMode('AI')}>模型自主规划</button>
          <button type="button" data-active={selectionMode === 'SUITE'} onClick={() => selectMode('SUITE')}>套图批量规划</button>
        </div>
        {selectionMode === 'SUITE' ? <>
          <Button loading={blueprintRequest.isPending} onClick={() => { setPickingStyle(false); setSuitePickerOpen(true); }}>选择套图</Button>
          {effectivePlanning?.config.suiteBlueprint ? <SuiteBlueprintEditor value={effectivePlanning.config.suiteBlueprint} onChange={setBlueprint}/> : <p>选择完整套图，画面数量由镜头清单决定。</p>}
        </> : <>
          <p className={styles.hint}>模型根据商品图、参考图和数量自主安排画面，每个画面使用一份提示词。</p>
          <Button onClick={() => { setPickingStyle(true); setSuitePickerOpen(true); }}>借用套图风格</Button>
          <Input.TextArea aria-label="风格指导" value={styleInstruction} onChange={event => setStyleInstruction(event.target.value)} placeholder="可选：输入风格指导"/>
        </>}
        <div className={styles.aiTextArea}>
          <Input.TextArea aria-label="补充说明" value={instruction} maxLength={4000} rows={3} placeholder="补充画面限制、构图偏好或不要出现的内容（可选）" onChange={(event) => changeCopyText("PLANNING_INSTRUCTION", event.target.value)}/>
          <AiWriteButton label="AI 帮写补充说明" disabled={Boolean(copywritingUnavailableReason) || instructionBlocked} loading={copywritingActive && activeCopywritingJob?.target === "PLANNING_INSTRUCTION"} reason={copywritingUnavailableReason ?? (existingDescriptionJob || descriptionResultPending || savingCopyDescription ? "请等待创作目标帮写及保存完成" : undefined)} onClick={() => void startCopywriting("PLANNING_INSTRUCTION")}/>
        </div>
      </Section>

      <Section title="商品事实与限制" defaultOpen={false} icon={<Sparkles size={14} strokeWidth={1.75} aria-hidden/>}>

        <label className={styles.fieldLabel}>
          已核验事实（每行一条）
          <Input.TextArea aria-label="已核验事实" rows={3} value={facts} placeholder="每行一条，例如：续航 8 小时" onChange={(event) => { factsDirty.current = true; markEdit("verifiedFacts"); setFacts(event.target.value); }} onBlur={() => {
            if (facts === toLines(detail.verifiedFacts)) { factsDirty.current = false; return; }
            const pending = save({ verifiedFacts: splitLines(facts) }, "保存事实失败");
            const token = writes.intents.get('verifiedFacts');
            void pending.then(saved => { if (saved && writes.intents.get('verifiedFacts') === token) factsDirty.current = false; });
        }}/>
        </label>
        <label className={styles.fieldLabel}>
          禁止宣称（每行一条）
          <Input.TextArea aria-label="禁止宣称" rows={2} value={claims} placeholder="每行一条，例如：医用级" onChange={(event) => { claimsDirty.current = true; markEdit("prohibitedClaims"); setClaims(event.target.value); }} onBlur={() => {
            if (claims === toLines(detail.prohibitedClaims)) { claimsDirty.current = false; return; }
            const pending = save({ prohibitedClaims: splitLines(claims) }, "保存禁止宣称失败");
            const token = writes.intents.get('prohibitedClaims');
            void pending.then(saved => { if (saved && writes.intents.get('prohibitedClaims') === token) claimsDirty.current = false; });
        }}/>
        </label>
      </Section>


      <Section title="高级设置" defaultOpen={false} icon={<SlidersHorizontal size={14} aria-hidden/>}>
      <Section title="市场与创作" icon={<Globe2 size={14} strokeWidth={1.75} aria-hidden/>}>
        <div className={styles.compactFields}>

          <label className={styles.fieldLabel}>
            <span className={styles.fieldLabelTitle}><MapPin size={13} strokeWidth={1.75} aria-hidden/>目标市场</span>
            <Select aria-label="目标市场" allowClear showSearch optionFilterProp="label" placeholder="请选择目标市场" value={targetMarket} options={MARKET_OPTIONS} onChange={(value: Exclude<TargetMarket, null> | undefined) => void saveOptimistic(value, setTargetMarket, targetMarket, { targetMarket: value ?? null }, "保存目标市场失败")}/>
          </label>

          <label className={styles.fieldLabel}>
            <span className={styles.fieldLabelTitle}><Type size={13} strokeWidth={1.75} aria-hidden/>提示词语种</span>
            <Select aria-label="提示词语种" value={promptLanguage} options={[
            { value: "CHINESE", label: "中文提示词" },
            { value: "ENGLISH", label: "英文提示词" },
        ]} onChange={(value: PromptLanguage) => void saveOptimistic(value, setPromptLanguage, promptLanguage, { promptLanguage: value }, "保存提示词语种失败")}/>
          </label>
          <label className={styles.fieldLabel}>
            <span className={styles.fieldLabelTitle}><Sparkles size={13} strokeWidth={1.75} aria-hidden/>默认模式</span>
            <Select aria-label="默认模式" value={defaultMode} options={[
            { value: "CREATIVE", label: "创意模式 · 允许场景创作" },
            { value: "PIXEL_PROTECTED", label: "像素保护 · 保留主体像素" },
        ]} onChange={(value) => void saveOptimistic(value, setDefaultMode, defaultMode, { defaultMode: value }, "保存模式失败")}/>
          </label>
        </div>
      </Section>

      <ManageModelsButton/>
      <Section title="出图参数" icon={<SlidersHorizontal size={14} strokeWidth={1.75} aria-hidden/>}>
        <div className={styles.paramGrid}>
          <label className={styles.fieldLabel}>
            推理模型
            <Select aria-label="推理模型" value={reasoningOptions.some((item) => item.value === reasoningKey) ? reasoningKey : undefined} options={reasoningOptions} placeholder="选择推理模型" onChange={(value) => void saveOptimistic(value, setReasoningKeyDraft, reasoningKeyDraft, { reasoningModel: splitKey(value) }, "保存推理模型失败")}/>
          </label>
          <label className={styles.fieldLabel}>
            生图模型
            <Select aria-label="生图模型" value={imageOptions.some((item) => item.value === imageKey) ? imageKey : undefined} options={imageOptions} placeholder="选择生图模型" onChange={(value) => void saveOptimistic(value, setImageKeyDraft, imageKeyDraft, { imageModel: splitKey(value) }, "保存生图模型失败")}/>
          </label>
          <label className={styles.fieldLabel}>
            分辨率
            <Select aria-label="分辨率" value={imageResolution} options={Object.entries(RESOLUTION_LABEL).map(([value, label]) => ({ value, label }))} onChange={(value) => void saveOptimistic(value, setImageResolution, imageResolution, { imageResolution: value }, "保存分辨率失败")}/>
          </label>

        </div>
        <div className={styles.stepper}>
          <span>每类型出图数</span>
          <button type="button" aria-label="减少出图数" disabled={candidatesPerType <= 1} onClick={() => changeCandidates(-1)}>
            −
          </button>
          <strong>{candidatesPerType}</strong>
          <button type="button" aria-label="增加出图数" disabled={candidatesPerType >= 4} onClick={() => changeCandidates(1)}>
            +
          </button>
        </div>
      </Section>

        <div className={styles.researchControl}>
          <div>
            <span className={styles.researchLabel}><Globe2 size={14} strokeWidth={1.75} aria-hidden/> 联网视觉研究</span>
            <p className={styles.researchHint}>仅检索近期构图、光线、材质表现和平台版式；不会搜索或补充商品事实。</p>
          </div>
          <Tooltip title={webResearchAvailable ? "搜索服务已配置，启用后本项目的分镜规划可使用视觉研究" : "服务端尚未配置搜索 API Key，暂不能开启"}>
            <Switch aria-label="联网视觉研究" checked={detail.webResearchEnabled} disabled={!webResearchAvailable || updateProject.isPending} onChange={(webResearchEnabled) => void save({ webResearchEnabled }, "保存联网视觉研究设置失败")}/>
          </Tooltip>
        </div>
        {detail.webResearchEnabled && !webResearchAvailable ? <p className={styles.researchUnavailable}>服务端未配置搜索服务，本次规划不会联网。</p> : null}

      </Section>
      <Popover open={snapshotPopoverOpen && businessActive} onOpenChange={setSnapshotPopoverOpen} placement="bottom" trigger="click" arrow={false} styles={{ container: snapshotPopoverStyle }} content={<div className={styles.snapshotList}>{planningSnapshots.data?.length ? planningSnapshots.data.map((snapshot) => {
                const aiMode = snapshot.payload.planning.planningMode === "AI";
                const imageCount = snapshot.payload.planning.targetImageCount ?? snapshot.payload.planning.requestedTypes.length;
                const platform = snapshot.payload.project.platformTargets[0] ? PLATFORM_LABEL[snapshot.payload.project.platformTargets[0]] ?? "—" : "—";
                const market = MARKET_OPTIONS.find((option) => option.value === snapshot.payload.project.targetMarket)?.label ?? "—";
                const mode = snapshot.payload.project.defaultMode === "PIXEL_PROTECTED" ? "像素保护" : "创意模式";
                return (<Tooltip key={snapshot.id} placement="right" arrow={false} mouseEnterDelay={0.3} title={<div className={styles.snapshotPreview}>
              <p className={styles.snapshotPreviewText}>{platform} · {market} · {mode} · {imageCount} 张</p>
              {snapshot.payload.project.productDescription ? <p className={styles.snapshotPreviewDesc}>{snapshot.payload.project.productDescription}</p> : null}
              {snapshot.payload.planning.userInstruction ? <p className={styles.snapshotPreviewText}>补充说明：{snapshot.payload.planning.userInstruction}</p> : null}
            </div>}>
              <button type="button" disabled={applyPlanningSnapshot.isPending} onClick={() => void applySnapshot(snapshot.id)}>
                <span className={styles.snapshotMain}>
                  <strong>{formatDateTime(snapshot.createdAt)}</strong>
                  <span className={styles.snapshotMode} data-ai={aiMode}>{aiMode ? "AI 规划" : "手动选择"}</span>
                </span>
                <span className={styles.snapshotCount}>{imageCount} 张</span>
              </button>
            </Tooltip>);
            }) : <p>生成分镜后会自动保留配置。</p>}</div>}>
        <Button className={styles.snapshotTrigger} size="small" icon={<History size={14} strokeWidth={1.75}/>}>历史配置</Button>
      </Popover>

      {defaultMode === 'PIXEL_PROTECTED' && productCount === 0 ? <p className={styles.banner}>像素保护需要至少一张产品图，否则生成会失败。</p> : null}
      </div>
      {footerContainer ? createPortal(footer, footerContainer) : footer}
      {planningDirectory ? <SkuManagerDrawer open={skuOpen} planning={planningDirectory} assets={detail.assets} saving={savePlanning.isPending} onDirtyChange={setSkuDirty} onSave={async input => { await savePlanning.mutateAsync(input); setConfigDraft(null); setSkuDirty(false); }} onClose={() => { setSkuOpen(false); setSkuDirty(false); }}/> : null}
      <SuitePickerDialog singleSuite open={suitePickerOpen} value={[]} onChange={shots => void chooseSuite(shots)} onClose={() => setSuitePickerOpen(false)}/>
    </div>);
});

function AiWriteButton({ label, disabled, loading, reason, onClick }: {
    label: string;
    disabled: boolean;
    loading: boolean;
    reason: string | undefined;
    onClick: () => void;
}) {
    const button = (<button type="button" className={styles.aiWriteButton} aria-label={label} disabled={disabled} onClick={onClick}>
      <WandSparkles size={14} strokeWidth={1.8} aria-hidden/>
      <span>{loading ? "生成中" : "AI 帮写"}</span>
    </button>);
    const wrapped = <span className={styles.aiWriteTooltip}>{button}</span>;
    return reason ? <Tooltip title={reason}>{wrapped}</Tooltip> : wrapped;
}
function Section({ title, icon, children, defaultOpen = true }: {
    title: string;
    defaultOpen?: boolean;
    icon: ReactNode;
    children: ReactNode;
}) {
    const [open, setOpen] = useState(defaultOpen);
    return (<section className={styles.section}>
      <button type="button" className={styles.sectionHead} aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <span className={styles.sectionHeadLabel}>
          <span className={styles.sectionTitleIcon}>{icon}</span>
          {title}
        </span>
        <ChevronDown size={14} strokeWidth={1.75} aria-hidden className={styles.sectionChevron} data-open={open}/>
      </button>
      <div className={styles.sectionBody} hidden={!open}>{children}</div>
    </section>);
}
