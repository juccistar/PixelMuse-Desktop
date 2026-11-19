import { describe, expect, it } from 'vitest';
import { resourceRequestOrigin } from './resource-origin';

const devOrigin = 'http://127.0.0.1:5173';
describe('受管资源 CORS 来源边界', () => {
  it.each([undefined, devOrigin])('file renderer 的匿名图片、opaque fetch 和无 Origin 请求（开发源 %s）', configuredOrigin => {
    expect(resourceRequestOrigin('file://', configuredOrigin)).toBe('file://');
    expect(resourceRequestOrigin('null', configuredOrigin)).toBe('null');
    expect(resourceRequestOrigin(null, configuredOrigin)).toBe('null');
  });

  it.each([devOrigin, 'https://localhost:5173'])('仅回显显式开发服务器的准确 origin %s', configuredOrigin => {
    expect(resourceRequestOrigin(configuredOrigin, configuredOrigin)).toBe(configuredOrigin);
    expect(resourceRequestOrigin(configuredOrigin)).toBeUndefined();
  });

  it.each([
    '', 'NULL', '*', 'undefined', ' file://', 'file:// ', 'file:', 'file:/', 'file:///',
    'file://localhost', 'file://remote/share', 'file:///C:/app/index.html', 'file://?x=1', 'file://#fragment',
    'http://127.0.0.1:5174', 'http://localhost:5173', 'https://127.0.0.1:5173',
    'http://127.0.0.1:5173/', 'http://127.0.0.1:5173/path', 'http://127.0.0.1:5173?query',
    'http://127.0.0.1:5173#fragment', 'http://127.0.0.1:5173.attacker.invalid',
    'http://user@127.0.0.1:5173', 'http://[', 'http://user@attacker.invalid',
    'https://attacker.invalid', 'null https://attacker.invalid', 'file://,null',
    'data:text/html,test', 'ecomgen-resource://ASSET/id', 'ws://127.0.0.1:5173',
  ])('拒绝任意外部、带路径或畸形 origin %s', origin => {
    expect(resourceRequestOrigin(origin)).toBeUndefined();
    expect(resourceRequestOrigin(origin, devOrigin)).toBeUndefined();
  });

  it.each(['http://[', 'http://localhost:5173/path', 'file://remote', 'data:text/plain,test', '*'])('无效开发配置不能额外授权 %s', origin => {
    expect(resourceRequestOrigin(origin, origin)).toBeUndefined();
  });
});
