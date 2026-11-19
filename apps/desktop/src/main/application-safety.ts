import { Value } from '@sinclair/typebox/value';
import { UsageReportFileSchema, type ApplicationInfo } from '@ecomgen/contracts';
import { PublicError } from './public-error.js';

export const MAX_USAGE_REPORT_BYTES = 8 * 1024 * 1024;
/** CSV 是单独的保存能力，不能借此扩展画布归档或任意文件类型。 */
export function decodeUsageReport(value: unknown): { name: string; bytes: Buffer } {
  if (!Value.Check(UsageReportFileSchema, value)) throw new PublicError('INVALID_INPUT', '统计文件参数无效');
  const file = value as { name: string; base64: string };
  // Windows 设备名和空白前缀也不能作为默认文件名。
  if (file.name.trim() !== file.name || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(file.name)) throw new PublicError('INVALID_INPUT', '统计文件名无效');
  const bytes = Buffer.from(file.base64, 'base64');
  if (!bytes.length || bytes.length > MAX_USAGE_REPORT_BYTES || bytes.toString('base64') !== file.base64) throw new PublicError('INVALID_INPUT', '统计文件编码或大小无效');
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new PublicError('INVALID_INPUT', '统计文件必须为 UTF-8 CSV'); }
  if (bytes.includes(0)) throw new PublicError('INVALID_INPUT', '统计文件不能包含二进制内容');
  return { name: file.name, bytes };
}

/** 明确逐项投影，未来扩展 info 也不会把目录或错误附带到诊断中。 */
export function diagnosticsSummary(info: ApplicationInfo, health: { backendReady: boolean; workspaceState: string | undefined }, timestamp = new Date().toISOString()) {
  const workspaceStates = ['READY', 'COPYING', 'VERIFYING', 'RESTARTING', 'FAILED'];
  return {
    formatVersion: 1, generatedAt: timestamp,
    application: { name: info.name, version: info.version, platform: info.platform, arch: info.arch,
      electronVersion: info.electronVersion, chromeVersion: info.chromeVersion, nodeVersion: info.nodeVersion,
      packaged: info.packaged, notificationsSupported: info.notificationsSupported },
    health: { backend: health.backendReady ? 'READY' : 'UNAVAILABLE',
      workspace: workspaceStates.includes(health.workspaceState ?? '') ? health.workspaceState : 'UNAVAILABLE' },
  };
}
