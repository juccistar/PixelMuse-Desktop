import { createHash } from "node:crypto";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model } from "@earendil-works/pi-ai";
import type { RequestEvidenceBinding } from "@ecomgen/providers";
import { ECOM_TEMPLATES_HASH } from "@ecomgen/ecom-skill";
import { boundedAgentStream } from "./stream.js";
import { withStructuredOutput, type StructuredOutputSchema } from "./structured-output.js";

export type AgentWorkflow = "PLAN" | "COPYWRITE" | "EDIT_PLAN" | "PROMPT_REVISION" | "LAYER_PLAN" | "SUITE_FORGE";
export type ReasoningModel = Model<"openai-completions" | "openai-responses">;

/** 复用 Provider 的绑定契约；每轮流在转交终态前等待自身回执。 */
export type AgentRequestEvidence = RequestEvidenceBinding;

/** 每次工作流独立传入取消、超时及 Backend 持久证据作用域。 */
export interface AgentRunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  thinkingLevel?: "auto" | "off" | "low" | "medium" | "high";
  maxOutputTokens?: number;
  external?: AgentRequestEvidence;
}

export interface AgentRuntimeOptions extends AgentRunOptions {
  workflow: AgentWorkflow;
  model: ReasoningModel;
  apiKey: string;
  systemPrompt: string;
  tools: AgentTool<any>[];
  outputSchema: StructuredOutputSchema;
}

function effectiveThinkingLevel(options: AgentRuntimeOptions): "off" | "low" | "medium" | "high" {
  if (!options.model.reasoning) return "off";
  return options.thinkingLevel && options.thinkingLevel !== "auto"
    ? options.thinkingLevel
    : options.workflow === "COPYWRITE" ? "low" : "medium";
}

export function promptVersion(options: AgentRuntimeOptions): string {
  const stableTools = options.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
  // 旧冻结任务没有 AI 参数；保留原会话身份，以便匹配已完成请求的指纹。
  const legacy = options.thinkingLevel === undefined && options.maxOutputTokens === undefined;
  return createHash("sha256").update(JSON.stringify({ systemPrompt: options.systemPrompt, tools: stableTools, outputSchema: options.outputSchema, skillHash: ECOM_TEMPLATES_HASH, api: options.model.api, provider: options.model.provider, ...(legacy ? {} : { thinkingLevel: effectiveThinkingLevel(options), maxOutputTokens: options.maxOutputTokens, timeoutMs: options.timeoutMs ?? 240_000 }) })).digest("hex").slice(0, 16);
}

/** 创建只使用显式凭据和模型配置的领域 Agent。 */
export function createAgent(options: AgentRuntimeOptions): Agent {
  const signal = options.external ? AbortSignal.any([options.external.scope.signal, ...(options.signal ? [options.signal] : [])]) : options.signal;
  signal?.throwIfAborted();
  const version = promptVersion(options);
  const sessionId = `ecomgen:${options.external?.scope.jobId ?? "standalone"}:${options.external?.requestKey ?? options.workflow}:${version}:${options.model.provider}:${options.model.id}`;
  return new Agent({
    streamFn: boundedAgentStream(signal, options.timeoutMs, options.external, options.maxOutputTokens),
    getApiKey: () => options.apiKey,
    sessionId,
    onPayload: (payload, model) => withStructuredOutput(payload, model as ReasoningModel, options.outputSchema),
    initialState: {
      model: options.model,
      systemPrompt: options.systemPrompt,
      // 自动模式对帮写使用 low，其余工作流使用 medium；不支持思考的模型始终关闭。
      thinkingLevel: effectiveThinkingLevel(options),
      tools: options.tools,
    },
  });
}

/** 等待真实模型和工具执行结束，取消时同时中止 Agent 内部运行。 */
export async function promptAgent(agent: Agent, control: AgentRunOptions, prompt: string, images?: ImageContent[]): Promise<void> {
  const signal = control.external ? AbortSignal.any([control.external.scope.signal, ...(control.signal ? [control.signal] : [])]) : control.signal;
  signal?.throwIfAborted();
  const abort = () => agent.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await agent.prompt(prompt, images);
    signal?.throwIfAborted();
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
