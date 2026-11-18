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
}

export interface NewPost {
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

/** How an inbox message reached the agent. */
export type DeliveryVia = 'check_inbox';

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
}

export interface NewInboxMessage {
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

  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

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
           (session_id, sender, slack_user, body, slack_channel_id, slack_ts, created_at)
         VALUES (?, 'human', ?, ?, ?, ?, ?)`,
      )
      .run(
        message.sessionId,
        message.slackUser,
        message.body,
        message.slackChannelId,
        message.slackTs,
        this.timestamp(),
      );
    const row = this.db
      .prepare('SELECT * FROM inbox WHERE slack_channel_id = ? AND slack_ts = ?')
      .get(message.slackChannelId, message.slackTs) as Row;
    return { record: toInbox(row), inserted: Number(result.changes) === 1 };
  }

  /** Undelivered messages for a session, oldest first. */
  undelivered(sessionId: string, limit: number): InboxRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM inbox WHERE session_id = ? AND delivered_at IS NULL ORDER BY id LIMIT ?',
      )
      .all(sessionId, limit) as Row[];
    return rows.map(toInbox);
  }

  countUndelivered(sessionId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM inbox WHERE session_id = ? AND delivered_at IS NULL')
      .get(sessionId) as Row;
    return Number(row.n);
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
        `INSERT INTO outbox (idem_key, target, session_id, in_thread, text, username, icon, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
    return found(this.getPost(Number(result.lastInsertRowid)), 'new outbox post');
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
