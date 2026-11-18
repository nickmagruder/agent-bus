import { describe, expect, it } from 'vitest';
import { checkRequest, platformForBearer } from '../../src/shared/guard.ts';
import { PLATFORMS } from '../../src/shared/platform.ts';
import { TOKENS } from './fakes.ts';

const port = 47823;
const options = { port, tokens: TOKENS };
const host = `127.0.0.1:${port}`;

describe('platformForBearer', () => {
  it.each(PLATFORMS)('maps the %s token to its platform', (platform) => {
    expect(platformForBearer(`Bearer ${TOKENS[platform]}`, TOKENS)).toBe(platform);
  });

  it.each([
    ['no header', undefined],
    ['empty', ''],
    ['wrong scheme', `Basic ${TOKENS.claude}`],
    ['lowercase scheme', `bearer ${TOKENS.claude}`],
    ['token prefix only', `Bearer ${TOKENS.claude.slice(0, 10)}`],
    ['token plus extra', `Bearer ${TOKENS.claude}x`],
    ['unknown token', `Bearer ${'z'.repeat(48)}`],
    ['empty token', 'Bearer '],
  ])('rejects %s', (_, header) => {
    expect(platformForBearer(header, TOKENS)).toBeUndefined();
  });
});

describe('checkRequest', () => {
  it.each(PLATFORMS)('accepts %s with a local Host and no Origin', (platform) => {
    expect(
      checkRequest(
        { host, origin: undefined, authorization: `Bearer ${TOKENS[platform]}` },
        options,
      ),
    ).toEqual({ ok: true, platform });
  });

  it.each([`localhost:${port}`, `LOCALHOST:${port}`, host])('accepts Host %s', (h) => {
    const result = checkRequest(
      { host: h, origin: undefined, authorization: `Bearer ${TOKENS.codex}` },
      options,
    );
    expect(result.ok).toBe(true);
  });

  it.each([
    undefined,
    'evil.example',
    `evil.example:${port}`,
    `127.0.0.1:${port + 1}`,
    '127.0.0.1',
    `0.0.0.0:${port}`,
    `[::1]:${port}`,
  ])('rejects Host %s with 403 even with a valid token', (h) => {
    expect(
      checkRequest(
        { host: h, origin: undefined, authorization: `Bearer ${TOKENS.claude}` },
        options,
      ),
    ).toMatchObject({ ok: false, status: 403, reason: 'Host not allowed' });
  });

  it.each([`http://127.0.0.1:${port}`, `http://localhost:${port}`])('accepts Origin %s', (o) => {
    expect(
      checkRequest({ host, origin: o, authorization: `Bearer ${TOKENS.claude}` }, options).ok,
    ).toBe(true);
  });

  it.each(['https://evil.example', `https://127.0.0.1:${port}`, 'null', ''])(
    'rejects Origin %s with 403',
    (o) => {
      expect(
        checkRequest({ host, origin: o, authorization: `Bearer ${TOKENS.claude}` }, options),
      ).toMatchObject({ ok: false, status: 403, reason: 'Origin not allowed' });
    },
  );

  it('checks Host before the token, so a rebinding page learns nothing about it', () => {
    expect(
      checkRequest({ host: 'evil.example', origin: undefined, authorization: undefined }, options),
    ).toMatchObject({ status: 403 });
  });

  it('rejects a missing token with 401', () => {
    expect(
      checkRequest({ host, origin: undefined, authorization: undefined }, options),
    ).toMatchObject({ ok: false, status: 401 });
  });
});
