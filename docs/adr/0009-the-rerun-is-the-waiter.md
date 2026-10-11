# ADR 0009: The rerun is the waiter

- Status: Accepted
- Date: 2026-10-11

## Context

ADR 0002 makes the running attempt the sole Codex lifecycle coordinator, and failures told agents to "request a fresh review — then re-run". An observed session with a weaker model read the second "then" as "after the review appears": it posted `@codex review`, then wrote its own `until gh api …/reviews …; do sleep 15; done` loop for the new HEAD, and only reran the check after being challenged. The model treated the check as a one-shot snapshot evaluator, so it waited for the input to exist before re-evaluating. Nothing in the message said the rerun itself waits.

The `review-timeout` message made this worse by literally saying "Re-run after the review finishes".

## Decision

Every failure prints its next steps as one `&&` chain in run order: the optional review request, `gh run rerun RUN_ID --failed`, and `gh pr checks PR --watch`. The message then states that the rerun waits up to the configured `review-timeout-seconds` for the Codex review to finish, to start it right away, and to wait on the check.

The message recommends rather than forbids. Reading Codex reviews or comments directly stays available when the check result looks wrong, so a check bug does not trap the agent.

`gh pr checks --watch` is guidance, not a correctness requirement: the attempt alone decides whether the review is accepted. If the watch races the rerun and reports the previous attempt, the agent loses only time.

## Consequences

- `failureOutput` and `summaryMarkdown` take a `MessageOptions` record that carries the run id, review-hint policy, LGTM mode, and review timeout.
- A `review-timeout` failure tells the agent to rerun to keep waiting, not to wait outside the check.
- The chain is longer than the previous two-step instruction; message fixtures pin the full text.
