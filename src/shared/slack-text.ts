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
