// Unique test entry: retain production startup and guard while observing only
// caught exception locations in the real Backend. Never persist exception values.
const { createRequire } = require('node:module');
const { join, dirname } = require('node:path');
const { app, utilityProcess, dialog } = createRequire(process.env.ECOMGEN_E2E_APP_PACKAGE)('electron');
app.setAppPath(dirname(process.env.ECOMGEN_E2E_APP_PACKAGE));
app.setVersion(createRequire(process.env.ECOMGEN_E2E_APP_PACKAGE)(process.env.ECOMGEN_E2E_APP_PACKAGE).version);
const { appendFileSync } = require('node:fs');
const showErrorBox = dialog.showErrorBox.bind(dialog);
dialog.showErrorBox = (title, content) => {
  if (title === 'PixelMuse 启动失败') appendFileSync(globalThis.__ecomgenFullGuard.auditFile,
    JSON.stringify({ event: 'startup-error-modal', title, message: content === '无法初始化本地应用。请检查数据目录权限和系统密钥保护是否可用。' ? content : '[omitted]' }) + '\n');
  return showErrorBox(title, content);
};
const fork = utilityProcess.fork.bind(utilityProcess);
utilityProcess.fork = (entry, args, options = {}) => fork(join(__dirname, 'e2e-full-lifecycle-cdx-20261106-diagnostic-utility.mjs'), args, {
  ...options, env: { ...process.env, ...options.env, ECOMGEN_E2E_LIFECYCLE_REAL_ENTRY: entry },
});
// Load before app.ready because production registers its resource scheme here.
createRequire(process.env.ECOMGEN_E2E_APP_PACKAGE)(join(dirname(process.env.ECOMGEN_E2E_APP_PACKAGE), 'out/main/index.js'));
