# Codex Review Check

Codex Review Check is a read-only, credit-aware GitHub Action that waits for Codex to review the current pull request HEAD, blocks unresolved Codex review threads, and gives coding agents an explicit `@codex review` command when no review started. The workflow job is named `Codex Review`, so that is the check name to require in a ruleset.

## Installation

Publish this repository, then pin the Action to a reviewed full commit SHA in the consuming repository. Copy [`examples/codex-review-check.yml`](examples/codex-review-check.yml) to `.github/workflows/codex-review-check.yml` and replace:

```yaml
uses: kkkiio/codex-review-check@COMMIT_SHA
```

The workflow needs only read permissions:

```yaml
permissions:
  contents: read
  issues: read
  pull-requests: read
```

After the workflow has run on a pull request, add `Codex Review` as a required check in the repository ruleset.

## Usage

The minimal job is:

```yaml
jobs:
  codex-review:
    name: Codex Review
    runs-on: ubuntu-latest
    timeout-minutes: 35
    steps:
      - uses: kkkiio/codex-review-check@COMMIT_SHA
        with:
          github-token: ${{ github.token }}
```

On pull request and review events, the Action infers the PR number. A manual `workflow_dispatch` run should pass `pull-request` explicitly.

The check follows this state model:

| Current PR state | Result |
| --- | --- |
| No current-HEAD Codex signal during the grace period | Fail with `gh pr comment <PR> --body '@codex review'` and rerun instructions |
| Current Codex 👀 or progress signal | Keep the job running/pending while polling |
| Terminal current-HEAD signal plus unresolved Codex threads | Fail and link the blocking conversations |
| Terminal current-HEAD signal with no blocking threads | Succeed |
| Liveness without a terminal result before the review timeout | Fail with rerun instructions |

The Action never posts `@codex review`; spending a Codex review credit remains an explicit agent or human decision. A standard GitHub Actions rerun reconstructs state from the live PR and reads its current HEAD, reviews, comments, reactions, and review threads again.

### Configuration

| Input | Default | Purpose |
| --- | --- | --- |
| `pull-request` | inferred | PR number for manual or unusual events |
| `codex-bot-logins` | Codex connector logins | Accepted review authors |
| `grace-seconds` | `60` | Wait before the missing-review hint fails |
| `review-timeout-seconds` | `1800` | Maximum wait after liveness is seen |
| `poll-interval-seconds` | `10` | GitHub state refresh interval |
| `terminal-settle-seconds` | `15` | Buffer for review-thread propagation |
| `outdated-threads` | `block` | `block` unresolved outdated threads, or `ignore` them |

`outdated-threads: block` treats `isOutdated` and `isResolved` independently: an outdated conversation still blocks until it is resolved. Choose `ignore` only when repository policy intentionally treats stale diff conversations as closed.

### Rerun after requesting review

The failure summary prints both commands:

```shell
gh pr comment 42 --body '@codex review'
gh run rerun RUN_ID --failed
```

GitHub reruns preserve the original event SHA, but this Action does not use that SHA as review authority. Every attempt calls GitHub for the PR's live `head.sha`, which is why rerun works after Codex finishes or after review conversations are resolved.

## Signal compatibility

Codex's visible GitHub behavior is documented separately in [`docs/CODEX_GITHUB_SIGNALS.md`](docs/CODEX_GITHUB_SIGNALS.md). Read it before changing parsers or adding a new pass signal. Source references and deliberate differences from related gates are in [`docs/REFERENCES.md`](docs/REFERENCES.md).

## Scope

This repository intentionally does not implement automatic review requests, begin-review handshakes, marker/retry comments, HEAD ancestry attestation, scheduled healing, or custom commit statuses. The required check is the `Codex Review` Actions job itself.
