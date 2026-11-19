import { Value } from "@sinclair/typebox/value";
import { EcomSuiteFile, EcomSuiteShot, SuiteCategory, SuitePaletteColor, SuiteStyleLock } from "./suite-schemas.js";
import { ImageAspectRatio, ImageResolution, StoryboardShotRole } from "./enums.js";

const references = [EcomSuiteShot, SuiteCategory, SuitePaletteColor, SuiteStyleLock, ImageAspectRatio, ImageResolution, StoryboardShotRole];

export interface SuiteFileValidation {
  ok: boolean;
  errors: string[];
}

/**
 * 校验套图文档（内置 JSON、用户上传或目录投放）是否符合 EcomSuiteFile 契约。
 * 直接引用领域 schema，构建、导入与模型产出使用同一份规则。
 */
export function validateEcomSuiteFile(value: unknown): SuiteFileValidation {
  if (Value.Check(EcomSuiteFile, references, value)) return { ok: true, errors: [] };
  const errors = [...Value.Errors(EcomSuiteFile, references, value)].map((error) => `${error.path || "/"}: ${error.message}`);
  return { ok: false, errors };
}
