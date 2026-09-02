import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  failureOutput,
  suggestsReviewRequest,
  summaryMarkdown,
  type FailureReason,
} from "../src/messages.js";
import type {
  ReviewEvaluation,
  ReviewHintPolicy,
  ReviewSnapshot,
  ReviewThreadRecord,
} from "../src/types.js";

// Every agent-facing message is pinned to a plain-text fixture so wording changes
// stay reviewable in diffs. Regenerate with: npm run fixtures:update
const FIXTURES_DIR = new URL("./fixtures/messages/", import.meta.url);

function expectFixture(name: string, actual: string): void {
  if (process.env.UPDATE_MESSAGE_FIXTURES) {
    mkdirSync(fileURLToPath(FIXTURES_DIR), { recursive: true });
    writeFileSync(fileURLToPath(new URL(`${name}.txt`, FIXTURES_DIR)), actual);
    return;
  }
  assert.equal(actual, readFileSync(fileURLToPath(new URL(`${name}.txt`, FIXTURES_DIR)), "utf8"));
}

const RUN_ID = "33499862152";

const snapshot: ReviewSnapshot = {
  repository: "owner/repo",
  pullRequest: 42,
  pullRequestUrl: "https://github.com/owner/repo/pull/42",
  headSha: "821c759c9c3256e8a677800dbe8e4a88ae5e2ab0",
  headCommittedAt: null,
  reviews: [],
  reactions: [],
  issueComments: [],
  threads: [],
};

function thread(overrides: Partial<ReviewThreadRecord>): ReviewThreadRecord {
  return {
    id: "PRRT_1",
    isResolved: false,
    isOutdated: false,
    path: "docs/adr/0012-glyph-width.md",
    line: 18,
    comments: [
      {
        author: "chatgpt-codex-connector[bot]",
        body: "Neutral glyphs are not Ambiguous.",
        createdAt: "2026-09-01T10:00:00Z",
        url: "https://github.com/owner/repo/pull/42#discussion_r1",
      },
    ],
    ...overrides,
  };
}

const blockingThreads: ReviewThreadRecord[] = [
  thread({}),
  thread({
    id: "PRRT_2",
    isOutdated: true,
    path: "src/widget.ts",
    line: null,
    comments: [{ author: "chatgpt-codex-connector[bot]", body: "stale", createdAt: null, url: null }],
  }),
];

function composite(
  reason: FailureReason,
  evaluation: ReviewEvaluation,
  reviewHint: ReviewHintPolicy,
  passWithoutLgtm = false,
): string {
  const output = failureOutput(
    reason,
    snapshot,
    evaluation,
    RUN_ID,
    reviewHint,
    passWithoutLgtm,
  );
  return [
    "=== annotation (core.setFailed — the line agents read via gh run view --log-failed) ===",
    output.annotation,
    "",
    "=== job log lines (core.info) ===",
    ...(output.logLines.length > 0 ? output.logLines : ["(none)"]),
    "",
    "=== job summary (web UI only) ===",
    summaryMarkdown(
      snapshot,
      evaluation,
      "failure",
      reason,
      RUN_ID,
      reviewHint,
      passWithoutLgtm,
    ),
  ].join("\n");
}

function evaluation(overrides: Partial<ReviewEvaluation>): ReviewEvaluation {
  return {
    phase: "missing",
    signal: "none",
    unresolvedThreads: [],
    currentHeadTerminal: false,
    currentHeadLiveness: false,
    ...overrides,
  };
}

test("unresolved-threads, current HEAD already satisfies the pass condition", () => {
  expectFixture(
    "unresolved-threads",
    composite(
      "unresolved-threads",
      evaluation({
        phase: "blocked",
        signal: "unresolved-threads",
        unresolvedThreads: blockingThreads,
        currentHeadTerminal: true,
      }),
      "suggest",
    ),
  );
});

test("unresolved-threads, HEAD needs a review, hint suggested", () => {
  expectFixture(
    "unresolved-threads-needs-review",
    composite(
      "unresolved-threads",
      evaluation({
        phase: "blocked",
        signal: "unresolved-threads",
        unresolvedThreads: blockingThreads,
      }),
      "suggest",
    ),
  );
});

test("unresolved-threads, HEAD needs a review, hint suppressed", () => {
  expectFixture(
    "unresolved-threads-auto-review",
    composite(
      "unresolved-threads",
      evaluation({
        phase: "blocked",
        signal: "unresolved-threads",
        unresolvedThreads: blockingThreads,
      }),
      "suppress",
    ),
  );
});

test("review-missing, hint suggested", () => {
  expectFixture("review-missing", composite("review-missing", evaluation({}), "suggest"));
});

test("review-missing, hint suppressed", () => {
  expectFixture("review-missing-auto-review", composite("review-missing", evaluation({}), "suppress"));
});

test("review-timeout failure output", () => {
  expectFixture(
    "review-timeout",
    composite(
      "review-timeout",
      evaluation({ phase: "reviewing", signal: "progress-comment" }),
      "suggest",
    ),
  );
});

test("unresolved-threads, review already in progress", () => {
  expectFixture(
    "unresolved-threads-review-in-progress",
    composite(
      "unresolved-threads",
      evaluation({
        phase: "blocked",
        signal: "unresolved-threads",
        unresolvedThreads: blockingThreads,
        currentHeadLiveness: true,
      }),
      "suggest",
    ),
  );
});

test("lgtm-missing, hint suggested", () => {
  expectFixture(
    "lgtm-missing",
    composite(
      "lgtm-missing",
      evaluation({ phase: "awaiting-lgtm", signal: "review:commented" }),
      "suggest",
    ),
  );
});

test("lgtm-missing, hint suppressed", () => {
  expectFixture(
    "lgtm-missing-auto-review",
    composite(
      "lgtm-missing",
      evaluation({ phase: "awaiting-lgtm", signal: "review:commented" }),
      "suppress",
    ),
  );
});

test("ready accepted without an LGTM under pass-without-lgtm", () => {
  const ready = summaryMarkdown(
    snapshot,
    evaluation({ phase: "terminal", signal: "review:commented", currentHeadTerminal: true }),
    "success",
    "ready",
    RUN_ID,
    "suggest",
    true,
  );
  expectFixture("ready-without-lgtm", ready);
});

test("ready strict success summary", () => {
  expectFixture(
    "ready",
    summaryMarkdown(
      snapshot,
      evaluation({ phase: "terminal", signal: "clean-reaction", currentHeadTerminal: true }),
      "success",
      "ready",
      RUN_ID,
      "suggest",
      false,
    ),
  );
});

test("review-hint output matches the annotation guidance", () => {
  const scenarios: [FailureReason, ReviewEvaluation][] = [
    ["unresolved-threads", evaluation({ unresolvedThreads: blockingThreads })],
    ["unresolved-threads", evaluation({ unresolvedThreads: blockingThreads, currentHeadLiveness: true })],
    ["unresolved-threads", evaluation({ unresolvedThreads: blockingThreads, currentHeadTerminal: true })],
    ["review-missing", evaluation({})],
    ["lgtm-missing", evaluation({ phase: "awaiting-lgtm", signal: "review:commented" })],
  ];
  for (const [reason, state] of scenarios) {
    for (const policy of ["suggest", "suppress"] as const) {
      const output = failureOutput(reason, snapshot, state, RUN_ID, policy);
      assert.equal(
        suggestsReviewRequest(reason, state, policy),
        output.annotation.includes("'@codex review'"),
        `${reason} terminal=${state.currentHeadTerminal} liveness=${state.currentHeadLiveness} policy=${policy}`,
      );
    }
  }
});
