import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileWriter, createLogger, localDate, silentLogger } from '../../src/broker/log.ts';
import { PortInUseError, startBroker } from '../../src/broker/main.ts';
import { BusService } from '../../src/broker/service.ts';
import { boltLogger } from '../../src/broker/slack/connection.ts';
import { ChannelDirectory } from '../../src/broker/slack/directory.ts';
import { DM_TARGET, Store } from '../../src/broker/store.ts';
import { summarizeToolInput } from '../../src/cli/hook-extract.ts';
import { toSlackMrkdwn } from '../../src/shared/slack-text.ts';
import { FakeSlack, TOKENS, USER_ID } from './fakes.ts';

describe('toSlackMrkdwn', () => {
  it.each([
    ['**The hook ran,** and more', '*The hook ran,* and more'],
    ['__under__ ~~gone~~', '_under_ ~gone~'],
    ['## Results\nbody', '*Results*\nbody'],
    ['# Title #', '*Title*'],
    ['* one\n  * two\n- three', '• one\n  • two\n- three'],
    ['see [the PR](https://github.com/x/y/pull/1)', 'see the PR (https://github.com/x/y/pull/1)'],
    ['[https://a.example](https://a.example)', 'https://a.example'],
    ['*already slack bold*', '*already slack bold*'],
  ])('converts %j', (input, output) => {
    expect(toSlackMrkdwn(input)).toBe(output);
  });

  it('still escapes mentions and never builds a Slack link', () => {
    const out = toSlackMrkdwn('<!channel> [click](https://evil.example) <@U1>');
    expect(out).toBe('&lt;!channel&gt; click (https://evil.example) &lt;@U1&gt;');
    expect(out).not.toContain('<');
  });

  it('leaves code spans and fenced blocks alone', () => {
    const input = 'Run `**not bold**` then\n```\n# not a heading\n* not a bullet\n```\n**bold**';
    expect(toSlackMrkdwn(input)).toBe(
      'Run `**not bold**` then\n```\n# not a heading\n* not a bullet\n```\n*bold*',
    );
  });
});

describe('summarizeToolInput argument fallback', () => {
  it('shows up to three short scalar arguments for MCP tools', () => {
    expect(
      summarizeToolInput({
        session: 'claude/agent-bus/38bc',
        purpose: 'Phase 1 live test',
        nested: { a: 1 },
        count: 3,
        flag: true,
      }),
    ).toBe('session: claude/agent-bus/38bc; purpose: Phase 1 live test; count: 3');
  });

  it('hides secrets and bulky bodies', () => {
    expect(
      summarizeToolInput({
        api_key: 'sk-123',
        authToken: 'x',
        password: 'p',
        content: 'big file',
        body: 'big body',
        channel: 'general',
      }),
    ).toBe('channel: general');
  });

  it('clips long values and collapses whitespace', () => {
    const summary = summarizeToolInput({ query: `a  \n b ${'x'.repeat(200)}` }) ?? '';
    expect(summary.startsWith('query: a b xxx')).toBe(true);
    expect(summary.length).toBeLessThanOrEqual('query: '.length + 80);
  });

  it('prefers the description when there is one, and gives nothing for no scalars', () => {
    expect(summarizeToolInput({ description: 'Push', other: 'x' })).toBe('Push');
    expect(summarizeToolInput({ nested: { a: 1 } })).toBeUndefined();
  });
});

describe('channel choice for new sessions', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(':memory:');
  });
  afterEach(() => store.close());

  function service(isMember: (name: string) => boolean | undefined) {
    return new BusService(store, { kick: () => undefined }, undefined, { isMember });
  }

  it('uses #agents up front when the bot is not in the project channel', () => {
    const { session } = service(() => false).register({
      platform: 'claude',
      purpose: 'x',
      project: 'agent-bus',
    });
    expect(session.channel).toBe('agents');
  });

  it('uses the project channel when the bot is in it, or when the list is not loaded', () => {
    expect(
      service((name) => name === 'proj-clankers').register({
        platform: 'claude',
        purpose: 'x',
        project: 'clankers',
      }).session.channel,
    ).toBe('proj-clankers');
    expect(
      service(() => undefined).register({ platform: 'claude', purpose: 'x', project: 'other' })
        .session.channel,
    ).toBe('proj-other');
  });

  it('formats Markdown in notify_human text', () => {
    const bus = service(() => true);
    const { session } = bus.register({ platform: 'codex', purpose: 'x', project: 'clankers' });
    bus.notify({
      platform: 'codex',
      session: session.id,
      text: '**Blocked** on you',
      urgency: 'urgent',
    });
    const row = store.db.prepare('SELECT text FROM outbox WHERE target = ?').get(DM_TARGET) as {
      text: string;
    };
    expect(row.text).toContain('*Blocked* on you');
    expect(row.text).not.toContain('**');
  });
});

describe('ChannelDirectory.isMember', () => {
  it('is unknown until loaded, then reflects the bot channels', async () => {
    const directory = new ChannelDirectory(new FakeSlack(), USER_ID);
    expect(directory.isMember('agents')).toBeUndefined();
    await directory.refresh();
    expect(directory.isMember('agents')).toBe(true);
    expect(directory.isMember('proj-nope')).toBe(false);
  });
});

describe('file logging', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'agent-bus-logs-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('names files by local date', () => {
    expect(localDate(new Date(2026, 10, 17, 23, 30))).toBe('2026-11-17');
    expect(localDate(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('writes JSON lines to one file per local day', async () => {
    let now = new Date(2026, 10, 17, 22, 0);
    const log = createLogger(createFileWriter(dir, { now: () => now }));
    log('info', 'first');
    now = new Date(2026, 10, 18, 1, 0);
    log('warn', 'second', { detail: 1 });
    expect((await readdir(dir)).sort()).toEqual(['broker-2026-11-17.log', 'broker-2026-11-18.log']);
    const second = JSON.parse(await readFile(path.join(dir, 'broker-2026-11-18.log'), 'utf8')) as {
      level: string;
      message: string;
      detail: number;
    };
    expect(second).toMatchObject({ level: 'warn', message: 'second', detail: 1 });
  });

  it('deletes broker logs older than keepDays, and nothing else', async () => {
    const old = path.join(dir, 'broker-2026-10-01.log');
    const recent = path.join(dir, 'broker-2026-11-16.log');
    const other = path.join(dir, 'launcher.log');
    for (const file of [old, recent, other]) await writeFile(file, 'x');
    const longAgo = new Date(2026, 9, 1);
    await utimes(old, longAgo, longAgo);
    await utimes(other, longAgo, longAgo);
    createFileWriter(dir, { keepDays: 14, now: () => new Date(2026, 10, 17) });
    expect((await readdir(dir)).sort()).toEqual(['broker-2026-11-16.log', 'launcher.log']);
  });
});

describe('boltLogger', () => {
  it('forwards warnings and errors with the client name, drops debug and info', () => {
    const lines: { level: string; message: string }[] = [];
    const logger = boltLogger((level, message) => lines.push({ level, message }));
    logger.setName('socket-mode');
    logger.debug('noise');
    logger.info('noise');
    logger.warn('reconnecting', { attempt: 2 });
    logger.error(new Error('boom'));
    expect(lines).toEqual([
      { level: 'warn', message: 'socket-mode: reconnecting {"attempt":2}' },
      { level: 'error', message: 'socket-mode: boom' },
    ]);
  });
});

describe('startBroker on a busy port', () => {
  it('fails with PortInUseError', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const port = (blocker.address() as { port: number }).port;
    const dir = await mkdtemp(path.join(tmpdir(), 'agent-bus-port-'));
    try {
      await expect(
        startBroker(
          {
            port,
            dataDir: dir,
            tokens: TOKENS,
            slack: { botToken: 'xoxb-test', appToken: 'xapp-test', userId: USER_ID },
          },
          { log: silentLogger, slackApi: new FakeSlack(), connection: null },
        ),
      ).rejects.toBeInstanceOf(PortInUseError);
    } finally {
      blocker.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
