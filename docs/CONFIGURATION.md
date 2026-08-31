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

Keep `cancel-in-progress: true` for the pull-request concurrency group so a new `synchronize` event replaces work tied to an older HEAD. After a missing-review or unresolved-thread failure, use the standard rerun printed in the job summary.

## Outdated threads

GitHub exposes `isResolved` and `isOutdated` independently.

- `block` keeps every unresolved Codex thread blocking, including `isOutdated: true` threads.
- `ignore` omits unresolved outdated threads but still blocks unresolved current threads.

Known blocking threads always take precedence over lifecycle state. The Action tells the agent to resolve them before it can emit a missing-review hint.

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
| `review-hint` | `gh` review-request command, populated only for a missing review with no known blockers |

## Reruns

The missing-review summary prints both commands:

```shell
gh pr comment 42 --body '@codex review'
gh run rerun RUN_ID --failed
```

A rerun reconstructs the PR state and reads its live `head.sha`, reviews, comments, reactions, and threads. It does not depend on a resolve webhook. GitHub still executes the Action version pinned by the original workflow run; update the workflow pin and trigger a new run when adopting a newer Action release.
