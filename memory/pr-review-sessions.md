---
name: pr-review-sessions
description: "Every agent-bus PR gets an AI review I request myself, right away; how to brief the reviewer so posting isn't blocked"
type: feedback
---

The rule itself now lives in clankers `standards/git.md` (clankers#43/#44, 2026-11-22): every PR in every repo but code-notes gets an AI review, requested by the agent that opened it in the same turn, without asking, from whichever reviewer is the best choice at the time (no platform required; another platform preferred), never the author. Local agents orchestrate reviews (repos no longer request Copilot automatically); any completed review by someone else counts. git.md keeps a dated "What can run now" line.

Machine-local facts that make the order play out here:

- Codex can't review from this machine yet: no Codex CLI on PATH (only the desktop app's helpers under WindowsApps) and no Codex GitHub integration on Nick's repos. So my PRs go to the linked Claude reviewer session; say so in the PR.
- Send each PR to the existing linked reviewer session (SendMessage) rather than starting a new one; a reviewer I started on my own was blocked by auto mode on 2026-11-19 (clankers#44 adds an autoMode allow line for this).
- Brief: quote the standing policy ("every PR gets an AI review, requested by the agent that opened it", clankers `standards/git.md`) plus any words of Nick's from this conversation. A reviewer told to post only by a relayed message refused once.
- Brief: read-only (`gh pr diff`, `git show origin/<branch>:<path>`), never touch Nick's checkout; post once with `gh api …/pulls/N/reviews -f event=COMMENT -F body=@<file>` (capital `-F`: on PR 80 a lowercase `-f` posted the file path) and `<!-- ai-review -->` first.
- Don't also send a queued "please post" message: on PR 42 the reviewer posted twice.

**Why:** reviews on PRs 42–45, 53 and 80–89 found real bugs (DST digests, dropped DMs, lost replies, oversized Slack blocks, stale offers). On 2026-11-22 Nick asked "Is getting a review not our standard procedure?" after I kept asking per PR.

**How to apply:** right after opening any PR, in the same turn. Copilot review is paused: [[copilot-review-paused]].
