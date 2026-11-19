/** 数据库及 v1/v2 显式转换由 core 独占，Backend 不维护第二份 DDL。 */
export { openDatabase, migrateDesktopDatabase, DESKTOP_SCHEMA_VERSION, type SqliteDatabase } from '@ecomgen/core';
