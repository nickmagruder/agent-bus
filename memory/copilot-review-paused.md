---
name: copilot-review-paused
description: "Copilot quota used up, and on 2026-11-22 Nick turned off the rulesets' automatic Copilot review: local agents orchestrate reviews"
type: feedback
---

Don't request Copilot reviews on PRs (quota used up since 2026-11-18). On 2026-11-22 Nick said "Turn off, we should orchestrate reviews from our local agents", and I removed the `copilot_code_review` rule from the `main` rulesets of agent-bus (27582725), crashmap (27589303) and esri-exporter (27590173); the other four rules are unchanged.

**Why:** Copilot premium quota is exhausted, and Nick wants reviews run by local agents (clankers `standards/git.md`).
**How to apply:** skip `gh pr edit --add-reviewer copilot`; get the review from a local agent per [[pr-review-sessions]]. Ask Nick before turning Copilot back on anywhere.
