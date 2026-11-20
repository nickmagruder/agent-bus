import { describe, expect, it } from 'vitest';
import { stopReason } from '../../src/broker/stop-hook.ts';
import type { InboxRecord, QuestionRecord, QuestionState } from '../../src/broker/store.ts';

function message(body: string): InboxRecord {
  return {
    id: 1,
    sessionId: 's-1',
    sender: 'human',
    slackUser: 'U-TEST',
    body,
    slackChannelId: 'D-TEST',
    slackTs: '1.0',
    createdAt: '2026-11-20T10:00:00Z',
    deliveredAt: null,
    deliveredVia: null,
    questionId: null,
  };
}

function question(id: string, state: QuestionState, answer: string | null = null): QuestionRecord {
  return {
    id,
    sessionId: 's-1',
    text: 'A or B?',
    options: [],
    defaultAnswer: 'A',
    state,
    answer,
    answeredBy: answer === null ? null : 'U-TEST',
    answerSource: answer === null ? null : 'reply',
    postId: null,
    reminderPostId: null,
    createdAt: '2026-11-20T09:00:00Z',
    remindAt: null,
    remindedAt: null,
    expiresAt: '2026-11-20T10:00:00Z',
    closedAt: '2026-11-20T10:00:00Z',
    deliveredAt: null,
    deliveredVia: null,
  };
}

const heading = (reason: string): string => reason.split('\n\n')[0] ?? '';

describe('stopReason heading (#71)', () => {
  it('says Nick replied for his messages alone', () => {
    const reason = stopReason({ messages: [message('Use plan B')], outcomes: [], remaining: 0 });
    expect(heading(reason)).toBe(
      'agent-bus: Nick replied in Slack before you stopped. Read his reply and act on it ' +
        '(answer him with notify_human if he asked something), then finish your turn.',
    );
    expect(reason).toContain('Use plan B');
  });

  it('says Nick replied for an answered question', () => {
    const reason = stopReason({
      messages: [],
      outcomes: [question('q-1', 'answered', 'B')],
      remaining: 0,
    });
    expect(heading(reason)).toContain('Nick replied in Slack');
    expect(heading(reason)).not.toContain('expired');
  });

  it("doesn't credit Nick for an expiry alone", () => {
    const reason = stopReason({
      messages: [],
      outcomes: [question('q-1', 'expired')],
      remaining: 0,
    });
    expect(heading(reason)).not.toMatch(/Nick replied/);
    expect(heading(reason)).toBe(
      'agent-bus has an update (not a message from Nick): a question you asked expired ' +
        'with no answer from Nick. Go with your stated default, then finish your turn.',
    );
    expect(reason).toContain('Go with your stated default: A');
  });

  it('counts several expiries', () => {
    const reason = stopReason({
      messages: [],
      outcomes: [question('q-1', 'expired'), question('q-2', 'expired')],
      remaining: 0,
    });
    expect(heading(reason)).toContain('2 questions you asked expired');
    expect(heading(reason)).not.toMatch(/Nick replied/);
  });

  it('says both for a reply and an expiry', () => {
    const reason = stopReason({
      messages: [message('Hold off on the deploy')],
      outcomes: [question('q-1', 'expired')],
      remaining: 0,
    });
    expect(heading(reason)).toBe(
      'agent-bus: Nick replied in Slack before you stopped, and a question you asked expired ' +
        'with no answer from Nick. Read his reply and act on it (answer him with notify_human ' +
        'if he asked something); for that question, go with your stated default. Then finish your turn.',
    );
  });

  it('says both for an answered question and an expiry', () => {
    const reason = stopReason({
      messages: [],
      outcomes: [question('q-1', 'answered', 'B'), question('q-2', 'expired')],
      remaining: 0,
    });
    expect(heading(reason)).toMatch(
      /^agent-bus: Nick replied in Slack .*, and a question you asked expired/,
    );
  });
});
