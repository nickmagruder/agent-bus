import { describe, expect, it } from 'vitest';
import { HeldCalls } from '../../src/broker/held-calls.ts';

describe('HeldCalls', () => {
  it('cancels only the call with that platform and request ID', () => {
    const calls = new HeldCalls();
    const a = calls.hold('claude', 7);
    const b = calls.hold('codex', 7);
    const c = calls.hold('claude', 8);
    const d = calls.hold('claude', '7'); // a string ID is a different ID
    expect(calls.cancel('claude', 7, 'Esc')).toBe(1);
    expect(a.signal.aborted).toBe(true);
    expect(a.signal.reason).toBe('Esc');
    expect([b, c, d].map((call) => call.signal.aborted)).toEqual([false, false, false]);
  });

  it('cancels every call sharing an ID on one platform (two clients)', () => {
    const calls = new HeldCalls();
    const first = calls.hold('claude', 1);
    const second = calls.hold('claude', 1);
    expect(calls.cancel('claude', 1)).toBe(2);
    expect(first.signal.aborted && second.signal.aborted).toBe(true);
  });

  it('forgets released calls, so a late cancel finds nothing', () => {
    const calls = new HeldCalls();
    const call = calls.hold('claude', 3);
    expect(calls.size).toBe(1);
    call.release();
    call.release(); // twice is harmless
    expect(calls.size).toBe(0);
    expect(calls.cancel('claude', 3)).toBe(0);
    expect(call.signal.aborted).toBe(false);
  });

  it('a released call does not drop a newer one with the same key', () => {
    const calls = new HeldCalls();
    const old = calls.hold('claude', 4);
    old.release();
    const fresh = calls.hold('claude', 4);
    old.release();
    expect(calls.cancel('claude', 4)).toBe(1);
    expect(fresh.signal.aborted).toBe(true);
  });
});
