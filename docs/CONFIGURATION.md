# Configuration

Codex Review Check reads live pull request state on every attempt. The complete workflow in [`examples/codex-review-check.yml`](../examples/codex-review-check.yml) supplies the event routing, permissions, concurrency, and pull request number used by the Action.

## Inputs

| Input | Required | Default | Purpose |
| --- | --- | --- | --- |
| `github-token` | yes | — | Token used to read the pull request, reviews, reactions, and review threads |
| `pull-request` | no | inferred from the event | Numeric PR number, such as `42`; omit for normal event-driven runs |
| `codex-bot-logins` | no | Codex connector logins | Comma-separated review authors accepted as Codex |
| `grace-seconds` | no | `60` | Wait before a missing-review hint fails |
| `review-timeout-seconds` | no | `1800` | Maximum wait after review liveness appears |
| `poll-interval-seconds` | no | `10` | Delay between live GitHub state reads |
| `terminal-settle-seconds` | no | `15` | Buffer for review-thread propagation after terminal evidence |
| `outdated-threads` | no | `block` | Either `block` or `ignore` for unresolved outdated threads |
| `stale-reviews` | no | `block` | Either `block` or `ignore` for terminal review evidence attesting an older HEAD |
| `review-hint` | no | `suggest` | Either `suggest` or `suppress` the manual `@codex review` request hint |

The workflow token needs only:

```yaml
permissions:
  contents: read
  issues: read
  pull-requests: read
```

## Workflow orchestration

Use one polling coordinator for each pull request. The recommended workflow starts for pull request lifecycle events that introduce or activate a HEAD, plus explicit manual dispatch:

```yaml
on:
  pull_request:
    types: [opened, reopened, ready_for_review, synchronize]
  workflow_dispatch:
```

Do not also subscribe the same workflow to `pull_request_review`, `pull_request_review_comment`, or `issue_comment`. The running Action already polls live reviews, comments, reactions, and threads. A lifecycle event creates a separate workflow run rather than notifying the existing run; with shared `cancel-in-progress` concurrency it replaces the coordinator, and without cancellation it duplicates the check.

Keep `cancel-in-progress: true` for the pull-request concurrency group so a new `synchronize` event replaces work tied to an older HEAD. After a missing-review or unresolved-thread failure, use the standard rerun printed in the failure log line and the job summary.

## Outdated threads

GitHub exposes `isResolved` and `isOutdated` independently.

- `block` keeps every unresolved Codex thread blocking, including `isOutdated: true` threads.
- `ignore` omits unresolved outdated threads but still blocks unresolved current threads.

Known blocking threads always take precedence over lifecycle state. The failure tells the agent to resolve them first; when the current HEAD also lacks accepted review evidence and `review-hint` is `suggest`, the same failure includes the review request as the step after resolving.

## Stale reviews

A terminal Codex review attests the commit it was submitted against. A push replaces the HEAD, so an older review no longer covers it.

- `block` requires terminal evidence attesting the current HEAD; anything older is treated as no review.
- `ignore` accepts the most recent terminal review, clean comment, or 👍 reaction even when it attests an older HEAD. Use this only when you are comfortable treating the last Codex verdict as final across pushes.

Unresolved threads block under either setting; thread resolution and review freshness are independent concerns.

## Review hint

The Action never spends Codex credits itself, but its failures can tell the agent to request a review with `gh pr comment <PR> --body '@codex review'`.

- `suggest` presents that command whenever the current HEAD lacks accepted review evidence. This fits setups where Codex reviews only on pull request open, and setups with no automatic review at all — in both, a manual comment is the only way a later HEAD gets reviewed.
- `suppress` omits the command. Use it when Codex is configured to review every push: a missing review then means the connector did not fire, and the failure says to verify that instead of requesting a review manually.

## Pull request selection

`pull-request` is the integer at the end of a pull request URL: `https://github.com/OWNER/REPO/pull/42` uses `42`. It is not a branch name or event type.

The Action infers this number from pull request, review, review-comment, and pull-request issue-comment events. A `workflow_dispatch` run must pass it explicitly, as shown in the complete example.

## Outputs

| Output | Meaning |
| --- | --- |
| `state` | Final `success` or `failure` state |
| `reason` | Machine-readable final reason |
| `head-sha` | Live pull request HEAD evaluated by this attempt |
| `review-signal` | Selected Codex lifecycle or blocking signal |
| `unresolved-count` | Number of threads that block under the outdated policy |
| `review-hint` | `gh` review-request command, populated when the action suggests a manual review request |

## Reruns

The missing-review failure prints both commands in the job log and the job summary:

```shell
gh pr comment 42 --body '@codex review'
gh run rerun RUN_ID --failed
```

A rerun reconstructs the PR state and reads its live `head.sha`, reviews, comments, reactions, and threads. It does not depend on a resolve webhook. GitHub still executes the Action version pinned by the original workflow run; update the workflow pin and trigger a new run when adopting a newer Action release.
