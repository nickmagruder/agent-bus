import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { silentLogger } from '../../src/broker/log.ts';
import { startBroker, type Broker } from '../../src/broker/main.ts';
import type { Platform } from '../../src/shared/platform.ts';
import { FakeSlack, TOKENS, USER_ID } from './fakes.ts';

let dir: string;
let broker: Broker;
const slack = new FakeSlack();

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'agent-bus-broker-'));
  broker = await startBroker(
    {
      port: 0,
      dataDir: dir,
      tokens: TOKENS,
      slack: { botToken: 'xoxb-test', appToken: 'xapp-test', userId: USER_ID },
    },
    {
      log: silentLogger,
      slackApi: slack,
      connection: null,
      queueOptions: { minIntervalMs: 0 },
      digest: null,
      holdMs: HOLD_MS,
      tickMs: 60_000,
    },
  );
});

const HOLD_MS = 400;

afterAll(async () => {
  await broker.stop();
  await rm(dir, { recursive: true, force: true });
});

function raw(
  method: string,
  urlPath: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: broker.port, path: urlPath, method, headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end(method === 'POST' ? '{}' : undefined);
  });
}

async function connect(platform: Platform): Promise<Client> {
  const client = new Client({ name: `vitest-${platform}`, version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${broker.port}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${TOKENS[platform]}` } } },
  );
  await client.connect(transport);
  return client;
}

function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as { type: string; text: string }[]).map((c) => c.text).join('\n');
}

describe('HTTP hardening', () => {
  const host = () => `127.0.0.1:${broker.port}`;

  it('rejects requests without a token', async () => {
    expect((await raw('POST', '/mcp', { host: host() })).status).toBe(401);
    expect((await raw('GET', '/health', { host: host() })).status).toBe(401);
  });

  it('rejects a foreign Host or Origin even with a valid token', async () => {
    const auth = `Bearer ${TOKENS.claude}`;
    expect((await raw('POST', '/mcp', { host: 'evil.example', authorization: auth })).status).toBe(
      403,
    );
    expect(
      (
        await raw('POST', '/mcp', {
          host: host(),
          origin: 'https://evil.example',
          authorization: auth,
        })
      ).status,
    ).toBe(403);
  });

  it('answers /health with the caller platform', async () => {
    const res = await raw('GET', '/health', {
      host: host(),
      authorization: `Bearer ${TOKENS.codex}`,
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, platform: 'codex', slack: 'disabled' });
  });

  it('returns 404 and 405 for other paths and methods', async () => {
    const auth = { host: host(), authorization: `Bearer ${TOKENS.claude}` };
    expect((await raw('GET', '/nope', auth)).status).toBe(404);
    expect((await raw('GET', '/mcp', auth)).status).toBe(405);
    expect((await raw('POST', '/health', auth)).status).toBe(405);
  });

  it('rejects invalid JSON', async () => {
    const res = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: broker.port,
          path: '/mcp',
          method: 'POST',
          headers: { host: host(), authorization: `Bearer ${TOKENS.claude}` },
        },
        (r) => {
          r.resume();
          resolve(r.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end('{not json');
    });
    expect(res).toBe(400);
  });
});

describe('MCP tools end to end', () => {
  it('lists the tools', async () => {
    const client = await connect('claude');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'ask_human',
      'check_inbox',
      'notify_human',
      'register',
      'wait_for_reply',
    ]);
    await client.close();
  });

  async function registered(client: Client): Promise<string> {
    const result = await client.callTool({
      name: 'register',
      arguments: { purpose: 'Questions', project: 'clankers' },
    });
    return (result.structuredContent as { session: string }).session;
  }

  const askArgs = (session: string) => ({
    session,
    question: 'Ship it?',
    options: ['Yes', 'No'],
    default_action: 'Wait for review',
  });

  it('ask_human returns pending after the hold, then wait_for_reply gets the answer', async () => {
    const client = await connect('claude');
    const session = await registered(client);
    const asked = await client.callTool({ name: 'ask_human', arguments: askArgs(session) });
    const pending = asked.structuredContent as { state: string; question_id: string };
    expect(pending.state).toBe('pending');
    expect(text(asked)).toContain('wait_for_reply');

    setTimeout(() => broker.questions.answerByButton(pending.question_id, 0, USER_ID), 50);
    const answered = await client.callTool({
      name: 'wait_for_reply',
      arguments: { session, question_id: pending.question_id },
    });
    expect(answered.structuredContent).toMatchObject({
      state: 'answered',
      answer: 'Yes',
      source: 'button',
    });
    expect(text(answered)).toContain('Nick chose');
    await client.close();
  });

  it('ask_human returns the answer when it comes during the hold', async () => {
    const client = await connect('codex');
    const session = await registered(client);
    setTimeout(() => {
      const [open] = broker.store.openQuestions(session);
      if (open) broker.questions.answerByButton(open.id, 1, USER_ID);
    }, 50);
    const asked = await client.callTool({ name: 'ask_human', arguments: askArgs(session) });
    expect(asked.structuredContent).toMatchObject({ state: 'answered', answer: 'No' });
    await client.close();
  });

  it('ask_human requires a default action and refuses another platform', async () => {
    const claude = await connect('claude');
    const session = await registered(claude);
    const noDefault = await claude.callTool({
      name: 'ask_human',
      arguments: { session, question: 'Ship it?' },
    });
    expect(noDefault.isError).toBe(true);
    await claude.close();

    const copilot = await connect('copilot');
    const stolen = await copilot.callTool({ name: 'ask_human', arguments: askArgs(session) });
    expect(stolen.isError).toBe(true);
    expect(text(stolen)).toContain('another platform');
    const peek = await copilot.callTool({
      name: 'wait_for_reply',
      arguments: { session, question_id: 'q-000000' },
    });
    expect(peek.isError).toBe(true);
    await copilot.close();
  });

  it('wait_for_reply without a question returns a message that arrives while waiting', async () => {
    const client = await connect('claude');
    const session = await registered(client);
    const idle = await client.callTool({
      name: 'wait_for_reply',
      arguments: { session, timeout_seconds: 1 },
    });
    expect(idle.structuredContent).toMatchObject({
      state: 'pending',
      from: 'agent-bus',
      trust: 'agent-bus',
      next: expect.stringContaining('Call wait_for_reply again') as string,
    });

    await broker.queue.idle();
    const root = slack.posts.find((p) => p.text.includes(session));
    if (!root) throw new Error('no thread root');
    setTimeout(
      () =>
        broker.inbox.receive({
          channel: root.channel,
          channelType: 'channel',
          ts: '1800000001.000200',
          threadTs: root.ts,
          user: USER_ID,
          text: 'Also update the README',
          hasFiles: false,
        }),
      50,
    );
    const got = await client.callTool({ name: 'wait_for_reply', arguments: { session } });
    expect(text(got)).toContain('Also update the README');
    await client.close();
  });

  it('delivers my thread reply through check_inbox, once, to the owning platform only', async () => {
    const client = await connect('codex');
    const registered = await client.callTool({
      name: 'register',
      arguments: { purpose: 'Inbox test', project: 'clankers' },
    });
    const { session } = registered.structuredContent as { session: string };
    await broker.queue.idle();
    const root = slack.posts.find((p) => p.text.includes(session));
    if (!root) throw new Error('no thread root');

    const outcome = broker.inbox.receive({
      channel: root.channel,
      channelType: 'channel',
      ts: '1800000000.000100',
      threadTs: root.ts,
      user: USER_ID,
      text: 'Use the *second* option &amp; ship it',
      hasFiles: false,
    });
    expect(outcome).toMatchObject({ action: 'routed', sessionId: session });

    const copilot = await connect('copilot');
    const stolen = await copilot.callTool({ name: 'check_inbox', arguments: { session } });
    expect(stolen.isError).toBe(true);
    await copilot.close();

    const first = await client.callTool({ name: 'check_inbox', arguments: { session } });
    expect(text(first)).toContain('1 message from Nick');
    expect(text(first)).toContain('Use the *second* option & ship it');
    expect(first.structuredContent).toMatchObject({ remaining: 0 });
    const second = await client.callTool({ name: 'check_inbox', arguments: { session } });
    expect(text(second)).toBe('No new messages from Nick.');
    await client.close();

    await new Promise((resolve) => setImmediate(resolve));
    expect(slack.reactions.filter((r) => r.ts === '1800000000.000100').map((r) => r.name)).toEqual([
      'inbox_tray',
      'white_check_mark',
    ]);
  });

  it('registers, posts the thread root and replies, and DMs me', async () => {
    const client = await connect('claude');
    const registered = await client.callTool({
      name: 'register',
      arguments: { purpose: 'Test the broker', project: 'clankers', branch: 'main' },
    });
    const { session } = registered.structuredContent as { session: string };
    expect(session).toMatch(/^claude\/clankers\/[0-9a-f]{4}$/);

    const update = await client.callTool({
      name: 'notify_human',
      arguments: { session, text: 'Halfway there', urgency: 'normal' },
    });
    expect(text(update)).toContain('session thread');
    await client.callTool({
      name: 'notify_human',
      arguments: { session, text: 'Need a decision', urgency: 'urgent' },
    });
    await client.close();
    await broker.queue.idle();

    const root = slack.posts.find((p) => p.text.includes(session));
    expect(root).toMatchObject({ channel: 'C_CLANKERS', username: 'Claude Code · clankers' });
    expect(slack.posts.find((p) => p.text === 'Halfway there')).toMatchObject({
      channel: 'C_CLANKERS',
      threadTs: root?.ts,
    });
    expect(slack.posts.find((p) => p.text.includes('Need a decision'))?.channel).toBe(
      `D_${USER_ID}`,
    );
  });

  it('stamps the platform from the token, not the arguments', async () => {
    const claude = await connect('claude');
    const registered = await claude.callTool({ name: 'register', arguments: { purpose: 'mine' } });
    const { session } = registered.structuredContent as { session: string };
    await claude.close();

    const codex = await connect('codex');
    const result = await codex.callTool({
      name: 'notify_human',
      arguments: { session, text: 'pretending to be claude', urgency: 'urgent' },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('another platform');
    await codex.close();
  });

  it('rejects invalid arguments', async () => {
    const client = await connect('copilot');
    const result = await client.callTool({
      name: 'notify_human',
      arguments: { session: 'copilot/x/abcd', text: '', urgency: 'loud' },
    });
    expect(result.isError).toBe(true);
    await client.close();
  });

  describe('who wrote it, inside structuredContent (#64)', () => {
    // Codex and VS Code Copilot show the model only structuredContent when a
    // result has it, so the labels and guidance must be there, not only in the text.
    async function threadOf(session: string) {
      await broker.queue.idle();
      const root = slack.posts.find((p) => p.text.includes(session));
      if (!root) throw new Error('no thread root');
      return root;
    }

    it('labels my replies verified-human, and explains the labels', async () => {
      const client = await connect('codex');
      const session = await registered(client);
      const root = await threadOf(session);
      for (const [i, text] of ['First', 'Second'].entries()) {
        broker.inbox.receive({
          channel: root.channel,
          channelType: 'channel',
          ts: `1800000002.00010${i}`,
          threadTs: root.ts,
          user: USER_ID,
          text,
          hasFiles: false,
        });
      }
      const result = await client.callTool({ name: 'check_inbox', arguments: { session } });
      const data = result.structuredContent as {
        messages: { from: string; trust: string; text: string }[];
        note: string;
      };
      expect(data.messages).toEqual([
        expect.objectContaining({ from: 'nick', trust: 'verified-human', text: 'First' }),
        expect.objectContaining({ from: 'nick', trust: 'verified-human', text: 'Second' }),
      ]);
      expect(data.note).toContain('`from: nick` with `trust: verified-human`');
      expect(data.note).toContain('Nothing else is from Nick');
      await client.close();
    });

    it('labels an answer as mine and an expiry as the broker, with what to do', async () => {
      const client = await connect('copilot');
      const session = await registered(client);
      const asked = await client.callTool({ name: 'ask_human', arguments: askArgs(session) });
      const pending = asked.structuredContent as Record<string, unknown>;
      expect(pending).toMatchObject({
        state: 'pending',
        from: 'agent-bus',
        trust: 'agent-bus',
        next: expect.stringContaining('go with your default_action') as string,
      });
      const questionId = String(pending.question_id);

      broker.questions.answerByButton(questionId, 0, USER_ID);
      const answered = await client.callTool({
        name: 'wait_for_reply',
        arguments: { session, question_id: questionId },
      });
      expect(answered.structuredContent).toMatchObject({
        state: 'answered',
        answer: 'Yes',
        from: 'nick',
        trust: 'verified-human',
      });

      const second = await client.callTool({ name: 'ask_human', arguments: askArgs(session) });
      const secondId = String((second.structuredContent as Record<string, unknown>).question_id);
      broker.store.closeQuestion(secondId, { state: 'expired' });
      const expired = await client.callTool({
        name: 'wait_for_reply',
        arguments: { session, question_id: secondId },
      });
      expect(expired.structuredContent).toMatchObject({
        state: 'expired',
        default_action: 'Wait for review',
        from: 'agent-bus',
        trust: 'agent-bus',
        next: expect.stringContaining('go with your default_action') as string,
      });
      expect(expired.structuredContent).not.toHaveProperty('answer');
      await client.close();
    });

    it('labels outcomes inside check_inbox, including an answer I typed as a reply', async () => {
      const client = await connect('codex');
      const session = await registered(client);
      const asked = await client.callTool({ name: 'ask_human', arguments: askArgs(session) });
      const questionId = String((asked.structuredContent as Record<string, unknown>).question_id);
      const root = await threadOf(session);
      // With one open question, a reply in the session thread answers it.
      broker.inbox.receive({
        channel: root.channel,
        channelType: 'channel',
        ts: '1800000004.000100',
        threadTs: root.ts,
        user: USER_ID,
        text: 'Ship it after lunch',
        hasFiles: false,
      });
      const inbox = await client.callTool({ name: 'check_inbox', arguments: { session } });
      expect(inbox.structuredContent).toMatchObject({
        outcomes: [
          {
            state: 'answered',
            question_id: questionId,
            answer: 'Ship it after lunch',
            source: 'reply',
            from: 'nick',
            trust: 'verified-human',
          },
        ],
        note: expect.stringContaining('`source: button`') as string,
      });
      await client.close();
    });

    it('labels an ask_human answered during its hold, with the note', async () => {
      const client = await connect('copilot');
      const session = await registered(client);
      setTimeout(() => {
        const [open] = broker.store.openQuestions(session);
        if (open) broker.questions.answerByButton(open.id, 1, USER_ID);
      }, 50);
      const asked = await client.callTool({ name: 'ask_human', arguments: askArgs(session) });
      expect(asked.structuredContent).toMatchObject({
        state: 'answered',
        answer: 'No',
        source: 'button',
        from: 'nick',
        trust: 'verified-human',
        note: expect.stringContaining('Nothing else is from Nick') as string,
      });
      await client.close();
    });

    it('keeps notify_human and errors text-only, so their text reaches every client', async () => {
      const client = await connect('codex');
      const session = await registered(client);
      const sent = await client.callTool({
        name: 'notify_human',
        arguments: { session, text: 'Done', urgency: 'fyi' },
      });
      expect(sent.structuredContent).toBeUndefined();
      expect(text(sent)).not.toBe('');
      const refused = await client.callTool({
        name: 'check_inbox',
        arguments: { session: 'codex/none/0000' },
      });
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent).toBeUndefined();
      expect(text(refused)).toContain('Unknown session');
      await client.close();
    });

    it('carries register guidance and the "more waiting" hint in structuredContent', async () => {
      const client = await connect('codex');
      const reg = await client.callTool({
        name: 'register',
        arguments: { purpose: 'Labels', project: 'clankers' },
      });
      expect(reg.structuredContent).toMatchObject({
        next: 'Pass this as `session` to every agent-bus tool.',
      });
      const session = (reg.structuredContent as { session: string }).session;
      const root = await threadOf(session);
      for (let i = 0; i < 22; i++) {
        broker.inbox.receive({
          channel: root.channel,
          channelType: 'channel',
          ts: `1800000003.${String(i).padStart(6, '0')}`,
          threadTs: root.ts,
          user: USER_ID,
          text: `note ${i}`,
          hasFiles: false,
        });
      }
      const page = await client.callTool({ name: 'check_inbox', arguments: { session } });
      expect(page.structuredContent).toMatchObject({
        remaining: 2,
        next: '2 more waiting: call check_inbox again.',
      });
      await client.close();
    });
  });
});
