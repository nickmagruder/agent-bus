import { randomBytes } from 'node:crypto';
import { PLATFORMS, type Platform } from './platform.ts';

/** Project names double as Slack channel suffixes (`#proj-<name>`). */
export const PROJECT_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The project used when an agent doesn't name one; its posts go to `#agents`. */
export const NO_PROJECT = 'misc';

const SESSION_PATTERN = new RegExp(
  `^(${PLATFORMS.join('|')})/([a-z0-9][a-z0-9-]{0,39})/([0-9a-f]{4,8})$`,
);

export interface SessionIdParts {
  platform: Platform;
  project: string;
  suffix: string;
}

/** Turns a folder or repo name into a project slug (`Esri Exporter` → `esri-exporter`). */
export function projectSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return PROJECT_PATTERN.test(slug) ? slug : NO_PROJECT;
}

/** A session ID: `platform/project/suffix`, e.g. `codex/esri-exporter/3f2a`. */
export function newSessionId(platform: Platform, project: string): string {
  return `${platform}/${project}/${randomBytes(2).toString('hex')}`;
}

export function parseSessionId(id: string): SessionIdParts | undefined {
  const match = SESSION_PATTERN.exec(id);
  const [, platform, project, suffix] = match ?? [];
  if (!platform || !project || !suffix) return undefined;
  return { platform: platform as Platform, project, suffix };
}
