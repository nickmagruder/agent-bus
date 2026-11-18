---
applyTo: 'src/shared/guard.ts,src/shared/config.ts,src/shared/hook-protocol.ts,src/shared/slack-text.ts,src/broker/http.ts,src/broker/mcp.ts,src/broker/service.ts,src/broker/inbox.ts,src/broker/questions.ts,src/broker/slack/inbound.ts,src/cli/**/*.ts'
---

# Security-critical code

These files decide who may call the broker, whose Slack messages reach an
agent, which session owns what, and what leaves the machine. Review every
change here as a possible security regression.

- **Request checks:** a missing or wrong `Host`, `Origin` or bearer token must
  be rejected before any work is done; tokens are compared in constant time;
  one platform's token must never act as another platform.
- **Ownership:** every tool that takes a session or question ID checks that the
  caller's platform owns it. Look for a new code path that skips the check.
- **Slack input:** only events from `SLACK_USER_ID` count. Bots, other users,
  edits, joins and retries are dropped (retries idempotently) and audited
  without their text. Button clicks are checked the same way.
- **Hooks:** never return allow/deny, never block a stop, never throw out of
  `main`; exit 0 on every path. Only the fields defined in
  `src/shared/hook-protocol.ts` are sent, within its size limits; nothing
  named like a secret or a body.
- **Output to Slack:** agent text goes through the escaping in
  `src/shared/slack-text.ts` so it can't mention `@channel` or disguise a link.
- **Caps and throttles** must still apply on the new path.
- **Tests:** every new or changed check has a test for the accepted case and
  each rejected case. A PR that changes these files without such tests is a
  finding.
