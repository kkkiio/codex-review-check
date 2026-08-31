# Design references

Research was refreshed on 2026-08-31 before this repository was implemented. Links below point to the source or official documentation used to choose the signal model.

## Upstream implementations

### Heúrema repository governance

[`heurema/repo-governance`](https://github.com/heurema/repo-governance/tree/58c1878e1e16c4139e35594aab6d1cb00f1c1018) was reviewed at commit `58c1878e1e16c4139e35594aab6d1cb00f1c1018`.

Relevant parts:

- [`actions/codex-review-ready`](https://github.com/heurema/repo-governance/tree/58c1878e1e16c4139e35594aab6d1cb00f1c1018/actions/codex-review-ready) is a state-based commit-status reconciler. It polls for current-head completion, writes `pending`/`failure`/`success`, accepts a bounded old `+1` fallback, and uses scheduled healing.
- [`actions/codex-review-gate`](https://github.com/heurema/repo-governance/tree/58c1878e1e16c4139e35594aab6d1cb00f1c1018/actions/codex-review-gate) supplies the review/thread GraphQL and REST evidence model.
- [`docs/CODEX_REVIEW_GATE.md`](https://github.com/heurema/repo-governance/blob/58c1878e1e16c4139e35594aab6d1cb00f1c1018/docs/CODEX_REVIEW_GATE.md) explains why review-thread resolution and PR reactions need polling or later reconciliation.

Codex Review Check keeps the current-head and fully paginated thread concepts, but deliberately changes missing evidence from long-lived `pending` to a short grace followed by an actionable failure. It does not write a commit status, accept an old clean reaction, scan all open PRs, or schedule healing.

### JoeyTeng Codex Review Gate Action

[`JoeyTeng/codex-review-gate-action`](https://github.com/JoeyTeng/codex-review-gate-action/tree/59eeda2af2a7baab3f3f15a59fbbaee015fa6c01) was reviewed at commit `59eeda2af2a7baab3f3f15a59fbbaee015fa6c01`.

Relevant parts:

- [`src/core.mjs`](https://github.com/JoeyTeng/codex-review-gate-action/blob/59eeda2af2a7baab3f3f15a59fbbaee015fa6c01/src/core.mjs) contains a strict provider identity, terminal grammar, current-head, ancestry, and evidence reduction model.
- [`DESIGN.md`](https://github.com/JoeyTeng/codex-review-gate-action/blob/59eeda2af2a7baab3f3f15a59fbbaee015fa6c01/DESIGN.md) records that 👀 is liveness-only and describes controlled marker, retry, ancestry, and final evidence stabilization.

That project is a much stronger attestation and orchestration gate. Codex Review Check borrows the distinction between liveness and terminal evidence, plus the observed clean-comment marker. It intentionally excludes controlled `@codex review` marker comments, sticky state, automatic retry, producer receipts, full provider grammar attestation, HEAD ancestry comparison, and scheduled recovery.

## GitHub documentation

- [`PullRequestReviewThread` fields](https://docs.github.com/en/graphql/reference/objects#pullrequestreviewthread) document `isResolved` and `isOutdated` as independent booleans.
- [Pull request reviews REST API](https://docs.github.com/en/rest/pulls/reviews) supplies submitted reviews and their commit binding.
- [Re-running workflows and jobs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs) documents that reruns reuse the original `GITHUB_SHA` and `GITHUB_REF`. This Action compensates by fetching the live PR and current `head.sha` on every attempt.
- [Workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows) define the PR, review, review-comment, issue-comment, and manual events used by the example workflow. GitHub does not provide a workflow event for resolving a review thread, so manual rerun remains part of the design.

## Codex GitHub review behavior

OpenAI's [Codex code review announcement](https://openai.com/index/introducing-upgrades-to-codex/) documents automatic pull request review and explicit review requests through `@codex review`. It does not define the exact GitHub reaction, comment, or review payload grammar as an API contract.

The current observed details—connector login, 👀 liveness, progress comment, terminal review, clean comment, and reviewed-commit marker—come from the two upstream implementations and their fixtures/design notes. They are isolated in [`CODEX_GITHUB_SIGNALS.md`](CODEX_GITHUB_SIGNALS.md) so later provider drift can be reviewed deliberately.

## Decision differences

| Concern | Heúrema ready | JoeyTeng gate | Codex Review Check |
| --- | --- | --- | --- |
| Required surface | Custom commit status | Custom commit status | Actions job `Codex Review` |
| Missing current-head signal | Pending, then configured timeout/scheduled healing | Marker orchestration and pending/retry | Short grace, then failure with review hint |
| Sends `@codex review` | No | Yes, controlled marker | No |
| 👀 | Not primary pass evidence | Liveness only | Liveness only |
| Clean `+1` | May pass with grace fallback | Audit only | Passes only when created no earlier than current HEAD |
| Current-head terminal review | Yes | Yes, strict attestation | Yes, exact REST `commit_id` |
| Unresolved outdated thread | Ignored by ready default | Blocks exact joined finding until resolved | Blocks by default; `ignore` is configurable |
| Thread resolution recovery | Polling plus schedule | Event/manual/schedule reconciliation | Standard Actions rerun |
| Ancestry attestation | No | Yes | No |
| Scheduled healing | Yes | Yes | No |

## Explicit non-goals

This first version does not implement begin-review, marker/retry state, automatic review comments, old-HEAD ancestry proof, custom status histories, producer receipts, scheduled scans, or healing. Those mechanisms solve different availability or attestation problems and would undermine this repository's small, agent-readable, credit-aware contract.
