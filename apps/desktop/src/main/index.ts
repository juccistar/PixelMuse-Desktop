import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, protocol, session, shell, type IpcMainInvokeEvent } from 'electron';
import { appendFileSync, existsSync, mkdirSync, createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { copyFile, lstat, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { rendererRequestAllowed } from './request-boundary.js';
import { resourceRequestOrigin } from './resource-origin.js';
import { pathToFileURL } from 'node:url';
import { Value } from '@sinclair/typebox/value';
import { operations, hostOperations, workspaceOperations, applicationOperations, ResourceRefSchema, type ApplicationInfo, type ApplicationOperation, type BackendOptions, type ByteImport, type HostInput, type HostOperation, type HostOutput, type Input, type Operation, type Output, type ResourceRef, type RpcResponse, type WorkspaceOperation, type WorkspaceStatus } from '@ecomgen/contracts';
import { ClipboardTextSchema, PickFilesSchema, GeneratedFileSchema } from '../shared/native-contracts.js';
import { decodeGeneratedFile, MAX_SELECTION_BYTES, parseResourceRequest, readSelectedImage } from './native-files.js';
import { BackendHost } from './backend-host.js';
import { loadMasterKey } from './credentials.js';
import { PublicError } from './public-error.js';
import { decodeUsageReport, diagnosticsSummary } from './application-safety.js';
import { ApplicationPreferences } from './application-preferences.js';
import { createApplicationUpdateService } from './application-updates.js';
import { createCollectionService } from './collection/index.js';
import { CollectionError, publicTransportPolicy } from './collection/transport.js';

protocol.registerSchemesAsPrivileged([{ scheme: 'ecomgen-resource', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const dataOverride = process.env.ECOMGEN_DESKTOP_DATA_DIR;
// 在设置显示名、session 和单实例锁之前固定旧版 userData，保留 SQLite 与 safeStorage 主密钥。
app.setPath('userData', dataOverride || join(app.getPath('appData'), 'EcomGen'));
app.setName('PixelMuse');
// 与安装器保留的应用身份一致，供 Windows 归属任务通知。
if (process.platform === 'win32') app.setAppUserModelId('com.ecomgen.desktop');
let window: BrowserWindow | undefined;
let backend: BackendHost | undefined;
let quitting = false;
let shutdownComplete = false;
let collection: ReturnType<typeof createCollectionService> | undefined;
let backendOptions: BackendOptions;
let backendLog: (message: string) => void;
let cachedWorkspace: WorkspaceStatus | undefined;
let workspaceRestart: Promise<void> | undefined;
let workspacePoll: NodeJS.Timeout | undefined;
let updates: Awaited<ReturnType<typeof createApplicationUpdateService>> | undefined;
let installingUpdate = false;
let updateRecoveryFailed = false;
const acceptedMainOperations = new Set<Promise<unknown>>();
const releasesUrl = 'https://github.com/juccistar/pixelmuse-releases/releases';
async function prepareUpdateInstall(): Promise<void> {
  if (installingUpdate || quitting || workspaceRestart || !backend?.available) throw safeError('UPDATE_BUSY', '后台不可用或正在切换工作空间，无法安装更新。');
  installingUpdate = true;
  clearTimeout(workspacePoll); workspacePoll = undefined;
  await Promise.allSettled([...acceptedMainOperations]);
  if (quitting || workspaceRestart || !backend?.available) throw safeError('UPDATE_BUSY', '后台不可用或正在切换工作空间，无法安装更新。');
  await hostRequest('host.prepareUpdateInstall', {});
  await collection?.close(); collection = undefined;
  await backend.stopStrict();
  shutdownComplete = true;
}
async function recoverUpdateInstall(): Promise<void> {
  if (!installingUpdate) return;
  shutdownComplete = false;
  const bounded = async (operation: Promise<void>): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Recovery timed out')), 5000); })]);
    } finally { clearTimeout(timer); }
  };
  try {
    if (backend?.available) {
      // cancel 是幂等操作；有界重试不会终止正在运行的任务。
      try { await bounded(hostRequest('host.cancelUpdateInstall', {}).then(() => undefined)); }
      catch { await bounded(hostRequest('host.cancelUpdateInstall', {}).then(() => undefined)); }
    } else if (backend && !quitting) {
      const previous = backend;
      // 旧进程退出之后才能启动替代进程，即使等待已超时也不能抢占其锁。
      const restart = previous.waitForExit().then(async () => {
        if (quitting || backend !== previous) throw new Error('Recovery interrupted');
        backend = createBackendHost();
        await backend.start();
        if (!collection) collection = createCollectionService({ parent: () => window, hostRequest });
        watchWorkspace();
      });
      await bounded(restart);
    } else throw new Error('Backend unavailable');
    if (backend?.available && !collection) collection = createCollectionService({ parent: () => window, hostRequest });
    installingUpdate = false;
    if (backend?.available && !quitting) watchWorkspace();
  } catch (error) {
    updateRecoveryFailed = true;
    backendLog('Backend recovery after update failed.');
    throw error;
  }
}
const preferences = new ApplicationPreferences({
  readSettings: () => backendRequest('getApplicationSettings', {}),
  readJob: id => backendRequest('getJob', { jobId: id }),
  applyScale: scale => { if (window && !window.isDestroyed()) window.webContents.setZoomFactor(scale); },
  notificationsSupported: () => Notification.isSupported(),
  notify: status => {
    if (quitting) return;
    const body = status === 'SUCCEEDED' ? '任务已完成，返回工作台查看结果。' : status === 'UNKNOWN' ? '任务结果待核实，请返回工作台查看。' : status === 'CANCELLED' ? '任务已取消。' : '任务未完成，请返回工作台查看。';
    const notification = new Notification({ title: 'PixelMuse 任务提醒', body });
    notification.on('click', () => { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus(); });
    notification.show();
  },
});
function createBackendHost(): BackendHost {
  const host = new BackendHost(backendOptions, backendLog);
  host.on('changed', event => {
    window?.webContents.send('ecomgen:changed', event);
    if (event.topic === 'settings') void preferences.refresh();
    if (event.topic === 'jobs' && event.aggregateId) void preferences.observeJob(event.aggregateId);
  });
  host.on('status', status => {
    window?.webContents.send('ecomgen:status', status);
    if (status === 'disconnected') preferences.disconnected();
    else if (status === 'ready') void preferences.refresh();
  });
  return host;
}
function watchWorkspace(): void {
  if (workspacePoll || quitting || installingUpdate) return;
  workspacePoll = setTimeout(() => {
    workspacePoll = undefined;
    void (async () => {
      if (quitting || installingUpdate || workspaceRestart) return;
      try {
        cachedWorkspace = await hostRequest('host.workspaceStatus', {});
        if (installingUpdate || quitting) return;
        if (cachedWorkspace.state === 'RESTARTING') {
          workspaceRestart = (async () => {
            await backend!.stop();
            if (quitting) return;
            backend = createBackendHost(); await backend.start();
            cachedWorkspace = await hostRequest('host.workspaceStatus', {});
            for (const topic of ['resources', 'assets', 'catalog'] as const) window?.webContents.send('ecomgen:changed', { topic });
          })();
          try { await workspaceRestart; }
          catch { if (cachedWorkspace) cachedWorkspace = { ...cachedWorkspace, state: 'FAILED', error: '工作空间已保存，但后台重启失败。请重新启动应用。' }; }
          finally { workspaceRestart = undefined; }
        } else if (cachedWorkspace.state === 'COPYING' || cachedWorkspace.state === 'VERIFYING') watchWorkspace();
      } catch { if (!quitting) watchWorkspace(); }
    })();
  }, 250);
}
const rendererFile = join(import.meta.dirname, '../renderer/index.html');
const devUrl = process.env.ELECTRON_RENDERER_URL;
const safeError = (code: string, message: string) => new PublicError(code, message);

async function backendRequest<K extends Operation>(operation: K, input: Input<K>): Promise<Output<K>> {
  const contract = operations[operation];
  if (!Value.Check(contract.input, input)) throw safeError('INVALID_INPUT', '请求参数不符合契约');
  const result = await backend!.request(operation, input);
  if (!Value.Check(contract.output, result)) throw safeError('INVALID_RESPONSE', '后台响应不符合契约');
  return result as Output<K>;
}
function applicationInfo(): ApplicationInfo {
  return { name: app.getName(), version: app.getVersion(), platform: process.platform, arch: process.arch,
    electronVersion: process.versions.electron, chromeVersion: process.versions.chrome, nodeVersion: process.versions.node,
    packaged: app.isPackaged, notificationsSupported: Notification.isSupported() };
}
async function hostRequest<K extends HostOperation>(operation: K, input: HostInput<K>): Promise<HostOutput<K>> {
  const contract = hostOperations[operation];
  if (!Value.Check(contract.input, input)) throw safeError('INVALID_INPUT', '文件操作参数不符合契约');
  const result = await backend!.request(operation, input, true);
  if (!Value.Check(contract.output, result)) throw safeError('INVALID_RESPONSE', '文件操作响应不符合契约');
  return result as HostOutput<K>;
}
function trusted(event: IpcMainInvokeEvent): void {
  const frame = event.senderFrame;
  if (!window || event.sender !== window.webContents || frame !== event.sender.mainFrame || !frame ||
      (devUrl ? new URL(frame.url).origin !== new URL(devUrl).origin : frame.url !== pathToFileURL(rendererFile).href)) throw safeError('FORBIDDEN', '请求来源不受信任');
}
function handle(channel: string, action: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>): void {
  ipcMain.handle(channel, async (event, ...args): Promise<RpcResponse> => {
    try {
      trusted(event);
      const updateControl = channel === 'ecomgen:application' && ['info', 'updateStatus', 'checkForUpdates', 'downloadUpdate', 'cancelUpdateDownload', 'installUpdate', 'setUpdatePreferences', 'openUpdateReleases'].includes(args[0] as string);
      if (updateControl) return { id: '', ok: true, data: await action(event, ...args) };
      if (installingUpdate) throw safeError('UPDATE_MAINTENANCE', '正在准备安装更新，请稍后重试。');
      const pending = action(event, ...args);
      acceptedMainOperations.add(pending);
      try { return { id: '', ok: true, data: await pending }; } finally { acceptedMainOperations.delete(pending); }
    }
    catch (error) { return { id: '', ok: false, error: error instanceof PublicError ? { code: error.code, message: error.message } : { code: 'LOCAL_OPERATION_FAILED', message: '本地操作未完成，请检查后台状态后重试。' } }; }
  });
}
function checkedRef(value: unknown): ResourceRef {
  if (!Value.Check(ResourceRefSchema, value)) throw safeError('INVALID_INPUT', '无效的资源引用');
  return value as ResourceRef;
}
const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/avif': 'avif', 'image/tiff': 'tiff', 'image/vnd.adobe.photoshop': 'psd', 'application/zip': 'zip', 'application/json': 'json' };
async function chooseSave(name: string): Promise<string | undefined> {
  const result = await dialog.showSaveDialog(window!, { title: '保存文件', defaultPath: join(app.getPath('downloads'), basename(name)) });
  return result.canceled ? undefined : result.filePath;
}
function registerIpc(): void {
  handle('ecomgen:application', async (_event, operation, input) => {
    if (typeof operation !== 'string' || !Object.hasOwn(applicationOperations, operation)) throw safeError('INVALID_OPERATION', '不支持的应用操作');
    const contract = applicationOperations[operation as ApplicationOperation];
    if (!Value.Check(contract.input, input)) throw safeError('INVALID_INPUT', '应用操作参数无效');
    let result: unknown;
    if (operation === 'info') result = applicationInfo();
    else if (operation === 'updateStatus') result = updates!.getStatus();
    else if (operation === 'checkForUpdates') result = await updates!.check();
    else if (operation === 'downloadUpdate') result = updates!.download();
    else if (operation === 'cancelUpdateDownload') result = updates!.cancel();
    else if (operation === 'installUpdate') result = await updates!.install();
    else if (operation === 'setUpdatePreferences') result = await updates!.setAutoCheck((input as { autoCheck: boolean }).autoCheck);
    else if (operation === 'openUpdateReleases') { await shell.openExternal(releasesUrl); result = null; }
    else if (installingUpdate) throw safeError('UPDATE_MAINTENANCE', '正在准备安装更新，请稍后重试。');
    else if (operation === 'openDirectory') {
      const target = (input as { target: 'applicationData' | 'logs' }).target;
      const directory = target === 'applicationData' ? app.getPath('userData') : join(app.getPath('userData'), 'logs');
      // 固定目录也检查链接，不能借外部替换把此能力重定向到任意位置。
      try {
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(directory)).toLowerCase() !== directory.toLowerCase()) throw new Error('Invalid directory');
      } catch { throw safeError('DIRECTORY_UNAVAILABLE', '应用目录不可用，请检查目录权限'); }
      if (await shell.openPath(directory)) throw safeError('DIRECTORY_UNAVAILABLE', '无法打开应用目录，请检查系统文件管理器');
      result = null;
    } else if (operation === 'exportDiagnostics') {
      let workspaceState: string | undefined;
      try { workspaceState = (await hostRequest('host.workspaceStatus', {})).state; } catch { /* 仅导出固定健康值。 */ }
      const summary = diagnosticsSummary(applicationInfo(), { backendReady: backend?.available === true, workspaceState });
      const path = await chooseSave(`PixelMuse-diagnostics-${new Date().toISOString().slice(0, 10)}.json`);
      if (path) await writeFile(path, JSON.stringify(summary, null, 2), 'utf8');
      result = { saved: Boolean(path) };
    } else {
      const report = decodeUsageReport(input);
      const selected = await dialog.showSaveDialog(window!, { title: '导出用量明细 CSV', defaultPath: join(app.getPath('downloads'), report.name), filters: [{ name: 'CSV', extensions: ['csv'] }] });
      const path = selected.canceled ? undefined : selected.filePath;
      if (path && !path.toLowerCase().endsWith('.csv')) throw safeError('INVALID_INPUT', '统计文件只能保存为 CSV');
      if (path) await writeFile(path, report.bytes);
      result = { saved: Boolean(path) };
    }
    if (!Value.Check(contract.output, result)) throw safeError('INVALID_RESPONSE', '应用响应无效');
    return result;
  });
  handle('ecomgen:collection', async (_event, operation, input) => {
    try { return await collection!.invoke(operation, input); }
    catch (error) {
      // 只投影采集模块自己的安全错误；未知异常仍使用统一本地失败摘要。
      if (error instanceof CollectionError) throw safeError('COLLECTION_FAILED', error.message);
      throw error;
    }
  });
  handle('ecomgen:workspace', async (_event, operation, input) => {
    if (typeof operation !== 'string' || !Object.hasOwn(workspaceOperations, operation)) throw safeError('INVALID_OPERATION', '不支持的工作空间操作');
    const contract = workspaceOperations[operation as WorkspaceOperation];
    if (!Value.Check(contract.input, input)) throw safeError('INVALID_INPUT', '工作空间操作参数无效');
    let result: unknown;
    if (operation === 'status' || operation === 'migration') result = (workspaceRestart || !backend?.available) && cachedWorkspace ? cachedWorkspace : await hostRequest('host.workspaceStatus', {});
    else if (operation === 'cancel') result = (workspaceRestart || !backend?.available) && cachedWorkspace ? cachedWorkspace : await hostRequest('host.workspaceCancel', {});
    else if (operation === 'choose') {
      if (workspaceRestart) throw safeError('WORKSPACE_BUSY', '后台正在重启，请稍后重试');
      const current = await hostRequest('host.workspaceStatus', {});
      const reconnect = current.state === 'FAILED' && current.error?.startsWith('已选择的工作空间不可用');
      const selected = await dialog.showOpenDialog(window!, { title: reconnect ? '重新连接原工作空间（选择该目录本身）' : '选择新工作空间的父目录', properties: ['openDirectory', 'createDirectory'] });
      const status = selected.canceled ? await hostRequest('host.workspaceStatus', {}) : await hostRequest('host.workspaceChoose', { directory: selected.filePaths[0]! });
      cachedWorkspace = status; result = { canceled: selected.canceled, status };
      if (!selected.canceled) watchWorkspace();
    } else {
      const status = await hostRequest('host.workspaceStatus', {});
      if (status.state !== 'READY' && status.state !== 'FAILED') throw safeError('WORKSPACE_BUSY', '工作空间正在切换');
      try {
        const info = await lstat(status.directory);
        if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(status.directory)).toLowerCase() !== status.directory.toLowerCase()) throw new Error('Invalid directory');
      } catch { throw safeError('WORKSPACE_UNAVAILABLE', '无法打开工作空间，请检查目录和设备连接'); }
      const error = await shell.openPath(status.directory);
      if (error) throw safeError('WORKSPACE_UNAVAILABLE', '无法打开工作空间，请检查目录和设备连接');
      result = null;
    }
    if (!Value.Check(contract.output, result)) throw safeError('INVALID_RESPONSE', '工作空间响应无效');
    return result;
  });
  handle('ecomgen:invoke', async (_event, name, input) => {
    if (typeof name !== 'string' || !Object.hasOwn(operations, name)) throw safeError('INVALID_OPERATION', '不支持的操作');
    const result = await backendRequest(name as Operation, input as Input<Operation>);
    if (name === 'updateApplicationSettings') await preferences.refresh();
    return result;
  });
  handle('ecomgen:pick-files', async (_event, raw) => {
    if (!Value.Check(PickFilesSchema, raw)) throw safeError('INVALID_INPUT', '文件选择参数无效');
    const options = raw as { multiple?: boolean; maxFiles?: number };
    const result = await dialog.showOpenDialog(window!, { title: '选择图片', properties: options.multiple ? ['openFile', 'multiSelections'] : ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'tif', 'tiff'] }] });
    if (result.canceled) return [];
    if (result.filePaths.length > (options.maxFiles ?? (options.multiple ? 32 : 1))) throw safeError('TOO_MANY_FILES', '所选图片数量超过本次上限');
    const files: ByteImport[] = []; let total = 0;
    for (const path of result.filePaths) { const file = await readSelectedImage(path); total += Buffer.byteLength(file.base64, 'base64'); if (total > MAX_SELECTION_BYTES) throw safeError('FILES_TOO_LARGE', '本次图片合计不能超过 128 MiB'); files.push(file); }
    return files;
  });
  handle('ecomgen:save-artifact', async (_event, value, suggestedName) => {
    const ref = checkedRef(value);
    if (suggestedName !== undefined && !Value.Check(GeneratedFileSchema.properties.name, suggestedName)) throw safeError('INVALID_INPUT', '文件名不符合保存规则');
    const resource = await hostRequest('host.resolveResource', { ref });
    const extension = extensions[resource.mimeType] ?? 'bin';
    const name = typeof suggestedName === 'string' ? `${suggestedName.replace(/\.[A-Za-z0-9]{1,8}$/, '')}.${extension}` : `${ref.kind.toLowerCase()}-${ref.id}.${extension}`;
    const path = await chooseSave(name);
    if (!path) return false;
    // 再解析一次，避免对话框打开期间删除资源或替换清理状态。
    const current = await hostRequest('host.resolveResource', { ref });
    if (current.hash !== resource.hash) throw safeError('RESOURCE_CHANGED', '资源已发生变化，请重新保存');
    await copyFile(current.path, path);
    return true;
  });
  handle('ecomgen:save-generated', async (_event, value) => {
    const { file, bytes } = decodeGeneratedFile(value);
    await hostRequest('host.archiveGeneratedFile', file);
    const path = await chooseSave(file.name);
    if (!path) return false;
    await writeFile(path, bytes);
    return true;
  });
  handle('ecomgen:clipboard-read', async () => {
    const text = clipboard.readText();
    if (!Value.Check(ClipboardTextSchema, text)) throw safeError('CLIPBOARD_TOO_LARGE', '剪贴板文本超过 64 KiB');
    return text;
  });
  handle('ecomgen:clipboard-write', async (_event, value) => {
    if (!Value.Check(ClipboardTextSchema, value)) throw safeError('INVALID_INPUT', '剪贴板文本超过 64 KiB');
    clipboard.writeText(value as string);
  });
}
async function createWindow(): Promise<void> {
  const icon = [join(process.resourcesPath, 'icon.ico'), join(app.getAppPath(), 'build/icon.ico')].find(path => existsSync(path));
  window = new BrowserWindow({ width: 1440, height: 960, minWidth: 1000, minHeight: 700, show: false, title: 'PixelMuse · 商品视觉创作工作台', backgroundColor: '#080808', ...(icon ? { icon } : {}), webPreferences: { preload: join(import.meta.dirname, '../preload/index.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false } });
  window.removeMenu();
  preferences.applyCurrentScale();
  window.webContents.on('did-finish-load', () => preferences.applyCurrentScale());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== (devUrl ?? pathToFileURL(rendererFile).href)) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.once('ready-to-show', () => window?.show());
  window.on('closed', () => {
    window = undefined;
    // 采集窗口是工作台的辅助窗口；关闭工作台也应完成后台退出。
    if (!quitting) app.quit();
  });
  if (devUrl) await window.loadURL(devUrl); else await window.loadFile(rendererFile);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
  app.whenReady().then(async () => {
    const configDir = app.getPath('userData'); mkdirSync(configDir, { recursive: true });
    const logDir = join(configDir, 'logs'); mkdirSync(logDir, { recursive: true });
    const log = (message: string) => appendFileSync(join(logDir, 'main.log'), `${new Date().toISOString()} ${message}\n`);
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on('will-download', event => event.preventDefault());
    const devOrigin = devUrl ? new URL(devUrl).origin : undefined;
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !rendererRequestAllowed(details.url, dirname(rendererFile), devOrigin) }));
    const csp = devOrigin
      ? `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' ecomgen-resource: data: blob:; font-src 'self' data:; connect-src ${devOrigin} ${devOrigin.replace(/^http/, 'ws')} ecomgen-resource:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-src 'none'`
      : "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' ecomgen-resource: data: blob:; font-src 'self' data:; connect-src ecomgen-resource:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-src 'none'";
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } }));
    backendOptions = { dataDir: join(configDir, 'data'), masterKey: loadMasterKey(configDir), version: app.getVersion() }; backendLog = log;
    backend = createBackendHost(); await backend.start();
    await preferences.refresh();
    collection = createCollectionService({ parent: () => window, hostRequest });
    const installed = process.platform === 'win32' && process.arch === 'x64' && app.isPackaged && existsSync(join(dirname(process.execPath), 'Uninstall PixelMuse.exe'));
    updates = await createApplicationUpdateService({ version: app.getVersion(), supported: installed, unsupportedReason: installed ? null : '当前运行环境不支持自动安装更新，请前往发布页面下载安装包。', userData: configDir, prepareInstall: prepareUpdateInstall, recoverAfterInstallFailure: recoverUpdateInstall });
    updates.startAutoCheck();
    protocol.handle('ecomgen-resource', async request => {
      try {
        if (request.method !== 'GET') return new Response(null, { status: 405 });
        const ref = parseResourceRequest(request.url);
        // 资源请求只接受此窗口自己的 document/fetch；协议绝不转发外部地址。
        const origin = resourceRequestOrigin(request.headers.get('Origin'), devOrigin);
        if (origin === undefined) return new Response(null, { status: 403 });
        const resource = await hostRequest('host.resolveResource', { ref });
        const stream = createReadStream(resource.path, { signal: request.signal });
        return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { headers: { 'Content-Type': resource.mimeType, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Cross-Origin-Resource-Policy': 'cross-origin' } });
      } catch { return new Response(null, { status: 404 }); }
    });
    registerIpc(); await createWindow();
    app.on('activate', () => { if (!window) void createWindow(); });
  }).catch(async () => {
    // 退出会中断尚未完成的 loadFile；此时弹模态错误框反而会阻止正常关闭。
    if (!quitting) dialog.showErrorBox('PixelMuse 启动失败', '无法初始化本地应用。请检查数据目录权限和系统密钥保护是否可用。');
    await collection?.close(); await backend?.stop(); app.quit();
  });
  app.on('window-all-closed', () => { if (!quitting) app.quit(); });
  app.on('before-quit', event => {
    if (installingUpdate && !shutdownComplete && !updateRecoveryFailed) { event.preventDefault(); return; }
    if (shutdownComplete || !backend) return;
    event.preventDefault();
    // 辅助窗口关闭或系统重复退出不能跳过已开始的 closed/锁释放屏障。
    if (quitting) return;
    quitting = true; clearTimeout(workspacePoll);
    void (async () => { try { await collection?.close(); } finally { await workspaceRestart?.catch(() => undefined); await backend?.stop(); } })().finally(() => { shutdownComplete = true; app.quit(); });
  });
}

/** 仅主进程内组合网络策略；不通过 preload 暴露策略或宿主能力。 */
export { publicTransportPolicy as collectionTransportPolicy };
