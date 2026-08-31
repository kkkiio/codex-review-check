import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateReviewState, parseCodexIssueComment } from "../src/state.js";
import type {
  IssueCommentRecord,
  ReactionRecord,
  ReviewRecord,
  ReviewSnapshot,
  ReviewThreadRecord,
} from "../src/types.js";

interface Fixtures {
  base: ReviewSnapshot;
  eyes: ReactionRecord;
  staleEyes: ReactionRecord;
  cleanReaction: ReactionRecord;
  staleCleanReaction: ReactionRecord;
  cleanComment: IssueCommentRecord;
  mismatchedCleanComment: IssueCommentRecord;
  progressComment: IssueCommentRecord;
  reviewRequestComment: IssueCommentRecord;
  completedReviewRequestComment: IssueCommentRecord;
  terminalReview: ReviewRecord;
  oldReview: ReviewRecord;
  unresolvedThread: ReviewThreadRecord;
  outdatedThread: ReviewThreadRecord;
}

const fixtures = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/review-states.json", import.meta.url)),
    "utf8",
  ),
) as Fixtures;
const bots = new Set(["chatgpt-codex-connector", "chatgpt-codex-connector[bot]"]);

test("Codex issue comments expose only supported clean and progress signals", () => {
  const clean = parseCodexIssueComment(fixtures.cleanComment);
  assert.equal(clean.kind, "terminal");
  assert.equal(clean.name, "clean-comment");
  assert.equal(clean.commitRef, "aaaaaaaaaa");

  const progress = parseCodexIssueComment(fixtures.progressComment);
  assert.equal(progress.kind, "liveness");
  assert.equal(progress.name, "progress-comment");
  assert.equal(progress.commitRef, null);

  const prose = parseCodexIssueComment({
    ...fixtures.cleanComment,
    body: "A human mentioned Codex Review: Didn't find any major issues.",
  });
  assert.equal(prose.kind, "none");

  const missingMarker = parseCodexIssueComment({
    ...fixtures.cleanComment,
    body: "Codex Review: Didn't find any major issues.",
  });
  assert.equal(missingMarker.kind, "none");

  const duplicatedMarker = parseCodexIssueComment({
    ...fixtures.cleanComment,
    body: `${fixtures.cleanComment.body}\n**Reviewed commit:** \`aaaaaaaaaa\``,
  });
  assert.equal(duplicatedMarker.kind, "none");
});

test("review state follows current-head, liveness, terminal, thread, and outdated policy", () => {
  const missing = evaluateReviewState(fixtures.base, bots, "block");
  assert.equal(missing.phase, "missing");
  assert.equal(missing.signal, "none");

  const staleEyes = evaluateReviewState(
    { ...fixtures.base, reactions: [fixtures.staleEyes] },
    bots,
    "block",
  );
  assert.equal(staleEyes.phase, "missing");

  const staleCleanReaction = evaluateReviewState(
    { ...fixtures.base, reactions: [fixtures.staleCleanReaction] },
    bots,
    "block",
  );
  assert.equal(staleCleanReaction.phase, "missing");

  const reviewing = evaluateReviewState(
    { ...fixtures.base, reactions: [fixtures.eyes] },
    bots,
    "block",
  );
  assert.equal(reviewing.phase, "reviewing");
  assert.equal(reviewing.signal, "eyes");

  const progress = evaluateReviewState(
    { ...fixtures.base, issueComments: [fixtures.progressComment] },
    bots,
    "block",
  );
  assert.equal(progress.phase, "reviewing");
  assert.equal(progress.signal, "progress-comment");

  const requestCommentReviewing = evaluateReviewState(
    { ...fixtures.base, issueComments: [fixtures.reviewRequestComment] },
    bots,
    "block",
  );
  assert.equal(requestCommentReviewing.phase, "reviewing");
  assert.equal(requestCommentReviewing.signal, "eyes");

  const staleTerminal = evaluateReviewState(
    { ...fixtures.base, reviews: [fixtures.oldReview] },
    bots,
    "block",
  );
  assert.equal(staleTerminal.phase, "missing");

  const mismatchedClean = evaluateReviewState(
    { ...fixtures.base, issueComments: [fixtures.mismatchedCleanComment] },
    bots,
    "block",
  );
  assert.equal(mismatchedClean.phase, "missing");

  const clean = evaluateReviewState(
    { ...fixtures.base, issueComments: [fixtures.cleanComment] },
    bots,
    "block",
  );
  assert.equal(clean.phase, "terminal");
  assert.equal(clean.signal, "clean-comment");

  const cleanReaction = evaluateReviewState(
    { ...fixtures.base, reactions: [fixtures.cleanReaction] },
    bots,
    "block",
  );
  assert.equal(cleanReaction.phase, "terminal");
  assert.equal(cleanReaction.signal, "clean-reaction");

  const requestCommentClean = evaluateReviewState(
    { ...fixtures.base, issueComments: [fixtures.completedReviewRequestComment] },
    bots,
    "block",
  );
  assert.equal(requestCommentClean.phase, "terminal");
  assert.equal(requestCommentClean.signal, "clean-reaction");

  const blocked = evaluateReviewState(
    {
      ...fixtures.base,
      reviews: [fixtures.terminalReview],
      threads: [fixtures.unresolvedThread, fixtures.outdatedThread],
    },
    bots,
    "block",
  );
  assert.equal(blocked.phase, "terminal");
  assert.equal(blocked.signal, "review:commented");
  assert.equal(blocked.unresolvedThreads.length, 2);

  const ignoredOutdated = evaluateReviewState(
    {
      ...fixtures.base,
      reviews: [fixtures.terminalReview],
      threads: [{ ...fixtures.unresolvedThread, isResolved: true }, fixtures.outdatedThread],
    },
    bots,
    "ignore",
  );
  assert.equal(ignoredOutdated.phase, "terminal");
  assert.equal(ignoredOutdated.unresolvedThreads.length, 0);
});
