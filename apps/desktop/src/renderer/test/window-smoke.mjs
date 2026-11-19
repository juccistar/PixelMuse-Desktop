import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile, rm } from 'node:fs/promises';
const rootRequire = createRequire('E:/EcomGen/desktop/package.json');
const appRequire = createRequire('E:/EcomGen/desktop/apps/desktop/package.json');
const { _electron } = rootRequire('playwright-core');
const esbuild = appRequire(appRequire.resolve('esbuild', { paths: [dirname(appRequire.resolve('electron-vite'))] }));
const dir = import.meta.dirname;
const keepArtifacts = process.env.ECOMGEN_KEEP_UI_ARTIFACTS === '1';
const { build } = await import(pathToFileURL(appRequire.resolve('vite')));
const { default: react } = await import(pathToFileURL(appRequire.resolve('@vitejs/plugin-react')));
await build({configFile:false,root:join(dir,'..'),base:'./',publicDir:join(dir,'../../../public'),plugins:[react()],logLevel:'warn',build:{outDir:join(dir,'bundle-output'),emptyOutDir:true}});
await esbuild.build({entryPoints:[join(dir,'window-smoke-main.ts')],outfile:join(dir,'window-main.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',target:'node22'});
await esbuild.build({entryPoints:[join(dir,'../../preload/index.ts')],outfile:join(dir,'window-preload.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron'],target:'node22'});
const electron = await _electron.launch({executablePath:appRequire('electron'),args:[join(dir,'window-main.mjs')],env:{...process.env,ELECTRON_RUN_AS_NODE:undefined},timeout:30000});
const results = []; const errors = [];
try {
  const page = await electron.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.getByText('项目画廊 · 暂无项目').waitFor();
  await page.getByText('本地后台已连接').waitFor();
  await page.screenshot({path:join(dir,'window-home.png')}); results.push('home');
  await page.getByRole('button',{name:'新建项目',exact:true}).click();
  await page.getByRole('button',{name:'收起配置面板'}).waitFor(); results.push('workbench');
  await page.getByRole('button',{name:'资产库',exact:true}).click(); await page.getByRole('heading',{name:'资产库',exact:true}).waitFor(); results.push('library');
  await page.getByRole('button',{name:'套图工坊',exact:true}).click(); await page.getByText('上传爆款套图').first().waitFor(); results.push('suite-forge');
  await page.getByRole('button',{name:'模特库',exact:true}).click(); await page.getByRole('heading',{name:'模特库',exact:true}).waitFor(); results.push('models');
  await page.getByRole('button',{name:'花型工坊',exact:true}).click(); await page.getByText('隔离花型',{exact:true}).waitFor(); results.push('patterns');
  await page.getByText('隔离花型',{exact:true}).click(); await page.getByRole('tab',{name:'平铺',exact:true}).waitFor();
  await page.getByRole('tab',{name:'平铺',exact:true}).click(); await page.getByText('平铺尺寸',{exact:true}).waitFor(); results.push('pattern-workspace');
  await page.getByRole('button',{name:'花型墙',exact:true}).click();
  await page.getByRole('button',{name:/草稿 ·/}).click(); await page.getByText('隔离草稿',{exact:true}).waitFor(); results.push('drafts');
  await page.getByText('隔离草稿',{exact:true}).click(); await page.getByLabel('草稿名称').waitFor();
  await page.getByLabel('草稿名称').click();
  await page.getByLabel('草稿名称').press('ControlOrMeta+A');
  await page.getByLabel('草稿名称').pressSequentially('窗口验证草稿', {delay:20});
  let persisted = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    const draft = await page.evaluate(() => window.ecomgen.invoke('getPatternDraft', {draftId:'bbbbbbbb-1111-4222-8333-444444444444'}));
    if (draft.name === '窗口验证草稿') { persisted = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!persisted) throw new Error('草稿名称未持久保存');
  await page.getByText('已保存',{exact:true}).waitFor();
  await page.waitForFunction(() => document.querySelector('input[aria-label="草稿名称"]')?.value === '窗口验证草稿', undefined, {timeout:5000});
  results.push('draft-workspace');
  await page.screenshot({path:join(dir,'window-draft.png')});
  if(errors.length)throw Error(errors.join('\n'));
  console.log(JSON.stringify({routes:results.length,passed:results,errors}));
  await writeFile(join(dir,'window-result.json'),JSON.stringify({routes:results.length,passed:results,errors},null,2));
} finally {
  await electron.evaluate(({BrowserWindow}) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); });
  await electron.close();
  await rm(join(dir,'gui-state'),{recursive:true,force:true});
  if (!keepArtifacts) for (const name of ['bundle-output','window-main.mjs','window-preload.cjs','window-home.png','window-draft.png','window-result.json']) await rm(join(dir,name),{recursive:true,force:true});
}
