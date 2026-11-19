import { randomUUID } from 'node:crypto';
import { BrowserWindow, Menu, session, type Session } from 'electron';
import { Value } from '@sinclair/typebox/value';
import { collectionOperations, type CollectionSnapshot, type CollectionOperation, type CollectionInput, type CollectionOutput, type CollectionHostOperation, type CollectionHostInput, type CollectionHostOutput, type ByteImport } from '@ecomgen/contracts';
import { EXTRACTION_SCRIPT, type ExtractedPage } from './extractor.js';
import { createCollectionBrowserProxy, type CollectionBrowserProxy } from './browser-proxy.js';
import { isSchemefulSameSite } from './cookie-policy.js';
import { CollectionError, downloadImage, parseWebUrl, publicTransportPolicy, sanitizePageUrl, validateTarget, type ImageTransportPolicy } from './transport.js';

/** main 仅提供父窗口与受控宿主请求，不接收 renderer 注入的系统能力。 */
export interface CollectionServiceOptions {
  parent(): BrowserWindow | undefined;
  hostRequest<K extends CollectionHostOperation>(operation: K, input: CollectionHostInput<K>): Promise<CollectionHostOutput<K>>;
}
/** 生命周期关闭会中止下载、清除临时会话并等待已接受操作退出。 */
export interface CollectionService { invoke(operation: unknown, input: unknown): Promise<unknown>; close(): Promise<void> }
interface Candidate { id: string; url: string; width: number; height: number; label: string }
interface State {
  id: string; projectId: string; revision: number; state: 'OPEN' | 'CLOSED'; browser: BrowserWindow; activeBrowser: BrowserWindow; session: Session; proxy: CollectionBrowserProxy;
  windows: Set<BrowserWindow>; candidates: Map<string, Candidate>; page?: CollectionSnapshot['page']; error?: string;
  jobs: Map<string, { controller: AbortController; importing: boolean }>; clearing?: Promise<void>; refreshing?: boolean;
}
const safeText = (text: string, max: number) => text.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
function platform(value: string): string {
  const host = new URL(value).hostname.toLowerCase();
  if (/(^|\.)amazon\./.test(host)) return 'Amazon';
  if (/(^|\.)(taobao|tmall)\.com$/.test(host)) return '淘宝 / 天猫';
  if (/(^|\.)jd\.com$/.test(host)) return '京东';
  if (/(^|\.)myshopify\.com$/.test(host)) return 'Shopify';
  return host.slice(0, 80);
}
/** 策略注入仅供同目录独立 fixture 工厂使用；正式入口固定 public 策略。 */
export function createScopedCollectionService(options: CollectionServiceOptions, policy: ImageTransportPolicy): CollectionService {
  const states = new Map<string, State>();
  const inFlight = new Set<Promise<unknown>>();
  let busyImages = 0;
  let shuttingDown = false;
  let opening = false;
  const track = <T>(promise: Promise<T>): Promise<T> => { inFlight.add(promise); void promise.finally(() => inFlight.delete(promise)).catch(() => {}); return promise; };
  const snapshot = (state: State): CollectionSnapshot => ({
    collectionId: state.id, revision: state.revision, state: state.state,
    ...(state.page ? { page: { ...state.page } } : {}),
    candidates: [...state.candidates.values()].map(c => ({ candidateId: c.id, width: c.width, height: c.height, label: c.label })),
    ...(state.error ? { error: state.error } : {}),
  });
  const get = (id: string, open = true) => {
    const state = states.get(id);
    if (!state || (open && state.state !== 'OPEN')) throw new CollectionError('本次采集已关闭，请重新打开。');
    return state;
  };
  const invalidate = (state: State) => {
    state.revision++; state.candidates.clear(); state.error = undefined;
    for (const [requestId, job] of state.jobs) {
      job.controller.abort();
      if (job.importing) track(options.hostRequest('host.cancelCollectionImport', { requestId })).catch(() => { state.error = '取消状态待核实，请重新查询项目素材和采集来源。'; });
    }
  };
  const closeState = (state: State): Promise<void> => {
    if (state.state === 'CLOSED') return state.clearing ?? Promise.resolve();
    state.state = 'CLOSED'; invalidate(state);
    for (const window of state.windows) if (!window.isDestroyed()) window.destroy();
    state.windows.clear(); state.page = undefined;
    state.clearing = (async () => {
      const results = await Promise.allSettled([state.proxy.close(), state.session.clearStorageData(), state.session.clearCache(), state.session.clearAuthCache(), state.session.closeAllConnections()]);
      if (results.some(result => result.status === 'rejected')) {
        state.error = '本次登录清理未完全完成，请退出应用以释放临时浏览会话。';
        throw new CollectionError(state.error);
      }
    })();
    return state.clearing;
  };
  const updatePage = (state: State) => {
    if (state.state !== 'OPEN' || state.activeBrowser.isDestroyed()) return;
    const browser = state.activeBrowser;
    try { const url = browser.webContents.getURL(); state.page = { url: sanitizePageUrl(url), title: safeText(browser.getTitle(), 240), platform: platform(url) }; }
    catch { state.page = undefined; }
  };
  const activate = (state: State, browser: BrowserWindow) => {
    if (state.state !== 'OPEN' || browser.isDestroyed() || !state.windows.has(browser)) return;
    if (state.activeBrowser !== browser) { invalidate(state); state.activeBrowser = browser; updatePage(state); }
  };
  const refresh = async (state: State, browser = state.activeBrowser): Promise<CollectionSnapshot> => {
    activate(state, browser);
    if (state.refreshing) throw new CollectionError('页面正在读取，请稍后重试。');
    state.refreshing = true;
    invalidate(state); const revision = state.revision;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (browser.isDestroyed() || browser.webContents.isLoadingMainFrame()) throw new CollectionError('页面仍在加载，请稍后读取。');
      const result = await Promise.race([
        browser.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: EXTRACTION_SCRIPT }]) as Promise<ExtractedPage>,
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new CollectionError('页面读取超时，请重试。')), 5000); }),
      ]);
      if (state.state !== 'OPEN' || state.revision !== revision || state.activeBrowser !== browser || browser.isDestroyed()) throw new CollectionError('页面已变化，请重新读取当前页。');
      if (!result || typeof result.url !== 'string' || typeof result.title !== 'string' || !Array.isArray(result.images) || result.images.length > 80 || result.url !== browser.webContents.getURL()) throw new CollectionError();
      state.page = { url: sanitizePageUrl(result.url), title: safeText(result.title, 240), platform: platform(result.url) };
      const seen = new Set<string>();
      for (const image of result.images) {
        if (!image || typeof image.url !== 'string' || !Number.isFinite(image.width) || !Number.isFinite(image.height)) continue;
        try {
          const url = parseWebUrl(image.url).href;
          if (seen.has(url)) continue; seen.add(url);
          const candidate: Candidate = { id: randomUUID(), url, width: Math.min(100000, Math.max(0, Math.floor(image.width))), height: Math.min(100000, Math.max(0, Math.floor(image.height))), label: ['页面已加载图片', '页面提供的图片链接', '页面分享图片', '商品结构化图片链接'].includes(image.label) ? image.label : '页面图片' };
          state.candidates.set(candidate.id, candidate);
        } catch { /* 页面中的非法候选不回显。 */ }
      }
      if (!state.candidates.size) state.error = '当前页没有可采集图片，可正常滚动加载后重读，或添加图片链接。';
      return snapshot(state);
    } catch (error) {
      if (state.revision === revision && state.state === 'OPEN') state.error = error instanceof CollectionError ? error.message : '读取页面失败，请正常浏览后重试。';
      return snapshot(state);
    } finally { state.refreshing = false; if (timeout) clearTimeout(timeout); }
  };
  const installWindow = (state: State, browser: BrowserWindow) => {
    state.windows.add(browser);
    browser.on('focus', () => activate(state, browser));
    browser.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    browser.webContents.on('login', (event, _details, auth, callback) => {
      if (auth.isProxy && auth.host === '127.0.0.1' && auth.port === state.proxy.port && auth.realm === 'PixelMuse collection') {
        event.preventDefault(); callback(state.proxy.username, state.proxy.password);
      }
    });
    browser.setMenu(Menu.buildFromTemplate([{ label: '采集', submenu: [
      { label: '读取当前页图片', click: () => { void refresh(state, browser).then(() => options.parent()?.focus()).catch(() => {}); } },
      { label: '返回工作台选择图片', click: () => { activate(state, browser); options.parent()?.focus(); } },
      { type: 'separator' },
      { label: '后退', click: () => { if (browser.webContents.navigationHistory.canGoBack()) browser.webContents.navigationHistory.goBack(); } },
      { label: '前进', click: () => { if (browser.webContents.navigationHistory.canGoForward()) browser.webContents.navigationHistory.goForward(); } },
      { label: '重新加载', click: () => browser.reload() },
      { type: 'separator' },
      { label: '清除本次登录并关闭', click: () => { void closeState(state).catch(() => {}); } },
    ] }]));
    browser.webContents.on('will-attach-webview', event => event.preventDefault());
    browser.webContents.on('will-navigate', (event, url) => { try { parseWebUrl(url); } catch { event.preventDefault(); } });
    browser.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame && browser === state.activeBrowser) { invalidate(state); state.page = undefined; } });
    browser.webContents.on('did-navigate', () => { if (browser === state.activeBrowser) updatePage(state); });
    browser.webContents.on('did-navigate-in-page', (_event, _url, isMainFrame) => { if (isMainFrame && browser === state.activeBrowser) { invalidate(state); updatePage(state); } });
    browser.webContents.setWindowOpenHandler(({ url }) => {
      try { if (url !== 'about:blank') parseWebUrl(url); } catch { return { action: 'deny' }; }
      if (state.state !== 'OPEN' || state.windows.size >= 4) return { action: 'deny' };
      return { action: 'allow', overrideBrowserWindowOptions: { width: 1100, height: 820, autoHideMenuBar: false, webPreferences: { session: state.session, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false, webSecurity: true, allowRunningInsecureContent: false } } };
    });
    browser.webContents.on('did-create-window', child => { installWindow(state, child); if (child.isFocused()) activate(state, child); });
    browser.on('closed', () => {
      state.windows.delete(browser);
      if (browser === state.browser) void closeState(state).catch(() => {});
      else if (browser === state.activeBrowser && state.state === 'OPEN') {
        const remaining = [...state.windows].find(window => !window.isDestroyed());
        if (remaining) activate(state, remaining);
      }
    });
  };
  const open = async (input: CollectionInput<'open'>): Promise<CollectionSnapshot> => {
    if ([...states.values()].some(state => state.state === 'OPEN')) throw new CollectionError('已有采集窗口，请先关闭本次采集。');
    await options.hostRequest('host.collectionSources', { projectId: input.projectId });
    const url = parseWebUrl(input.url);
    await validateTarget(url, policy);
    if (shuttingDown) throw new CollectionError('采集服务已关闭。');
    // A random non-persist partition isolates cookies, cache, service workers and permissions.
    const isolated = session.fromPartition(`collection-${randomUUID()}`, { cache: false });
    isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.setDevicePermissionHandler(() => false);
    isolated.on('will-download', event => event.preventDefault());
    isolated.webRequest.onBeforeRequest((details, callback) => {
      if (details.url === 'about:blank') { callback({}); return; }
      let target: URL;
      try { target = parseWebUrl(details.url); } catch { callback({ cancel: true }); return; }
      void validateTarget(target, policy).then(() => callback({}), () => callback({ cancel: true }));
    });
    const proxy = await createCollectionBrowserProxy(policy);
    let browser: BrowserWindow | undefined;
    try {
      // A single fixed proxy has no DIRECT fallback; <-loopback> disables Chromium's implicit local bypass.
      await isolated.setProxy({ mode: 'fixed_servers', proxyRules: `http://127.0.0.1:${proxy.port}`, proxyBypassRules: '<-loopback>' });
      if (shuttingDown) throw new CollectionError('采集服务已关闭。');
      browser = new BrowserWindow({ width: 1180, height: 850, title: 'PixelMuse · 正常浏览并采集参考图', autoHideMenuBar: false, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false, webSecurity: true, allowRunningInsecureContent: false } });
      const state: State = { id: randomUUID(), projectId: input.projectId, revision: 0, state: 'OPEN', browser, activeBrowser: browser, session: isolated, proxy, windows: new Set(), candidates: new Map(), jobs: new Map() };
      states.set(state.id, state); installWindow(state, browser);
      while (states.size > 16) { const first = [...states.values()].find(item => item.state === 'CLOSED'); if (!first) break; states.delete(first.id); }
      track(browser.loadURL(url.href).then(() => updatePage(state)).catch(() => { if (state.state === 'OPEN') state.error = '页面未能加载，请检查链接或在采集窗口正常浏览。'; }));
      return snapshot(state);
    } catch (error) {
      if (browser && !browser.isDestroyed()) browser.destroy();
      await proxy.close();
      throw error;
    }
  };
  const image = async <K extends 'preview' | 'import'>(operation: K, input: CollectionInput<K>): Promise<CollectionOutput<K>> => {
    const state = get(input.collectionId);
    if (state.revision !== input.revision || !state.candidates.has(input.candidateId)) throw new CollectionError('图片选择已过期，请重新读取当前页。');
    if (busyImages >= 2) throw new CollectionError('图片处理繁忙，请稍后重试。');
    const candidate = state.candidates.get(input.candidateId)!;
    const browser = state.activeBrowser;
    if (browser.isDestroyed() || !state.page) throw new CollectionError('当前页面来源已失效，请重新读取。');
    const pageUrl = parseWebUrl(browser.webContents.getURL());
    const sourcePage = { ...state.page };
    const requestId = randomUUID(); const controller = new AbortController();
    const job = { controller, importing: false }; state.jobs.set(requestId, job); busyImages++;
    const assertCurrent = () => { controller.signal.throwIfAborted(); if (state.state !== 'OPEN' || state.revision !== input.revision) throw new CollectionError('页面已变化，请重新选择图片。'); };
    try {
      const downloaded = await downloadImage(candidate.url, { signal: controller.signal, policy, referrer: pageUrl.href, cookies: async target => {
        assertCurrent();
        const cookies = await state.session.cookies.get({ url: target.href });
        assertCurrent();
        if (cookies.length > 128) throw new CollectionError();
        const sameSite = isSchemefulSameSite(pageUrl, target);
        return cookies.filter(c => (!c.secure || target.protocol === 'https:') && (c.expirationDate === undefined || c.expirationDate > Date.now() / 1000) && (sameSite || (c.sameSite === 'no_restriction' && c.secure))).sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0)).map(c => `${c.name}=${c.value}`).join('; ');
      } });
      assertCurrent();
      const mime = downloaded.mimeType as ByteImport['mimeType'];
      const file: ByteImport = { name: 'collected-image', mimeType: mime, base64: downloaded.buffer.toString('base64') };
      if (operation === 'preview') {
        const result = await options.hostRequest('host.previewCollectionImage', { file }); assertCurrent();
        return result as CollectionOutput<K>;
      }
      if (!state.page) throw new CollectionError('当前页面来源已失效，请重新读取。');
      job.importing = true;
      const result = await options.hostRequest('host.importCollectedAsset', { requestId, projectId: state.projectId, file, source: { platform: sourcePage.platform, pageUrl: sourcePage.url, title: sourcePage.title, collectedAt: new Date().toISOString() } });
      // Once committed, a late reply remains a truthful success; sources/project queries are authoritative.
      return result as CollectionOutput<K>;
    } catch (error) {
      if (error instanceof CollectionError) throw error;
      throw new CollectionError(controller.signal.aborted ? '读取已取消。已提交的导入可在项目素材和采集来源中查询。' : '图片处理失败，请重新查询项目素材后重试。');
    } finally { busyImages--; state.jobs.delete(requestId); }
  };
  const dispatch = async (operation: CollectionOperation, input: unknown): Promise<unknown> => {
    if (shuttingDown) throw new CollectionError('采集服务已关闭。');
    switch (operation) {
      case 'open': {
        if (opening) throw new CollectionError('采集窗口正在打开，请稍后重试。');
        opening = true;
        try { return await open(input as CollectionInput<'open'>); } finally { opening = false; }
      }
      case 'sources': return options.hostRequest('host.collectionSources', input as CollectionInput<'sources'>);
      case 'status': return snapshot(get((input as CollectionInput<'status'>).collectionId, false));
      case 'refresh': return refresh(get((input as CollectionInput<'refresh'>).collectionId));
      case 'close': case 'clearSession': await closeState(get((input as CollectionInput<'close'>).collectionId, false)); return null;
      case 'preview': return image('preview', input as CollectionInput<'preview'>);
      case 'import': return image('import', input as CollectionInput<'import'>);
      case 'addImage': {
        const value = input as CollectionInput<'addImage'>; const state = get(value.collectionId);
        const revision = state.revision; const url = parseWebUrl(value.url); await validateTarget(url, policy);
        if (state.revision !== revision || state.state !== 'OPEN') throw new CollectionError('页面已变化，请重新添加图片。');
        if (!state.page) updatePage(state);
        if (!state.page) throw new CollectionError('请先打开来源网页。');
        if (![...state.candidates.values()].some(c => c.url === url.href)) {
          if (state.candidates.size >= 80) throw new CollectionError('本次候选已达上限，请重新读取页面。');
          const candidate = { id: randomUUID(), url: url.href, width: 0, height: 0, label: '手动图片链接' }; state.candidates.set(candidate.id, candidate);
        }
        return snapshot(state);
      }
    }
  };
  return {
    invoke: (operation, input) => track((async () => {
      try {
        if (typeof operation !== 'string' || !Object.hasOwn(collectionOperations, operation)) throw new CollectionError('不支持此采集操作。');
        const key = operation as CollectionOperation;
        if (!Value.Check(collectionOperations[key].input, input)) throw new CollectionError('采集参数无效。');
        const result = await dispatch(key, input);
        if (!Value.Check(collectionOperations[key].output, result)) throw new CollectionError('采集返回数据无效。');
        return result;
      } catch (error) { if (error instanceof CollectionError) throw error; throw new CollectionError('采集操作失败，请重新查询状态。'); }
    })()),
    close: async () => { shuttingDown = true; await Promise.allSettled([...states.values()].map(closeState)); while (inFlight.size) await Promise.allSettled([...inFlight]); states.clear(); },
  };
}
/** 正式采集入口不读取测试环境变量，也不允许放宽网络策略。 */
export function createCollectionService(options: CollectionServiceOptions): CollectionService { return createScopedCollectionService(options, publicTransportPolicy); }
