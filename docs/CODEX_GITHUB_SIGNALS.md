# Codex review signals on GitHub pull requests

This document records what the Codex GitHub connector observably does on pull requests, as of 2026-10-11. It exists to make provider behavior drift visible.

OpenAI documents the connector's user-facing controls in [Codex code review in GitHub](https://learn.chatgpt.com/codex/third-party/github) (summarized in [the code-review use case](https://learn.chatgpt.com/use-cases/github-code-reviews)): the `@codex review` and `@codex security review` requests, the 👀 acknowledgment reaction, automatic review triggers, a stated focus on P0/P1 findings, and `AGENTS.md` review rules. The connector's own summary comment adds one more self-description: "Codex reacts with 👀 while any review is running, comments if it has suggestions, and reacts with 👍 once all reviews finish with no findings." The summary-comment table, clean-result comment format, `Reviewed commit` marker, and error-comment text remain undocumented presentation details that can change without notice. Everything beyond the documented controls is an observation, not an OpenAI API guarantee.

## Two sources of truth

1. GitHub's documented data model: pull request review `commit_id`, GraphQL review-thread `isResolved` and `isOutdated`, author identity, timestamps, issue-comment edit history, and pagination. Comparatively stable.
2. Codex's currently observed presentation: connector login, the review summary comment, 👀 and 👍 reactions, clean-result text, the `Reviewed commit` marker, and error text. Can change without this repository changing.

## Review summary comment

Since early October 2026 the connector keeps exactly one issue comment per pull request that it edits in place for every review. The comment is created when the first review after the rollout starts, then updated on each state change; the REST `id` stays the same, `updated_at` moves, and GraphQL `userContentEdits` retains every previous body.

Observed body, with the About block shortened:

```markdown
<!-- codex-pull-request-review-summary -->

## Codex Review Summary

This comment shows the latest Codex review activity on this pull request.

| Review | Status | Commit | Review trigger |
| --- | --- | --- | --- |
| 📝 **Code Review** | 🔄 **Running** since <relative-time datetime="2026-10-11T05:46:24.205001Z">2026-10-11T05:46:24.205001Z</relative-time> | `a20ec45` | Manual request |
| 🔒 **Security Review** | ✅ **Completed** <relative-time datetime="2026-10-11T05:42:49.135672Z">2026-10-11T05:42:49.135672Z</relative-time> | `a20ec45` | PR opened |

<details> <summary>ℹ️ About Codex in GitHub</summary>
...
</details>
```

| Field | Observed values |
| --- | --- |
| Marker | First line `<!-- codex-pull-request-review-summary -->` |
| Review | `📝 **Code Review**`; `🔒 **Security Review**` only when Security Review runs for the repository |
| Status | `🔄 **Running** since <relative-time …>` or `✅ **Completed** <relative-time …>`; no other status was observed |
| Timestamp | `relative-time` `datetime` attribute with microsecond UTC precision: the start time while running, the completion time once completed |
| Commit | Backticked 7-hex abbreviation of the commit being reviewed |
| Review trigger | `PR opened`, `Draft marked ready`, `New commits`, or `Manual request` |

Row semantics:

- Each row holds only the latest run of that review kind. A new run overwrites the row, including its commit and trigger; earlier runs survive only in the edit history.
- Rows change independently. A Code Review row and a Security Review row can name different commits, and during a new push one row can briefly still show the previous commit as `Completed` while the other already shows the new commit as `Running`.
- A run superseded by a newer push never shows `Completed`: the row moves straight from `Running` on the old commit to `Running` on the new one.
- The row keeps naming the commit it reviews. When HEAD moves and no new review starts, the row stays on the older commit; when HEAD moves during a run, the row shows `Running` on a commit that is no longer HEAD.
- `Completed` does not distinguish findings from a clean result. Findings and clean results are visible only through the artifacts below.
- `@codex security review` on a repository without Security Review enabled produced a `Code Review` row with trigger `Manual request`.
- When the connector hits a usage limit for Security Review, it posts `You have reached your Codex usage limits for security reviews. Please try again later.` and adds no Security Review row.

## Observed lifecycle

| Stage | Observable GitHub artifact |
| --- | --- |
| Review started | Summary row switches to `Running` for the reviewed commit, about 10–20 s after the trigger. The connector adds 👀 on the PR body; a manual request also gets 👀 on the `@codex review` comment |
| Review completed with findings | Submitted PR review whose REST `commit_id` equals the reviewed commit, with its review threads; then the row switches to `Completed`. No 👍 |
| Review completed cleanly, automatic trigger | Row switches to `Completed`, then a fresh 👍 appears on the PR body. No review and no issue comment |
| Review completed cleanly, manual request | Issue comment beginning `Codex Review: Didn't find any major issues.` with exactly one 10-hex `Reviewed commit` marker; then the row switches to `Completed`; then a fresh 👍 on the PR body |
| Review errored | Issue comment beginning `Codex Review: Something went wrong. Try again later by commenting “@codex review”.` followed by an error code block; the summary row was not updated |
| Finding conversation | GraphQL review thread containing a comment from the connector login |

Observed ordering and latency on a completed run:

1. The terminal artifact is published first: the submitted review with its threads, or the clean comment.
2. The summary row switches to `Completed` 2–6 s later. Its `datetime` is after the review's `submitted_at`.
3. 👍, when the result is clean, appears 2–3 s after the row update.

👀 is removed once the run finishes. GitHub keeps one reaction of each type per user and subject, so the 👍 visible after a clean run is recreated for that run; its `created_at` is the completion time, not the time of an earlier clean run.

## How artifacts bind to commits

- Submitted reviews bind strongly: `commit_id` is the exact 40-hex reviewed commit.
- Clean comments bind through their single `Reviewed commit` marker: the observed value is a 10-hex prefix of the reviewed commit.
- Summary rows bind through a 7-hex prefix and carry their own start or completion timestamp, which also orders them against other artifacts.
- 👀 and 👍 reactions carry no commit field. Their `created_at` can be compared with a HEAD commit timestamp or with a summary row's start time.

An artifact attesting an older commit says nothing about any later HEAD. Whether such stale evidence satisfies a gate is a consumer's policy choice, not a property of the artifact.

## Review-thread data model

GitHub exposes `isResolved` and `isOutdated` as separate booleans. They are not synonyms: a thread can be outdated but unresolved, resolved but not outdated, and so on. Thread and nested thread-comment connections are paginated.

## Artifacts that are not review outcomes

Observed or plausible artifacts that carry no review verdict for the current HEAD:

- the workflow's original `GITHUB_SHA`;
- a review, clean comment, or summary row that names a prior HEAD;
- a summary row showing `Running`;
- a `Completed` summary row by itself — it does not say whether findings exist;
- a human review or human-authored thread;
- a 👍 created before the current HEAD commit;
- 👀 by itself — it marks activity, not an outcome;
- the error or usage-limit comments;
- old commit statuses, marker comments, retry counters, or scheduled reconciler state.

## Legacy artifacts

The progress comment, a one-line `Codex Review in progress` or `Codex Review still in progress` issue comment, was not observed on any sampled pull request that carries the summary comment. Pull requests whose last review predates the rollout have no summary comment and only show the older artifacts: reviews, clean comments, and reactions.

## Drift risks

| Possible provider change | Observable symptom |
| --- | --- |
| Connector login changes | Reviews and comments arrive from an unknown author |
| Summary marker or table columns change | A running review has no recognizable summary row |
| A new summary status appears, such as a failure state | A row shows a status other than `Running` or `Completed` |
| Summary rows stop naming the reviewed commit, or switch to a different abbreviation length | Rows no longer match the HEAD prefix |
| 👀 is replaced with another liveness artifact | A running review shows no 👀 |
| Clean heading, reviewed-commit marker, or 👍 transition changes | A clean review produces no recognizable clean artifact after the row completes |
| GitHub review state delivery changes | Terminal artifacts arrive after the row shows `Completed` |
| Codex findings stop using review threads | Findings appear without review threads |

## Adding or correcting an observation

1. Capture the relevant artifact from a real pull request through GitHub REST or GraphQL without editing the PR. For the summary comment, read GraphQL `IssueComment.userContentEdits`: the current body alone hides earlier rows.
2. Remove repository-sensitive prose and identifiers while retaining field names, author type, timestamps, commit binding, and structural text.
3. Add or update a case in [`../test/fixtures/review-states.json`](../test/fixtures/review-states.json).
4. Run `npm run check` and inspect the bundled `dist/index.js` change.
5. Update the observation log and this document if the provider behavior changed materially.

Useful read-only inspection surfaces are the REST pull request reviews, issue reactions, issue comments, the GraphQL `reviewThreads` connection, and GraphQL issue-comment edit history. Prefer raw payloads over screenshots because the UI may combine several artifacts.

## Observation log

- 2026-08-31, [`kkkiio/pi-workmap#5`](https://github.com/kkkiio/pi-workmap/pull/5): Codex auto-review first created 👀, then replaced it with a fresh `+1`; it did not create a submitted review or clean issue comment. This live observation added `clean-reaction` support and corresponding stale/fresh fixtures.
- 2026-08-31, the explicit `@codex review` follow-up on the same PR: Codex attached 👀 to the request comment rather than the PR body. This added paginated request-comment reaction reads and fixture coverage.
- 2026-09-01, [`kkkiio/codex-review-check#1`](https://github.com/kkkiio/codex-review-check/pull/1): first dogfood run of the log-first failure guidance. The run failed fast on a real unresolved thread and printed the three-step sequence; Codex's review of that PR also flagged that this document had drifted from the Action's acceptance policy, prompting the split between behavior (here) and policy (CONFIGURATION.md).
- 2026-09-01, same PR: findings arrived with P2 badges although the product documentation states that Codex flags only P0 and P1 issues in GitHub. Treat badge severities as presentational.
- 2026-10-09, [`kkkiio/pi.mbt#31`](https://github.com/kkkiio/pi.mbt/pull/31): first summary comment on a `kkkiio` repository; `kkkiio/pi.mbt#30` on 2026-10-04 had none. A clean `PR opened` review went `Running` → `Completed` and was followed 3 s later by a PR-body 👍, with no review or clean comment.
- 2026-10-11, [`kkkiio/pi.mbt#32`](https://github.com/kkkiio/pi.mbt/pull/32#issuecomment-6105915884): the same summary comment went through four edits for two runs on one commit (`PR opened`, then `Manual request`). Both runs submitted a findings review 2–3 s before the row switched to `Completed`; the PR body had no remaining Codex reaction afterwards.
- 2026-10-11, public sample of about 60 pull requests from other repositories: confirmed the table grammar, the Security Review row, the four trigger labels, superseded runs that never complete, rows left on a non-HEAD commit after a push, 👀 on both the PR body and a manual request comment, the manual-request clean comment followed by 👍, the automatic-trigger 👍 without a comment, the usage-limit comment, and the `Something went wrong` error comment posted while the row still showed `Running`. No status other than `Running` or `Completed` and no progress comment were observed.
