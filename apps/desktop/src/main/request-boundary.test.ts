import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rendererRequestAllowed } from './request-boundary';
const root = resolve('E:/isolated-renderer');
describe('renderer 协议和文件请求范围', () => {
  it('允许安装目录内的页面/脚本/字体与合法受管资源', () => {
    expect(rendererRequestAllowed(pathToFileURL(resolve(root,'index.html')).href,root)).toBe(true);
    expect(rendererRequestAllowed(pathToFileURL(resolve(root,'assets','app.js')).href,root)).toBe(true);
    expect(rendererRequestAllowed('ecomgen-resource://LAYER_FILE/export-1/0',root)).toBe(true);
  });
  it.each(['https://provider.invalid/image','http://127.0.0.1:8787/api/v1/projects','file:///C:/Users/private.txt','file://remote/share/file.png','ecomgen-resource://ASSET/id?path=secret','ecomgen-resource://LAYER_FILE/id/256','javascript:alert(1)'])('阻止未授权读取 %s', url => {
    expect(rendererRequestAllowed(url,root)).toBe(false);
  });
  it('拒绝目录前缀碰撞和编码穿越', () => {
    expect(rendererRequestAllowed(pathToFileURL(resolve(root,'..','isolated-renderer-other','secret.png')).href,root)).toBe(false);
    expect(rendererRequestAllowed(pathToFileURL(root).href+'/%2e%2e/secret.png',root)).toBe(false);
  });
  it('开发模式只放行指定服务器的准确 origin 与 websocket', () => {
    expect(rendererRequestAllowed('http://127.0.0.1:5173/main.tsx',root,'http://127.0.0.1:5173')).toBe(true);
    expect(rendererRequestAllowed('ws://127.0.0.1:5173/',root,'http://127.0.0.1:5173')).toBe(true);
    expect(rendererRequestAllowed('http://127.0.0.1:5174/main.tsx',root,'http://127.0.0.1:5173')).toBe(false);
    expect(rendererRequestAllowed('http://127.0.0.1:5173.attacker.invalid/main.tsx',root,'http://127.0.0.1:5173')).toBe(false);
  });
});
