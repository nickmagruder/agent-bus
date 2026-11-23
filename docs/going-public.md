# Going public: repo standards before Phase 3

Status: **done** (2026-11-18). All eight steps shipped; step 7 merged as [crashmap#212](https://github.com/nickmagruder/crashmap/pull/212), [crashmap#219](https://github.com/nickmagruder/crashmap/pull/219) (MIT license) and [esri-exporter#50](https://github.com/nickmagruder/esri-exporter/pull/50). Open follow-ups live in issues, listed under step 8.

Five goals:

1. Make `nickmagruder/agent-bus` public.
2. README fully describes the project and keeps its changelog.
3. Apply the CrashMap repo standards (lint, commit hooks, branch protection…).
4. Copilot does the first review on every PR.
5. clankers dev flow: trunk-based development, and GitHub issues track all
   pending and completed work from now on.

## What exists today

| Area                   | agent-bus                                                                 | CrashMap                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Visibility             | private                                                                   | public                                                                                                                                        |
| Pre-commit             | `.githooks/pre-commit` (gitleaks only; needs `git config core.hooksPath`) | husky + lint-staged (`eslint --fix`, `prettier --write`)                                                                                      |
| CI                     | typecheck, lint, format, test, markdownlint, gitleaks; on PRs and `main`  | lint, format, typecheck, test, codegen drift, build, deploy, Lighthouse; on every push                                                        |
| Action versions        | `checkout@v4`, `setup-node@v4`                                            | `@v7`                                                                                                                                         |
| Branch protection      | none (private repo on a free plan can't have it)                          | `main`: required `check`, strict                                                                                                              |
| GitHub secret scanning | n/a (private)                                                             | on, with push protection                                                                                                                      |
| Node pin               | `engines >=24`                                                            | `.nvmrc` + `engines >=24 <25`                                                                                                                 |
| README                 | overview, how it works, setup, scripts, changelog                         | `**Version:**` line, Overview, Features, Tech Stack, Getting Started, Commands, Structure, API, Deployment, Security, Contributing, Changelog |
| LICENSE / SECURITY.md  | none                                                                      | none                                                                                                                                          |
| Merge settings         | merge, squash, rebase; branches kept                                      | merge, squash; branches kept                                                                                                                  |

Not carried over: Lighthouse, Sentry, codegen drift, deploy hook (no web app
here). Prettier style stays agent-bus's own (semicolons).

### Pre-public audit (done 2026-11-18)

- gitleaks over full history: 11 commits, no leaks.
- No Slack user, team or channel IDs and no Slack URLs anywhere in history.
- Commit author email becomes public: accepted (already public via CrashMap
  and esri-exporter).
- README has local paths (`C:/Users/nickm/...`): replace with placeholders.
- README links to the private clankers Slack plan: the agent-bus design moves
  here (step 1).
- `docs/phase-2.md` has uncommitted edits (PR 1/2 merged and tested live);
  they ship in step 1.

## Decisions

| #   | Question                     | Decision                                                                                                                                                                                                                                         |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | License                      | MIT                                                                                                                                                                                                                                              |
| 2   | Private clankers design link | Move agent-bus design and phase overview into `docs/design.md`; clankers keeps a pointer                                                                                                                                                         |
| 3   | Changelog and version        | Keep agent-bus style: newest first, agents bump semver                                                                                                                                                                                           |
| 4   | Prettier                     | Keep agent-bus style; no reformat                                                                                                                                                                                                                |
| 5   | Extra checks                 | Dependabot version updates, CodeQL, commit-msg lint, OpenSSF Scorecard                                                                                                                                                                           |
| 6   | Branching                    | Trunk-based everywhere; per-repo rules in the table below                                                                                                                                                                                        |
| 7   | Issues backfill              | Open Phase 2 items become issues; shipped work (PRs #1–#8) is backfilled as closed issues                                                                                                                                                        |
| 8   | Copilot comments             | Agent triages (fixes valid ones, replies with a reason to the rest), then pings Nick; Nick merges. Not for clankers / code-notes (below)                                                                                                         |
| 9   | Rollout                      | agent-bus, CrashMap and esri-exporter now; other projects on next touch                                                                                                                                                                          |
| 10  | Commit email                 | Leave as is                                                                                                                                                                                                                                      |
| 11  | code-notes concurrency       | Keep code-notes's own flow: parallel sessions in worktrees, each shipping a squash-merged PR (`Ship-Session`), no review. The "one agent at a time" rule was dropped (2026-11-18); #31 (repo lease) is optional                                  |
| 12  | clankers merging             | Superseded by the clankers review policy (`02181a2`, 2026-11-18): the agent requests a Copilot review (`gh pr edit --add-reviewer @copilot`), addresses it, and merges with `--rebase` once checks pass; merged PRs go in the daily digest (#24) |
| 13  | PR review skill              | Copilot code review uses an adapted `mattpocock/skills` `code-review` skill, vendored into each repo's `.github/skills/`; canonical copy in clankers as `pr-review`                                                                              |
| 14  | GitHub Projects              | One **AI Orchestration** board (project 5) for agent-bus, clankers and any new repo built for orchestration; one board per other app (CrashMap = 2, esri-exporter = 3). Milestones stay per repo for phases                                      |

### Trunk-based rules by repo type

| Repo type     | Examples                           | Flow                                                                    | Review                                           | Merge                                                                        |
| ------------- | ---------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------- |
| App           | agent-bus, CrashMap, esri-exporter | Short-lived branch per issue → PR                                       | Copilot auto-review; agent triages; Nick reviews | Nick, squash, branch auto-deleted                                            |
| Shared config | clankers                           | Short-lived branch → PR (several agents may edit at once)               | Copilot review, requested by the agent           | Agent, after the review is addressed, `--rebase`; listed in the daily digest |
| Notes vault   | code-notes                         | Its own `Ship-Session`: worktree → PR (direct pushes to `main` allowed) | none                                             | Agent, squash                                                                |

_Review column superseded 2026-11-22 by [#90](https://github.com/nickmagruder/agent-bus/issues/90)
and clankers `standards/git.md`: every PR gets an AI review from the best
reviewer available, never its author, requested by the agent that opened it;
merges still wait for Nick's ask (code-notes excepted)._

## Plan

Agents open PRs; Nick merges app-repo PRs. Steps run in order unless noted.

### 1. Ready the content (agent-bus PR `docs/public-readme`)

- [x] README rewrite for a stranger: what it is and why; how it works (diagram:
      apps → MCP / hooks → broker → Slack); feature status by phase; security
      model (localhost only, per-platform tokens, Host/Origin checks, sender
      gating, hooks never block); requirements; setup; scripts; project
      structure; contributing (issues); `**Version:**` line; changelog
- [x] Replace machine-specific paths with placeholders
- [x] `docs/design.md`: agent-bus design and phases, moved from clankers
      `docs/slack-integration-plan.md` (that file keeps a pointer; clankers PR)
- [x] `LICENSE` (MIT) and `"license": "MIT"` in `package.json`
- [x] `SECURITY.md`: report via GitHub private vulnerability reporting; scope
- [x] `CONTRIBUTING.md`: coding standards for public readers and the review skill
- [x] Commit the pending `docs/phase-2.md` edits
- [x] `AGENTS.md` key files and docs list; changelog 0.6.1

### 2. Flip to public (settings, after step 1 merges)

- [x] `gh repo edit --visibility public --accept-visibility-change-consequences`
- [x] Secret scanning + push protection, Dependabot alerts and security
      updates, private vulnerability reporting
- [x] Merge settings: squash only, PR title as commit title, delete branch on
      merge
- [x] Ruleset on `main`: PR required, required check `check` (strict), no
      force push or deletion, auto-request Copilot review (step 4)

### 3. Tooling parity (agent-bus PR `chore/repo-standards`)

- [x] husky + lint-staged pre-commit: `eslint --fix` + `prettier --write` on
      staged TS, `prettier --write` on JSON/MD, `markdownlint-cli2` on MD,
      then the gitleaks staged scan; `prepare: husky`
- [x] commit-msg hook (`scripts/commit-msg.ts`, tested) enforcing clankers rules:
      imperative summary ≤ 72 chars; agent co-author trailer allowed
- [x] Remove `.githooks/` and the `core.hooksPath` setup step
- [x] `.nvmrc` (`24`); `engines` `>=24 <25`
- [x] CI: bump actions to current majors; job stays `check`
- [x] `.github/dependabot.yml`: weekly, grouped npm and Actions updates
- [x] CodeQL workflow (JS/TS; PRs, `main`, weekly); first run green on #33
- [x] OpenSSF Scorecard workflow + README badge
- [x] Scorecard first run on `main` (runs only after merge) publishes the badge
- [x] README setup, changelog, `AGENTS.md`

### 4. Copilot first review (with step 3)

- [x] Ruleset rule "Automatically request Copilot code review", reviewing new
      pushes
- [x] `.github/copilot-instructions.md` from `AGENTS.md` working rules and
      clankers `prompts/code-review.md`: guard and approval changes need
      tests, hooks never block, only `hook-protocol.ts` fields leave the
      machine, no tokens in files, erasable TS only, bind `127.0.0.1`
- [x] Path-scoped `.github/instructions/security.instructions.md` for
      `src/shared/guard.ts`, `src/broker/http.ts`, approval and inbound code
- [x] Review skill (decision 13): vendor an adapted copy of
      [`mattpocock/skills` `code-review`](https://www.skills.sh/mattpocock/skills/code-review)
      (MIT) at `.github/skills/code-review/SKILL.md` (Copilot code review only
      reads skills from the repo, on the PR's head branch). Adaptations: fixed
      point is the PR base; spec is the issue in `Closes #N` (else "no spec");
      no asking the user; drop `/setup-matt-pocock-skills`; keep the
      Standards / Spec split and Fowler baseline; standards come from
      `CONTRIBUTING.md`, `AGENTS.md` and `copilot-instructions.md`
- [x] `CONTRIBUTING.md` (also step 1): the coding standards the skill looks
      for, since clankers `standards/` is private
- [x] Verify on the step 3 PR: Copilot review shows up without asking, and
      its comments credit the `code-review` skill (use is likely, not
      guaranteed, per GitHub's docs). Seen on #35: separate Standards and
      Spec sections, Spec checked against the linked issue
- [x] Agents triage Copilot comments before pinging Nick (decision 8)

### 5. Issues in agent-bus (with step 3)

- [x] Labels: `phase-0`…`phase-5`, `chore`, `security`, `follow-up` (plus GitHub's
      `bug`, `enhancement`, `documentation`)
- [x] Milestones: Phase 0–5
- [x] Issue forms (`.github/ISSUE_TEMPLATE/`: bug, task, config) and PR template
      (`Closes #`, how tested, docs updated)
- [x] Backfill closed issues for shipped work: #11–#20 (Phase 0 and PRs #1–#9)
      in the right milestones; Phase 0 and 1 milestones closed
- [x] Open issues for the remaining Phase 2 items: PR 3 hooks, PR 4 digest,
      clankers PR, each verify item, each follow-up: #21–#30, #32
- [x] New issues: digest includes clankers PRs merged that day (decision 12);
      repo lease/lock tool for single-agent repos like code-notes (decision 11):
      #24, #31
- [x] `docs/phase-2.md` keeps design, decisions and live results; its
      checklists become issue links

### 5b. GitHub Projects (done 2026-11-18)

- [x] **AI Orchestration** project (#5, private) linked to agent-bus and
      clankers
- [x] Status: Todo, In progress, In review, Done; fields Agent (bus session
      ID) and Priority. Milestone and Repository are built in, so no Phase
      field
- [x] Views: Board (by Status), By repo (table grouped by repository),
      Roadmap (by milestone). Milestone due dates set 2026-11-18 (guesses
      from the Phase 0–1 pace): Phase 0 2026-11-17 and Phase 1 2026-11-18
      (actual), Phase 2 2026-11-25, Phase 3 2026-12-11, Phase 4 2027-01-08,
      Phase 5 2027-02-05. The Roadmap can't place items by milestone, so a Target date field
      carries each item's milestone due date (12 open issues filled); the
      view uses it, with milestone markers on
- [x] Open agent-bus issues added as Todo
- [x] Workflows: item added → Todo; PR linked → In review; merged or closed
      → Done; Done closes the issue; auto-add for agent-bus open issues and
      PRs. The free plan allows one auto-add workflow, so agents add
      clankers items with `gh project item-add`
- [x] CrashMap and esri-exporter boards already exist (projects 2 and 3).
      Decision (2026-11-18): they keep their Status options (Backlog, Ready,
      In progress, In review, Done) and their Size, Estimate and Iteration
      fields, since replacing options breaks the board workflows; their
      workflows (item added, PR linked, merged, closed, auto-close, auto-add)
      are all on

### 6. clankers standards ([clankers#11](https://github.com/nickmagruder/clankers/pull/11))

- [x] `standards/git.md`: trunk-based flow and the repo-type table; squash
      merge; branch names carry the issue (`feat/12-digest`); `Closes #12`;
      Copilot first review and triage rule; one fixer per PR; clankers and
      code-notes rows follow decisions 11 and 12
- [x] New `standards/github.md`: issues track all work (status lives in
      issues, design in docs); bugs and follow-ups found mid-task become
      issues; labels, milestones, templates; project boards (decision 14:
      one AI Orchestration board, one per app); repo setup checklist (ruleset,
      security settings, Dependabot, CodeQL, Scorecard, Copilot review,
      husky/lint-staged/commit-msg, LICENSE/SECURITY.md)
- [x] `standards/docs.md`: plans hold design and decisions; checklists link
      to issues
- [x] Skills: `finish-task` and `close-out-session` create, update and close
      issues and check the repo setup checklist; `register-project` and
      `prompts/new-project-kickoff.md` run the setup checklist
- [x] clankers `settings/agent-bus/claude-settings.json`: add Claude's
      `Notification` hook (matcher `permission_prompt`) to match the README
- [x] `docs/slack-integration-plan.md`: agent-bus design now lives in the
      agent-bus repo; pointer left
- [x] Registry: agent-bus visibility public, license
- [x] code-notes `AGENTS.md`: unchanged (decision 11)
- [x] Standards index in `global/AGENTS.md` gains `github.md`
- [x] Canonical review skill: `skills/pr-review/` with `UPSTREAM.md` (source,
      commit, license, our adaptations), so local agents run the same review.
      Named `pr-review` because clankers skills install into
      `~/.claude/skills`, where `code-review` would collide with Claude Code's
      built-in `/code-review`. Repos get a synced copy under the name
      `code-review`; the setup checklist covers copying it

### 7. Roll out to CrashMap and esri-exporter (one PR each, in their repos)

CrashMap: issue [crashmap#197](https://github.com/nickmagruder/crashmap/issues/197),
PR [crashmap#212](https://github.com/nickmagruder/crashmap/pull/212).
esri-exporter: issue [esri-exporter#49](https://github.com/nickmagruder/esri-exporter/issues/49),
PR [esri-exporter#50](https://github.com/nickmagruder/esri-exporter/pull/50).
Decisions (2026-11-18): CrashMap's git rule now matches agent-bus (agents
open the PR as the next step; only Nick merges, which deploys);
esri-exporter keeps its GitHub Desktop override; its PLAN.md items become
grouped issues; esri-exporter gets the full checklist but no formatter yet.

- [x] Ruleset (PR required, required `check`, Copilot auto-review),
      squash-only merges, branch auto-delete, "Update branch", Dependabot
      alerts and security updates, private vulnerability reporting. CrashMap's
      classic branch protection was replaced by the ruleset
- [x] Labels `chore`, `security`, `follow-up`; milestones kept as they were;
      issue forms, PR template, `CONTRIBUTING.md`, `SECURITY.md`
- [x] Boards: fields kept (see 5b); new issues and PRs added
- [x] `.github/copilot-instructions.md` and path-scoped security instructions
      from each repo's AGENTS.md
- [x] `.github/skills/code-review/` synced from clankers `pr-review`, header
      reworded as a vendored copy
- [x] CrashMap `PLAN.md` open items → 14 grouped issues (crashmap#198–#211),
      linked from `PLAN.md`; esri-exporter's deferred upgrades →
      esri-exporter#53
- [x] esri-exporter hooks and CI: root `package.json` (husky, lint-staged,
      commit-msg, gitleaks), `check` job (frontend lint/typecheck/build,
      ruff, offline pytest), CodeQL (JS/TS, Python, Actions), Scorecard,
      Dependabot. Follow-ups: formatter decision (esri-exporter#51), input
      validation (esri-exporter#52)
- [x] CrashMap: actions pinned by SHA, CodeQL, Scorecard, Dependabot,
      gitleaks pre-commit and commit-msg hook added to its husky setup
- [x] CrashMap AGENTS.md git rule mentions issues and Copilot triage
- [x] Copilot's first review on both PRs: skipped. GitHub reported the
      Copilot review quota used up on 2026-11-18, and Nick merged without
      it; the ruleset requests a review on the next PR in each repo
- [x] Nick merged both PRs; CrashMap's `main` run passed `check`, `deploy`
      and `lighthouse` with the pinned actions, and CI, CodeQL and Scorecard
      passed on both `main` branches
- [x] CrashMap license: MIT
      ([crashmap#219](https://github.com/nickmagruder/crashmap/pull/219))
- [x] Dependabot's first CrashMap PRs (#213–#217, mostly deferred majors)
      are held for the deferred-upgrades phase,
      [crashmap#202](https://github.com/nickmagruder/crashmap/issues/202)

### 8. Close out

- [x] `npm run check`, markdownlint, link check
- [x] Changelog entries and version bumps
- [x] Mark this doc done and link the issues that replaced its checklists

Follow-ups now tracked as issues:

- agent-bus: Phase 2 work, #21–#32; repo lease, #31
- clankers: `install.ps1 -AgentBus` drops Codex tool approvals inside its
  marked block,
  [clankers#18](https://github.com/nickmagruder/clankers/issues/18)
- CrashMap: PLAN.md items,
  [crashmap#198](https://github.com/nickmagruder/crashmap/issues/198) to
  [crashmap#211](https://github.com/nickmagruder/crashmap/issues/211)
- esri-exporter: formatter decision
  ([esri-exporter#51](https://github.com/nickmagruder/esri-exporter/issues/51)),
  input validation
  ([esri-exporter#52](https://github.com/nickmagruder/esri-exporter/issues/52)),
  deferred upgrades
  ([esri-exporter#53](https://github.com/nickmagruder/esri-exporter/issues/53))
