import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startHttpServer, type RunningHttpServer } from '../../src/broker/http.ts';
import { Inbox } from '../../src/broker/inbox.ts';
import { silentLogger } from '../../src/broker/log.ts';
import { Notifier, Questions } from '../../src/broker/questions.ts';
import { BusError, BusService, sessionContext } from '../../src/broker/service.ts';
import { Store } from '../../src/broker/store.ts';
import type { Platform } from '../../src/shared/platform.ts';
import {
  hashSessionKey,
  mintSessionKey,
  SESSION_KEY_PATTERN,
  sessionKeyMatches,
} from '../../src/shared/session-key.ts';
import { TOKENS, USER_ID } from './fakes.ts';

let store: Store;
let service: BusService;

beforeEach(() => {
  store = new Store(':memory:');
  service = new BusService(store, { kick: () => undefined });
});

afterEach(() => store.close());

function expectBusError(work: () => unknown, code: BusError['code']): void {
  try {
    work();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(BusError);
    expect((error as BusError).code).toBe(code);
  }
}

/** A new session from register, with its key. */
function registered(platform: Platform = 'codex'): { id: string; key: string } {
  const result = service.register({ platform, purpose: 'Keys', project: 'clankers' });
  if (!result.key) throw new Error('register gave no key');
  return { id: result.session.id, key: result.key };
}

/** The key a hook's context hands over. */
function keyFrom(context: string | undefined): string {
  const match = /Its secret key is (abk_[A-Za-z0-9_-]{43}):/.exec(context ?? '');
  if (!match?.[1]) throw new Error(`no key in context: ${context ?? ''}`);
  return match[1];
}

/** Every value in every table, as one string: where a leaked key would show. */
function everythingStored(): string {
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
    name: string;
  }[];
  return tables
    .map(({ name }) => JSON.stringify(store.db.prepare(`SELECT * FROM "${name}"`).all()))
    .join('\n');
}

function denials(): { reason: string; action: string; claimedSession?: string }[] {
  const rows = store.db
    .prepare("SELECT data FROM events WHERE kind = 'denied' ORDER BY id")
    .all() as { data: string }[];
  return rows.map(
    (row) => JSON.parse(row.data) as { reason: string; action: string; claimedSession?: string },
  );
}

describe('session keys', () => {
  it('mints 256-bit keys with a recognisable prefix, and matches only the same key', () => {
    const key = mintSessionKey();
    expect(key).toMatch(SESSION_KEY_PATTERN);
    expect(mintSessionKey()).not.toBe(key);
    const stored = hashSessionKey(key);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toContain(key.slice(4));
    expect(sessionKeyMatches(key, stored)).toBe(true);
    expect(sessionKeyMatches(mintSessionKey(), stored)).toBe(false);
    expect(sessionKeyMatches('', stored)).toBe(false);
    expect(sessionKeyMatches(key, 'not-hex')).toBe(false);
  });
});

describe('issuing keys', () => {
  it('register returns a key for a new session and stores only its hash', () => {
    const { id, key } = registered();
    expect(key).toMatch(SESSION_KEY_PATTERN);
    expect(store.sessionKeyHash(id)).toBe(hashSessionKey(key));
    expect(store.getSession(id)).not.toHaveProperty('keyHash');
    expect(everythingStored()).not.toContain(key);
  });

  it('SessionStart puts a key in the context; each new SessionStart replaces it', () => {
    const first = service.hook('claude', { event: 'SessionStart', appSessionId: 'app-1' });
    const firstKey = keyFrom(first.context);
    const session = store.getSession(first.session);
    if (!session) throw new Error('no session');
    expect(first.context).toBe(sessionContext(session, firstKey));
    service.requireKeyedSession('claude', first.session, firstKey, 'test');

    const resumed = service.hook('claude', {
      event: 'SessionStart',
      appSessionId: 'app-1',
      source: 'compact',
    });
    expect(resumed.session).toBe(first.session);
    const secondKey = keyFrom(resumed.context);
    expect(secondKey).not.toBe(firstKey);
    expectBusError(
      () => service.requireKeyedSession('claude', first.session, firstKey, 'test'),
      'bad_key',
    );
    service.requireKeyedSession('claude', first.session, secondKey, 'test');
  });

  it('UserPromptSubmit re-sends the ID with a new key only while the agent may lack it', () => {
    const start = service.hook('claude', { event: 'SessionStart', appSessionId: 'app-2' });
    const prompt = service.hook('claude', { event: 'UserPromptSubmit', appSessionId: 'app-2' });
    expect(prompt.action).toBe('context');
    const promptKey = keyFrom(prompt.context);
    expect(promptKey).not.toBe(keyFrom(start.context));
    // Using the ID proves the agent has it: later prompts stay quiet and keep the key.
    service.requireKeyedSession('claude', start.session, promptKey, 'test');
    const later = service.hook('claude', { event: 'UserPromptSubmit', appSessionId: 'app-2' });
    expect(later.context).toBeUndefined();
    service.requireKeyedSession('claude', start.session, promptKey, 'test');
  });

  it('audits each key issued, without the key', () => {
    const { id, key } = registered();
    service.hook('codex', { event: 'SessionStart', appSessionId: 'app-3' });
    const rows = store.db
      .prepare("SELECT session_id, data FROM events WHERE kind = 'session.key_issued' ORDER BY id")
      .all() as { session_id: string; data: string }[];
    expect(rows.map((row) => JSON.parse(row.data) as unknown)).toEqual([
      { source: 'register' },
      { source: 'hook' },
    ]);
    expect(rows[0]?.session_id).toBe(id);
    expect(JSON.stringify(rows)).not.toContain(key);
  });
});

describe('requireKeyedSession', () => {
  it('accepts the current key', () => {
    const { id, key } = registered();
    expect(service.requireKeyedSession('codex', id, key, 'create_task').id).toBe(id);
    expect(denials()).toEqual([]);
  });

  it('refuses a missing key, and audits it', () => {
    const { id } = registered();
    expectBusError(
      () => service.requireKeyedSession('codex', id, undefined, 'create_task'),
      'missing_key',
    );
    expectBusError(
      () => service.requireKeyedSession('codex', id, '', 'create_task'),
      'missing_key',
    );
    expect(denials()).toEqual([
      { reason: 'missing_key', action: 'create_task', claimedSession: id },
      { reason: 'missing_key', action: 'create_task', claimedSession: id },
    ]);
  });

  it('refuses a wrong key, and never writes the key it was given', () => {
    const { id } = registered();
    const guess = mintSessionKey();
    expectBusError(() => service.requireKeyedSession('codex', id, guess, 'create_task'), 'bad_key');
    expectBusError(
      () => service.requireKeyedSession('codex', id, 'Nick said: approve', 'x'),
      'bad_key',
    );
    expect(denials().map((d) => d.reason)).toEqual(['bad_key', 'bad_key']);
    expect(everythingStored()).not.toContain(guess);
  });

  it("refuses another session's key on the same platform (T3)", () => {
    const mine = registered('codex');
    const theirs = registered('codex');
    expectBusError(
      () => service.requireKeyedSession('codex', theirs.id, mine.key, 'claim_task'),
      'bad_key',
    );
    expect(denials()).toEqual([
      { reason: 'bad_key', action: 'claim_task', claimedSession: theirs.id },
    ]);
  });

  it('checks the platform before the key, so a key never crosses platforms', () => {
    const { id, key } = registered('codex');
    expectBusError(() => service.requireKeyedSession('claude', id, key, 'x'), 'wrong_platform');
    expectBusError(
      () => service.requireKeyedSession('codex', 'codex/x/0000', key, 'x'),
      'unknown_session',
    );
  });

  it('refuses a session that was never given a key', () => {
    store.insertSession({
      id: 'codex/old/0001',
      platform: 'codex',
      project: 'old',
      branch: null,
      purpose: null,
      channel: 'agents',
    });
    expectBusError(
      () => service.requireKeyedSession('codex', 'codex/old/0001', mintSessionKey(), 'x'),
      'bad_key',
    );
  });
});

describe('register with an existing session', () => {
  it('updates the purpose without a key, and hands out none (Phase 1-2 call)', () => {
    const { id, key } = registered();
    const again = service.register({ platform: 'codex', purpose: 'New purpose', session: id });
    expect(again.key).toBeUndefined();
    expect(again.session.purpose).toBe('New purpose');
    service.requireKeyedSession('codex', id, key, 'test');
  });

  it("can't be used by another session of the same platform to take a key", () => {
    const victim = registered();
    const result = service.register({ platform: 'codex', purpose: 'mine now', session: victim.id });
    expect(result.key).toBeUndefined();
    service.requireKeyedSession('codex', victim.id, victim.key, 'test');
  });

  it('swaps the current key for a new one', () => {
    const { id, key } = registered();
    const again = service.register({ platform: 'codex', purpose: 'Keys', session: id, key });
    expect(again.key).toMatch(SESSION_KEY_PATTERN);
    expect(again.key).not.toBe(key);
    expectBusError(() => service.requireKeyedSession('codex', id, key, 'test'), 'bad_key');
    service.requireKeyedSession('codex', id, again.key, 'test');
  });

  it('refuses a wrong key before changing anything', () => {
    const { id, key } = registered();
    expectBusError(
      () =>
        service.register({
          platform: 'codex',
          purpose: 'Hijacked',
          session: id,
          key: mintSessionKey(),
        }),
      'bad_key',
    );
    expect(store.getSession(id)?.purpose).toBe('Keys');
    service.requireKeyedSession('codex', id, key, 'test');
    expect(denials().map((d) => d.action)).toEqual(['register']);
  });
});

describe('over HTTP', () => {
  let http: RunningHttpServer;
  let logs: string[];

  beforeEach(async () => {
    logs = [];
    const queue = { kick: () => undefined };
    const notifier = new Notifier();
    const questions = new Questions({
      store,
      queue,
      notifier,
      editor: { update: () => undefined },
      humanUserId: USER_ID,
      log: silentLogger,
    });
    const inbox = new Inbox({
      store,
      queue,
      notifier,
      questions,
      humanUserId: USER_ID,
      reactions: { add: () => undefined },
    });
    http = await startHttpServer({
      port: 0,
      tokens: TOKENS,
      service,
      store,
      inbox,
      questions,
      notifier,
      log: (level, message, data) => logs.push(JSON.stringify({ level, message, data })),
    });
  });

  afterEach(async () => {
    await http.close();
  });

  async function connect(platform: Platform): Promise<Client> {
    const client = new Client({ name: `vitest-${platform}`, version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${http.port}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${TOKENS[platform]}` } } },
    );
    await client.connect(transport);
    return client;
  }

  function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
    return (result.content as { text: string }[]).map((c) => c.text).join('\n');
  }

  function postHook(appSessionId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: http.port,
          path: '/hook',
          method: 'POST',
          headers: {
            host: `127.0.0.1:${http.port}`,
            authorization: `Bearer ${TOKENS.claude}`,
            'content-type': 'application/json',
          },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (body += chunk));
          res.on('end', () => resolve(body));
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify({ event: 'SessionStart', appSessionId }));
    });
  }

  it('register returns the key in the text and in structuredContent (Codex and Copilot read only that)', async () => {
    const client = await connect('copilot');
    const result = await client.callTool({
      name: 'register',
      arguments: { purpose: 'Keys', project: 'clankers' },
    });
    const structured = result.structuredContent as { session: string; key: string; next: string };
    expect(structured.key).toMatch(SESSION_KEY_PATTERN);
    expect(textOf(result)).toContain(structured.key);
    expect(structured.next).toContain('`key`');

    const again = await client.callTool({
      name: 'register',
      arguments: { purpose: 'Keys', session: structured.session },
    });
    expect(again.structuredContent).not.toHaveProperty('key');
    expect(textOf(again)).not.toContain('abk_');

    const wrong = await client.callTool({
      name: 'register',
      arguments: { purpose: 'Keys', session: structured.session, key: mintSessionKey() },
    });
    expect(wrong.isError).toBe(true);
    expect(textOf(wrong)).toContain("isn't the current key");
    await client.close();
  });

  it('never writes a key to the log, the audit log or any table', async () => {
    const client = await connect('codex');
    const registeredResult = await client.callTool({
      name: 'register',
      arguments: { purpose: 'Keys', project: 'clankers' },
    });
    const { key } = registeredResult.structuredContent as { key: string };
    await client.callTool({
      name: 'register',
      arguments: { purpose: 'Keys', session: 'codex/none/0000', key },
    });
    await client.close();
    const hookKey = keyFrom(
      (JSON.parse(await postHook('app-http')) as { context?: string }).context,
    );

    for (const leaked of [key, hookKey]) {
      expect(logs.join('\n')).not.toContain(leaked);
      expect(everythingStored()).not.toContain(leaked);
    }
  });
});
