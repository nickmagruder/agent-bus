/**
 * Escapes agent-supplied text for Slack mrkdwn.
 *
 * Slack turns `<…>` sequences into mentions and links (`<!channel>`,
 * `<@U123>`, `<https://x|label>`), so an agent could otherwise ping the whole
 * channel or disguise a link. Per Slack's formatting rules only `&`, `<` and
 * `>` need escaping; bold, code and quotes still render.
 */
export function escapeSlackText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Escapes agent text, then turns the common Markdown agents write into Slack
 * mrkdwn: `**bold**` → `*bold*`, `__x__` → `_x_`, `~~x~~` → `~x~`, headings →
 * bold lines, `* item` → `• item`, and `[text](url)` → `text (url)`. Links
 * stay plain text so their target is always visible. Code spans and fenced
 * blocks are left as they are.
 */
export function toSlackMrkdwn(text: string): string {
  return escapeSlackText(text)
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, index) => (index % 2 === 1 ? part : convertProse(part)))
    .join('');
}

/**
 * Turns Slack message text (what I type) into plain text for an agent:
 * `<url|label>` → `label (url)`, `<url>` → `url`, `<#C1|name>` → `#name`,
 * `<@U1>` → `@U1`, `<!here>` → `@here`, then unescapes `&lt;`, `&gt;`, `&amp;`.
 */
export function fromSlackText(text: string): string {
  return text
    .replace(/<([^<>]+)>/g, (_, inner: string) => {
      const [target = '', label] = inner.split('|', 2);
      if (target.startsWith('#')) return `#${label ?? target.slice(1)}`;
      if (target.startsWith('@') || target.startsWith('!')) {
        const name = label ?? target.slice(1).split('^')[0] ?? '';
        return name.startsWith('@') ? name : `@${name}`;
      }
      return label && label !== target ? `${label} (${target})` : target;
    })
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function convertProse(text: string): string {
  return text
    .replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, '*$1*')
    .replace(/^([ \t]*)[*+][ \t]+/gm, '$1• ')
    .replace(/\*\*(?=\S)([^*\n]+?)\*\*/g, '*$1*')
    .replace(/__(?=\S)([^_\n]+?)__/g, '_$1_')
    .replace(/~~(?=\S)([^~\n]+?)~~/g, '~$1~')
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) =>
      label === url ? url : `${label} (${url})`,
    );
}
