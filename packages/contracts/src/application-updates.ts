import { Type, type Static } from '@sinclair/typebox';

const object = { additionalProperties: false } as const;
const Empty = Type.Object({}, object);
const NullableText = Type.Union([Type.String({ maxLength: 32768 }), Type.Null()]);
/** 更新状态只公开版本、进度与固定提示，不返回下载路径或原始网络错误。 */
export const ApplicationUpdateStatusSchema = Type.Object({
  state: Type.Union(['UNSUPPORTED', 'IDLE', 'CHECKING', 'AVAILABLE', 'NOT_AVAILABLE', 'DOWNLOADING', 'DOWNLOADED', 'INSTALLING', 'ERROR'].map(value => Type.Literal(value))),
  currentVersion: Type.String(), availableVersion: NullableText,
  releaseNotes: Type.String({ maxLength: 32768 }), releaseDate: NullableText,
  checkedAt: NullableText, error: NullableText,
  supported: Type.Boolean(), unsupportedReason: NullableText,
  autoCheck: Type.Boolean(),
  releaseUrl: Type.Literal('https://github.com/juccistar/pixelmuse-releases/releases'),
  progress: Type.Union([Type.Object({ percent: Type.Number({ minimum: 0, maximum: 100 }), transferred: Type.Number({ minimum: 0 }), total: Type.Number({ minimum: 0 }), bytesPerSecond: Type.Number({ minimum: 0 }) }, object), Type.Null()]),
}, object);
export type ApplicationUpdateStatus = Static<typeof ApplicationUpdateStatusSchema>;
/** 更新源由应用固定，renderer 不能传入地址、文件路径或安装命令。 */
export const applicationUpdateOperations = {
  updateStatus: { input: Empty, output: ApplicationUpdateStatusSchema },
  checkForUpdates: { input: Empty, output: ApplicationUpdateStatusSchema },
  downloadUpdate: { input: Empty, output: ApplicationUpdateStatusSchema },
  cancelUpdateDownload: { input: Empty, output: ApplicationUpdateStatusSchema },
  installUpdate: { input: Empty, output: ApplicationUpdateStatusSchema },
  setUpdatePreferences: { input: Type.Object({ autoCheck: Type.Boolean() }, object), output: ApplicationUpdateStatusSchema },
  openUpdateReleases: { input: Empty, output: Type.Null() },
} as const;
