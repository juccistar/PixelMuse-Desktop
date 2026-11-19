import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { _electron } from 'playwright-core';

// 专项视觉检查：仅启动 renderer 开发服务器，复用已有宿主构建，不构建或覆盖 main。
const renderer = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = resolve(renderer, '../..');
const artifacts = process.argv[2] ? resolve(process.argv[2]) : await mkdtemp(join(tmpdir(), 'pixelmuse-render-'));
await mkdir(artifacts, { recursive: true });
const data = await mkdtemp(join(tmpdir(), 'pixelmuse-ui-data-'));
const server = await createServer({ configFile: false, root: renderer, plugins: [react()], server: { host: '127.0.0.1', port: 0 }, clearScreen: false });
let app;
const observations = [];
try {
    await server.listen();
    const address = server.httpServer.address();
    const env = { ...process.env, ELECTRON_RENDERER_URL: `http://127.0.0.1:${address.port}`, ECOMGEN_DESKTOP_DATA_DIR: data };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath: join(desktop, 'node_modules/electron/dist/electron.exe'), args: [desktop], cwd: desktop, env, timeout: 45000 });
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('heading', { name: '商品视觉创作工作台' }).waitFor({ timeout: 45000 });
    await page.getByText('本地后台已连接', { exact: true }).waitFor();
    const native = await page.evaluate(() => ({ workspace: typeof window.ecomgen.workspace, collection: typeof window.ecomgen.collection }));
    observations.push({ native });
    const sharp = createRequire(join(desktop, '../../packages/backend/package.json'))('sharp');
    const image = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#dedbd4' } }).png().toBuffer();
    await page.evaluate(async base64 => {
        const provider = await window.ecomgen.invoke('createProvider', { name: '本地渲染检查', baseUrl: 'https://provider.invalid/v1', reasoningProtocol: 'openai', apiKey: 'ui-render-test-only', models: [{ id: 'reasoning-test', supportsVision: true, supportsThinking: false, supportsTools: true, supportsStructuredOutput: true }, { id: 'image-test', supportsVision: false, supportsThinking: false, supportsTools: false, supportsStructuredOutput: false, imageApiKind: 'openai_images' }] });
        await window.ecomgen.invoke('createProject', { name: '视觉验收项目', reasoningProviderId: provider.id, reasoningModelId: 'reasoning-test', imageProviderId: provider.id, imageModelId: 'image-test', defaultMode: 'CREATIVE' });
        await window.ecomgen.invoke('createPatternDraft', { name: '视觉验收草稿', composeType: 'PLACEMENT' });
        await window.ecomgen.invoke('uploadPattern', { name: '视觉验收花型', file: { name: 'render-check.png', mimeType: 'image/png', base64 } });
    }, image.toString('base64'));
    const window = await app.browserWindow(page);
    for (const [width, height] of [[1440, 960], [1000, 700]]) {
        await window.evaluate((browser, size) => browser.setContentSize(...size), [width, height]);
        await page.getByRole('link', { name: 'PixelMuse', exact: true }).click();
        await page.getByRole('heading', { name: '商品视觉创作工作台' }).waitFor();
        const box = await page.evaluate(() => ({ viewport: window.innerWidth, content: document.documentElement.scrollWidth, background: getComputedStyle(document.body).backgroundColor }));
        assert.ok(box.content <= box.viewport, JSON.stringify(box));
        assert.equal(box.background, 'rgb(8, 8, 8)');
        const primary = await page.getByRole('button', { name: '新建项目', exact: true }).evaluate(element => ({ foreground: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
        assert.equal(primary.foreground, 'rgb(17, 17, 17)');
        assert.equal(primary.background, 'rgb(241, 241, 237)');
        await page.screenshot({ path: join(artifacts, `home-${width}.png`) });
        for (const [label, heading] of [['资产库', '资产库'], ['套图工坊', '把爆款套图，变成可复用模板'], ['模特库', '模特库'], ['花型工坊', '花型工坊'], ['创作草稿', '草稿']]) {
            await page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: label, exact: true }).click();
            await page.getByRole('heading', { name: heading, exact: true }).waitFor();
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
            assert.equal(overflow, false, `${label} at ${width} overflows the window`);
            await page.screenshot({ path: join(artifacts, `${label}-${width}.png`) });
        }
        await page.getByRole('link', { name: 'PixelMuse', exact: true }).click();
        await page.getByRole('link', { name: '视觉验收项目', exact: true }).click();
        await page.getByRole('navigation', { name: '工作阶段' }).waitFor();
        await page.getByLabel('上传素材', { exact: true }).waitFor({ state: 'attached' });
        await page.screenshot({ path: join(artifacts, `workbench-${width}.png`) });
        await page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '创作草稿', exact: true }).click();
        await page.getByRole('listitem').filter({ hasText: '视觉验收草稿' }).click();
        await page.getByLabel('草稿名称', { exact: true }).waitFor();
        await page.screenshot({ path: join(artifacts, `draft-workspace-${width}.png`) });
        await page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '花型工坊', exact: true }).click();
        await page.getByText('视觉验收花型', { exact: true }).click();
        await page.getByRole('heading', { name: '视觉验收花型', exact: true }).waitFor();
        await page.screenshot({ path: join(artifacts, `pattern-workspace-${width}.png`) });
        await page.getByRole('button', { name: '设置', exact: true }).click();
        await page.getByText('设置 · Provider', { exact: true }).waitFor();
        await page.waitForFunction(() => [...document.querySelectorAll('.ant-drawer-content-wrapper')].some(element => ['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(getComputedStyle(element).transform)));
        await page.screenshot({ path: join(artifacts, `settings-${width}.png`) });
        await page.keyboard.press('Escape');
        await page.getByText('设置 · Provider', { exact: true }).waitFor({ state: 'hidden' });
        observations.push({ viewport: [width, height], routes: 9, collectionRoutesOverflow: false });
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ artifacts, data, observations, rendererErrors: errors }, null, 2));
} finally {
    try { if (app) await app.close(); }
    finally { await server.close(); }
}
