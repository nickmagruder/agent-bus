import { describe, expect, it } from 'vitest';
import { checkCommitMessage, MAX_SUMMARY, stripComments } from '../../scripts/commit-msg.ts';

const TRAILER = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';

describe('checkCommitMessage', () => {
  it('accepts an imperative summary with a body and trailer', () => {
    expect(checkCommitMessage(`Add digest scheduler\n\nWhy it matters.\n\n${TRAILER}\n`)).toEqual(
      [],
    );
  });

  it('accepts a summary of exactly the maximum length', () => {
    expect(checkCommitMessage('A'.repeat(MAX_SUMMARY))).toEqual([]);
  });

  it('rejects an empty message, including one with only comments', () => {
    expect(checkCommitMessage('')).toEqual(['The commit message is empty.']);
    expect(checkCommitMessage('# Please enter the commit message\n#\n')).toEqual([
      'The commit message is empty.',
    ]);
  });

  it('rejects a summary over the limit', () => {
    expect(checkCommitMessage('A'.repeat(MAX_SUMMARY + 1))).toEqual([
      `Summary is ${MAX_SUMMARY + 1} characters; keep it to ${MAX_SUMMARY} or fewer.`,
    ]);
  });

  it('rejects a trailing period and a lowercase start', () => {
    expect(checkCommitMessage('fix the queue.')).toEqual([
      'Summary ends with a period; drop it.',
      'Summary starts with a lowercase letter; capitalise it.',
    ]);
  });

  it.each(['Added', 'Adding', 'Adds', 'Fixes', 'Updated', 'Updating'])(
    'rejects a non-imperative first word: %s',
    (word) => {
      expect(checkCommitMessage(`${word} the digest`)).toHaveLength(1);
    },
  );

  it.each(['Embed', 'Need', 'Ping', 'Seed', 'Speed', 'Bring', 'Use', 'Fix', 'Add'])(
    'accepts an imperative first word: %s',
    (word) => {
      expect(checkCommitMessage(`${word} the digest`)).toEqual([]);
    },
  );

  it('accepts a summary that starts with code or a number', () => {
    expect(checkCommitMessage('`ask_human`: require a default action')).toEqual([]);
    expect(checkCommitMessage('2FA: nothing to see')).toEqual([]);
  });

  it('requires a blank line between summary and body', () => {
    expect(checkCommitMessage('Add digest\nbody right away')).toEqual([
      'Leave a blank line between the summary and the body.',
    ]);
  });

  it.each([
    'Merge pull request #9 from nickmagruder/docs/public-readme',
    "Merge branch 'main' into feat/x",
    'Revert "Add digest scheduler"',
    'fixup! Add digest scheduler',
    'squash! Add digest scheduler',
    'amend! Add digest scheduler',
  ])('skips messages git writes itself: %s', (summary) => {
    expect(checkCommitMessage(`${summary}${'x'.repeat(80)}.`)).toEqual([]);
  });

  it('handles CRLF line endings', () => {
    expect(checkCommitMessage('Add digest\r\n\r\nBody\r\n')).toEqual([]);
  });
});

describe('stripComments', () => {
  it('drops comment lines and everything below the scissors line', () => {
    const raw = [
      'Add digest',
      '',
      '# Please enter the commit message',
      'Body',
      '# ------------------------ >8 ------------------------',
      'diff --git a/x b/x',
    ].join('\n');
    expect(stripComments(raw)).toBe('Add digest\n\nBody');
  });
});
