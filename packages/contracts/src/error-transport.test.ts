import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { AppErrorSchema, PublicErrorTransportSchema, decodePublicErrorMessage, publicErrorDisplayMessage, type PublicErrorTransport } from './error-transport.js';

const encode = (code: string, message: string) => JSON.stringify({
  kind: 'ecomgen.public-error', version: 1, error: { code, message },
} satisfies PublicErrorTransport);

describe('public contextBridge error transport', () => {
  it.each(['CONFLICT', 'REVISION_CONFLICT', 'NOT_FOUND', 'BACKEND_UNAVAILABLE', 'NEW_DOMAIN_CODE'])('preserves %s and human text without interpreting message contents', code => {
    const message = '草稿已更新，请刷新。\n“引号” \\ {"code":"OTHER"}';
    const decoded = decodePublicErrorMessage(encode(code, message));
    expect(decoded).toEqual({ code, message });
    expect(Value.Check(AppErrorSchema, decoded)).toBe(true);
    expect(publicErrorDisplayMessage(encode(code, message))).toBe(message);
  });

  it.each([
    'connection closed', '', 'null', '[]', '{',
    JSON.stringify({ code: 'CONFLICT', message: 'plain object' }),
    JSON.stringify({ kind: 'other', version: 1, error: { code: 'CONFLICT', message: 'wrong marker' } }),
    JSON.stringify({ kind: 'ecomgen.public-error', version: 2, error: { code: 'CONFLICT', message: 'future version' } }),
    JSON.stringify({ kind: 'ecomgen.public-error', version: 1, error: { code: 409, message: 'wrong type' } }),
    JSON.stringify({ kind: 'ecomgen.public-error', version: 1, error: { code: 'CONFLICT' } }),
    JSON.stringify({ kind: 'ecomgen.public-error', version: 1, error: { code: 'CONFLICT', message: 'text', stack: 'private stack' } }),
    JSON.stringify({ kind: 'ecomgen.public-error', version: 1, error: { code: 'CONFLICT', message: 'text' }, rawResponse: 'private payload' }),
    `Error invoking remote method: ${encode('CONFLICT', 'wrapped')}`,
  ])('rejects unmarked, malformed or extended messages: %s', message => {
    expect(decodePublicErrorMessage(message)).toBeUndefined();
  });

  it('keeps genuine infrastructure text and hides a damaged internal envelope', () => {
    expect(publicErrorDisplayMessage('IPC channel closed')).toBe('IPC channel closed');
    expect(publicErrorDisplayMessage('{"kind":"ecomgen.public-error","version":2}')).toBe('本地后台操作失败');
    expect(Value.Check(PublicErrorTransportSchema, { kind: 'ecomgen.public-error', version: 1, error: { code: 'X', message: 'text' } })).toBe(true);
  });
});
