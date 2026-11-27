import type { Logger } from './log.ts';
import type { MessageEditor } from './questions.ts';
import type { LeaseHooks } from './service.ts';
import { DM_TARGET, LEASE_IDLE_MS, type SessionRecord, type Store } from './store.ts';

/**
 * Repo leases (#31, D6, Q7, Q22): in a repo listed in
 * `AGENT_BUS_LEASE_REPOS` (by project name), one session at a time holds the
 * lease. SessionStart claims a free lease; the holder's activity (any hook or
 * tool call) keeps it, and it lapses after 2 h idle. Copilot, which has no
 * hooks, claims with `claim_lease`. Leases only warn: a second session is
 * told who holds it, and I get a DM with Break. Nothing is ever blocked.
 */
export const LEASES = {
  /** A lease lapses this long after its holder's last sign of life (Q22). */
  idleMs: LEASE_IDLE_MS,
} as const;

/** The Break button's `action_id`; its block ID is `<repo>|<holder>`. */
export const LEASE_ACTION = /^agentbus_lease_break$/;

export type LeaseSource = 'hook' | 'tool';

export interface LeaseRecord {
  repo: string;
  holder: string;
  source: LeaseSource;
  claimedAt: string;
  renewedAt: string;
  /** When it lapses unless the holder shows life (each hook or tool call pushes it to now + 2 h). */
  expiresAt: string;
}

export type ClaimOutcome =
  { held: true; lease: LeaseRecord; renewed: boolean } | { held: false; lease: LeaseRecord };

export type BreakOutcome = 'broken' | 'changed' | 'not_human';

type Row = Record<string, unknown>;

export class Leases implements LeaseHooks {
  private readonly store: Store;
  private readonly queue: { kick(): void };
  private readonly repos: ReadonlySet<string>;
  private readonly humanUserId: string | undefined;
  private readonly editor: MessageEditor | undefined;
  private readonly log: Logger | undefined;
  private readonly now: () => Date;

  constructor(options: {
    store: Store;
    queue: { kick(): void };
    /** Project names whose repos are leased. */
    repos: readonly string[];
    humanUserId?: string;
    editor?: MessageEditor;
    log?: Logger;
    now?: () => Date;
  }) {
    this.store = options.store;
    this.queue = options.queue;
    this.repos = new Set(options.repos);
    this.humanUserId = options.humanUserId;
    this.editor = options.editor;
    this.log = options.log;
    this.now = options.now ?? (() => new Date());
  }

  isLeased(repo: string): boolean {
    return this.repos.has(repo);
  }

  /** SessionStart in a leased repo: claim it if free, else warn (Q22). */
  atSessionStart(session: SessionRecord): string | undefined {
    if (!this.isLeased(session.project)) return undefined;
    const outcome = this.claim(session, session.project, 'hook');
    return outcome.held ? heldText(session.project) : contendedText(outcome.lease);
  }

  /**
   * A prompt: once, the news that I broke this session's lease; and for a
   * session whose lease SessionEnd released, a fresh claim (#100).
   */
  atPrompt(session: SessionRecord): string | undefined {
    const parts = [this.takeBrokenNotice(session), this.reclaimAfterEnd(session)];
    const present = parts.filter((part): part is string => Boolean(part));
    return present.length > 0 ? present.join('\n\n') : undefined;
  }

  /**
   * Codex ends a conversation that sits idle 30 min (SessionEnd), which
   * releases its lease, yet the user can come back to it. Its next prompt
   * claims again, once per release, and tells the agent either way, so it
   * never edits on a lease it no longer holds without knowing.
   */
  private reclaimAfterEnd(session: SessionRecord): string | undefined {
    const repo = session.project;
    if (!this.isLeased(repo)) return undefined;
    return this.store.transaction(() => {
      const ended = this.store.latestEvent({
        kind: 'lease.released',
        sessionId: session.id,
        dataField: { name: 'via', value: 'session_end' },
      });
      if (!ended) return undefined;
      const since = this.store.db
        .prepare(
          `SELECT 1 FROM events WHERE session_id = ? AND id > ?
             AND kind IN ('lease.claimed', 'lease.renewed', 'lease.resumed')
             AND json_extract(data, '$.repo') = ?`,
        )
        .get(session.id, Number(ended.eventId), repo);
      if (since) return undefined;
      const outcome = this.claim(session, repo, 'hook');
      this.store.appendEvent({
        kind: 'lease.resumed',
        platform: session.platform,
        sessionId: session.id,
        data: { repo, held: outcome.held },
      });
      const lead = `agent-bus: this session ended earlier, which released its lease on ${repo}.`;
      return `${lead} ${outcome.held ? heldText(repo) : contendedText(outcome.lease)}`;
    });
  }

  /**
   * SessionEnd (#100): the session lets go of every lease it holds, live or
   * lapsed, so the next session needn't wait out the 2 h idle.
   */
  atSessionEnd(session: SessionRecord): string[] {
    return this.store.transaction(() => {
      const rows = this.store.db
        .prepare('SELECT repo FROM leases WHERE holder = ? ORDER BY repo')
        .all(session.id) as Row[];
      const repos = rows.map((row) => String(row.repo));
      for (const repo of repos) this.release(session, repo, 'session_end');
      return repos;
    });
  }

  /** The repo's lease, if it's held and hasn't lapsed. */
  current(repo: string): LeaseRecord | undefined {
    const row = this.store.db.prepare('SELECT * FROM leases WHERE repo = ?').get(repo) as
      Row | undefined;
    const lease = row && toLease(row);
    return lease && this.live(lease) ? lease : undefined;
  }

  /** Every lease still held, oldest first (for the digest). */
  held(): LeaseRecord[] {
    const rows = this.store.db.prepare('SELECT * FROM leases ORDER BY claimed_at').all() as Row[];
    return rows.map(toLease).filter((lease) => this.live(lease));
  }

  /**
   * Claims a repo's lease for a session: free (never held, released, broken
   * or lapsed) or already its own. Otherwise reports the holder, and the
   * first time this session meets it, DMs me with Break. Atomic: two
   * sessions racing get one holder.
   */
  claim(session: SessionRecord, repo: string, source: LeaseSource): ClaimOutcome {
    const outcome = this.store.transaction((): ClaimOutcome => {
      const existing = this.current(repo);
      if (existing && existing.holder !== session.id) {
        this.contended(session, existing);
        return { held: false, lease: existing };
      }
      const at = this.now();
      const iso = at.toISOString();
      const expires = new Date(at.getTime() + LEASES.idleMs).toISOString();
      // A live lease of its own keeps its first claim time; a fresh or lapsed
      // one starts now (`existing` is live-checked).
      const claimedAt = existing ? existing.claimedAt : iso;
      this.store.db
        .prepare(
          `INSERT INTO leases (repo, holder, source, claimed_at, renewed_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (repo) DO UPDATE SET
             claimed_at = excluded.claimed_at, holder = excluded.holder,
             source = excluded.source, renewed_at = excluded.renewed_at,
             expires_at = excluded.expires_at`,
        )
        .run(repo, session.id, source, claimedAt, iso, expires);
      this.store.appendEvent({
        kind: existing ? 'lease.renewed' : 'lease.claimed',
        platform: session.platform,
        sessionId: session.id,
        data: { repo, source },
      });
      return { held: true, lease: found(this.lease(repo)), renewed: Boolean(existing) };
    });
    this.queue.kick();
    return outcome;
  }

  /** Lets go of a session's own lease; false when it didn't hold it. */
  release(session: SessionRecord, repo: string, via?: 'session_end'): boolean {
    return this.store.transaction(() => {
      const changed = this.store.db
        .prepare('DELETE FROM leases WHERE repo = ? AND holder = ?')
        .run(repo, session.id).changes;
      if (changed === 0) return false;
      this.store.appendEvent({
        kind: 'lease.released',
        platform: session.platform,
        sessionId: session.id,
        data: via ? { repo, via } : { repo },
      });
      return true;
    });
  }

  /**
   * My Break click. Only my clicks count (T5): anyone else's is dropped and
   * audited. It breaks the lease only if the holder the DM named still holds
   * it (compare and swap); the old holder hears at its next prompt.
   */
  breakByButton(blockId: string, userId: string): BreakOutcome {
    const [repo = '', holder = ''] = blockId.split('|');
    if (userId !== this.humanUserId) {
      this.store.appendEvent({
        kind: 'inbound.dropped',
        data: {
          reason: 'not_human',
          user: userId.slice(0, 40),
          repo: repo.slice(0, 100),
          via: 'lease_button',
        },
      });
      return 'not_human';
    }
    const broken = this.store.transaction(() => {
      const lease = this.lease(repo);
      // Only a live lease of the holder the DM named is broken. One that
      // already lapsed is just cleared: the holder isn't told to stop.
      const live = lease?.holder === holder && this.live(lease);
      const changed = this.store.db
        .prepare('DELETE FROM leases WHERE repo = ? AND holder = ?')
        .run(repo, holder).changes;
      if (changed === 0 || !live) return false;
      this.store.appendEvent({
        kind: 'lease.broken',
        sessionId: holder,
        data: { repo, by: 'nick' },
      });
      return true;
    });
    this.refreshDms(repo, holder, broken ? 'broken' : 'changed');
    this.queue.kick();
    return broken ? 'broken' : 'changed';
  }

  /**
   * Leases I broke that the old holder hasn't been told about yet, and marks
   * them told: the words for its next prompt's context (Claude Code, Codex).
   */
  takeBrokenNotice(session: SessionRecord): string | undefined {
    return this.store.transaction(() => {
      const told = this.store.latestEvent({ kind: 'lease.broken_told', sessionId: session.id });
      const rows = this.store.db
        .prepare(
          `SELECT data FROM events WHERE kind = 'lease.broken' AND session_id = ? AND id > ?
           ORDER BY id`,
        )
        .all(session.id, Number(told?.eventId ?? 0)) as Row[];
      if (rows.length === 0) return undefined;
      const repos = rows.map((row) => String((JSON.parse(String(row.data)) as Row).repo));
      this.store.appendEvent({
        kind: 'lease.broken_told',
        platform: session.platform,
        sessionId: session.id,
        data: { repos },
      });
      return brokenText(repos);
    });
  }

  /** A lease the caller holds, refused otherwise (for the tools' renew and status). */
  heldBy(session: SessionRecord, repo: string): LeaseRecord | undefined {
    const lease = this.current(repo);
    return lease?.holder === session.id ? lease : undefined;
  }

  /** Live: its expiry, pushed on by the holder's activity (Store.touchSession), is ahead. */
  private live(lease: LeaseRecord): boolean {
    return lease.expiresAt > this.now().toISOString();
  }

  private lease(repo: string): LeaseRecord | undefined {
    const row = this.store.db.prepare('SELECT * FROM leases WHERE repo = ?').get(repo) as
      Row | undefined;
    return row && toLease(row);
  }

  /** The first time a session meets another's lease: a DM to me with Break. */
  private contended(session: SessionRecord, lease: LeaseRecord): void {
    const seen = this.store.db
      .prepare(
        `SELECT 1 FROM events WHERE kind = 'lease.contended' AND session_id = ?
           AND json_extract(data, '$.repo') = ? AND json_extract(data, '$.holder') = ?`,
      )
      .get(session.id, lease.repo, lease.holder);
    if (seen) return;
    const message = breakMessage(lease, session.id, this.lastSeen(lease));
    const post = this.store.enqueue({
      target: DM_TARGET,
      text: message.text,
      blocks: message.blocks,
    });
    this.store.appendEvent({
      kind: 'lease.contended',
      platform: session.platform,
      sessionId: session.id,
      data: { repo: lease.repo, holder: lease.holder, post: post.id },
    });
  }

  /** Edits every Break DM about this repo and holder to show the outcome. */
  private refreshDms(repo: string, holder: string, outcome: 'broken' | 'changed'): void {
    const rows = this.store.db
      .prepare(
        `SELECT session_id, json_extract(data, '$.post') AS post FROM events
         WHERE kind = 'lease.contended' AND json_extract(data, '$.repo') = ?
           AND json_extract(data, '$.holder') = ?`,
      )
      .all(repo, holder) as Row[];
    for (const row of rows) {
      const postId = Number(row.post);
      const post = this.store.getPost(postId);
      if (!post) {
        this.log?.('warn', 'lease DM not found', { post: postId });
        continue;
      }
      const message = breakOutcome(post.blocks?.[0], repo, holder, outcome);
      if (this.store.updateQueuedPost(postId, message.text, message.blocks)) continue;
      if (post.state === 'sent' && post.slackChannelId && post.slackTs) {
        this.editor?.update(post.slackChannelId, post.slackTs, message.text, message.blocks);
      }
    }
  }

  private lastSeen(lease: LeaseRecord): string {
    const holder = this.store.getSession(lease.holder);
    return holder && holder.lastSeenAt > lease.renewedAt ? holder.lastSeenAt : lease.renewedAt;
  }
}

/** What a session that now holds the lease is told (SessionStart context, claim_lease). */
export function heldText(repo: string): string {
  return (
    `agent-bus: you hold the lease on ${repo}, so other agents are told not to edit it while ` +
    `you're active (it lapses after ${LEASES.idleMs / 3_600_000} hours idle). ` +
    'Call release_lease when you finish editing here.'
  );
}

/** What a session told off a held lease hears (SessionStart context, claim_lease). */
export function contendedText(lease: LeaseRecord): string {
  return (
    `agent-bus: ${lease.repo} is leased to another session, ${lease.holder}, since ` +
    `${lease.claimedAt}. Don't edit files in ${lease.repo} until it's released; read-only ` +
    'work is fine. Nick has been told and can break the lease.'
  );
}

function brokenText(repos: readonly string[]): string {
  const list = [...new Set(repos)].join(', ');
  return (
    `agent-bus: Nick broke your lease on ${list}. Another session may be editing there now: ` +
    'stop editing those files, and check with Nick before you go on.'
  );
}

/** My DM about a contended lease, with Break. */
export function breakMessage(
  lease: LeaseRecord,
  claimant: string,
  lastSeen: string,
): { text: string; blocks: unknown[] } {
  const head =
    `:lock: \`${claimant}\` wants to work in \`${lease.repo}\`, but \`${lease.holder}\` ` +
    `holds its lease (since ${when(lease.claimedAt)}, last seen ${when(lastSeen)}). ` +
    `\`${claimant}\` was told not to edit there.`;
  const section = { type: 'section', text: { type: 'mrkdwn', text: head } };
  return {
    text: `${lease.repo} is leased to ${lease.holder}`,
    blocks: [
      section,
      {
        type: 'actions',
        block_id: `${lease.repo}|${lease.holder}`,
        elements: [
          {
            type: 'button',
            action_id: 'agentbus_lease_break',
            style: 'danger',
            text: { type: 'plain_text', text: 'Break', emoji: false },
            value: lease.repo,
          },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text:
              'Break frees the lease; the holder is told at its next prompt. Or leave it: ' +
              `it lapses after ${LEASES.idleMs / 3_600_000} hours of the holder being idle.`,
          },
        ],
      },
    ],
  };
}

/** A Break DM once decided: its own first section, then the outcome (no button). */
function breakOutcome(
  section: unknown,
  repo: string,
  holder: string,
  state: 'broken' | 'changed',
): { text: string; blocks: unknown[] } {
  const outcome =
    state === 'broken'
      ? ':unlock: Broken: the holder is told at its next prompt.'
      : `:information_source: \`${holder}\` no longer holds it: nothing to break.`;
  return {
    text: `${repo} lease (${state})`,
    blocks: [
      ...(section ? [section] : []),
      { type: 'context', elements: [{ type: 'mrkdwn', text: outcome }] },
    ],
  };
}

/** A day and time for Slack ("Mon 3:05 PM"). */
function when(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Feedback for a Break click that changed nothing, shown only to the clicker. */
export const BREAK_REPLIES: Partial<Record<BreakOutcome, string>> = {
  changed: 'That lease was already released, broken, lapsed or taken over: nothing to break.',
  not_human: 'Only Nick can break leases.',
};

function toLease(row: Row): LeaseRecord {
  return {
    repo: String(row.repo),
    holder: String(row.holder),
    source: row.source as LeaseSource,
    claimedAt: String(row.claimed_at),
    renewedAt: String(row.renewed_at),
    expiresAt: String(row.expires_at),
  };
}

function found<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing lease');
  return value;
}
