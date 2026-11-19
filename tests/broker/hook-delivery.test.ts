import { request, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startHttpServer, type RunningHttpServer } from '../../src/broker/http.ts';
import { Inbox, REACTION } from '../../src/broker/inbox.ts';
import { silentLogger } from '../../src/broker/log.ts';
import { Notifier, Questions } from '../../src/broker/questions.ts';
import { BusService } from '../../src/broker/service.ts';
import { Store } from '../../src/broker/store.ts';
import { TOKENS, USER_ID } from './fakes.ts';

const CHANNEL = 'C_STOP';
const ROOT_TS = '1700000200.000001';
const REPLY_TS = '1700000200.000002';

let store: Store;
let service: BusService;
let inbox: Inbox;
let http: RunningHttpServer;
let reactions: { channel: string; ts: string; name: string }[];
let lastResponse: ServerResponse | undefined;

beforeEach(async () => {
  store = new Store(':memory:');
  reactions = [];
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
  inbox = new Inbox({
    store,
    queue,
    notifier,
    questions,
    humanUserId: USER_ID,
    reactions: { add: (channel, ts, name) => reactions.push({ channel, ts, name }) },
  });
  service = new BusService(store, queue);
  http = await startHttpServer({
    port: 0,
    tokens: TOKENS,
    service,
    inbox,
    questions,
    notifier,
    log: silentLogger,
  });
  http.server.prependListener('request', (_req, res: ServerResponse) => (lastResponse = res));
});

afterEach(async () => {
  await http.close();
  store.close();
});

/** A Claude session with my reply waiting in its inbox. */
function sessionWithReply(): string {
  const { session } = service.hook('claude', { event: 'SessionStart', appSessionId: 'app-1' });
  store.setThread(session, CHANNEL, ROOT_TS);
  inbox.receive({
    channel: CHANNEL,
    channelType: 'channel',
    ts: REPLY_TS,
    threadTs: ROOT_TS,
    user: USER_ID,
    text: 'Use plan B',
    hasFiles: false,
  });
  return session;
}

/** POSTs a Stop hook; resolves with the body, or undefined if the connection dropped. */
function postStop(): Promise<string | undefined> {
  return postHook('Stop', 'app-1');
}

function postHook(event: string, appSessionId: string): Promise<string | undefined> {
  return new Promise((resolve) => {
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
        res.on('error', () => resolve(undefined));
      },
    );
    req.on('error', () => resolve(undefined));
    req.end(JSON.stringify({ event, appSessionId }));
  });
}

describe('/hook bus-ID delivery', () => {
  const contextOf = (body: string | undefined) =>
    (JSON.parse(body ?? '{}') as { context?: string }).context;
  const recorded = () =>
    store.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'hook.context_delivered'")
      .get();

  it('records the bus ID as delivered once the SessionStart response is written', async () => {
    expect(contextOf(await postHook('SessionStart', 'app-9'))).toMatch(/^agent-bus: /);
    await expect.poll(recorded).toEqual({ n: 1 });
    expect(contextOf(await postHook('UserPromptSubmit', 'app-9'))).toBeUndefined();
  });

  it('re-sends it on the first prompt when the SessionStart response was cut', async () => {
    const hook = service.hook.bind(service);
    service.hook = (platform, input, check) => {
      const result = hook(platform, input, check);
      lastResponse?.destroy();
      return result;
    };
    expect(await postHook('SessionStart', 'app-9')).toBeUndefined();
    service.hook = hook;
    expect(recorded()).toEqual({ n: 0 });
    expect(contextOf(await postHook('UserPromptSubmit', 'app-9'))).toMatch(/^agent-bus: /);
    await expect.poll(recorded).toEqual({ n: 1 });
    expect(contextOf(await postHook('UserPromptSubmit', 'app-9'))).toBeUndefined();
  });
});

const delivered = { channel: CHANNEL, ts: REPLY_TS, name: REACTION.delivered };

describe('/hook Stop delivery', () => {
  it('confirms the replies (✅) once the response is written', async () => {
    const session = sessionWithReply();
    const body = JSON.parse((await postStop()) ?? '{}') as { action: string; reason: string };
    expect(body.action).toBe('blocked');
    expect(body.reason).toContain('Use plan B');
    await expect.poll(() => reactions).toContainEqual(delivered);
    expect(store.countUndelivered(session)).toBe(0);
  });

  it('puts the replies back when the hook is gone before the response is written', async () => {
    const session = sessionWithReply();
    const hook = service.hook.bind(service);
    service.hook = (platform, input, check) => {
      const result = hook(platform, input, check);
      // The hook process timed out while the broker was busy.
      lastResponse?.destroy();
      return result;
    };
    expect(await postStop()).toBeUndefined();
    await expect.poll(() => store.countUndelivered(session)).toBe(1);
    expect(reactions).not.toContainEqual(delivered);
    const undone = store.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'inbox.undelivered'")
      .get();
    expect(undone).toEqual({ n: 1 });

    // The next stop hands the reply over again.
    service.hook = hook;
    const body = JSON.parse((await postStop()) ?? '{}') as { reason: string };
    expect(body.reason).toContain('Use plan B');
  });

  it('takes nothing for a request whose connection already closed', async () => {
    const session = sessionWithReply();
    const hook = service.hook.bind(service);
    let check: unknown = 'not called';
    service.hook = (platform, input, stopInbox) => {
      check = stopInbox;
      return hook(platform, input, stopInbox);
    };
    // Close the socket as soon as the body has been read, before routing.
    http.server.prependListener('request', (req) => {
      req.on('end', () => req.socket.destroy());
    });
    await postStop();
    await expect.poll(() => check).toBeUndefined();
    expect(store.countUndelivered(session)).toBe(1);
  });
});
