const messages: Record<string, string> = {
  REFERENCE_ASSET_REQUIRED: '请添加编辑所需的参考素材。',
  EDIT_TARGET_REQUIRED: '请说明或标记需要修改的区域。',
  OUTPAINT_CANVAS_REQUIRED: '请先设置需要扩展的画布范围。',
  EDIT_VISION_REQUIRED: '当前编辑需要支持图片理解的推理模型，请检查模型设置。',
  CAPABILITY_UNSUPPORTED: '当前图片模型不支持此编辑操作，请检查模型设置。',
  EDIT_PLAN_INVALID: '模型返回的编辑方案不符合要求，请重试。',
  EDIT_PLAN_EMPTY: '模型未返回编辑方案，请重试。',
  EDIT_PLAN_MASK_REQUIRED: '模型返回的编辑方案未遵守选区，请重试。',
  QUEUE_UNAVAILABLE: '任务已创建，但队列暂不可用，请稍后重试。',
};

/** 只公开受控代码和固定提示，不透传运行时或 Provider 的错误文本。 */
export function publicTaskError(error: unknown, status?: unknown): { code: string; message: string } | null {
  if (!error) return null;
  if (status === 'UNKNOWN') return { code: 'EXTERNAL_UNKNOWN', message: '任务已中断，可选择重试或结束。' };
  if (typeof error === 'object') {
    const row = error as Record<string, unknown>;
    for (const value of [row.code, row.message]) {
      if (typeof value !== 'string') continue;
      const code = value.match(/^([A-Z_]+)(?::|$)/)?.[1];
      if (code && Object.hasOwn(messages, code)) return { code, message: messages[code]! };
    }
  }
  return { code: 'TASK_ERROR', message: '任务未完成，请查看任务状态。' };
}
