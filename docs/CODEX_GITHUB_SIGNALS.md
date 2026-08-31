# Codex review signals on GitHub pull requests

This document records the GitHub evidence that Codex Review Check understands as of 2026-08-31. It exists to make provider behavior drift visible instead of silently changing the gate. It is an observation and compatibility contract for this repository, not an OpenAI API guarantee.

## Three layers of evidence

The implementation deliberately separates three layers:

1. GitHub's documented data model: pull request review `commit_id`, GraphQL review-thread `isResolved` and `isOutdated`, author identity, timestamps, and pagination.
2. Codex's currently observed presentation: connector login, 👀 reaction, progress text, clean-result text, and the `Reviewed commit` marker.
3. This Action's policy: what may keep a job pending, what may pass it, and what blocks it.

The first layer is comparatively stable. The second can change without this repository changing. The third must remain explicit and covered by fixtures.

## Current observed lifecycle

| Stage | Observable GitHub artifact | Interpretation here |
| --- | --- | --- |
| Review requested or picked up | 👀 reaction from a configured Codex login | Liveness only; never passes |
| Review running | A one-line `Codex Review in progress` or `Codex Review still in progress` issue comment, with the currently observed optional punctuation/metadata | Liveness only; never passes |
| Review completed with review output | Submitted PR review by Codex whose REST `commit_id` equals the current PR `head.sha` | Terminal current-HEAD signal |
| Review completed cleanly | Codex issue comment beginning `Codex Review: Didn't find any major issues.` with exactly one 10- or 40-hex `Reviewed commit` marker matching the current HEAD | Terminal current-HEAD signal |
| Finding conversation | GraphQL review thread containing a comment from a configured Codex login | Blocks when unresolved under the outdated policy |

OpenAI's public product description documents that a pull request can explicitly request review with `@codex review`. It does not document the reaction payload, exact progress sentence, clean-comment grammar, or promise those presentation details as a stable API. Treat those formats as compatibility observations.

## Current-HEAD binding

Terminal PR reviews bind strongly through an exact 40-hex `commit_id == pull_request.head.sha` comparison. Clean issue comments bind through their single `Reviewed commit` marker: a 40-hex value must equal HEAD, while a 10-hex value must be its prefix.

The 👀 reaction has no commit field. For liveness only, the Action accepts a configured Codex 👀 whose `created_at` is not earlier than the current HEAD commit timestamp. This is intentionally not sufficient for success: a reaction timestamp cannot prove which pushed PR state Codex inspected.

An old review, a clean marker for a different commit, or an old 👀 does not satisfy current-head semantics.

## Terminal and clean signals

Accepted submitted review states are `COMMENTED`, `APPROVED`, and `CHANGES_REQUESTED`. `PENDING` and `DISMISSED` are not terminal evidence. The Action waits a short settle interval after first seeing a terminal signal, then reads the complete state again so that newly created review threads have time to appear.

The clean-comment parser is narrower than general natural-language matching:

- the first heading must visibly begin with `Codex Review` after only Markdown heading syntax or emoji-like decoration;
- the clean lead must be `Codex Review: Didn't find any major issues.`;
- exactly one `**Reviewed commit:** \`<10-or-40-hex>\`` line must exist;
- the marker must match current HEAD.

The parser does not use a PR-level `+1` reaction as terminal evidence. GitHub issue reactions are not commit-bound and one actor cannot create a fresh identical reaction for every HEAD. A thumbs-up can be useful to a human, but it is not authoritative enough for this Action's retained current-head policy.

## Review-thread policy

GitHub exposes `isResolved` and `isOutdated` as separate booleans. They are not synonyms.

- `outdated-threads: block` (default): every unresolved thread containing a configured Codex comment blocks, including `isOutdated: true` threads.
- `outdated-threads: ignore`: unresolved outdated threads are omitted; unresolved non-outdated threads still block.
- A resolved thread never blocks.

Thread and nested thread-comment connections are fully paginated before a decision. The Action does not assume that the first 100 threads or first 100 comments contain all Codex evidence.

## Drift risks and expected failure mode

| Possible provider change | Expected symptom | Safe repository response |
| --- | --- | --- |
| Connector login changes | Review looks missing; grace ends with hint | Add the verified login through `codex-bot-logins` and a fixture |
| 👀 is replaced with another liveness artifact | Job may fail after grace while review is actually running | Add only a liveness parser; do not make it a pass signal |
| Progress sentence changes | Same as missing liveness | Capture a real payload, update fixture and parser |
| Clean heading or reviewed-commit marker changes | Clean review does not pass | Verify new artifact is commit-bound before accepting it |
| GitHub review state delivery changes | Terminal signal arrives late | Adjust settle/poll timing, not current-head authority |
| Codex findings stop using review threads | Existing unresolved-thread policy no longer covers all findings | Design a new explicit finding model; do not infer clean from absence |

Unknown presentation fails by absence: it cannot produce success. Depending on whether another known liveness signal exists, the job either keeps waiting or fails with the explicit review hint. GitHub API or pagination failures fail the job rather than returning a clean result.

## Drift verification procedure

Before changing a signal parser:

1. Capture the relevant artifact from a real test PR through GitHub REST or GraphQL without editing the PR.
2. Remove repository-sensitive prose and identifiers while retaining field names, author type, timestamps, commit binding, and structural text.
3. Add or update a case in [`../test/fixtures/review-states.json`](../test/fixtures/review-states.json).
4. Add a negative case proving that stale or mismatched-HEAD evidence cannot pass.
5. Run `npm run check` and inspect the bundled `dist/index.js` change.
6. Update the observation date and this document if the provider behavior changed materially.

Useful read-only inspection surfaces are the REST pull request reviews, issue reactions, issue comments, and the GraphQL `reviewThreads` connection. Prefer raw payloads over screenshots because the UI may combine several artifacts.

## Non-signals

The following do not make this Action pass:

- the workflow's original `GITHUB_SHA`;
- a prior-HEAD Codex review;
- a human review or human-authored thread;
- a bare thumbs-up reaction;
- 👀 by itself;
- thread `isOutdated: true` when the configured policy is `block`;
- old commit statuses, marker comments, retry counters, or scheduled reconciler state.
