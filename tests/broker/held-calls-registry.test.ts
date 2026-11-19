import { describe, expect, it, vi } from 'vitest';
import { HeldCalls, UNDO_WINDOW_MS } from '../../src/broker/held-calls.ts';

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

describe('HeldCalls: undoing a hand-over the client never read (#50)', () => {
  it('a cancel for a call that just answered runs its undo, once', () => {
    const calls = new HeldCalls();
    let undone = 0;
    calls.answeredWith('claude', 9, () => undone++);
    expect(calls.undoable).toBe(1);
    expect(calls.cancel('claude', 9)).toBe(1);
    expect(undone).toBe(1);
    expect(calls.cancel('claude', 9)).toBe(0);
    expect(undone).toBe(1);
    expect(calls.undoable).toBe(0);
  });

  it('only for the same platform and request ID', () => {
    const calls = new HeldCalls();
    let undone = 0;
    calls.answeredWith('claude', 9, () => undone++);
    expect(calls.cancel('codex', 9)).toBe(0);
    expect(calls.cancel('claude', 10)).toBe(0);
    expect(calls.cancel('claude', '9')).toBe(0);
    expect(undone).toBe(0);
  });

  it('expires after the undo window', () => {
    vi.useFakeTimers();
    try {
      const calls = new HeldCalls();
      let undone = 0;
      calls.answeredWith('claude', 9, () => undone++);
      vi.advanceTimersByTime(UNDO_WINDOW_MS - 1);
      expect(calls.undoable).toBe(1);
      vi.advanceTimersByTime(1);
      expect(calls.undoable).toBe(0);
      expect(calls.cancel('claude', 9)).toBe(0);
      expect(undone).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a live hold with that ID is cancelled instead of undoing an older answer', () => {
    const calls = new HeldCalls();
    let undone = 0;
    calls.answeredWith('claude', 9, () => undone++);
    const live = calls.hold('claude', 9);
    expect(calls.cancel('claude', 9)).toBe(1);
    expect(live.signal.aborted).toBe(true);
    expect(undone).toBe(0);
  });
});
