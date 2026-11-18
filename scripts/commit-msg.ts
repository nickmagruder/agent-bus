// commit-msg hook: checks a commit message against the repo's rules
// (CONTRIBUTING.md). Run by husky as `node scripts/commit-msg.ts <file>`.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MAX_SUMMARY = 72;

/** Messages git or GitHub writes itself; not ours to police. */
const GENERATED = /^(Merge |Revert "|fixup! |squash! |amend! )/;

/** Real words ending in -ed/-ing that are fine as an imperative first word. */
const IMPERATIVE_EXCEPTIONS = new Set([
  'bleed',
  'breed',
  'bring',
  'embed',
  'exceed',
  'feed',
  'need',
  'ping',
  'proceed',
  'seed',
  'shed',
  'shred',
  'speed',
  'spring',
  'string',
  'succeed',
  'swing',
]);

/** Common third-person openers ("Adds" instead of "Add"). */
const THIRD_PERSON = new Set([
  'adds',
  'bumps',
  'changes',
  'fixes',
  'improves',
  'makes',
  'moves',
  'removes',
  'renames',
  'updates',
  'uses',
]);

/** Drops git's comment lines and everything below the `--verbose` scissors line. */
export function stripComments(raw: string): string {
  const lines: string[] = [];
  for (const line of raw.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('# ------------------------ >8')) break;
    if (!line.startsWith('#')) lines.push(line);
  }
  return lines.join('\n').trim();
}

/** Returns the rule violations in a commit message; empty when it passes. */
export function checkCommitMessage(raw: string): string[] {
  const message = stripComments(raw);
  if (message === '') return ['The commit message is empty.'];

  const [summary = '', second] = message.split('\n');
  if (GENERATED.test(summary)) return [];

  const errors: string[] = [];
  if (summary.length > MAX_SUMMARY) {
    errors.push(`Summary is ${summary.length} characters; keep it to ${MAX_SUMMARY} or fewer.`);
  }
  if (summary.endsWith('.')) errors.push('Summary ends with a period; drop it.');
  if (/^[a-z]/.test(summary)) errors.push('Summary starts with a lowercase letter; capitalise it.');

  const first = (summary.match(/^[A-Za-z]+/)?.[0] ?? '').toLowerCase();
  if (first !== '' && !IMPERATIVE_EXCEPTIONS.has(first)) {
    if (/(ed|ing)$/.test(first) || THIRD_PERSON.has(first)) {
      errors.push(
        `Summary starts with "${first}"; use the imperative ("Add", "Fix", not "Added", "Adds", "Adding").`,
      );
    }
  }

  if (second !== undefined && second.trim() !== '') {
    errors.push('Leave a blank line between the summary and the body.');
  }
  return errors;
}

function main(): void {
  const file = process.argv[2];
  if (file === undefined) {
    console.error('usage: node scripts/commit-msg.ts <commit-message-file>');
    process.exit(2);
  }
  const errors = checkCommitMessage(readFileSync(file, 'utf8'));
  if (errors.length > 0) {
    console.error('commit-msg: the message breaks the commit rules (CONTRIBUTING.md):');
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
