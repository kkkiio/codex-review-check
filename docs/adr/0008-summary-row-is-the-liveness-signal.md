# ADR 0008: The summary comment's Code Review row is the liveness signal

- Status: Accepted
- Date: 2026-10-11

## Context

ADR 0006 detected an in-flight review from 👀 reactions and the one-line progress comment, and treated them as new only when they were newer than the latest completed verdict. Neither artifact names a commit, so freshness relied on the HEAD commit timestamp, and 👀 on `@codex review` comments needed one extra paginated request per request comment.

Since October 2026 the connector keeps one Codex Review Summary issue comment per pull request and edits it in place ([CODEX_GITHUB_SIGNALS.md](../CODEX_GITHUB_SIGNALS.md)). Each review kind has one row holding only its latest run, with status, a 7-hex commit, and a timestamp. No progress comment was observed after the rollout.

## Decision

A Code Review row that names the current HEAD and is not `Completed` keeps the job waiting in both modes. An unrecognized status on that row also waits, so presentation drift fails closed at `review-timeout`. The Security Review row is ignored. 👀 reactions, the progress comment, and request-comment reactions are no longer read.

The row switches to `Running` 10–20 s after an `@codex review` request, so a request comment newer than every Codex artifact (the Code Review row time, any verdict, any connector comment) also waits. Without this bridge a stale lenient verdict could pass during that gap, before the requested review publishes findings.

A `Completed` row is never a verdict: it does not say whether findings exist. Verdicts still come from submitted reviews, clean comments, and 👍, as before.

## Consequences

- The "newer than the latest verdict" comparison remains only for request comments; the row itself is the latest run by construction.
- A request that Codex never picks up waits until `review-timeout`; a connector error comment ends the wait.
- An automatic review started by a push has no request comment, so the short gap before its row appears is not bridged.
- A connector error that leaves the row `Running` waits until `review-timeout`.
- A pull request with no summary comment has no liveness signal and relies on verdict evidence and the grace period.
