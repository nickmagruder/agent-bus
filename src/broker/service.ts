import { PLATFORM_STYLE, type Platform } from '../shared/platform.ts';
import { newSessionId, NO_PROJECT, projectSlug } from '../shared/session-id.ts';
import { escapeSlackText } from '../shared/slack-text.ts';
import { FALLBACK_CHANNEL } from './slack/directory.ts';
import { DM_TARGET, found, type SessionRecord, type Store } from './store.ts';

export const URGENCIES = ['urgent', 'normal', 'fyi'] as const;
export type Urgency = (typeof URGENCIES)[number];

/** Per-hour caps that stop a looping agent from flooding Slack or my DMs. */
export const LIMITS = {
  registerPerPlatform: 30,
  notifyPerSession: 60,
  urgentPerSession: 10,
} as const;

const HOUR_MS = 60 * 60_000;

export type BusErrorCode = 'unknown_session' | 'wrong_platform' | 'rate_limited';

/** An error the calling agent should see and can act on. */
export class BusError extends Error {
  readonly code: BusErrorCode;

  constructor(code: BusErrorCode, message: string) {
    super(message);
    this.name = 'BusError';
    this.code = code;
  }
}

export interface RegisterInput {
  platform: Platform;
  purpose: string;
  project?: string | undefined;
  branch?: string | undefined;
  /** A bus ID minted earlier (by a hook, or a previous register call). */
  session?: string | undefined;
}

export interface NotifyInput {
  platform: Platform;
  session: string;
  text: string;
  urgency: Urgency;
}

export type Route = 'dm' | 'thread' | 'digest';

/**
 * The broker's rules: who may act on which session, where each message goes,
 * and how often. Everything here is written to the audit log.
 */
export class BusService {
  private readonly store: Store;
  private readonly queue: { kick(): void };
  private readonly now: () => Date;

  constructor(store: Store, queue: { kick(): void }, now: () => Date = () => new Date()) {
    this.store = store;
    this.queue = queue;
    this.now = now;
  }

  register(input: RegisterInput): { session: SessionRecord; created: boolean } {
    if (input.session) return this.reregister(input, input.session);

    const since = new Date(this.now().getTime() - HOUR_MS);
    if (
      this.store.countEvents({ kind: 'session.created', platform: input.platform, since }) >=
      LIMITS.registerPerPlatform
    ) {
      this.deny(input.platform, null, 'rate_limited', 'register');
      throw new BusError('rate_limited', 'Too many new sessions this hour; try again later.');
    }

    const project = input.project ? projectSlug(input.project) : NO_PROJECT;
    const channel = project === NO_PROJECT ? FALLBACK_CHANNEL : `proj-${project}`;
    const session = this.store.transaction(() => {
      let id = newSessionId(input.platform, project);
      while (this.store.getSession(id)) id = newSessionId(input.platform, project);
      const created = this.store.insertSession({
        id,
        platform: input.platform,
        project,
        branch: input.branch ?? null,
        purpose: input.purpose,
        channel,
      });
      this.store.appendEvent({
        kind: 'session.created',
        platform: input.platform,
        sessionId: id,
        data: { project, branch: input.branch ?? null, purpose: input.purpose },
      });
      this.store.enqueue({
        target: channel,
        sessionId: id,
        inThread: true,
        text: sessionStartText(created),
        ...style(created),
      });
      return created;
    });
    this.queue.kick();
    return { session, created: true };
  }

  notify(input: NotifyInput): { route: Route } {
    const session = this.ownedSession(input.platform, input.session, 'notify');
    const since = new Date(this.now().getTime() - HOUR_MS);
    const sent = this.store.countEvents({ kind: 'notify', sessionId: session.id, since });
    const urgentSent =
      input.urgency === 'urgent'
        ? this.store.countEvents({
            kind: 'notify',
            sessionId: session.id,
            since,
            dataField: { name: 'urgency', value: 'urgent' },
          })
        : 0;
    if (sent >= LIMITS.notifyPerSession || urgentSent >= LIMITS.urgentPerSession) {
      this.deny(input.platform, session.id, 'rate_limited', 'notify');
      throw new BusError(
        'rate_limited',
        'Notification limit reached for this session; batch updates or wait before sending more.',
      );
    }

    const route: Route =
      input.urgency === 'urgent' ? 'dm' : input.urgency === 'normal' ? 'thread' : 'digest';
    this.store.transaction(() => {
      this.store.touchSession(session.id);
      this.store.appendEvent({
        kind: 'notify',
        platform: input.platform,
        sessionId: session.id,
        data: { urgency: input.urgency, route, text: input.text },
      });
      if (route === 'dm') {
        this.store.enqueue({
          target: DM_TARGET,
          sessionId: session.id,
          text: urgentText(session, input.text),
          ...style(session),
        });
      } else if (route === 'thread') {
        this.store.enqueue({
          target: session.channel,
          sessionId: session.id,
          inThread: true,
          text: escapeSlackText(input.text),
          ...style(session),
        });
      }
    });
    if (route !== 'digest') this.queue.kick();
    return { route };
  }

  private reregister(
    input: RegisterInput,
    id: string,
  ): { session: SessionRecord; created: boolean } {
    const session = this.ownedSession(input.platform, id, 'register');
    const purposeChanged = input.purpose !== session.purpose;
    this.store.transaction(() => {
      this.store.touchSession(id, {
        purpose: input.purpose,
        ...(input.branch ? { branch: input.branch } : {}),
      });
      this.store.appendEvent({
        kind: 'session.registered',
        platform: input.platform,
        sessionId: id,
        data: { purpose: input.purpose, branch: input.branch ?? null },
      });
      if (purposeChanged) {
        this.store.enqueue({
          target: session.channel,
          sessionId: id,
          inThread: true,
          text: `*Purpose:* ${escapeSlackText(input.purpose)}`,
          ...style(session),
        });
      }
    });
    if (purposeChanged) this.queue.kick();
    return { session: found(this.store.getSession(id), `session ${id}`), created: false };
  }

  /** A session the calling platform may act on. Identity comes from the token, not the ID. */
  private ownedSession(platform: Platform, id: string, action: string): SessionRecord {
    const session = this.store.getSession(id);
    if (!session) {
      this.deny(platform, null, 'unknown_session', action, id);
      throw new BusError(
        'unknown_session',
        `Unknown session "${id}". Call register without a session to get one.`,
      );
    }
    if (session.platform !== platform) {
      this.deny(platform, null, 'wrong_platform', action, id);
      throw new BusError('wrong_platform', `Session "${id}" belongs to another platform.`);
    }
    return session;
  }

  private deny(
    platform: Platform,
    sessionId: string | null,
    reason: BusErrorCode,
    action: string,
    claimed?: string,
  ): void {
    this.store.appendEvent({
      kind: 'denied',
      platform,
      sessionId,
      data: { action, reason, ...(claimed ? { claimedSession: claimed } : {}) },
    });
  }
}

function style(session: SessionRecord): { username: string; icon: string } {
  const { label, icon } = PLATFORM_STYLE[session.platform];
  return { username: `${label} · ${session.project}`, icon };
}

export function sessionStartText(session: SessionRecord): string {
  const branch = session.branch ? ` on \`${escapeSlackText(session.branch)}\`` : '';
  const purpose = session.purpose ? `\n> ${escapeSlackText(session.purpose)}` : '';
  return `:large_green_circle: *Session started* \`${session.id}\`${branch}${purpose}`;
}

export function urgentText(session: SessionRecord, text: string): string {
  return `:rotating_light: \`${session.id}\` needs you\n${escapeSlackText(text)}`;
}
