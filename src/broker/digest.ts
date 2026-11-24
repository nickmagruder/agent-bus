import { escapeSlackText } from '../shared/slack-text.ts';
import type { GitHubApi, MergedPr } from './github.ts';
import { errorMessage, type Logger } from './log.ts';
import { FALLBACK_CHANNEL } from './slack/directory.ts';
import type { DigestItemRecord, QuestionRecord, SessionRecord, Store } from './store.ts';
import type { LeaseRecord } from './leases.ts';
import { title as taskTitle } from './task-slack.ts';
import { TaskStore, type TaskRecord } from './task-store.ts';

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
  /** Room kept for the "not shown" footer. */
  footerChars: 80,
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
  return local.hour >= hour ? local.day : previousDay(local.day);
}

/**
 * The calendar day before `day` (`YYYY-MM-DD`). Calendar arithmetic, not
 * "24 hours ago": a day can be 23 or 25 hours long around DST changes.
 */
export function previousDay(day: string): string {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date - 1)).toISOString().slice(0, 10);
}

/**
 * Posts the daily digest to #agents: open and expired questions, tasks
 * (opened, finished, and still open: #61), PRs merged in the configured
 * repos, fyi notifications grouped by session, and the sessions seen since
 * the last digest. Nothing to report → no post (the slot is still marked
 * done); an open task always counts, so one waiting unclaimed shows daily.
 */
export class Digest {
  private readonly store: Store;
  private readonly queue: { kick(): void };
  private readonly log: Logger;
  private readonly now: () => Date;
  private readonly timeZone: string;
  private readonly hour: number;
  private readonly github: GitHubApi | undefined;
  private readonly repos: readonly string[];
  private readonly leases: (() => readonly LeaseRecord[]) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(options: {
    store: Store;
    queue: { kick(): void };
    log: Logger;
    now?: () => Date;
    /** IANA zone for the digest hour; defaults to this machine's. */
    timeZone?: string;
    hour?: number;
    /** Repos (`owner/name`) whose merged PRs the digest lists. */
    repos?: readonly string[];
    github?: GitHubApi;
    /** Leases still held (#31), for the digest's Leases section. */
    leases?: () => readonly LeaseRecord[];
  }) {
    this.leases = options.leases;
    this.store = options.store;
    this.queue = options.queue;
    this.log = options.log;
    this.now = options.now ?? (() => new Date());
    this.timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.hour = options.hour ?? DIGEST.hour;
    this.repos = options.repos ?? [];
    this.github = options.github;
  }

  /** Checks now (the catch-up after a missed slot) and then every `tickMs`. */
  start(tickMs: number = DIGEST.tickMs): void {
    void this.safeTick();
    this.timer = setInterval(() => void this.safeTick(), tickMs);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<DigestOutcome> {
    // A slow GitHub call must not let the next timer tick post the same slot.
    if (this.running) return 'not_due';
    this.running = true;
    try {
      return await this.runTick();
    } finally {
      this.running = false;
    }
  }

  private async runTick(): Promise<DigestOutcome> {
    const now = this.now();
    const slot = digestSlot(now, this.timeZone, this.hour);
    const last = this.store.latestEventOfKind(DONE_EVENT);
    // Slots only move forward (ISO dates compare as strings): a clock set
    // back, or a move to a zone further east, never re-posts an older slot.
    const lastSlot = typeof last?.data.slot === 'string' ? last.data.slot : undefined;
    if (lastSlot !== undefined && slot <= lastSlot) return 'not_due';
    // The window runs from where the last one ended (`until`, taken before
    // its GitHub call, so nothing merged during the call falls between two
    // digests; older events only have their own time) to now.
    const lastUntil = typeof last?.data.until === 'string' ? last.data.until : last?.at;
    const since = lastUntil ? new Date(lastUntil) : new Date(now.getTime() - DIGEST.firstWindowMs);
    // Outside the transaction: a network call must not hold the database.
    const github = await this.mergedPrs(since);
    // Stopped during the call: the store may be closed; the slot reruns at next start.
    if (this.stopped) return 'not_due';
    const prs = github.prs;

    const outcome = this.store.transaction(() => {
      const items = this.store.pendingDigestItems();
      const questions = this.store.digestQuestions(since);
      const sessions = this.store.sessionsSeenSince(since);
      const tasks = new TaskStore(this.store, this.now).digestTasks(since);
      const text = digestText({
        since,
        timeZone: this.timeZone,
        items,
        questions,
        sessions,
        tasks,
        leases: this.leases?.() ?? [],
        prs,
        prsTruncated: github.truncated,
        sessionById: (id) => this.store.getSession(id),
      });
      if (text) this.store.enqueue({ target: FALLBACK_CHANNEL, text });
      this.store.markDigested(items.map((item) => item.id));
      this.store.appendEvent({
        kind: DONE_EVENT,
        data: {
          slot,
          until: now.toISOString(),
          posted: Boolean(text),
          items: items.length,
          questions: questions.length,
          sessions: sessions.length,
          tasks: tasks.length,
          prs: prs.length,
        },
      });
      return text ? 'sent' : 'empty';
    });
    if (outcome === 'sent') this.queue.kick();
    return outcome;
  }

  /**
   * Merged PRs in the configured repos, oldest first across all of them. A
   * repo GitHub can't serve is skipped and logged; so are PRs dropped for an
   * unexpected link and a list cut at the page limit.
   */
  private async mergedPrs(since: Date): Promise<{ prs: MergedPr[]; truncated: boolean }> {
    const github = this.github;
    if (!github || this.repos.length === 0) return { prs: [], truncated: false };
    const results = await Promise.allSettled(
      this.repos.map((repo) => github.mergedPullRequests(repo, since)),
    );
    const prs: MergedPr[] = [];
    let truncated = false;
    for (const [index, result] of results.entries()) {
      const repo = this.repos[index];
      if (result.status === 'rejected') {
        this.log('warn', 'digest skipped merged PRs for a repo', {
          repo,
          error: errorMessage(result.reason),
        });
        continue;
      }
      prs.push(...result.value.prs);
      if (result.value.dropped > 0) {
        this.log('warn', "digest left out merged PRs whose link isn't the repo's own", {
          repo,
          dropped: result.value.dropped,
        });
      }
      if (result.value.truncated) {
        truncated = true;
        this.log('warn', 'digest listed only the most recent merged PRs for a repo', { repo });
      }
    }
    prs.sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
    return { prs, truncated };
  }

  private async safeTick(): Promise<void> {
    try {
      await this.tick();
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
  /** Tasks opened or closed in the window, and every open one (#61). */
  tasks?: readonly TaskRecord[];
  /** Leases still held (#31). */
  leases?: readonly LeaseRecord[];
  prs?: readonly MergedPr[];
  /** GitHub had more than the page limit: older merged PRs aren't listed. */
  prsTruncated?: boolean;
  sessionById: (id: string) => SessionRecord | undefined;
}

type LineKind = 'question' | 'task' | 'lease' | 'pr' | 'fyi' | 'session' | 'other';

/**
 * The digest post (Slack mrkdwn), or undefined when there's nothing to report.
 * Sections go in order of importance: questions, tasks, merged PRs, fyi
 * items, then sessions seen. Lines are added until the first one that doesn't fit; the
 * rest is left out and counted in a footer, so a section never shows gaps
 * or a heading without its body.
 */
export function digestText(input: DigestInput): string | undefined {
  const { items, questions, sessions } = input;
  const prs = input.prs ?? [];
  const tasks = input.tasks ?? [];
  const leases = input.leases ?? [];
  const prsTruncated = input.prsTruncated ?? false;
  const count =
    items.length + questions.length + sessions.length + prs.length + tasks.length + leases.length;
  if (count === 0 && !prsTruncated) {
    return undefined;
  }

  const planned: { kind: LineKind; text: string }[] = [];
  const plan = (kind: LineKind, text: string): void => {
    planned.push({ kind, text });
  };

  if (questions.length > 0) {
    plan('other', '');
    plan('other', `*Questions* (${questions.length})`);
    for (const question of questions) plan('question', questionLine(question));
  }
  // Tasks may wait on me (approval, stuck, unclaimed), so they come next.
  if (tasks.length > 0) {
    plan('other', '');
    plan('other', tasksHeading(tasks, input.since));
    for (const task of [...tasks].sort(byUrgency)) plan('task', taskLine(task, input.timeZone));
  }
  if (leases.length > 0) {
    plan('other', '');
    plan('other', `*Leases* (${leases.length})`);
    for (const lease of leases) {
      plan(
        'lease',
        `• :lock: \`${lease.repo}\` held by \`${lease.holder}\` since ` +
          formatTime(new Date(lease.claimedAt), input.timeZone),
      );
    }
  }
  // Agents merge these without my review, so they come right after tasks.
  if (prs.length > 0 || prsTruncated) {
    plan('other', '');
    plan('other', `*Merged PRs* (${prs.length})`);
    if (prsTruncated)
      plan('pr', '• _Older merged PRs not listed: more than GitHub returned in one pass_');
    for (const pr of prs) plan('pr', prLine(pr));
  }
  if (items.length > 0) {
    plan('other', '');
    plan('other', `*FYI* (${items.length})`);
    for (const [sessionId, group] of groupBy(items, (item) => item.sessionId)) {
      plan('other', sessionLine(sessionId, input.sessionById(sessionId)));
      for (const item of group) plan('fyi', `• ${itemPreview(item.text)}`);
    }
  }
  if (sessions.length > 0) {
    plan('other', '');
    plan('other', `*Sessions seen* (${sessions.length})`);
    for (const session of sessions.slice(0, DIGEST.maxSessions)) {
      plan('session', sessionLine(session.id, session));
    }
    if (sessions.length > DIGEST.maxSessions) {
      plan('other', `_…and ${sessions.length - DIGEST.maxSessions} more_`);
    }
  }

  const header = `:newspaper: *Agent digest* since ${formatTime(input.since, input.timeZone)}`;
  const lines = [header];
  let length = header.length;
  let cut = planned.length;
  for (const [index, line] of planned.entries()) {
    if (length + 1 + line.text.length > DIGEST.maxChars - DIGEST.footerChars) {
      cut = index;
      break;
    }
    lines.push(line.text);
    length += 1 + line.text.length;
  }
  if (cut < planned.length) {
    // Don't end on a blank line, heading or session name whose body was cut.
    while (lines.length > 1 && !lines.at(-1)?.startsWith('•')) lines.pop();
    lines.push(leftOutFooter(planned.slice(cut)));
  }
  return lines.join('\n');
}

/** "…not shown: 2 questions, 14 fyi items, 3 sessions" for what the cap left out. */
function leftOutFooter(rest: readonly { kind: LineKind }[]): string {
  const count = (kind: LineKind) => rest.filter((line) => line.kind === kind).length;
  const parts = [
    plural(count('question'), 'question'),
    plural(count('task'), 'task'),
    plural(count('lease'), 'lease'),
    plural(count('pr'), 'merged PR'),
    plural(count('fyi'), 'fyi item'),
    plural(count('session'), 'session'),
  ].filter((part) => part !== undefined);
  return parts.length > 0 ? `_…not shown: ${parts.join(', ')}_` : '_…more not shown_';
}

function plural(n: number, noun: string): string | undefined {
  if (n === 0) return undefined;
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * `• <link|owner/name#12 Title> by author (Claude Code)`. Titles and logins
 * come from GitHub, so they're escaped like agent text; the link was checked
 * to be the repo's own PR URL.
 */
export function prLine(pr: MergedPr): string {
  const title = escapeSlackText(clip(pr.title, 160)).replaceAll('|', '¦');
  const agent = pr.agent ? ` (${pr.agent})` : '';
  return `• <${pr.url}|${pr.repo}#${pr.number} ${title}> by ${escapeSlackText(pr.author)}${agent}`;
}

/** `*Tasks* (2 opened, 1 finished, 3 open)`: counts for the window, and open now. */
function tasksHeading(tasks: readonly TaskRecord[], since: Date): string {
  const after = since.toISOString();
  const opened = tasks.filter((task) => task.createdAt >= after).length;
  const finished = tasks.filter((task) => task.closedAt !== null && task.closedAt >= after).length;
  const open = tasks.filter((task) => task.closedAt === null).length;
  return `*Tasks* (${opened} opened, ${finished} finished, ${open} open)`;
}

/**
 * Where a task stands, most in need of me first: stuck, needing input,
 * awaiting my approval, waiting unclaimed (Copilot pools included, D7),
 * being worked on; then the ones that finished.
 */
const URGENCY = [
  'stuck',
  'input-required',
  'approval',
  'unclaimed',
  'working',
  'completed',
  'failed',
  'rejected',
  'canceled',
] as const;
type Standing = (typeof URGENCY)[number];

function standing(task: TaskRecord): Standing {
  if (task.state === 'submitted') return task.approval === 'pending' ? 'approval' : 'unclaimed';
  if (task.state === 'working') return task.stuckAt ? 'stuck' : 'working';
  if (task.state === 'input-required') return task.stuckAt ? 'stuck' : 'input-required';
  return task.state;
}

function byUrgency(a: TaskRecord, b: TaskRecord): number {
  return URGENCY.indexOf(standing(a)) - URGENCY.indexOf(standing(b));
}

/**
 * `• :warning: \`t-3f2a1b\` *Title* (\`from\` → \`to\`): stuck since …`. The
 * title is the agent's, made one plain escaped line; the rest is the broker's.
 */
function taskLine(task: TaskRecord, timeZone: string): string {
  const to = task.targetSession ?? `any ${task.targetPlatform} session in ${task.targetProject}`;
  const head = `\`${task.id}\` *${taskTitle(task)}* (\`${task.createdBy}\` → \`${to}\`)`;
  const holder = task.holder ? `\`${task.holder}\`` : 'its holder';
  const since = (iso: string) => formatTime(new Date(iso), timeZone);
  switch (standing(task)) {
    case 'stuck':
      return `• :warning: ${head}: stuck, ${holder} silent since ${since(task.holderSeenAt ?? task.updatedAt)}`;
    case 'input-required':
      return `• :question: ${head}: ${holder} needs input from \`${task.createdBy}\``;
    case 'approval':
      return `• :inbox_tray: ${head}: waits for your approval (expires ${since(task.approvalExpiresAt)})`;
    case 'unclaimed': {
      const open = since(task.openSince ?? task.approvedAt ?? task.createdAt);
      return task.waitingAt
        ? `• :hourglass: ${head}: flagged, unclaimed since ${open} (cancel it from its DM)`
        : `• :hourglass: ${head}: approved, not claimed yet (since ${open})`;
    }
    case 'working':
      return `• :arrow_forward: ${head}: ${holder} is working on it`;
    case 'completed':
      return `• :white_check_mark: ${head}: completed`;
    case 'failed':
      return `• :x: ${head}: failed`;
    case 'rejected':
      return `• :leftwards_arrow_with_hook: ${head}: rejected`;
    case 'canceled':
      return `• :no_entry_sign: ${head}: canceled`;
  }
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

/**
 * One line for an fyi item (already escaped mrkdwn): its first two non-empty
 * lines, clipped. Code fences are dropped and a lone backtick removed, so a
 * preview never leaves code formatting open; a clip never splits an
 * `&amp;`-style entity.
 */
export function itemPreview(text: string): string {
  const lines = text
    .replaceAll('```', '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  let preview = lines.length > 2 ? `${lines.slice(0, 2).join(' ')} …` : lines.join(' ');
  if (preview.length > DIGEST.itemChars) {
    preview = `${preview
      .slice(0, DIGEST.itemChars - 1)
      .replace(/&[a-z]*$/, '')
      .trimEnd()}…`;
  }
  const ticks = preview.split('`').length - 1;
  return ticks % 2 === 1 ? preview.replace(/`(?=[^`]*$)/, '') : preview;
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
