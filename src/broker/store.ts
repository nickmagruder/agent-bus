import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Platform } from '../shared/platform.ts';

/**
 * Each entry upgrades the schema by one version (tracked in PRAGMA user_version).
 * Never edit a released migration; append a new one.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    project TEXT NOT NULL,
    branch TEXT,
    purpose TEXT,
    channel TEXT NOT NULL,
    slack_channel_id TEXT,
    thread_ts TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    platform TEXT,
    session_id TEXT,
    data TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX events_by_session ON events (session_id, kind, at);
  CREATE INDEX events_by_platform ON events (platform, kind, at);
  CREATE TRIGGER events_no_update BEFORE UPDATE ON events
    BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  CREATE TRIGGER events_no_delete BEFORE DELETE ON events
    BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

  CREATE TABLE outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idem_key TEXT UNIQUE,
    target TEXT NOT NULL,
    session_id TEXT,
    in_thread INTEGER NOT NULL DEFAULT 0,
    text TEXT NOT NULL,
    username TEXT,
    icon TEXT,
    state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'sent', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    sent_at TEXT,
    slack_channel_id TEXT,
    slack_ts TEXT
  );
  CREATE INDEX outbox_queued ON outbox (state, target, id);
  `,
  // v2: hooks identify a session by the app's own session ID; sessions are
  // announced in Slack lazily, on their first post.
  `
  ALTER TABLE sessions ADD COLUMN app_session_id TEXT;
  ALTER TABLE sessions ADD COLUMN announced_at TEXT;
  UPDATE sessions SET announced_at = created_at;
  CREATE UNIQUE INDEX sessions_by_app_session ON sessions (platform, app_session_id)
    WHERE app_session_id IS NOT NULL;
  `,
  // v3: my Slack replies, routed to a session's inbox until the agent reads them.
  // One row per Slack message (channel + ts), so Slack's event retries are no-ops.
  `
  CREATE TABLE inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions (id),
    sender TEXT NOT NULL CHECK (sender IN ('human')),
    slack_user TEXT NOT NULL,
    body TEXT NOT NULL,
    slack_channel_id TEXT NOT NULL,
    slack_ts TEXT NOT NULL,
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    delivered_via TEXT,
    UNIQUE (slack_channel_id, slack_ts)
  );
  CREATE INDEX inbox_undelivered ON inbox (session_id, delivered_at, id);
  CREATE INDEX sessions_by_thread ON sessions (slack_channel_id, thread_ts);
  CREATE INDEX outbox_by_slack_ts ON outbox (slack_channel_id, slack_ts);
  `,
  // v4: questions an agent asks me (ask_human), answered by button or reply,
  // reminded once and expired to the agent's own default. Posts can carry
  // Block Kit blocks (the question's buttons).
  `
  CREATE TABLE questions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions (id),
    text TEXT NOT NULL,
    options TEXT NOT NULL DEFAULT '[]',
    default_answer TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'answered', 'expired')),
    answer TEXT,
    answered_by TEXT,
    answer_source TEXT CHECK (answer_source IN ('button', 'reply')),
    post_id INTEGER REFERENCES outbox (id),
    reminder_post_id INTEGER REFERENCES outbox (id),
    created_at TEXT NOT NULL,
    remind_at TEXT,
    reminded_at TEXT,
    expires_at TEXT NOT NULL,
    closed_at TEXT,
    delivered_at TEXT,
    delivered_via TEXT
  );
  CREATE INDEX questions_by_state ON questions (state, expires_at);
  CREATE INDEX questions_by_session ON questions (session_id, state);
  ALTER TABLE inbox ADD COLUMN question_id TEXT REFERENCES questions (id);
  ALTER TABLE outbox ADD COLUMN blocks TEXT;
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Outbox target for a DM to me; anything else is a channel name without `#`. */
export const DM_TARGET = '@me';

export interface SessionRecord {
  id: string;
  platform: Platform;
  project: string;
  branch: string | null;
  purpose: string | null;
  /** Channel name the session posts to (`proj-x` or `agents`). */
  channel: string;
  slackChannelId: string | null;
  threadTs: string | null;
  /** The app's own session ID (from hooks), when known. */
  appSessionId: string | null;
  /** When the session's thread root was queued; null until its first post. */
  announcedAt: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export interface NewEvent {
  kind: string;
  platform?: Platform | null;
  sessionId?: string | null;
  data?: Record<string, unknown>;
}

export interface OutboxRecord {
  id: number;
  target: string;
  sessionId: string | null;
  inThread: boolean;
  text: string;
  username: string | null;
  icon: string | null;
  state: 'queued' | 'sent' | 'failed';
  attempts: number;
  lastError: string | null;
  slackChannelId: string | null;
  slackTs: string | null;
  /** Block Kit blocks; `text` is the notification fallback. */
  blocks: unknown[] | null;
}

export interface NewPost {
  blocks?: unknown[] | null;
  target: string;
  sessionId?: string | null;
  /** Post into the session's thread (or start it). */
  inThread?: boolean;
  text: string;
  username?: string | null;
  icon?: string | null;
  /** Repeating a key returns the existing post instead of queueing a duplicate. */
  idemKey?: string | null;
}

/** How an inbox message or question outcome reached the agent. */
export type DeliveryVia = 'check_inbox' | 'wait_for_reply' | 'ask_human' | 'stop_hook';

export type QuestionState = 'open' | 'answered' | 'expired';
export type AnswerSource = 'button' | 'reply';

export interface QuestionRecord {
  id: string;
  sessionId: string;
  text: string;
  options: string[];
  defaultAnswer: string;
  state: QuestionState;
  answer: string | null;
  answeredBy: string | null;
  answerSource: AnswerSource | null;
  postId: number | null;
  reminderPostId: number | null;
  createdAt: string;
  remindAt: string | null;
  remindedAt: string | null;
  expiresAt: string;
  closedAt: string | null;
  deliveredAt: string | null;
  deliveredVia: DeliveryVia | null;
}

export interface NewQuestion {
  id: string;
  sessionId: string;
  text: string;
  options: readonly string[];
  defaultAnswer: string;
  remindAt: Date | null;
  expiresAt: Date;
}

export interface InboxRecord {
  id: number;
  sessionId: string;
  sender: 'human';
  slackUser: string;
  body: string;
  slackChannelId: string;
  slackTs: string;
  createdAt: string;
  deliveredAt: string | null;
  deliveredVia: DeliveryVia | null;
  /** Set when this reply answered a question; delivered with the question's outcome. */
  questionId: string | null;
}

export interface NewInboxMessage {
  questionId?: string | null;
  sessionId: string;
  slackUser: string;
  body: string;
  slackChannelId: string;
  slackTs: string;
}

type Row = Record<string, unknown>;

export class Store {
  readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(file: string, options: { now?: () => Date } = {}) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.now = options.now ?? (() => new Date());
    this.db.exec(
      'PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;',
    );
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  get schemaVersion(): number {
    const row = this.db.prepare('PRAGMA user_version').get() as Row;
    return Number(row.user_version);
  }

  private migrate(): void {
    const current = this.schemaVersion;
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `Database schema v${current} is newer than this broker (v${SCHEMA_VERSION}); update agent-bus.`,
      );
    }
    for (let version = current; version < SCHEMA_VERSION; version++) {
      this.transaction(() => {
        this.db.exec(found(MIGRATIONS[version], `migration ${version + 1}`));
        this.db.exec(`PRAGMA user_version = ${version + 1}`);
      });
    }
  }

  /** Runs `work` in one transaction; a nested call joins the outer transaction. */
  transaction<T>(work: () => T): T {
    if (this.depth > 0) {
      this.depth++;
      try {
        return work();
      } finally {
        this.depth--;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.depth = 0;
    }
  }

  private depth = 0;

  private timestamp(): string {
    return this.now().toISOString();
  }

  // Sessions

  insertSession(
    session: Pick<
      SessionRecord,
      'id' | 'platform' | 'project' | 'branch' | 'purpose' | 'channel'
    > & {
      appSessionId?: string | null;
    },
  ): SessionRecord {
    const at = this.timestamp();
    this.db
      .prepare(
        `INSERT INTO sessions
           (id, platform, project, branch, purpose, channel, app_session_id, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.platform,
        session.project,
        session.branch,
        session.purpose,
        session.channel,
        session.appSessionId ?? null,
        at,
        at,
      );
    return found(this.getSession(session.id), `session ${session.id}`);
  }

  getSession(id: string): SessionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row | undefined;
    return row && toSession(row);
  }

  findByAppSession(platform: Platform, appSessionId: string): SessionRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE platform = ? AND app_session_id = ?')
      .get(platform, appSessionId) as Row | undefined;
    return row && toSession(row);
  }

  markAnnounced(id: string): void {
    this.db.prepare('UPDATE sessions SET announced_at = ? WHERE id = ?').run(this.timestamp(), id);
  }

  /** Updates purpose/branch when given, and marks the session as seen. */
  touchSession(id: string, changes: { purpose?: string; branch?: string } = {}): void {
    this.db
      .prepare(
        `UPDATE sessions SET purpose = COALESCE(?, purpose), branch = COALESCE(?, branch),
         last_seen_at = ? WHERE id = ?`,
      )
      .run(changes.purpose ?? null, changes.branch ?? null, this.timestamp(), id);
  }

  setThread(id: string, slackChannelId: string, threadTs: string): void {
    this.db
      .prepare('UPDATE sessions SET slack_channel_id = ?, thread_ts = ? WHERE id = ?')
      .run(slackChannelId, threadTs, id);
  }

  /** The session whose Slack thread starts at `threadTs` in `channelId`. */
  findByThread(channelId: string, threadTs: string): SessionRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE slack_channel_id = ? AND thread_ts = ?')
      .get(channelId, threadTs) as Row | undefined;
    return row && toSession(row);
  }

  /** The session a sent post belongs to (e.g. an urgent DM), by its Slack channel and ts. */
  findByPost(channelId: string, ts: string): SessionRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT sessions.* FROM outbox JOIN sessions ON sessions.id = outbox.session_id
         WHERE outbox.slack_channel_id = ? AND outbox.slack_ts = ?`,
      )
      .get(channelId, ts) as Row | undefined;
    return row && toSession(row);
  }

  // Inbox

  /** Stores one of my messages for a session; `inserted` is false for a repeat of the same Slack message. */
  addToInbox(message: NewInboxMessage): { record: InboxRecord; inserted: boolean } {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO inbox
           (session_id, sender, slack_user, body, slack_channel_id, slack_ts, created_at, question_id)
         VALUES (?, 'human', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.sessionId,
        message.slackUser,
        message.body,
        message.slackChannelId,
        message.slackTs,
        this.timestamp(),
        message.questionId ?? null,
      );
    const row = this.db
      .prepare('SELECT * FROM inbox WHERE slack_channel_id = ? AND slack_ts = ?')
      .get(message.slackChannelId, message.slackTs) as Row;
    return { record: toInbox(row), inserted: Number(result.changes) === 1 };
  }

  findInbox(channelId: string, ts: string): InboxRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM inbox WHERE slack_channel_id = ? AND slack_ts = ?')
      .get(channelId, ts) as Row | undefined;
    return row && toInbox(row);
  }

  /**
   * Undelivered plain messages for a session, oldest first. Replies that
   * answered a question are delivered with that question's outcome instead.
   */
  undelivered(sessionId: string, limit: number): InboxRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM inbox WHERE session_id = ? AND delivered_at IS NULL AND question_id IS NULL
         ORDER BY id LIMIT ?`,
      )
      .all(sessionId, limit) as Row[];
    return rows.map(toInbox);
  }

  countUndelivered(sessionId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM inbox
         WHERE session_id = ? AND delivered_at IS NULL AND question_id IS NULL`,
      )
      .get(sessionId) as Row;
    return Number(row.n);
  }

  /** Inbox rows (replies) that answered a question. */
  questionReplies(questionId: string): InboxRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM inbox WHERE question_id = ? ORDER BY id')
      .all(questionId) as Row[];
    return rows.map(toInbox);
  }

  // Questions

  insertQuestion(question: NewQuestion): QuestionRecord {
    this.db
      .prepare(
        `INSERT INTO questions
           (id, session_id, text, options, default_answer, created_at, remind_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        question.id,
        question.sessionId,
        question.text,
        JSON.stringify(question.options),
        question.defaultAnswer,
        this.timestamp(),
        question.remindAt?.toISOString() ?? null,
        question.expiresAt.toISOString(),
      );
    return found(this.getQuestion(question.id), `question ${question.id}`);
  }

  getQuestion(id: string): QuestionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as Row | undefined;
    return row && toQuestion(row);
  }

  setQuestionPost(id: string, field: 'post' | 'reminder', postId: number): void {
    const column = field === 'post' ? 'post_id' : 'reminder_post_id';
    const extra = field === 'reminder' ? ', reminded_at = ?' : '';
    const params: SQLInputValue[] =
      field === 'reminder' ? [postId, this.timestamp(), id] : [postId, id];
    this.db.prepare(`UPDATE questions SET ${column} = ?${extra} WHERE id = ?`).run(...params);
  }

  openQuestions(sessionId: string): QuestionRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM questions WHERE session_id = ? AND state = 'open' ORDER BY created_at",
      )
      .all(sessionId) as Row[];
    return rows.map(toQuestion);
  }

  /** The question whose DM (or reminder DM) was sent as this Slack message. */
  questionByPost(channelId: string, ts: string): QuestionRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT questions.* FROM questions JOIN outbox
           ON outbox.id = questions.post_id OR outbox.id = questions.reminder_post_id
         WHERE outbox.slack_channel_id = ? AND outbox.slack_ts = ?`,
      )
      .get(channelId, ts) as Row | undefined;
    return row && toQuestion(row);
  }

  /**
   * Closes an open question (compare-and-swap on `state = 'open'`). Returns
   * false when it was already answered or expired: the first answer wins.
   */
  closeQuestion(
    id: string,
    outcome:
      | { state: 'answered'; answer: string; answeredBy: string; source: AnswerSource }
      | { state: 'expired' },
  ): boolean {
    const answered = outcome.state === 'answered' ? outcome : undefined;
    const result = this.db
      .prepare(
        `UPDATE questions SET state = ?, answer = ?, answered_by = ?, answer_source = ?, closed_at = ?
         WHERE id = ? AND state = 'open'`,
      )
      .run(
        outcome.state,
        answered?.answer ?? null,
        answered?.answeredBy ?? null,
        answered?.source ?? null,
        this.timestamp(),
        id,
      );
    return Number(result.changes) === 1;
  }

  /** Open questions whose reminder is due and hasn't been sent. */
  dueReminders(now: Date): QuestionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM questions WHERE state = 'open' AND reminded_at IS NULL
         AND remind_at IS NOT NULL AND remind_at <= ? AND expires_at > ? ORDER BY remind_at`,
      )
      .all(now.toISOString(), now.toISOString()) as Row[];
    return rows.map(toQuestion);
  }

  dueExpiries(now: Date): QuestionRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM questions WHERE state = 'open' AND expires_at <= ? ORDER BY expires_at",
      )
      .all(now.toISOString()) as Row[];
    return rows.map(toQuestion);
  }

  /** Answered or expired questions whose outcome the agent hasn't been given. */
  undeliveredOutcomes(sessionId: string): QuestionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM questions WHERE session_id = ? AND state != 'open' AND delivered_at IS NULL
         ORDER BY closed_at`,
      )
      .all(sessionId) as Row[];
    return rows.map(toQuestion);
  }

  /** Marks an outcome delivered, with the replies that answered it. */
  markQuestionDelivered(id: string, via: DeliveryVia): void {
    const at = this.timestamp();
    this.db
      .prepare(
        'UPDATE questions SET delivered_at = ?, delivered_via = ? WHERE id = ? AND delivered_at IS NULL',
      )
      .run(at, via, id);
    this.db
      .prepare(
        'UPDATE inbox SET delivered_at = ?, delivered_via = ? WHERE question_id = ? AND delivered_at IS NULL',
      )
      .run(at, via, id);
  }

  markDelivered(ids: readonly number[], via: DeliveryVia): void {
    const statement = this.db.prepare(
      'UPDATE inbox SET delivered_at = ?, delivered_via = ? WHERE id = ? AND delivered_at IS NULL',
    );
    const at = this.timestamp();
    for (const id of ids) statement.run(at, via, id);
  }

  // Audit log

  appendEvent(event: NewEvent): number {
    const result = this.db
      .prepare('INSERT INTO events (at, kind, platform, session_id, data) VALUES (?, ?, ?, ?, ?)')
      .run(
        this.timestamp(),
        event.kind,
        event.platform ?? null,
        event.sessionId ?? null,
        JSON.stringify(event.data ?? {}),
      );
    return Number(result.lastInsertRowid);
  }

  /** The newest event of a kind for a session, optionally matching a top-level `data` field. */
  latestEvent(filter: {
    kind: string;
    sessionId: string;
    dataField?: { name: string; value: string };
  }): Record<string, unknown> | undefined {
    const where = ['kind = ?', 'session_id = ?'];
    const params: SQLInputValue[] = [filter.kind, filter.sessionId];
    if (filter.dataField) {
      where.push('json_extract(data, ?) = ?');
      params.push(`$.${filter.dataField.name}`, filter.dataField.value);
    }
    const row = this.db
      .prepare(`SELECT data FROM events WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 1`)
      .get(...params) as Row | undefined;
    return row ? (JSON.parse(String(row.data)) as Record<string, unknown>) : undefined;
  }

  /** Counts events since a time, optionally matching a top-level `data` field. */
  countEvents(filter: {
    kind: string;
    since: Date;
    sessionId?: string;
    platform?: Platform;
    dataField?: { name: string; value: string };
  }): number {
    const where = ['kind = ?', 'at >= ?'];
    const params: SQLInputValue[] = [filter.kind, filter.since.toISOString()];
    if (filter.sessionId !== undefined) {
      where.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter.platform !== undefined) {
      where.push('platform = ?');
      params.push(filter.platform);
    }
    if (filter.dataField) {
      where.push('json_extract(data, ?) = ?');
      params.push(`$.${filter.dataField.name}`, filter.dataField.value);
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE ${where.join(' AND ')}`)
      .get(...params) as Row;
    return Number(row.n);
  }

  // Outbox

  enqueue(post: NewPost): OutboxRecord {
    if (post.idemKey) {
      const existing = this.db
        .prepare('SELECT * FROM outbox WHERE idem_key = ?')
        .get(post.idemKey) as Row | undefined;
      if (existing) return toOutbox(existing);
    }
    const result = this.db
      .prepare(
        `INSERT INTO outbox
           (idem_key, target, session_id, in_thread, text, username, icon, created_at, blocks)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        post.idemKey ?? null,
        post.target,
        post.sessionId ?? null,
        post.inThread ? 1 : 0,
        post.text,
        post.username ?? null,
        post.icon ?? null,
        this.timestamp(),
        post.blocks ? JSON.stringify(post.blocks) : null,
      );
    return found(this.getPost(Number(result.lastInsertRowid)), 'new outbox post');
  }

  /** Rewrites a post that hasn't been sent yet; false once it's sent (edit it in Slack instead). */
  updateQueuedPost(id: number, text: string, blocks: unknown[] | null): boolean {
    const result = this.db
      .prepare("UPDATE outbox SET text = ?, blocks = ? WHERE id = ? AND state = 'queued'")
      .run(text, blocks ? JSON.stringify(blocks) : null, id);
    return Number(result.changes) === 1;
  }

  getPost(id: number): OutboxRecord | undefined {
    const row = this.db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as Row | undefined;
    return row && toOutbox(row);
  }

  /** Targets with queued posts, so the queue can start one lane per target. */
  queuedTargets(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT target FROM outbox WHERE state = 'queued'")
      .all() as Row[];
    return rows.map((row) => String(row.target));
  }

  nextQueued(target: string): OutboxRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM outbox WHERE state = 'queued' AND target = ? ORDER BY id LIMIT 1")
      .get(target) as Row | undefined;
    return row && toOutbox(row);
  }

  markSent(id: number, slackChannelId: string, slackTs: string): void {
    this.db
      .prepare(
        `UPDATE outbox SET state = 'sent', attempts = attempts + 1, sent_at = ?,
         slack_channel_id = ?, slack_ts = ?, last_error = NULL WHERE id = ?`,
      )
      .run(this.timestamp(), slackChannelId, slackTs, id);
  }

  /** Records a failed attempt; `final` gives up on the post. */
  markAttemptFailed(id: number, error: string, final: boolean): void {
    this.db
      .prepare(
        `UPDATE outbox SET attempts = attempts + 1, last_error = ?,
         state = CASE WHEN ? THEN 'failed' ELSE state END WHERE id = ?`,
      )
      .run(error, final ? 1 : 0, id);
  }
}

function toSession(row: Row): SessionRecord {
  return {
    id: String(row.id),
    platform: row.platform as Platform,
    project: String(row.project),
    branch: nullableString(row.branch),
    purpose: nullableString(row.purpose),
    channel: String(row.channel),
    slackChannelId: nullableString(row.slack_channel_id),
    threadTs: nullableString(row.thread_ts),
    appSessionId: nullableString(row.app_session_id),
    announcedAt: nullableString(row.announced_at),
    createdAt: String(row.created_at),
    lastSeenAt: String(row.last_seen_at),
  };
}

function toOutbox(row: Row): OutboxRecord {
  return {
    id: Number(row.id),
    target: String(row.target),
    sessionId: nullableString(row.session_id),
    inThread: Number(row.in_thread) === 1,
    text: String(row.text),
    username: nullableString(row.username),
    icon: nullableString(row.icon),
    state: row.state as OutboxRecord['state'],
    attempts: Number(row.attempts),
    lastError: nullableString(row.last_error),
    slackChannelId: nullableString(row.slack_channel_id),
    slackTs: nullableString(row.slack_ts),
    blocks:
      row.blocks === null || row.blocks === undefined
        ? null
        : (JSON.parse(String(row.blocks)) as unknown[]),
  };
}

function toQuestion(row: Row): QuestionRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    text: String(row.text),
    options: JSON.parse(String(row.options)) as string[],
    defaultAnswer: String(row.default_answer),
    state: row.state as QuestionState,
    answer: nullableString(row.answer),
    answeredBy: nullableString(row.answered_by),
    answerSource: nullableString(row.answer_source) as AnswerSource | null,
    postId: row.post_id === null || row.post_id === undefined ? null : Number(row.post_id),
    reminderPostId:
      row.reminder_post_id === null || row.reminder_post_id === undefined
        ? null
        : Number(row.reminder_post_id),
    createdAt: String(row.created_at),
    remindAt: nullableString(row.remind_at),
    remindedAt: nullableString(row.reminded_at),
    expiresAt: String(row.expires_at),
    closedAt: nullableString(row.closed_at),
    deliveredAt: nullableString(row.delivered_at),
    deliveredVia: nullableString(row.delivered_via) as DeliveryVia | null,
  };
}

function toInbox(row: Row): InboxRecord {
  return {
    id: Number(row.id),
    sessionId: String(row.session_id),
    sender: 'human',
    slackUser: String(row.slack_user),
    body: String(row.body),
    slackChannelId: String(row.slack_channel_id),
    slackTs: String(row.slack_ts),
    createdAt: String(row.created_at),
    deliveredAt: nullableString(row.delivered_at),
    deliveredVia: nullableString(row.delivered_via) as DeliveryVia | null,
    questionId: nullableString(row.question_id),
  };
}

/** For rows that must exist (just inserted, or checked earlier in the same call). */
export function found<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`agent-bus store: ${what} not found`);
  return value;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
