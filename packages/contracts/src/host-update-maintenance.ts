import { Type } from '@sinclair/typebox';

const Empty = Type.Object({}, { additionalProperties: false });
/** 安装屏障仅供可信主进程使用。 */
export const updateMaintenanceHostOperations = {
  'host.prepareUpdateInstall': { input: Empty, output: Type.Null() },
  'host.cancelUpdateInstall': { input: Empty, output: Type.Null() },
} as const;
