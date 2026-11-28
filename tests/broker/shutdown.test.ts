import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { silentLogger } from '../../src/broker/log.ts';
import { makeShutdown, SHUTDOWN_TIMEOUT_MS } from '../../src/broker/shutdown.ts';

let exits: number[];
let exitCodes: number[];
let stops: number;

beforeEach(() => {
  vi.useFakeTimers();
  exits = [];
  exitCodes = [];
  stops = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

function shutdownWith(stop: () => Promise<void>) {
  return makeShutdown({
    stop: () => {
      stops += 1;
      return stop();
    },
    exit: (code) => exits.push(code),
    setExitCode: (code) => exitCodes.push(code),
    log: silentLogger,
  });
}

it('exits 0 after a clean stop, so the launcher stops', async () => {
  shutdownWith(() => Promise.resolve())('SIGTERM');
  await vi.advanceTimersByTimeAsync(0);
  expect(exits).toEqual([0]);
  expect(exitCodes).toEqual([0]);
  // The forced exit was cleared.
  await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS);
  expect(exits).toEqual([0]);
});

it('exits 1 after a stuck-Slack stop, so the launcher restarts the broker', async () => {
  shutdownWith(() => Promise.resolve())('Slack link stuck', 1);
  await vi.advanceTimersByTimeAsync(0);
  expect(exits).toEqual([1]);
});

it('still exits 1 when stopping never finishes (#106)', async () => {
  shutdownWith(() => new Promise<void>(() => undefined))('Slack link stuck', 1);
  // Set up front: if the event loop empties before the timer, Node exits 1, not 0.
  expect(exitCodes).toEqual([1]);
  await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS - 1);
  expect(exits).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(exits).toEqual([1]);
});

it('keeps the forced-exit timer referenced, so it holds the process open', () => {
  const spy = vi.spyOn(globalThis, 'setTimeout');
  shutdownWith(() => new Promise<void>(() => undefined))('Slack link stuck', 1);
  const timer = spy.mock.results[0]?.value as { hasRef?: () => boolean } | undefined;
  expect(timer?.hasRef?.() ?? true).toBe(true);
  spy.mockRestore();
});

it('exits 1 when stopping fails, whatever was asked', async () => {
  shutdownWith(() => Promise.reject(new Error('boom')))('SIGINT');
  await vi.advanceTimersByTimeAsync(0);
  expect(exits).toEqual([1]);
});

it('acts on the first call only: a signal during a stuck-Slack shutdown keeps exit 1', async () => {
  const shutdown = shutdownWith(() => new Promise<void>(() => undefined));
  shutdown('Slack link stuck', 1);
  shutdown('SIGTERM');
  expect(stops).toBe(1);
  expect(exitCodes).toEqual([1]);
  await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS);
  expect(exits).toEqual([1]);
});
