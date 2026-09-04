# ADR 0006: A review started after the latest verdict keeps the gate waiting

- Status: Accepted
- Date: 2026-09-04

## Context

Lenient mode accepts the most recent completed verdict even when it attests an older HEAD. Two races were observed around in-flight reviews:

- On `kkkiio/pi-workmap#12`, a check passed on a resolved review minutes before a newly requested review landed with further findings — the gate opened while a paid-for review was still running.
- A first fix let liveness supersede only stale evidence, keeping a "current-HEAD evidence is not superseded" exception. In practice, fresh liveness on an already-reviewed HEAD means someone explicitly requested another review with `@codex review`, spending a Codex credit; passing before that verdict lands wastes the credit's information.

An unconditional "liveness always waits" rule would overcorrect: Codex leaves 👀 reactions that predate its own completed review, and treating those as a new review would stall the gate until timeout on every normal run.

## Decision

Liveness records newer than the latest completed verdict — across terminal reviews, clean comments, and 👍 reactions — keep the job waiting in both modes. Liveness predating the latest completed verdict is a leftover of that review and does not block.

## Consequences

- A requested re-review is always awaited, so its findings can never land behind an open gate.
- Leftover 👀 reactions from a completed review do not stall the gate.
- A genuinely stuck review still fails with `review-timeout` after the configured timeout, naming the connector as the suspect.
