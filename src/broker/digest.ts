import { escapeSlackText } from '../shared/slack-text.ts';
import { errorMessage, type Logger } from './log.ts';
import { FALLBACK_CHANNEL } from './slack/directory.ts';
import type { DigestItemRecord, QuestionRecord, SessionRecord, Store } from './store.ts';

export const DIGEST = {
  /** Local hour of the daily post (docs/phase-2.md: 08:00). */
  hour: 8,
  /** How often the scheduler checks whether a digest is due. */
  tickMs: 5 * 60_000,
  /** What the first digest covers when none was ever sent. */
  firstWindowMs: 24 * 60 * 60_000,
  /** Keeps the post well inside Slack's limits; the rest is counted, not shown. */
  maxChars: 3500,
  itemChars: 300,
  maxSessions: 15,
} as const;

/** One digest, recorded once per slot so a slot is never posted twice. */
const DONE_EVENT = 'digest.done';

export type DigestOutcome = 'sent' | 'empty' | 'not_due';

export interface LocalTime {
  /** `YYYY-MM-DD` in the digest's time zone. */
  day: string;
  hour: number;
}

/** The date and hour of `date` in `timeZone`. */
export function localTime(date: Date, timeZone: string): LocalTime {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { day: `${part('year')}-${part('month')}-${part('day')}`, hour: Number(part('hour')) };
}

/**
 * The digest slot `now` falls in: today's if it's past the digest hour,
 * else yesterday's. A slot without a digest is due, so the broker starting
 * after a missed slot sends one catch-up, and never more than one per slot.
 */
export function digestSlot(now: Date, timeZone: string, hour: number = DIGEST.hour): string {
  const local = localTime(now, timeZone);
  if (local.hour >= hour) return local.day;
  return localTime(new Date(now.getTime() - 24 * 60 * 60_000), timeZone).day;
}

/**
 * Posts the daily digest to #agents: fyi notifications grouped by session,
 * open and expired questions, and the sessions seen since the last digest.
 * Nothing to report → no post (the slot is still marked done).
 */
export class Digest {
  private readonly store: Store;
  private readonly queue: { kick(): void };
  private readonly log: Logger;
  private readonly now: () => Date;
  private readonly timeZone: string;
  private readonly hour: number;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: {
    store: Store;
    queue: { kick(): void };
    log: Logger;
    now?: () => Date;
    /** IANA zone for the digest hour; defaults to this machine's. */
    timeZone?: string;
    hour?: number;
  }) {
    this.store = options.store;
    this.queue = options.queue;
    this.log = options.log;
    this.now = options.now ?? (() => new Date());
    this.timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.hour = options.hour ?? DIGEST.hour;
  }

  /** Checks now (the catch-up after a missed slot) and then every `tickMs`. */
  start(tickMs: number = DIGEST.tickMs): void {
    this.safeTick();
    this.timer = setInterval(() => this.safeTick(), tickMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  tick(): DigestOutcome {
    const now = this.now();
    const slot = digestSlot(now, this.timeZone, this.hour);
    const last = this.store.latestEventOfKind(DONE_EVENT);
    if (last?.data.slot === slot) return 'not_due';
    const since = last ? new Date(last.at) : new Date(now.getTime() - DIGEST.firstWindowMs);

    const outcome = this.store.transaction(() => {
      const items = this.store.pendingDigestItems();
      const questions = this.store.digestQuestions(since);
      const sessions = this.store.sessionsSeenSince(since);
      const text = digestText({
        since,
        timeZone: this.timeZone,
        items,
        questions,
        sessions,
        sessionById: (id) => this.store.getSession(id),
      });
      if (text) this.store.enqueue({ target: FALLBACK_CHANNEL, text });
      this.store.markDigested(items.map((item) => item.id));
      this.store.appendEvent({
        kind: DONE_EVENT,
        data: {
          slot,
          posted: Boolean(text),
          items: items.length,
          questions: questions.length,
          sessions: sessions.length,
        },
      });
      return text ? 'sent' : 'empty';
    });
    if (outcome === 'sent') this.queue.kick();
    return outcome;
  }

  private safeTick(): void {
    try {
      this.tick();
    } catch (error) {
      this.log('error', 'digest tick failed', { error: errorMessage(error) });
    }
  }
}

export interface DigestInput {
  since: Date;
  timeZone: string;
  items: readonly DigestItemRecord[];
  questions: readonly QuestionRecord[];
  sessions: readonly SessionRecord[];
  sessionById: (id: string) => SessionRecord | undefined;
}

/** The digest post (Slack mrkdwn), or undefined when there's nothing to report. */
export function digestText(input: DigestInput): string | undefined {
  const { items, questions, sessions } = input;
  if (items.length === 0 && questions.length === 0 && sessions.length === 0) return undefined;

  const lines: string[] = [
    `:newspaper: *Agent digest* since ${formatTime(input.since, input.timeZone)}`,
  ];
  let hidden = 0;
  const add = (line: string): void => {
    if (lines.join('\n').length + line.length + 1 > DIGEST.maxChars) hidden++;
    else lines.push(line);
  };

  if (items.length > 0) {
    add('');
    add(`*FYI* (${items.length})`);
    for (const [sessionId, group] of groupBy(items, (item) => item.sessionId)) {
      add(sessionLine(sessionId, input.sessionById(sessionId)));
      for (const item of group) add(`• ${clip(firstLines(item.text), DIGEST.itemChars)}`);
    }
  }

  if (questions.length > 0) {
    add('');
    add(`*Questions* (${questions.length})`);
    for (const question of questions) add(questionLine(question));
  }

  if (sessions.length > 0) {
    add('');
    add(`*Sessions seen* (${sessions.length})`);
    for (const session of sessions.slice(0, DIGEST.maxSessions)) {
      add(sessionLine(session.id, session));
    }
    if (sessions.length > DIGEST.maxSessions) {
      add(`_…and ${sessions.length - DIGEST.maxSessions} more_`);
    }
  }

  if (hidden > 0) lines.push(`_…${hidden} more lines not shown_`);
  return lines.join('\n');
}

function sessionLine(id: string, session: SessionRecord | undefined): string {
  const purpose = session?.purpose ? ` ${escapeSlackText(clip(session.purpose, 120))}` : '';
  return `\`${id}\`${purpose}`;
}

function questionLine(question: QuestionRecord): string {
  const about = `"${escapeSlackText(clip(question.text, 160))}"`;
  if (question.state === 'expired') {
    const fallback = escapeSlackText(clip(question.defaultAnswer, 160));
    return `• :hourglass: \`${question.id}\` (\`${question.sessionId}\`) ${about}: expired, went with: ${fallback}`;
  }
  return `• :question: \`${question.id}\` (\`${question.sessionId}\`) ${about}: still open`;
}

/** An item's first two lines, so one long note doesn't fill the post. */
function firstLines(text: string): string {
  const lines = text.trim().split('\n');
  return lines.length > 2 ? `${lines.slice(0, 2).join(' ')} …` : lines.join(' ');
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function groupBy<T>(list: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of list) {
    const k = key(item);
    const group = groups.get(k);
    if (group) group.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

/** "Tue 17 Nov 08:00" in the digest's time zone. */
function formatTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(date)
    .replace(',', '');
}
