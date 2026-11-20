import { describe, expect, it } from 'vitest';
import { defaultDataDir, loadBrokerConfig } from '../../src/shared/config.ts';
import { newSessionId, parseSessionId, projectSlug } from '../../src/shared/session-id.ts';
import { escapeSlackText } from '../../src/shared/slack-text.ts';
import { TOKENS, USER_ID } from './fakes.ts';

const validEnv = {
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_APP_TOKEN: 'xapp-test',
  SLACK_USER_ID: USER_ID,
  AGENT_BUS_TOKEN_CLAUDE: TOKENS.claude,
  AGENT_BUS_TOKEN_CODEX: TOKENS.codex,
  AGENT_BUS_TOKEN_COPILOT: TOKENS.copilot,
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
};

describe('loadBrokerConfig: digest repos', () => {
  it('has no repos and no GitHub token by default', () => {
    expect(loadBrokerConfig(validEnv).github).toEqual({ repos: [], token: undefined });
  });

  it('reads a comma-separated repo list and an optional token', () => {
    const config = loadBrokerConfig({
      ...validEnv,
      AGENT_BUS_DIGEST_REPOS: ' octo/clankers , octo/agent-bus.js ,',
      AGENT_BUS_GITHUB_TOKEN: 'github_pat_test',
    });
    expect(config.github).toEqual({
      repos: ['octo/clankers', 'octo/agent-bus.js'],
      token: 'github_pat_test',
    });
  });

  it.each([
    'clankers',
    'octo/clankers/extra',
    'https://github.com/octo/clankers',
    'octo/a b',
    'octo/..',
    'octo/.',
    '-octo/clankers',
    'octo-/clankers',
    'oc_to/clankers',
  ])('rejects %j without echoing the token', (repos) => {
    expect(() =>
      loadBrokerConfig({
        ...validEnv,
        AGENT_BUS_DIGEST_REPOS: repos,
        AGENT_BUS_GITHUB_TOKEN: 'github_pat_secret',
      }),
    ).toThrow(/AGENT_BUS_DIGEST_REPOS must be comma-separated owner\/name repos/);
    try {
      loadBrokerConfig({
        ...validEnv,
        AGENT_BUS_DIGEST_REPOS: repos,
        AGENT_BUS_GITHUB_TOKEN: 'github_pat_secret',
      });
    } catch (error) {
      expect(String(error)).not.toContain('github_pat_secret');
    }
  });
});

describe('loadBrokerConfig', () => {
  it('loads a valid environment with defaults', () => {
    const config = loadBrokerConfig(validEnv);
    expect(config.port).toBe(47823);
    expect(config.tokens).toEqual(TOKENS);
    expect(config.slack.userId).toBe(USER_ID);
    expect(config.dataDir).toBe(defaultDataDir(validEnv.LOCALAPPDATA));
  });

  it('honours AGENT_BUS_PORT and AGENT_BUS_DATA_DIR', () => {
    const config = loadBrokerConfig({
      ...validEnv,
      AGENT_BUS_PORT: '5000',
      AGENT_BUS_DATA_DIR: 'x',
    });
    expect(config.port).toBe(5000);
    expect(config.dataDir).toBe('x');
  });

  it('leaves the hold limit unset by default and reads AGENT_BUS_HOLD_SECONDS (#68)', () => {
    expect(loadBrokerConfig(validEnv).holdSeconds).toBeUndefined();
    expect(loadBrokerConfig({ ...validEnv, AGENT_BUS_HOLD_SECONDS: '360' }).holdSeconds).toBe(360);
    expect(loadBrokerConfig({ ...validEnv, AGENT_BUS_HOLD_SECONDS: '30' }).holdSeconds).toBe(30);
    expect(loadBrokerConfig({ ...validEnv, AGENT_BUS_HOLD_SECONDS: '900' }).holdSeconds).toBe(900);
  });

  it.each(['29', '901', '0', '-5', '1.5', 'abc'])('rejects AGENT_BUS_HOLD_SECONDS=%s', (value) => {
    expect(() => loadBrokerConfig({ ...validEnv, AGENT_BUS_HOLD_SECONDS: value })).toThrow(
      'AGENT_BUS_HOLD_SECONDS',
    );
  });

  it.each([
    ['SLACK_BOT_TOKEN', 'xapp-wrong'],
    ['SLACK_APP_TOKEN', 'xoxb-wrong'],
    ['SLACK_USER_ID', 'nick'],
    ['AGENT_BUS_TOKEN_CODEX', 'short'],
    ['AGENT_BUS_PORT', '70000'],
  ])('rejects a bad %s', (name, value) => {
    expect(() => loadBrokerConfig({ ...validEnv, [name]: value })).toThrow(name);
  });

  it('names a missing variable', () => {
    const env: Record<string, string> = { ...validEnv };
    delete env.AGENT_BUS_TOKEN_COPILOT;
    expect(() => loadBrokerConfig(env)).toThrow('AGENT_BUS_TOKEN_COPILOT is not set');
  });

  it('rejects two platforms sharing a token', () => {
    expect(() => loadBrokerConfig({ ...validEnv, AGENT_BUS_TOKEN_CODEX: TOKENS.claude })).toThrow(
      'must be different',
    );
  });

  it('never puts a token value in the error', () => {
    const secret = 'xoxb-' + 's'.repeat(40);
    try {
      loadBrokerConfig({ ...validEnv, SLACK_BOT_TOKEN: secret, SLACK_USER_ID: 'bad' });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});

describe('session IDs', () => {
  it('builds and parses platform/project/suffix', () => {
    const id = newSessionId('codex', 'esri-exporter');
    expect(id).toMatch(/^codex\/esri-exporter\/[0-9a-f]{4}$/);
    expect(parseSessionId(id)).toMatchObject({ platform: 'codex', project: 'esri-exporter' });
  });

  it.each(['gemini/x/abcd', 'claude/X/abcd', 'claude/x/zzzz', 'claude/x', 'claude//abcd', ''])(
    'rejects %s',
    (id) => {
      expect(parseSessionId(id)).toBeUndefined();
    },
  );

  it.each([
    ['Esri Exporter', 'esri-exporter'],
    ['agent-bus', 'agent-bus'],
    ['__weird__name!!', 'weird-name'],
    ['!!!', 'misc'],
    ['', 'misc'],
    ['a'.repeat(60), 'a'.repeat(40)],
  ])('slugs %s as %s', (input, slug) => {
    expect(projectSlug(input)).toBe(slug);
  });
});

describe('escapeSlackText', () => {
  it('neutralises mentions and disguised links', () => {
    expect(escapeSlackText('<!channel> hi <@U123> <https://x.example|docs> & co')).toBe(
      '&lt;!channel&gt; hi &lt;@U123&gt; &lt;https://x.example|docs&gt; &amp; co',
    );
  });

  it('leaves ordinary formatting alone', () => {
    expect(escapeSlackText('*bold* `code` _it_')).toBe('*bold* `code` _it_');
  });
});
