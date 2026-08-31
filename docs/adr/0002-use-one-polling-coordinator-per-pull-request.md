# ADR 0002: Use one polling coordinator per pull request

- Status: Accepted
- Date: 2026-08-31

## Context

The Action keeps a GitHub Actions job pending while it polls the pull request's live reviews, comments, reactions, and review threads. The consumer workflow also subscribed to `pull_request_review`, `pull_request_review_comment`, and `issue_comment`, so the same lifecycle evidence created replacement workflow runs.

GitHub delivers each matching event as a separate workflow run, not as a notification to the existing job. Because all runs for a pull request shared a concurrency group with `cancel-in-progress: true`, a terminal Codex comment or submitted review could cancel the coordinator before its next poll and terminal settle interval completed. Turning cancellation off would retain duplicate queued or concurrent checks instead. An `issue_comment` run also uses the default branch SHA rather than the pull request HEAD, so its successful job is not a reliable replacement for the PR-head check.

## Decision

The recommended consumer workflow starts only for `pull_request` actions `opened`, `reopened`, `ready_for_review`, and `synchronize`, plus explicit `workflow_dispatch` runs. It does not subscribe to review, review-comment, or issue-comment lifecycle events.

The running Action is the sole Codex lifecycle coordinator for that pull request attempt. It observes new signals through polling and completes the same PR-head check. If an attempt has already failed because review is missing or known conversations remain unresolved, the agent or human uses the standard rerun command after taking the instructed action.

The workflow keeps PR-scoped concurrency with `cancel-in-progress: true`. A `synchronize` event therefore replaces work for an older HEAD, which is the intended cancellation boundary.

## Consequences

- A Codex 👀, submitted review, review comment, clean comment, or 👍 is consumed by the existing polling job instead of replacing it.
- The PR retains one authoritative check path for its current HEAD instead of accumulating lifecycle-triggered duplicate or cancelled checks.
- A lifecycle signal that arrives after an attempt has failed requires the documented standard rerun.
- The polling job continues to occupy a runner while Codex is active, bounded by the configured review timeout.
- Avoiding runner polling entirely would require a separate event-driven Checks API service and is outside this Action's scope.
