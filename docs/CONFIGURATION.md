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
| `terminal-settle-seconds` | no | `15` | Buffer for review-thread propagation after terminal evidence, before both success and missing-LGTM failures |
| `require-lgtm` | no | `false` | Require an LGTM attesting the current HEAD; `true` opts into the strict gate |
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

## What satisfies the check

The observable artifacts are documented in [CODEX_GITHUB_SIGNALS.md](CODEX_GITHUB_SIGNALS.md). Acceptance policy:

- A review that started after the latest completed verdict keeps the job waiting in both modes, up to `review-timeout-seconds`: an in-flight review was paid for, so its result must land before the gate opens. Liveness predating the latest completed verdict is a leftover of that review and does not block.
- In the default lenient mode, the most recent completed terminal review, clean comment, or 👍 may satisfy the review condition even when it attests an older HEAD, once no unresolved Codex review thread remains.
- With `require-lgtm: true`, Codex must leave an LGTM attesting the current HEAD, and no unresolved Codex review thread may remain.
- A terminal review with `COMMENTED`, `CHANGES_REQUESTED`, or `APPROVED` state is not an LGTM, even when it has no findings.
- Unknown presentation never produces success: the job keeps waiting while a known liveness signal exists, otherwise it fails with the printed guidance. GitHub API or pagination failures also fail the job.

## LGTM requirement

`require-lgtm` controls whether a completed review must include Codex's own clean verdict:

- The default `false` is lenient: the most recent terminal review, clean comment, or 👍 can pass once every Codex review thread is resolved, even when the evidence attests an older HEAD.
- Set `require-lgtm: true` to require an LGTM on the current HEAD. An LGTM is either a 👍 reaction from the configured Codex bot created at or after the HEAD commit, or a bot issue comment beginning `Codex Review: Didn't find any major issues.` with exactly one `Reviewed commit` marker matching the current HEAD.
- Every unresolved Codex review thread blocks in both modes, including threads GitHub marks outdated. Resolve each finding by fixing it, or reply with your reasoning on the thread and then resolve it; silent resolves are not auditable.

Known blocking threads always take precedence over lifecycle state. After they are handled, strict mode may require a fresh review to obtain an LGTM.

## Review hint

The Action never spends Codex credits itself, but its failures can tell the agent to request a review with `gh pr comment <PR> --body '@codex review'`.

- `suggest` presents that command when the current HEAD lacks accepted review evidence and no review of it is in progress. This fits setups where Codex reviews only on pull request open, and setups with no automatic review at all — in both, a manual comment is the only way a later HEAD gets reviewed.
- `suppress` omits the command. Use it when Codex is configured to review every push: a missing review then means the connector did not fire, and the failure says to verify that instead of requesting a review manually.

## Pull request selection

`pull-request` is the integer at the end of a pull request URL: `https://github.com/OWNER/REPO/pull/42` uses `42`. It is not a branch name or event type.

The Action infers this number from pull request, review, review-comment, and pull-request issue-comment events. A `workflow_dispatch` run must pass it explicitly, as shown in the complete example.

## Outputs

| Output | Meaning |
| --- | --- |
| `state` | Final `success` or `failure` state |
| `reason` | Machine-readable final reason (`ready`, `unresolved-threads`, `review-missing`, `review-timeout`, or `lgtm-missing`) |
| `head-sha` | Live pull request HEAD evaluated by this attempt |
| `review-signal` | Selected Codex lifecycle or blocking signal |
| `unresolved-count` | Number of unresolved Codex review threads blocking this check |
| `review-hint` | `gh` review-request command, populated when the action suggests a manual review request |

## Reruns

The missing-review failure prints both commands in the job log and the job summary:

```shell
gh pr comment 42 --body '@codex review'
gh run rerun RUN_ID --failed
```

A rerun reconstructs the PR state and reads its live `head.sha`, reviews, comments, reactions, and threads. It does not depend on a resolve webhook. GitHub still executes the Action version pinned by the original workflow run; update the workflow pin and trigger a new run when adopting a newer Action release.
