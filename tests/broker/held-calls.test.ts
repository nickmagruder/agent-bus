import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../../src/broker/log.ts';
import { startBroker, type Broker } from '../../src/broker/main.ts';
import { FakeSlack, TOKENS, USER_ID } from './fakes.ts';

/** Long enough that a held call is still waiting when the test acts on it. */
const HOLD_MS = 30_000;

let dir: string;
const started: Broker[] = [];
const clients: Client[] = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'agent-bus-held-calls-'));
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const broker of started.splice(0)) await broker.stop().catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

async function start(): Promise<Broker> {
  const broker = await startBroker(
    {
      port: 0,
      dataDir: dir,
      tokens: TOKENS,
      slack: { botToken: 'xoxb-test', appToken: 'xapp-test', userId: USER_ID },
    },
    {
      log: silentLogger,
      slackApi: new FakeSlack(),
      connection: null,
      queueOptions: { minIntervalMs: 0 },
      holdMs: HOLD_MS,
      digest: null,
    },
  );
  started.push(broker);
  return broker;
}

async function stop(broker: Broker): Promise<void> {
  started.splice(started.indexOf(broker), 1);
  await broker.stop();
}

async function connect(broker: Broker): Promise<Client> {
  const client = new Client({ name: 'vitest-held', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${broker.port}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${TOKENS.claude}` } } },
  );
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function register(client: Client): Promise<string> {
  const result = await client.callTool({
    name: 'register',
    arguments: { purpose: 'Held calls', project: 'clankers' },
  });
  return (result.structuredContent as { session: string }).session;
}

const askArgs = (session: string) => ({
  session,
  question: 'Ship it?',
  options: ['Yes', 'No'],
  default_action: 'Wait for review',
});

describe('held calls across a broker restart', () => {
  it('the held ask_human never returns a result; the question survives and wait_for_reply gets the answer', async () => {
    const first = await start();
    const session = await register(await connect(first));
    // The client's own tool timeout ends the call (Claude Code's is 300 s; no
    // heartbeats arrive from a stopped broker). See #48.
    const asking = (await connect(first))
      .callTool({ name: 'ask_human', arguments: askArgs(session) }, undefined, { timeout: 1500 })
      .then(
        () => 'returned',
        () => 'failed',
      );
    await expect.poll(() => first.notifier.waiting(session)).toBe(1);
    const questionId = first.store.openQuestions(session)[0]?.id ?? '';
    expect(questionId).toMatch(/^q-/);

    await stop(first);
    expect(await asking).toBe('failed');

    const second = await start();
    expect(second.store.getQuestion(questionId)?.state).toBe('open');
    expect(second.questions.answerByButton(questionId, 0, USER_ID)).toBe('answered');
    const answered = await (
      await connect(second)
    ).callTool({ name: 'wait_for_reply', arguments: { session, question_id: questionId } });
    expect(answered.structuredContent).toMatchObject({
      state: 'answered',
      question_id: questionId,
      answer: 'Yes',
      source: 'button',
    });
  }, 15_000);

  it('a reply that arrived while the broker was down reaches wait_for_reply after the restart', async () => {
    const first = await start();
    const session = await register(await connect(first));
    await stop(first);

    const second = await start();
    second.store.setThread(session, 'C_HELD', '1700000300.000001');
    second.inbox.receive({
      channel: 'C_HELD',
      channelType: 'channel',
      ts: '1700000300.000002',
      threadTs: '1700000300.000001',
      user: USER_ID,
      text: 'Use plan B',
      hasFiles: false,
    });
    const reply = await (
      await connect(second)
    ).callTool({ name: 'wait_for_reply', arguments: { session } });
    expect(reply.structuredContent).toMatchObject({
      messages: [expect.objectContaining({ text: 'Use plan B', from: 'nick' })],
    });
  }, 15_000);
});

describe('a client disconnecting mid-hold', () => {
  it('ends the wait_for_reply hold at once and takes nothing from the inbox', async () => {
    const broker = await start();
    const session = await register(await connect(broker));
    const holder = await connect(broker);
    const waiting = holder
      .callTool({ name: 'wait_for_reply', arguments: { session } }, undefined, {
        timeout: HOLD_MS * 2,
      })
      .then(
        () => 'returned',
        () => 'failed',
      );
    await expect.poll(() => broker.notifier.waiting(session)).toBe(1);

    await holder.close();
    expect(await waiting).toBe('failed');
    // Well before HOLD_MS: the server saw the connection close.
    await expect.poll(() => broker.notifier.waiting(session), { timeout: 3000 }).toBe(0);

    // A reply that comes afterwards stays in the inbox for the next call.
    broker.store.setThread(session, 'C_HELD', '1700000400.000001');
    broker.inbox.receive({
      channel: 'C_HELD',
      channelType: 'channel',
      ts: '1700000400.000002',
      threadTs: '1700000400.000001',
      user: USER_ID,
      text: 'Later reply',
      hasFiles: false,
    });
    expect(broker.store.countUndelivered(session)).toBe(1);
  }, 15_000);

  it('ends an ask_human hold and keeps the question open for wait_for_reply', async () => {
    const broker = await start();
    const session = await register(await connect(broker));
    const holder = await connect(broker);
    const asking = holder
      .callTool({ name: 'ask_human', arguments: askArgs(session) }, undefined, {
        timeout: HOLD_MS * 2,
      })
      .catch(() => 'failed');
    await expect.poll(() => broker.notifier.waiting(session)).toBe(1);
    await holder.close();
    expect(await asking).toBe('failed');
    await expect.poll(() => broker.notifier.waiting(session), { timeout: 3000 }).toBe(0);
    const [question] = broker.store.openQuestions(session);
    expect(question?.deliveredAt).toBeNull();
  }, 15_000);

  it.todo(
    'a cancelled (aborted) held call ends its hold and takes nothing: see #48 (today it holds until the limit)',
  );
});
