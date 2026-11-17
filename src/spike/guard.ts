import { timingSafeEqual } from 'node:crypto';

/** Headers the guard needs from an incoming HTTP request. */
export interface GuardInput {
  host: string | undefined;
  origin: string | undefined;
  authorization: string | undefined;
}

export interface GuardOptions {
  port: number;
  token: string;
}

export type GuardResult = { ok: true } | { ok: false; status: 401 | 403; reason: string };

export function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

export function allowedOrigins(port: number): string[] {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}

/**
 * Rejects anything that isn't a same-machine, authenticated MCP client.
 *
 * Host and Origin checks block DNS rebinding (a web page making the browser
 * talk to 127.0.0.1); the MCP spec requires them for local HTTP servers.
 * Non-browser clients usually send no Origin, so Host is the check that
 * always applies. The bearer token stops other local programs.
 */
export function checkRequest(input: GuardInput, options: GuardOptions): GuardResult {
  const host = input.host?.toLowerCase();
  if (!host || !allowedHosts(options.port).includes(host)) {
    return { ok: false, status: 403, reason: 'Host not allowed' };
  }
  if (
    input.origin !== undefined &&
    !allowedOrigins(options.port).includes(input.origin.toLowerCase())
  ) {
    return { ok: false, status: 403, reason: 'Origin not allowed' };
  }
  if (!bearerMatches(input.authorization, options.token)) {
    return { ok: false, status: 401, reason: 'Missing or invalid bearer token' };
  }
  return { ok: true };
}

export function bearerMatches(header: string | undefined, token: string): boolean {
  const prefix = 'Bearer ';
  if (!header?.startsWith(prefix)) return false;
  const given = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
