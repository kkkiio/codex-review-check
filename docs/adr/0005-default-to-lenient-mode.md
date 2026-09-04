# ADR 0005: Default to lenient review evidence

- Status: Accepted
- Date: 2026-09-03

## Context

PR #2 introduced a strict default in which every push needed a current-HEAD Codex LGTM. Field experience showed that this costs one Codex review credit per push, while Codex nitpicking can drive review and fix loops that do not converge. The strict gate's value is concentrated at final-merge time, when an independent Codex verdict matters more than during ordinary iteration.

The input name `pass-without-lgtm` also framed the common iteration path as an exception and did not follow the project's preference for booleans that default to false.

## Decision

Rename `pass-without-lgtm` to `require-lgtm` and default it to `false`.

With `require-lgtm: false`, the Action is lenient: the most recent terminal Codex evidence of any supported kind may satisfy the review condition, even when it attests an older HEAD, once every unresolved Codex thread has been handled. With `require-lgtm: true`, the Action retains the strict behavior: an LGTM from the current HEAD is required, and a terminal current-HEAD review without one enters `awaiting-lgtm` and can fail with `lgtm-missing`.

Unresolved Codex threads continue to block in both modes, including outdated threads. The LGTM definition and all other review-state semantics from ADR 0004 are unchanged apart from the input rename and default direction.

## Consequences

- Existing consumers silently move from strict to lenient behavior when they upgrade to this version; this is an intentional behavior change that may allow a completed older-HEAD verdict to pass where the prior default would have waited for a current-HEAD LGTM.
- Strict mode remains available as an opt-in and is recommended for final merge gates where an independent Codex verdict matters.
- The common iteration path avoids spending a review credit for every push and is less likely to enter a non-converging nitpick loop.
- Consumers must rename configured `pass-without-lgtm` inputs to `require-lgtm`; the old input is no longer recognized.
- The project's boolean convention is restored: the positive requirement is named directly and defaults to false.
