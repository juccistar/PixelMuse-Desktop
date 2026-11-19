import { Type, type Static } from '@sinclair/typebox';
import { applicationUpdateOperations } from './application-updates.js';
export * from './application-updates.js';

const Empty = Type.Object({}, { additionalProperties: false });
/** 应用信息只公开版本和平台能力，不含目录、设备标识或凭据。 */
export const ApplicationInfoSchema = Type.Object({
  name: Type.String(), version: Type.String(), platform: Type.String(), arch: Type.String(),
  electronVersion: Type.String(), chromeVersion: Type.String(), nodeVersion: Type.String(),
  packaged: Type.Boolean(), notificationsSupported: Type.Boolean(),
}, { additionalProperties: false });
export type ApplicationInfo = Static<typeof ApplicationInfoSchema>;
/** 统计仅接受有界 CSV，实际路径始终由系统保存对话框提供。 */
export const UsageReportFileSchema = Type.Object({
  name: Type.String({ minLength: 5, maxLength: 160, pattern: '^[^\\\\/:*?"<>|\\x00-\\x1f]+\\.csv$' }),
  base64: Type.String({ minLength: 4, maxLength: 11184812, pattern: '^[A-Za-z0-9+/]*={0,2}$' }),
}, { additionalProperties: false });
/** 固定原生能力；禁止任意路径、MIME 或日志复制。 */
export const applicationOperations = {
  ...applicationUpdateOperations,
  info: { input: Empty, output: ApplicationInfoSchema },
  openDirectory: { input: Type.Object({ target: Type.Union([Type.Literal('applicationData'), Type.Literal('logs')]) }, { additionalProperties: false }), output: Type.Null() },
  exportDiagnostics: { input: Empty, output: Type.Object({ saved: Type.Boolean() }, { additionalProperties: false }) },
  saveUsageReport: { input: UsageReportFileSchema, output: Type.Object({ saved: Type.Boolean() }, { additionalProperties: false }) },
} as const;
export type ApplicationOperation = keyof typeof applicationOperations;
export type ApplicationInput<K extends ApplicationOperation> = Static<(typeof applicationOperations)[K]['input']>;
export type ApplicationOutput<K extends ApplicationOperation> = Static<(typeof applicationOperations)[K]['output']>;
