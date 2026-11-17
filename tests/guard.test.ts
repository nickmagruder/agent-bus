import { describe, expect, it } from 'vitest';
import { bearerMatches, checkRequest } from '../src/spike/guard.ts';

const token = 'a'.repeat(40);
const options = { port: 47823, token };
const valid = {
  host: '127.0.0.1:47823',
  origin: undefined,
  authorization: `Bearer ${token}`,
};

describe('checkRequest', () => {
  it('accepts a local client with the right token and no Origin', () => {
    expect(checkRequest(valid, options)).toEqual({ ok: true });
  });

  it.each(['127.0.0.1:47823', 'localhost:47823', 'LOCALHOST:47823'])('accepts Host %s', (host) => {
    expect(checkRequest({ ...valid, host }, options).ok).toBe(true);
  });

  it.each([undefined, '', 'evil.example:47823', '127.0.0.1:1234', '0.0.0.0:47823', '127.0.0.1'])(
    'rejects Host %s with 403',
    (host) => {
      expect(checkRequest({ ...valid, host }, options)).toMatchObject({ ok: false, status: 403 });
    },
  );

  it.each(['http://127.0.0.1:47823', 'http://localhost:47823'])('accepts Origin %s', (origin) => {
    expect(checkRequest({ ...valid, origin }, options).ok).toBe(true);
  });

  it.each(['https://evil.example', 'null', 'http://127.0.0.1:1234', ''])(
    'rejects Origin %s with 403 (DNS rebinding)',
    (origin) => {
      expect(checkRequest({ ...valid, origin }, options)).toMatchObject({ ok: false, status: 403 });
    },
  );

  it('checks Host before the token, so a rebinding page learns nothing about auth', () => {
    expect(
      checkRequest({ host: 'evil.example', origin: undefined, authorization: undefined }, options),
    ).toMatchObject({ status: 403 });
  });

  it.each([
    undefined,
    '',
    token,
    `Basic ${token}`,
    'Bearer ',
    `Bearer ${token.slice(1)}`,
    `Bearer ${token}x`,
    `Bearer ${'b'.repeat(40)}`,
  ])('rejects Authorization %s with 401', (authorization) => {
    expect(checkRequest({ ...valid, authorization }, options)).toMatchObject({
      ok: false,
      status: 401,
    });
  });
});

describe('bearerMatches', () => {
  it('matches only the exact token', () => {
    expect(bearerMatches(`Bearer ${token}`, token)).toBe(true);
    expect(bearerMatches(`bearer ${token}`, token)).toBe(false);
  });
});
