import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { failureOutput, summaryMarkdown, type FailureReason } from "../src/messages.js";
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
): string {
  const output = failureOutput(reason, snapshot, evaluation, RUN_ID, reviewHint);
  return [
    "=== annotation (core.setFailed — the line agents read via gh run view --log-failed) ===",
    output.annotation,
    "",
    "=== job log lines (core.info) ===",
    ...(output.logLines.length > 0 ? output.logLines : ["(none)"]),
    "",
    "=== job summary (web UI only) ===",
    summaryMarkdown(snapshot, evaluation, "failure", reason, RUN_ID, reviewHint),
  ].join("\n");
}

test("unresolved-threads, current HEAD already reviewed", () => {
  const evaluation: ReviewEvaluation = {
    phase: "blocked",
    signal: "unresolved-threads",
    unresolvedThreads: blockingThreads,
    currentHeadTerminal: true,
  };
  expectFixture("unresolved-threads", composite("unresolved-threads", evaluation, "suggest"));
});

test("unresolved-threads, HEAD needs a review, hint suggested", () => {
  const evaluation: ReviewEvaluation = {
    phase: "blocked",
    signal: "unresolved-threads",
    unresolvedThreads: blockingThreads,
    currentHeadTerminal: false,
  };
  expectFixture(
    "unresolved-threads-needs-review",
    composite("unresolved-threads", evaluation, "suggest"),
  );
});

test("unresolved-threads, HEAD needs a review, hint suppressed", () => {
  const evaluation: ReviewEvaluation = {
    phase: "blocked",
    signal: "unresolved-threads",
    unresolvedThreads: blockingThreads,
    currentHeadTerminal: false,
  };
  expectFixture(
    "unresolved-threads-auto-review",
    composite("unresolved-threads", evaluation, "suppress"),
  );
});

test("review-missing, hint suggested", () => {
  const evaluation: ReviewEvaluation = {
    phase: "missing",
    signal: "none",
    unresolvedThreads: [],
    currentHeadTerminal: false,
  };
  expectFixture("review-missing", composite("review-missing", evaluation, "suggest"));
});

test("review-missing, hint suppressed", () => {
  const evaluation: ReviewEvaluation = {
    phase: "missing",
    signal: "none",
    unresolvedThreads: [],
    currentHeadTerminal: false,
  };
  expectFixture("review-missing-auto-review", composite("review-missing", evaluation, "suppress"));
});

test("review-timeout failure output", () => {
  const evaluation: ReviewEvaluation = {
    phase: "reviewing",
    signal: "progress-comment",
    unresolvedThreads: [],
    currentHeadTerminal: false,
  };
  expectFixture("review-timeout", composite("review-timeout", evaluation, "suggest"));
});

test("ready success summary", () => {
  const evaluation: ReviewEvaluation = {
    phase: "terminal",
    signal: "review:approved",
    unresolvedThreads: [],
    currentHeadTerminal: true,
  };
  expectFixture(
    "ready",
    summaryMarkdown(snapshot, evaluation, "success", "ready", RUN_ID, "suggest"),
  );
});
