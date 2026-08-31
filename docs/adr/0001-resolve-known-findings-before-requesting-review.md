# ADR 0001: Resolve known findings before requesting another review

- Status: Accepted
- Date: 2026-08-31

## Context

The check result is not only a merge gate. Its failure reason and job summary are control signals for the next step in an agent loop.

A pull request can have unresolved Codex review threads from an earlier HEAD while the current HEAD has no Codex lifecycle signal. Reporting only the missing current-HEAD signal tells the agent to request another review. That consumes a review credit before the agent has addressed known findings and can produce the same feedback again.

GitHub exposes thread resolution and diff freshness independently. A thread can remain `isResolved: false` whether `isOutdated` is true or false, and the configured outdated policy determines whether it blocks. This decision therefore applies to every thread already selected as blocking by that policy.

## Decision

Known blocking Codex review threads take precedence over lifecycle states for the current HEAD.

When at least one selected thread is unresolved, the Action fails immediately, links those conversations, and tells the agent to resolve them before rerunning the check. It does not emit the `@codex review` hint in that state.

After the conversations are resolved, a rerun reconstructs the live PR state. Only then may a missing current-HEAD signal produce the explicit review-request hint. Terminal current-HEAD evidence with no blocking threads succeeds after the existing settle interval.

## Consequences

- Agents address available evidence before spending another Codex review credit.
- The same unresolved-first result applies while a review is missing, in progress, or complete.
- Resolving a conversation does not attest the current HEAD; a later rerun can still require a new review.
- `outdated-threads: block` keeps unresolved outdated conversations in the first-priority set, while `ignore` omits them.
- The displayed failure reason now describes the most valuable next action, not merely the first lifecycle condition observed.
