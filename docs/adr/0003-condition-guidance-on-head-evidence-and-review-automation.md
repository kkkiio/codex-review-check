# ADR 0003: Condition guidance on HEAD evidence and review automation

- Status: Accepted
- Date: 2026-09-02

## Context

ADR 0001 kept the `@codex review` hint out of the unresolved-threads failure so agents resolve known findings before spending another review credit. Observed agent sessions then showed the two-step failure cascade in full: agents resolved the threads, re-ran as instructed, and immediately hit a missing-review failure because the pushed HEAD had no fresh review. The guidance was correct but incomplete — the real next action after resolving is often `resolve → request review → re-run`, and agents had to infer the middle step themselves.

Two further observations shape the fix:

- Whether the middle step exists depends on state. If the current HEAD already has terminal review evidence, a rerun passes right after resolving; requesting another review would waste a credit.
- Not every setup needs the hint at all. Repositories where Codex reviews every push automatically must never be told to request a review manually, while repositories with no automatic review rely on the hint as the only path to a fresh review.

## Decision

The unresolved-threads failure selects its guidance from live state:

- Current HEAD already has accepted terminal evidence: resolve, then re-run.
- Otherwise, with `review-hint: suggest` (default): resolve, then request a review with the printed command, then re-run. Resolving still comes first, preserving the credit ordering from ADR 0001.
- Otherwise, with `review-hint: suppress`: resolve, then re-run; the message notes that Codex is expected to review each push automatically. In this mode a missing review is reported as a connector problem, not as a request to comment.

A new `stale-reviews` policy controls what counts as accepted evidence: `block` (default) requires terminal evidence attesting the current HEAD; `ignore` accepts the most recent terminal review, clean comment, or 👍 reaction even for an older HEAD. Thread blocking is unaffected by this policy.

Failure guidance lives in the job log (the failure annotation and info lines), the channel CLI agents actually read; the job summary mirrors it for humans in the web UI.

## Consequences

- Agents receive the complete next-action sequence for their situation instead of discovering the review-request step through a second failure.
- `review-hint: suppress` protects auto-review setups from double-spending credits on redundant manual requests; manual-only and on-pull-request setups keep the hint unchanged under `suggest`.
- `stale-reviews: ignore` lets repositories treat the last Codex verdict as final across pushes, at the price of merging commits Codex never inspected.
- ADR 0001 is refined rather than reversed: known findings are still resolved before any review request is suggested, but the request is now printed in the same failure when the HEAD will need it.
