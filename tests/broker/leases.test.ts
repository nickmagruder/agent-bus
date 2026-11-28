import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { digestText } from '../../src/broker/digest.ts';
import { startHttpServer, type RunningHttpServer } from '../../src/broker/http.ts';
import { Inbox } from '../../src/broker/inbox.ts';
import { LEASES, Leases } from '../../src/broker/leases.ts';
import { silentLogger } from '../../src/broker/log.ts';
import { Notifier, Questions } from '../../src/broker/questions.ts';
import { BusService } from '../../src/broker/service.ts';
import { toBreakClick } from '../../src/broker/slack/inbound.ts';
import { DM_TARGET, Store, type OutboxRecord } from '../../src/broker/store.ts';
import { loadBrokerConfig } from '../../src/shared/config.ts';
import type { Platform } from '../../src/shared/platform.ts';
import { TOKENS, USER_ID } from './fakes.ts';

/** #31: repo leases (D6, Q7, Q22). */

const HOUR = 60 * 60_000;
let now: Date;
let store: Store;
let service: BusService;
let leases: Leases;
let edits: { ts: string; blocks: unknown[] }[];

function setUp(at: Store): void {
  store = at;
  service = new BusService(store, { kick: () => undefined }, () => now);
  edits = [];
  leases = new Leases({
    store,
    queue: { kick: () => undefined },
    repos: ['code-notes', 'vault'],
    humanUserId: USER_ID,
    editor: { update: (_channel, ts, _text, blocks) => edits.push({ ts, blocks }) },
    log: silentLogger,
    now: () => now,
  });
  service.useLeases(leases);
}

beforeEach(() => {
  now = new Date('2026-11-23T20:00:00Z');
  setUp(new Store(':memory:', { now: () => now }));
});

afterEach(() => store.close());

/** A SessionStart hook: the session and the context it hands the agent. */
function start(platform: Platform, app: string, project = 'code-notes') {
  const result = service.hook(platform, { event: 'SessionStart', appSessionId: app, project });
  return { id: result.session, context: result.context ?? '' };
}

function prompt(platform: Platform, app: string) {
  return service.hook(platform, { event: 'UserPromptSubmit', appSessionId: app });
}

function sessionOf(id: string) {
  const session = store.getSession(id);
  if (!session) throw new Error('no session');
  return session;
}

function dms(): OutboxRecord[] {
  const rows = store.db
    .prepare('SELECT id FROM outbox WHERE target = ? ORDER BY id')
    .all(DM_TARGET) as { id: number }[];
  return rows.map((row) => store.getPost(row.id)).filter((p): p is OutboxRecord => Boolean(p));
}

function events(kind: string): Record<string, unknown>[] {
  const rows = store.db.prepare('SELECT data FROM events WHERE kind = ? ORDER BY id').all(kind) as {
    data: string;
  }[];
  return rows.map((row) => JSON.parse(row.data) as Record<string, unknown>);
}

function breakBlock(post: OutboxRecord): string | undefined {
  const actions = (post.blocks ?? []).find(
    (block) => (block as { type: string }).type === 'actions',
  ) as { block_id: string } | undefined;
  return actions?.block_id;
}

describe('SessionStart in a leased repo', () => {
  it('claims a free lease and tells the agent it holds it', () => {
    const first = start('claude', 'app-1');
    expect(first.context).toContain(`bus ID is ${first.id}`);
    expect(first.context).toContain('you hold the lease on code-notes');
    expect(leases.current('code-notes')).toMatchObject({ holder: first.id, source: 'hook' });
    expect(events('lease.claimed')).toEqual([{ repo: 'code-notes', source: 'hook' }]);
  });

  it('warns a second session, and DMs Nick once with Break', () => {
    const first = start('claude', 'app-1');
    const second = start('codex', 'app-2');
    expect(second.context).toContain(`code-notes is leased to another session, ${first.id}`);
    expect(second.context).toContain("Don't edit files in code-notes");
    expect(leases.current('code-notes')?.holder).toBe(first.id);
    const [dm] = dms();
    expect(dm?.text).toBe(`code-notes is leased to ${first.id}`);
    expect(dm && breakBlock(dm)).toBe(`code-notes|${first.id}`);
    // The same session starting again (/clear) doesn't DM again.
    start('codex', 'app-2');
    expect(dms()).toHaveLength(1);
  });

  it('leaves other repos alone', () => {
    const other = start('claude', 'app-3', 'agent-bus');
    expect(other.context).not.toContain('lease');
    expect(leases.held()).toEqual([]);
  });

  it('keeps the lease for a holder that starts again, with its first claim time', () => {
    const first = start('claude', 'app-1');
    const since = leases.current('code-notes')?.claimedAt;
    now = new Date(now.getTime() + HOUR);
    expect(start('claude', 'app-1').context).toContain('you hold the lease');
    expect(leases.current('code-notes')).toMatchObject({ holder: first.id, claimedAt: since });
  });
});

describe('expiry and renewal', () => {
  it("lapses after 2 h of the holder's silence, and the next session takes it", () => {
    const first = start('claude', 'app-1');
    now = new Date(now.getTime() + LEASES.idleMs + 60_000);
    expect(leases.current('code-notes')).toBeUndefined();
    const second = start('codex', 'app-2');
    expect(second.context).toContain('you hold the lease on code-notes');
    expect(leases.current('code-notes')).toMatchObject({
      holder: second.id,
      claimedAt: now.toISOString(),
    });
    expect(leases.current('code-notes')?.holder).not.toBe(first.id);
  });

  it("is kept alive by the holder's activity (any hook)", () => {
    const first = start('claude', 'app-1');
    now = new Date(now.getTime() + 1.5 * HOUR);
    prompt('claude', 'app-1');
    now = new Date(now.getTime() + 1.5 * HOUR);
    expect(leases.current('code-notes')?.holder).toBe(first.id);
    expect(start('codex', 'app-2').context).toContain('leased to another session');
  });

  it('survives a broker restart', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'agent-bus-lease-'));
    try {
      store.close();
      setUp(new Store(path.join(dir, 'bus.db'), { now: () => now }));
      const first = start('claude', 'app-1');
      store.close();
      setUp(new Store(path.join(dir, 'bus.db'), { now: () => now }));
      expect(leases.current('code-notes')?.holder).toBe(first.id);
      expect(start('codex', 'app-2').context).toContain('leased to another session');
    } finally {
      store.close();
      setUp(new Store(':memory:', { now: () => now }));
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('a lapsed lease', () => {
  it('re-claimed by its old holder starts a new claim time', () => {
    const first = start('claude', 'app-1');
    now = new Date(now.getTime() + 5 * HOUR);
    const again = start('claude', 'app-1');
    expect(again.context).toContain('you hold the lease');
    expect(leases.current('code-notes')).toMatchObject({
      holder: first.id,
      claimedAt: now.toISOString(),
    });
    expect(events('lease.claimed')).toHaveLength(2);
  });

  it('is cleared by Break without telling the old holder to stop', () => {
    start('claude', 'app-1');
    start('codex', 'app-2');
    const [dm] = dms();
    if (!dm) throw new Error('no DM');
    now = new Date(now.getTime() + 5 * HOUR);
    expect(leases.breakByButton(breakBlock(dm) ?? '', USER_ID)).toBe('changed');
    expect(events('lease.broken')).toEqual([]);
    expect(prompt('claude', 'app-1').context ?? '').not.toContain('broke your lease');
    expect(JSON.stringify(store.getPost(dm.id)?.blocks)).toContain('no longer holds it');
  });
});

describe('claiming directly', () => {
  it('gives one holder to two claims in a row (the upsert re-checks the live holder)', () => {
    const a = sessionOf(start('claude', 'app-a', 'agent-bus').id);
    const b = sessionOf(start('codex', 'app-b', 'agent-bus').id);
    const outcomes = [leases.claim(a, 'vault', 'tool'), leases.claim(b, 'vault', 'tool')];
    expect(outcomes.map((o) => o.held)).toEqual([true, false]);
    expect(outcomes[1]).toMatchObject({ lease: { holder: a.id } });
  });

  it('releases only its own lease', () => {
    const first = sessionOf(start('claude', 'app-1').id);
    const second = sessionOf(start('codex', 'app-2').id);
    expect(leases.release(second, 'code-notes')).toBe(false);
    expect(leases.release(first, 'code-notes')).toBe(true);
    expect(leases.claim(second, 'code-notes', 'tool').held).toBe(true);
    expect(events('lease.released')).toEqual([{ repo: 'code-notes' }]);
  });
});

describe('Break from Slack', () => {
  it('frees the lease, edits the DM, and tells the old holder once at its next prompt', () => {
    const first = start('claude', 'app-1');
    start('codex', 'app-2');
    const [dm] = dms();
    if (!dm) throw new Error('no DM');
    expect(leases.breakByButton(breakBlock(dm) ?? '', USER_ID)).toBe('broken');
    expect(leases.current('code-notes')).toBeUndefined();
    expect(JSON.stringify(store.getPost(dm.id)?.blocks)).toContain('Broken');
    expect(store.getPost(dm.id) && breakBlock(store.getPost(dm.id) as OutboxRecord)).toBe(
      undefined,
    );
    expect(events('lease.broken')).toEqual([{ repo: 'code-notes', by: 'nick' }]);
    expect(
      store.db.prepare("SELECT session_id FROM events WHERE kind = 'lease.broken'").get(),
    ).toEqual({ session_id: first.id });

    const told = prompt('claude', 'app-1');
    expect(told.context).toContain('Nick broke your lease on code-notes');
    expect(prompt('claude', 'app-1').context ?? '').not.toContain('broke your lease');
  });

  it('tells a broken holder at its next claim instead of re-taking the lease (#102)', () => {
    const first = start('claude', 'app-1');
    start('codex', 'app-2');
    const [dm] = dms();
    leases.breakByButton(dm ? (breakBlock(dm) ?? '') : '', USER_ID);
    // SessionStart again (/clear) before any prompt: told, and nothing re-claimed.
    const again = start('claude', 'app-1');
    expect(again.context).toContain('Nick broke your lease on code-notes');
    expect(again.context).toContain("It wasn't re-claimed");
    expect(leases.current('code-notes')).toBeUndefined();
    expect(events('lease.claimed')).toHaveLength(1);
    // Told once, shared with the prompt: the prompt adds nothing, and the
    // next claim takes the free lease as usual.
    expect(prompt('claude', 'app-1').context ?? '').not.toContain('broke your lease');
    expect(start('claude', 'app-1').context).toContain('you hold the lease on code-notes');
    expect(leases.current('code-notes')?.holder).toBe(first.id);
  });

  it('names the new holder when the broken holder claims after another took it', () => {
    const first = sessionOf(start('claude', 'app-1').id);
    const second = sessionOf(start('codex', 'app-2').id);
    const [dm] = dms();
    leases.breakByButton(dm ? (breakBlock(dm) ?? '') : '', USER_ID);
    expect(leases.claim(second, 'code-notes', 'hook').held).toBe(true);
    const outcome = leases.claim(first, 'code-notes', 'tool');
    expect(outcome).toMatchObject({ held: false, broken: expect.any(String) as string });
    expect(outcome.lease?.holder).toBe(second.id);
    // The break notice stands in for the contention DM this time.
    expect(dms()).toHaveLength(1);
    // Once told, a claim is an ordinary contention.
    expect(leases.claim(first, 'code-notes', 'tool')).toMatchObject({
      held: false,
      lease: { holder: second.id },
    });
    expect('broken' in leases.claim(first, 'code-notes', 'tool')).toBe(false);
  });

  it('counts a prompt as telling: a later claim re-takes a free lease', () => {
    const first = start('claude', 'app-1');
    start('codex', 'app-2');
    const [dm] = dms();
    leases.breakByButton(dm ? (breakBlock(dm) ?? '') : '', USER_ID);
    expect(prompt('claude', 'app-1').context).toContain('Nick broke your lease');
    expect(leases.claim(sessionOf(first.id), 'code-notes', 'tool')).toMatchObject({ held: true });
  });

  it('edits a DM already sent to Slack', () => {
    start('claude', 'app-1');
    start('codex', 'app-2');
    const [dm] = dms();
    if (!dm) throw new Error('no DM');
    store.markSent(dm.id, 'D_NICK', '1800000000.000200');
    leases.breakByButton(breakBlock(dm) ?? '', USER_ID);
    expect(edits.at(-1)?.ts).toBe('1800000000.000200');
  });

  it("only counts Nick's click: another user's is dropped and audited (T5)", () => {
    const first = start('claude', 'app-1');
    expect(leases.breakByButton(`code-notes|${first.id}`, 'U_OTHER')).toBe('not_human');
    expect(leases.current('code-notes')?.holder).toBe(first.id);
    expect(events('inbound.dropped')).toEqual([
      { reason: 'not_human', user: 'U_OTHER', repo: 'code-notes', via: 'lease_button' },
    ]);
  });

  it('breaks nothing once the lease changed hands', () => {
    const first = start('claude', 'app-1');
    start('codex', 'app-2');
    const [dm] = dms();
    leases.release(sessionOf(first.id), 'code-notes');
    const third = start('codex', 'app-3');
    expect(leases.breakByButton(dm ? (breakBlock(dm) ?? '') : '', USER_ID)).toBe('changed');
    expect(leases.current('code-notes')?.holder).toBe(third.id);
  });

  it('reads the lease from the block ID', () => {
    const body = { user: { id: USER_ID } };
    const action = { type: 'button', action_id: 'agentbus_lease_break', block_id: 'vault|x/y/1' };
    expect(toBreakClick(body, action)).toEqual({ blockId: 'vault|x/y/1', userId: USER_ID });
    expect(toBreakClick(body, { ...action, action_id: 'agentbus_flag_cancel' })).toBeUndefined();
  });
});

describe('the lease tools over MCP', () => {
  let http: RunningHttpServer;

  beforeEach(async () => {
    const notifier = new Notifier();
    const questions = new Questions({
      store,
      queue: { kick: () => undefined },
      notifier,
      editor: { update: () => undefined },
      humanUserId: USER_ID,
      log: silentLogger,
    });
    const inbox = new Inbox({
      store,
      queue: { kick: () => undefined },
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
      leases,
      log: silentLogger,
    });
  });

  afterEach(async () => {
    await http.close();
  });

  async function connect(platform: Platform): Promise<Client> {
    const client = new Client({ name: `vitest-${platform}`, version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.port}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${TOKENS[platform]}` } },
      }),
    );
    return client;
  }

  it('lets Copilot claim and release, needs the key, and refuses a repo that isn’t leased', async () => {
    const registered = service.register({
      platform: 'copilot',
      purpose: 'Notes',
      project: 'vault',
    });
    const client = await connect('copilot');
    const call = (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: { session: registered.session.id, ...args } });

    expect((await call('claim_lease', {})).isError).toBe(true); // no key
    const claimed = await call('claim_lease', { key: registered.key });
    expect(claimed.structuredContent).toMatchObject({ repo: 'vault', held: true });
    // Only its own project: a stray agent can't warn the real ones off another repo.
    const other = await call('claim_lease', { key: registered.key, repo: 'code-notes' });
    expect(other.isError).toBe(true);
    expect(JSON.stringify(other.content)).toContain('You can only lease your own project');
    expect(leases.current('code-notes')).toBeUndefined();
    // A project that isn't leased needs no lease.
    const elsewhere = service.register({
      platform: 'copilot',
      purpose: 'Bus',
      project: 'agent-bus',
    });
    const unleased = await client.callTool({
      name: 'claim_lease',
      arguments: { session: elsewhere.session.id, key: elsewhere.key },
    });
    expect(JSON.stringify(unleased.content)).toContain("isn't a leased repo");

    const released = await call('release_lease', { key: registered.key });
    expect(released.structuredContent).toEqual({ repo: 'vault', released: true });
    await client.close();
  });

  /** A Copilot session holding vault's lease, broken by Nick after a Claude session met it. */
  function brokenCopilot() {
    const registered = service.register({
      platform: 'copilot',
      purpose: 'Notes',
      project: 'vault',
    });
    leases.claim(registered.session, 'vault', 'tool');
    start('claude', 'app-1', 'vault');
    const [dm] = dms();
    expect(leases.breakByButton(dm ? (breakBlock(dm) ?? '') : '', USER_ID)).toBe('broken');
    return registered;
  }

  it('tells a broken Copilot holder at its next claim_lease, once, without re-taking (#102)', async () => {
    const registered = brokenCopilot();
    const client = await connect('copilot');
    const claim = () =>
      client.callTool({
        name: 'claim_lease',
        arguments: { session: registered.session.id, key: registered.key },
      });
    const told = await claim();
    expect(told.structuredContent).toMatchObject({ repo: 'vault', held: false, broken: true });
    // Codex and Copilot read only structuredContent (#64).
    expect(JSON.stringify(told.structuredContent)).toContain('Nick broke your lease on vault');
    expect(leases.current('vault')).toBeUndefined();
    // Told once: the next claim takes the free lease.
    const again = await claim();
    expect(again.structuredContent).toMatchObject({ held: true, holder: registered.session.id });
    expect(JSON.stringify(again.structuredContent)).not.toContain('broke your lease');
    await client.close();
  });

  it('hands the broken-lease notice to a keyed check_inbox, once (#102)', async () => {
    const registered = brokenCopilot();
    const client = await connect('copilot');
    const inboxCall = (key?: string) =>
      client.callTool({
        name: 'check_inbox',
        arguments: { session: registered.session.id, ...(key ? { key } : {}) },
      });
    // Without the key: not handed over (anyone may know a session ID).
    expect(JSON.stringify(await inboxCall())).not.toContain('broke your lease');
    // Nor with a wrong key, which falls back to the keyless answer.
    const wrong = await inboxCall(`abk_${'x'.repeat(43)}`);
    expect(wrong.structuredContent).toMatchObject({ keyRejected: true });
    expect(JSON.stringify(wrong)).not.toContain('broke your lease');
    const told = await inboxCall(registered.key);
    expect(told.structuredContent).toMatchObject({
      leaseBroken: { from: 'agent-bus', trust: 'agent-bus' },
    });
    expect(JSON.stringify(told.structuredContent)).toContain('Nick broke your lease on vault');
    expect(JSON.stringify(told.content)).toContain('Nick broke your lease on vault');
    expect(JSON.stringify((await inboxCall(registered.key)).structuredContent)).not.toContain(
      'leaseBroken',
    );
    // Already told, so a claim re-takes the free lease.
    const claimed = await client.callTool({
      name: 'claim_lease',
      arguments: { session: registered.session.id, key: registered.key },
    });
    expect(claimed.structuredContent).toMatchObject({ held: true });
    await client.close();
  });

  it('tells a second claimant who holds the lease', async () => {
    const holder = start('claude', 'app-1', 'vault');
    const registered = service.register({
      platform: 'copilot',
      purpose: 'Notes',
      project: 'vault',
    });
    const client = await connect('copilot');
    const result = await client.callTool({
      name: 'claim_lease',
      arguments: { session: registered.session.id, key: registered.key },
    });
    expect(result.structuredContent).toMatchObject({ held: false, holder: holder.id });
    expect(dms()).toHaveLength(1);
    await client.close();
  });
});

describe('the digest and config', () => {
  it('lists held leases', () => {
    const first = start('claude', 'app-1');
    const text = digestText({
      since: new Date(0),
      timeZone: 'America/Los_Angeles',
      items: [],
      questions: [],
      sessions: [],
      leases: leases.held(),
      sessionById: () => undefined,
    });
    expect(text).toContain('*Leases* (1)');
    expect(text).toContain(`\`code-notes\` held by \`${first.id}\``);
  });

  it('reads AGENT_BUS_LEASE_REPOS as project names', () => {
    const env = {
      SLACK_BOT_TOKEN: 'xoxb-test',
      SLACK_APP_TOKEN: 'xapp-test',
      SLACK_USER_ID: USER_ID,
      AGENT_BUS_TOKEN_CLAUDE: TOKENS.claude,
      AGENT_BUS_TOKEN_CODEX: TOKENS.codex,
      AGENT_BUS_TOKEN_COPILOT: TOKENS.copilot,
    };
    expect(loadBrokerConfig(env).leaseRepos).toEqual([]);
    expect(
      loadBrokerConfig({ ...env, AGENT_BUS_LEASE_REPOS: ' code-notes , vault-2 ,' }).leaseRepos,
    ).toEqual(['code-notes', 'vault-2']);
    // Names sessions could never report (projectSlug lowercases and keeps only
    // letters, digits and hyphens) fail at startup instead of leasing nothing.
    for (const bad of ['owner/repo', 'a b', '..', 'Code-Notes', 'code_notes', 'my.vault', 'misc']) {
      expect(() => loadBrokerConfig({ ...env, AGENT_BUS_LEASE_REPOS: bad })).toThrow(
        /AGENT_BUS_LEASE_REPOS/,
      );
    }
  });
});
