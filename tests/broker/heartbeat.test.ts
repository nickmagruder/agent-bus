import type { ServerNotification } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startHeartbeat } from '../../src/broker/heartbeat.ts';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function target(progressToken?: string | number) {
  const sent: ServerNotification[] = [];
  return {
    sent,
    extra: {
      _meta: progressToken === undefined ? undefined : { progressToken },
      sendNotification: async (n: ServerNotification) => {
        sent.push(n);
      },
    },
  };
}

describe('startHeartbeat', () => {
  it('sends progress with the client token every interval until stopped', () => {
    const { sent, extra } = target('tok-1');
    const stop = startHeartbeat(extra, 'waiting for Nick', 60_000);
    vi.advanceTimersByTime(180_000);
    stop();
    vi.advanceTimersByTime(120_000);
    expect(sent).toHaveLength(3);
    expect(sent[0]).toMatchObject({
      method: 'notifications/progress',
      params: { progressToken: 'tok-1', progress: 60, message: 'waiting for Nick' },
    });
    expect(sent[2]).toMatchObject({ params: { progress: 180 } });
  });

  it('falls back to log messages without a progress token', () => {
    const { sent, extra } = target();
    const stop = startHeartbeat(extra, 'waiting', 60_000);
    vi.advanceTimersByTime(60_000);
    stop();
    expect(sent[0]).toMatchObject({
      method: 'notifications/message',
      params: { level: 'info', data: 'waiting (60s)' },
    });
  });

  it('ignores a failed send', () => {
    const stop = startHeartbeat(
      { sendNotification: () => Promise.reject(new Error('gone')) },
      'x',
      1000,
    );
    vi.advanceTimersByTime(3000);
    stop();
  });
});
