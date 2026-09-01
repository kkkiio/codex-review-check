# Codex review signals on GitHub pull requests

This document records what the Codex GitHub connector observably does on pull requests, as of 2026-09-01. It exists to make provider behavior drift visible.

OpenAI documents the connector's user-facing controls in [Codex code review in GitHub](https://learn.chatgpt.com/codex/third-party/github) (summarized in [the code-review use case](https://learn.chatgpt.com/use-cases/github-code-reviews)): the `@codex review` request, the 👀 acknowledgment reaction, automatic review triggers, a stated focus on P0/P1 findings, and `AGENTS.md` review rules. The progress-sentence grammar, clean-result comment format, `Reviewed commit` marker, and `+1` reaction transition remain undocumented presentation details that can change without notice. Everything beyond the documented controls is an observation, not an OpenAI API guarantee.

## Two sources of truth

1. GitHub's documented data model: pull request review `commit_id`, GraphQL review-thread `isResolved` and `isOutdated`, author identity, timestamps, and pagination. Comparatively stable.
2. Codex's currently observed presentation: connector login, 👀 reaction, progress text, clean-result text, and the `Reviewed commit` marker. Can change without this repository changing.

## Observed lifecycle

| Stage | Observable GitHub artifact |
| --- | --- |
| Review requested or picked up | 👀 reaction from the connector login on the PR body or on the `@codex review` comment |
| Review running | A one-line `Codex Review in progress` or `Codex Review still in progress` issue comment, with the currently observed optional punctuation and metadata |
| Review completed with review output | Submitted PR review whose REST `commit_id` equals the reviewed commit |
| Review completed cleanly | Issue comment beginning `Codex Review: Didn't find any major issues.` with exactly one 10- or 40-hex `Reviewed commit` marker naming the reviewed commit |
| Review completed cleanly through reaction | Connector removes 👀 and creates a fresh `+1` reaction |
| Finding conversation | GraphQL review thread containing a comment from the connector login |

## How artifacts bind to commits

- Submitted reviews bind strongly: `commit_id` is the exact 40-hex reviewed commit.
- Clean comments bind through their single `Reviewed commit` marker: a 40-hex value names the full commit, while a 10-hex value is its prefix.
- 👀 and `+1` reactions carry no commit field. The only freshness information is `created_at`, comparable against a HEAD commit timestamp — weaker than `commit_id`, matching the connector behavior observed on real pull requests.

An artifact attesting an older commit says nothing about any later HEAD. Whether such stale evidence satisfies a gate is a consumer's policy choice, not a property of the artifact.

## Review-thread data model

GitHub exposes `isResolved` and `isOutdated` as separate booleans. They are not synonyms: a thread can be outdated but unresolved, resolved but not outdated, and so on. Thread and nested thread-comment connections are paginated.

## Artifacts that are not review outcomes

Observed or plausible artifacts that carry no review verdict for the current HEAD:

- the workflow's original `GITHUB_SHA`;
- a review whose `commit_id` names a prior HEAD;
- a human review or human-authored thread;
- a thumbs-up reaction created before the current HEAD commit;
- 👀 by itself — it marks activity, not an outcome;
- old commit statuses, marker comments, retry counters, or scheduled reconciler state.

## Drift risks

| Possible provider change | Observable symptom |
| --- | --- |
| Connector login changes | Reviews and comments arrive from an unknown author |
| 👀 is replaced with another liveness artifact | A running review shows no 👀 |
| Progress sentence changes | The progress comment no longer matches the observed grammar |
| Clean heading, reviewed-commit marker, or reaction transition changes | A clean review produces no recognizable terminal artifact |
| GitHub review state delivery changes | Terminal artifacts arrive late |
| Codex findings stop using review threads | Findings appear without review threads |

## Adding or correcting an observation

1. Capture the relevant artifact from a real pull request through GitHub REST or GraphQL without editing the PR.
2. Remove repository-sensitive prose and identifiers while retaining field names, author type, timestamps, commit binding, and structural text.
3. Add or update a case in [`../test/fixtures/review-states.json`](../test/fixtures/review-states.json).
4. Run `npm run check` and inspect the bundled `dist/index.js` change.
5. Update the observation log and this document if the provider behavior changed materially.

Useful read-only inspection surfaces are the REST pull request reviews, issue reactions, issue comments, and the GraphQL `reviewThreads` connection. Prefer raw payloads over screenshots because the UI may combine several artifacts.

## Observation log

- 2026-08-31, [`kkkiio/pi-workmap#5`](https://github.com/kkkiio/pi-workmap/pull/5): Codex auto-review first created 👀, then replaced it with a fresh `+1`; it did not create a submitted review or clean issue comment. This live observation added `clean-reaction` support and corresponding stale/fresh fixtures.
- 2026-08-31, the explicit `@codex review` follow-up on the same PR: Codex attached 👀 to the request comment rather than the PR body. This added paginated request-comment reaction reads and fixture coverage.
- 2026-09-01, [`kkkiio/codex-review-check#1`](https://github.com/kkkiio/codex-review-check/pull/1): first dogfood run of the log-first failure guidance. The run failed fast on a real unresolved thread and printed the three-step sequence; Codex's review of that PR also flagged that this document had drifted from the action's new `stale-reviews` policy, prompting the split between behavior (here) and policy (CONFIGURATION.md).
- 2026-09-01, same PR: findings arrived with P2 badges although the product documentation states that Codex flags only P0 and P1 issues in GitHub. Treat badge severities as presentational.
