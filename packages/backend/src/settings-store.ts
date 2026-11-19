import { ApplicationSettingsSchema, DEFAULT_APPLICATION_SETTINGS, type ApplicationSettings } from '@ecomgen/contracts';
import type { SqliteDatabase } from '@ecomgen/core';
import { BackendError, check } from './validation.js';

/** 从唯一 SQLite owner 读取完整设置，不访问网络。 */
export function readApplicationSettings(db: SqliteDatabase): ApplicationSettings {
  const row = db.prepare('SELECT settings_json FROM desktop_application_settings WHERE singleton=1').get() as { settings_json: string } | undefined;
  if (!row) return structuredClone(DEFAULT_APPLICATION_SETTINGS);
  let value: unknown;
  try { value = JSON.parse(row.settings_json); } catch { throw new BackendError('INVALID_SETTINGS', '应用设置数据无效。'); }
  check(ApplicationSettingsSchema, value, true);
  return value as ApplicationSettings;
}
