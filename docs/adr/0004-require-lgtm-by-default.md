# ADR 0004: Require LGTM by default

- Status: Accepted
- Date: 2026-09-02

## Context

The Action gates a pull request after Codex reviews it. Its review threads can then be handled by the same agent that authored the change: the agent may resolve findings, push a fix, and leave a follow-up comment. Thread resolution in that loop is therefore self-attestation, not a human signature.

The assumption that a resolved thread represented a human-confirmed clean result failed in practice. In PR [#12 on `kkkiio/pi-workmap`](https://github.com/kkkiio/pi-workmap/pull/12), the check passed while an unresolved finding landed after the run. The gate needs Codex's own clean verdict rather than treating the agent's thread operations as an independent approval.

The previous two policy inputs also exposed a middle tier in which a fresh review plus an agent-resolved finding could pass without a clean Codex verdict. That tier does not provide the independent evidence the gate needs.

## Decision

Replace `stale-reviews` and `outdated-threads` with one boolean input, `pass-without-lgtm`, defaulting to `false`.

In strict mode (the default), the check passes only when a 👍 reaction or a clean Codex issue comment attests the current HEAD, and no unresolved Codex review thread remains. A terminal review in `COMMENTED`, `CHANGES_REQUESTED`, or `APPROVED` state is not an LGTM, even if it reports no findings. A terminal current-HEAD review without an LGTM enters `awaiting-lgtm` and fails with a fresh-review instruction after the grace period.

`pass-without-lgtm: true` is the explicit lenient opt-out. It accepts the most recent terminal review, clean comment, or 👍 even when it attests an older HEAD, while still requiring every Codex thread to be resolved. Unresolved threads always block, including threads GitHub marks outdated.

Unresolved-thread guidance requires the agent either to fix the finding, or to reply with its reasoning on the thread and then resolve it. Silent resolves are not auditable.

## Consequences

- Strict mode spends a review credit for each push that needs a fresh current-HEAD LGTM.
- A strict review/fix cycle can fail to converge when each push invalidates the prior clean verdict; `pass-without-lgtm: true` is the escape hatch for those iteration loops.
- `stale-reviews` and `outdated-threads` are removed, which is a breaking change for existing action pins that configure either input.
- The middle “fresh review + human resolve passes” tier is deliberately gone: resolving a Codex thread is not treated as an independent human approval.
- All unresolved Codex threads remain visible and blocking regardless of GitHub's outdated marker.
- An LGTM is not revoked within the same HEAD: if Codex leaves a 👍 and later submits a review with findings against the same commit, the findings block only while their threads are unresolved; once resolved, the earlier LGTM still passes the check. Requiring the latest same-HEAD review to be clean would need an additional rule and is deliberately not modeled.
