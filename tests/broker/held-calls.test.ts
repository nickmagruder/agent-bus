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
  it('the held ask_human answers "pending" as the broker stops; after the restart wait_for_reply gets the answer', async () => {
    const first = await start();
    const session = await register(await connect(first));
    // A long client timeout: the call must end because the broker answered,
    // not because the client gave up.
    const asking = (await connect(first)).callTool(
      { name: 'ask_human', arguments: askArgs(session) },
      undefined,
      { timeout: HOLD_MS * 2 },
    );
    await expect.poll(() => first.notifier.waiting(session)).toBe(1);
    const questionId = first.store.openQuestions(session)[0]?.id ?? '';
    expect(questionId).toMatch(/^q-/);

    const stopping = Date.now();
    await stop(first);
    const pending = await asking;
    expect(Date.now() - stopping).toBeLessThan(3000);
    expect(pending.structuredContent).toMatchObject({ state: 'pending', question_id: questionId });

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
});

describe('a client cancelling a held call (Esc), #48', () => {
  it('ends the wait_for_reply hold at once, and a later reply stays for the next call', async () => {
    const broker = await start();
    const session = await register(await connect(broker));
    const holder = await connect(broker);
    const controller = new AbortController();
    const waiting = holder
      .callTool({ name: 'wait_for_reply', arguments: { session } }, undefined, {
        signal: controller.signal,
        timeout: HOLD_MS * 2,
      })
      .then(
        () => 'returned',
        () => 'cancelled',
      );
    await expect.poll(() => broker.notifier.waiting(session)).toBe(1);
    expect(broker.heldCalls.size).toBe(1);

    controller.abort('Esc');
    expect(await waiting).toBe('cancelled');
    // The cancel came on its own request; the hold still ends, long before HOLD_MS.
    await expect.poll(() => broker.notifier.waiting(session), { timeout: 3000 }).toBe(0);
    expect(broker.heldCalls.size).toBe(0);

    broker.store.setThread(session, 'C_HELD', '1700000500.000001');
    broker.inbox.receive({
      channel: 'C_HELD',
      channelType: 'channel',
      ts: '1700000500.000002',
      threadTs: '1700000500.000001',
      user: USER_ID,
      text: 'Reply after the cancel',
      hasFiles: false,
    });
    // Nobody took it: the cancelled call is gone, so it waits for the next one.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(broker.store.countUndelivered(session)).toBe(1);
    const next = await holder.callTool({ name: 'check_inbox', arguments: { session } });
    expect(next.structuredContent).toMatchObject({
      messages: [expect.objectContaining({ text: 'Reply after the cancel' })],
    });
  }, 15_000);

  it('ends an ask_human hold; the question stays open and its answer undelivered', async () => {
    const broker = await start();
    const session = await register(await connect(broker));
    const holder = await connect(broker);
    const controller = new AbortController();
    const asking = holder
      .callTool({ name: 'ask_human', arguments: askArgs(session) }, undefined, {
        signal: controller.signal,
        timeout: HOLD_MS * 2,
      })
      .catch(() => 'cancelled');
    await expect.poll(() => broker.notifier.waiting(session)).toBe(1);
    controller.abort();
    expect(await asking).toBe('cancelled');
    await expect.poll(() => broker.notifier.waiting(session), { timeout: 3000 }).toBe(0);

    const questionId = broker.store.openQuestions(session)[0]?.id ?? '';
    expect(broker.questions.answerByButton(questionId, 1, USER_ID)).toBe('answered');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(broker.store.getQuestion(questionId)?.deliveredAt).toBeNull();
    const answer = await holder.callTool({
      name: 'wait_for_reply',
      arguments: { session, question_id: questionId },
    });
    expect(answer.structuredContent).toMatchObject({ state: 'answered', answer: 'No' });
  }, 15_000);

  it("doesn't end another client's hold on a different request", async () => {
    const broker = await start();
    const session = await register(await connect(broker));
    const keep = await connect(broker);
    const kept = keep
      .callTool({ name: 'wait_for_reply', arguments: { session, timeout_seconds: 2 } })
      .then((result) => result.content);
    const cancelled = await connect(broker);
    const controller = new AbortController();
    // Register first, so this client's next request ID differs from `keep`'s.
    await cancelled.callTool({ name: 'check_inbox', arguments: { session } });
    const cancelling = cancelled
      .callTool({ name: 'wait_for_reply', arguments: { session } }, undefined, {
        signal: controller.signal,
        timeout: HOLD_MS * 2,
      })
      .catch(() => 'cancelled');
    await expect.poll(() => broker.notifier.waiting(session)).toBe(2);
    controller.abort();
    expect(await cancelling).toBe('cancelled');
    await expect.poll(() => broker.notifier.waiting(session), { timeout: 3000 }).toBe(1);
    // The other call runs to its own 2 s limit and answers normally.
    expect(JSON.stringify(await kept)).toContain('Nothing new from Nick yet');
  }, 15_000);
});
