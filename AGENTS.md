# codex-review-check AGENTS.md

## Project Structure Guide

### Repo Structure & Important Files

```text
.
├── AGENTS.md                    # Repository-wide developer-agent guide
├── action.yml                   # Public Action metadata, inputs, outputs, and Node entrypoint
├── assets/                      # README screenshots; regenerate gh-pr-checks.png via assets/gh-pr-checks.sh
├── dist/                        # Committed ncc release bundle loaded by GitHub Actions
├── docs/
│   ├── CONFIGURATION.md         # User-facing inputs, outputs, policies, and rerun reference
│   ├── CODEX_GITHUB_SIGNALS.md  # Observed provider behavior and accepted evidence
│   ├── REFERENCES.md            # Upstream sources and deliberate design differences
│   └── adr/                     # Architecture decisions and their consequences
├── examples/
│   └── codex-review-check.yml   # Complete consumer workflow pinned to an immutable SHA
├── src/
│   ├── github.ts                # Paginated GitHub REST and GraphQL state loading
│   ├── index.ts                 # Action runtime, polling loop, and outputs
│   ├── messages.ts              # Agent-facing failure wording and job-summary text
│   ├── state.ts                 # Pure Codex signal and blocking-state evaluation
│   └── types.ts                 # Shared runtime records and evaluation types
├── test/
│   ├── fixtures/                # Captured review-state examples and pinned message text
│   ├── messages.test.ts         # Fixture-pinned wording for every failure reason
│   └── state.test.ts            # Signal, current-HEAD, and thread-policy tests
├── package.json                 # Development commands and dependencies
└── README.md                    # Short user getting-started guide
```

Keep GitHub transport and pagination in `src/github.ts`, provider interpretation in `src/state.ts`, user-facing wording in `src/messages.ts`, and polling plus runtime orchestration in `src/index.ts`. Keep compiled release code in `dist/`; consumers do not install dependencies at runtime.

### Documentation Map

- [`docs/CODEX_GITHUB_SIGNALS.md`](docs/CODEX_GITHUB_SIGNALS.md) — Observed connector behavior on GitHub pull requests. Acceptance policy lives in `docs/CONFIGURATION.md`.
- [`docs/REFERENCES.md`](docs/REFERENCES.md) — Upstream projects, GitHub documentation, and deliberate design differences.
- [`docs/adr/0001-resolve-known-findings-before-requesting-review.md`](docs/adr/0001-resolve-known-findings-before-requesting-review.md) — Decision to resolve known findings before suggesting another review.
- [`docs/adr/0002-use-one-polling-coordinator-per-pull-request.md`](docs/adr/0002-use-one-polling-coordinator-per-pull-request.md) — Decision to let one PR-head run observe the Codex lifecycle without comment-triggered replacement runs.

## Domain Language

- **Current HEAD** — The live commit SHA at the tip of the pull request being evaluated.
- **Lifecycle signal** — Codex-authored evidence that a review is missing, active, or complete.
- **Liveness** — Non-terminal evidence such as a fresh 👀 reaction or progress comment.
- **Terminal signal** — Current-HEAD evidence that Codex finished reviewing, with or without findings.
- **Review thread** — A GitHub pull request conversation containing a configured Codex author.
- **Outdated thread** — A review thread GitHub marks `isOutdated` independently of resolution.
- **Blocking thread** — An unresolved Codex thread retained by the configured outdated policy.
- **Review hint** — The explicit `gh pr comment <PR> --body '@codex review'` next action.
- **Rerun** — A new attempt of the same Actions run that reconstructs live pull request state.

## Policies & Mandatory Rules

### Behavior and documentation

- When changing inputs or outputs, update `action.yml` and `docs/CONFIGURATION.md` together.
- When Codex connector behavior is newly observed or changes, record it in `docs/CODEX_GITHUB_SIGNALS.md` and add or revise a fixture in `test/fixtures/`; keep acceptance policy in `docs/CONFIGURATION.md` and out of the behavior record.
- When changing product intent or state priority, record the rationale in `docs/adr/`; keep `README.md` limited to observable behavior and first use, without implementation rationale or ADR links.
- Agent-facing wording in `src/messages.ts` is pinned by plain-text fixtures in `test/fixtures/messages/`; regenerate with `npm run fixtures:update` and review the wording diff.

### Runtime and release

- When changing `src/`, rebuild and commit `dist/index.js` and `dist/index.js.map` in the same change.
- When changing the consumer workflow pin, use a reviewed full-length commit SHA; do not replace it with a mutable branch reference.
- When changing review orchestration, keep the Action read-only: never post `@codex review`, resolve conversations, or mutate pull request state.
- When adding TypeScript abstractions, prefer deep cohesive functions over chains of thin one-use helpers; keep substantial functions long enough to own a complete responsibility.
- When tools format generated or source files, preserve the formatter's changes. Do not run `git diff --check` as a project verification step.

## Operation Guide

Use Node.js 24 and install dependencies with:

```bash
npm ci
```

When changing `src/`, `test/`, `action.yml`, or release behavior, run the complete verification suite:

```bash
npm run check
```

`npm run check` runs TypeScript checking, tests, and the ncc build. After it completes, confirm that intended `dist/` changes are committed. For documentation-only edits that do not change examples, metadata, or generated assets, skip the build and verify links and rendered Markdown directly.
