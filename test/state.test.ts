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
  const missing = evaluateReviewState(fixtures.base, bots, "block", "block");
  assert.equal(missing.phase, "missing");
  assert.equal(missing.signal, "none");

  const staleEyes = evaluateReviewState(
    { ...fixtures.base, reactions: [fixtures.staleEyes] },
    bots,
    "block",
    "block",
  );
  assert.equal(staleEyes.phase, "missing");

  const staleCleanReaction = evaluateReviewState(
    { ...fixtures.base, reactions: [fixtures.staleCleanReaction] },
    bots,
    "block",
    "block",
  );
  assert.equal(staleCleanReaction.phase, "missing");

  const reviewing = evaluateReviewState(
    { ...fixtures.base, reactions: [fixtures.eyes] },
    bots,
    "block",
    "block",
  );
  assert.equal(reviewing.phase, "reviewing");
  assert.equal(reviewing.signal, "eyes");

  const progress = evaluateReviewState(
    { ...fixtures.base, issueComments: [fixtures.progressComment] },
    bots,
    "block",
    "block",
  );
  assert.equal(progress.phase, "reviewing");
  assert.equal(progress.signal, "progress-comment");

  const requestCommentReviewing = evaluateReviewState(
    { ...fixtures.base, issueComments: [fixtures.reviewRequestComment] },
    bots,
    "block",
    "block",
  );
  assert.equal(requestCommentReviewing.phase, "reviewing");
  assert.equal(requestCommentReviewing.signal, "eyes");

  const staleTerminal = evaluateReviewState(
    { ...fixtures.base, reviews: [fixtures.oldReview] },
    bots,
    "block",
    "block",
  );
  assert.equal(staleTerminal.phase, "missing");

  const mismatchedClean = evaluateReviewState(
    { ...fixtures.base, issueComments: [fixtures.mismatchedCleanComment] },
    bots,
    "block",
    "block",
  );
  assert.equal(mismatchedClean.phase, "missing");

  const clean = evaluateReviewState(
    { ...fixtures.base, issueComments: [fixtures.cleanComment] },
    bots,
    "block",
    "block",
  );
  assert.equal(clean.phase, "terminal");
  assert.equal(clean.signal, "clean-comment");

  const cleanReaction = evaluateReviewState(
    { ...fixtures.base, reactions: [fixtures.cleanReaction] },
    bots,
    "block",
    "block",
  );
  assert.equal(cleanReaction.phase, "terminal");
  assert.equal(cleanReaction.signal, "clean-reaction");

  const requestCommentClean = evaluateReviewState(
    { ...fixtures.base, issueComments: [fixtures.completedReviewRequestComment] },
    bots,
    "block",
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
    "block",
  );
  assert.equal(blocked.phase, "blocked");
  assert.equal(blocked.signal, "unresolved-threads");
  assert.equal(blocked.unresolvedThreads.length, 2);

  const blockedBeforeReview = evaluateReviewState(
    { ...fixtures.base, reviews: [fixtures.oldReview], threads: [fixtures.unresolvedThread] },
    bots,
    "block",
    "block",
  );
  assert.equal(blockedBeforeReview.phase, "blocked");
  assert.equal(blockedBeforeReview.signal, "unresolved-threads");
  assert.equal(blockedBeforeReview.unresolvedThreads.length, 1);

  const ignoredOutdated = evaluateReviewState(
    {
      ...fixtures.base,
      reviews: [fixtures.terminalReview],
      threads: [{ ...fixtures.unresolvedThread, isResolved: true }, fixtures.outdatedThread],
    },
    bots,
    "ignore",
    "block",
  );
  assert.equal(ignoredOutdated.phase, "terminal");
  assert.equal(ignoredOutdated.unresolvedThreads.length, 0);
});

test("stale-reviews ignore accepts terminal evidence for an older HEAD", () => {
  const staleReview = evaluateReviewState(
    { ...fixtures.base, reviews: [fixtures.oldReview] },
    bots,
    "block",
    "ignore",
  );
  assert.equal(staleReview.phase, "terminal");
  assert.equal(staleReview.signal, "review:commented");

  const staleReaction = evaluateReviewState(
    { ...fixtures.base, reactions: [fixtures.staleCleanReaction] },
    bots,
    "block",
    "ignore",
  );
  assert.equal(staleReaction.phase, "terminal");
  assert.equal(staleReaction.signal, "clean-reaction");

  const mismatchedClean = evaluateReviewState(
    { ...fixtures.base, issueComments: [fixtures.mismatchedCleanComment] },
    bots,
    "block",
    "ignore",
  );
  assert.equal(mismatchedClean.phase, "terminal");
  assert.equal(mismatchedClean.signal, "clean-comment");
});

test("blocked results expose whether the current HEAD already has terminal evidence", () => {
  const withTerminal = evaluateReviewState(
    { ...fixtures.base, reviews: [fixtures.terminalReview], threads: [fixtures.unresolvedThread] },
    bots,
    "block",
    "block",
  );
  assert.equal(withTerminal.phase, "blocked");
  assert.equal(withTerminal.currentHeadTerminal, true);

  const withoutTerminal = evaluateReviewState(
    { ...fixtures.base, reviews: [fixtures.oldReview], threads: [fixtures.unresolvedThread] },
    bots,
    "block",
    "block",
  );
  assert.equal(withoutTerminal.phase, "blocked");
  assert.equal(withoutTerminal.currentHeadTerminal, false);

  const staleTerminalAccepted = evaluateReviewState(
    { ...fixtures.base, reviews: [fixtures.oldReview], threads: [fixtures.unresolvedThread] },
    bots,
    "block",
    "ignore",
  );
  assert.equal(staleTerminalAccepted.phase, "blocked");
  assert.equal(staleTerminalAccepted.currentHeadTerminal, true);
});

test("blocked results expose current-HEAD liveness", () => {
  const reviewRunning = evaluateReviewState(
    { ...fixtures.base, reactions: [fixtures.eyes], threads: [fixtures.unresolvedThread] },
    bots,
    "block",
    "block",
  );
  assert.equal(reviewRunning.phase, "blocked");
  assert.equal(reviewRunning.currentHeadTerminal, false);
  assert.equal(reviewRunning.currentHeadLiveness, true);

  const noReview = evaluateReviewState(
    { ...fixtures.base, threads: [fixtures.unresolvedThread] },
    bots,
    "block",
    "block",
  );
  assert.equal(noReview.phase, "blocked");
  assert.equal(noReview.currentHeadLiveness, false);
});

test("currentHeadAttested tracks strict HEAD binding regardless of stale policy", () => {
  const attested = evaluateReviewState(
    { ...fixtures.base, reviews: [fixtures.terminalReview] },
    bots,
    "block",
    "block",
  );
  assert.equal(attested.phase, "terminal");
  assert.equal(attested.currentHeadAttested, true);

  const staleAccepted = evaluateReviewState(
    { ...fixtures.base, reviews: [fixtures.oldReview] },
    bots,
    "block",
    "ignore",
  );
  assert.equal(staleAccepted.phase, "terminal");
  assert.equal(staleAccepted.currentHeadTerminal, true);
  assert.equal(staleAccepted.currentHeadAttested, false);

  const staleBlocked = evaluateReviewState(
    { ...fixtures.base, reviews: [fixtures.oldReview], threads: [fixtures.unresolvedThread] },
    bots,
    "block",
    "ignore",
  );
  assert.equal(staleBlocked.phase, "blocked");
  assert.equal(staleBlocked.currentHeadTerminal, true);
  assert.equal(staleBlocked.currentHeadAttested, false);
});
