import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { applicationOperations, type ApplicationInfo } from '@ecomgen/contracts';
import { decodeUsageReport, diagnosticsSummary, MAX_USAGE_REPORT_BYTES } from './application-safety.js';

const report = { name: '用量-2026.csv', base64: Buffer.from('模型,请求数\r\nfixture,1\r\n').toString('base64') };
describe('application 原生边界', () => {
  it('只接受固定目录目标和严格无路径输入', () => {
    expect(Value.Check(applicationOperations.openDirectory.input, { target: 'logs' })).toBe(true);
    for (const input of [{ target: 'C:/secret' }, { target: 'logs', path: 'C:/secret' }, {}]) expect(Value.Check(applicationOperations.openDirectory.input, input)).toBe(false);
    expect(Value.Check(applicationOperations.info.input, { path: 'anything' })).toBe(false);
  });
  it('CSV 保存不扩展 MIME、路径、设备名或非规范编码', () => {
    expect(decodeUsageReport(report).bytes.toString('utf8')).toContain('fixture,1');
    for (const input of [
      { ...report, mimeType: 'text/csv' }, { ...report, path: 'C:/x.csv' },
      { ...report, name: '../x.csv' }, { ...report, name: 'report.exe' },
      { ...report, name: 'CON.csv' }, { ...report, name: 'nul.data.csv' },
      { ...report, name: ' spaced.csv' }, { ...report, base64: 'AB==' },
      { ...report, base64: Buffer.from([0xff, 0xfe, 0]).toString('base64') },
      { ...report, base64: Buffer.from('a\0b').toString('base64') },
    ]) expect(() => decodeUsageReport(input)).toThrow();
  });
  it('CSV 限制按实际字节而非仅 Base64 长度执行', () => {
    const bytes = Buffer.alloc(MAX_USAGE_REPORT_BYTES, 65);
    expect(decodeUsageReport({ ...report, base64: bytes.toString('base64') }).bytes.length).toBe(MAX_USAGE_REPORT_BYTES);
    expect(() => decodeUsageReport({ ...report, base64: Buffer.alloc(MAX_USAGE_REPORT_BYTES + 1, 65).toString('base64') })).toThrow();
  });
  it('诊断只投影版本、白名单健康和时间，不复制额外字段', () => {
    const info = { name: 'PixelMuse', version: '0.4.0', platform: 'win32', arch: 'x64', electronVersion: '1', chromeVersion: '2', nodeVersion: '3', packaged: false, notificationsSupported: true, apiKey: 'never-export', path: 'C:/secret' };
    const summary = diagnosticsSummary(info as ApplicationInfo, { backendReady: false, workspaceState: 'C:/raw-error' }, '2026-11-06T00:00:00.000Z');
    expect(summary.health).toEqual({ backend: 'UNAVAILABLE', workspace: 'UNAVAILABLE' });
    expect(summary.generatedAt).toBe('2026-11-06T00:00:00.000Z');
    expect(JSON.stringify(summary)).not.toMatch(/never-export|secret|raw-error|apiKey/);
    expect(Object.keys(summary.application)).toEqual(['name', 'version', 'platform', 'arch', 'electronVersion', 'chromeVersion', 'nodeVersion', 'packaged', 'notificationsSupported']);
  });
});
