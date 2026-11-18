# Security policy

agent-bus relays answers from Slack to AI coding agents, so security bugs
matter even though it runs on one machine.

## Reporting a vulnerability

Please report privately through GitHub:
[Report a vulnerability](https://github.com/nickmagruder/agent-bus/security/advisories/new)
(Security tab › Advisories). Don't open a public issue for a vulnerability.

Include what you found, how to reproduce it and the impact you expect. I'll
reply within a week. This is a personal project, so there's no bounty.

## Supported versions

Only the latest commit on `main` gets fixes.

## In scope

- Getting past the broker's request checks: `Host`/`Origin` validation,
  bearer tokens, or one platform's token acting as another
  (`src/shared/guard.ts`, `src/broker/http.ts`)
- A session reading or answering another session's inbox or questions
- Slack input reaching an agent from anyone other than `SLACK_USER_ID`
  (`src/broker/inbox.ts`, `src/broker/slack/inbound.ts`)
- Hook payload data leaving the machine beyond the fields in
  `src/shared/hook-protocol.ts`
- A hook failing or blocking the agent, or returning an allow/deny decision
- Agent text in Slack triggering mentions or disguising links
  (`src/shared/slack-text.ts`)
- Secrets written to logs, the database or the repo

## Out of scope

- Attacks that need local admin access or the user's own environment
  variables (anyone holding the tokens is, by design, that platform)
- Slack's or the agent apps' own vulnerabilities (report those to them)
- Denial of service against a broker that only listens on `127.0.0.1`
