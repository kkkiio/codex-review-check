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
  followUpEyes: ReactionRecord;
  cleanReaction: ReactionRecord;
  staleCleanReaction: ReactionRecord;
  cleanComment: IssueCommentRecord;
  mismatchedCleanComment: IssueCommentRecord;
  progressComment: IssueCommentRecord;
  followUpProgressComment: IssueCommentRecord;
  reviewRequestComment: IssueCommentRecord;
  completedReviewRequestComment: IssueCommentRecord;
  terminalReview: ReviewRecord;
  oldReview: ReviewRecord;
  unresolvedThread: ReviewThreadRecord;
  outdatedThread: ReviewThreadRecord;
}

const fixtures = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/review-states.json", import.meta.url)), "utf8"),
) as Fixtures;
const bots = new Set(["chatgpt-codex-connector", "chatgpt-codex-connector[bot]"]);
const evaluate = (snapshot: ReviewSnapshot, requireLgtm = false) =>
  evaluateReviewState(snapshot, bots, requireLgtm);

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

test("strict mode requires a current-HEAD LGTM", () => {
  const strictEvaluate = (snapshot: ReviewSnapshot) => evaluate(snapshot, true);
  assert.equal(strictEvaluate(fixtures.base).phase, "missing");
  assert.equal(strictEvaluate({ ...fixtures.base, reactions: [fixtures.staleEyes] }).phase, "missing");
  assert.equal(
    strictEvaluate({ ...fixtures.base, reactions: [fixtures.staleCleanReaction] }).phase,
    "missing",
  );

  const reviewing = strictEvaluate({ ...fixtures.base, reactions: [fixtures.eyes] });
  assert.equal(reviewing.phase, "reviewing");
  assert.equal(reviewing.signal, "eyes");

  const progress = strictEvaluate({ ...fixtures.base, issueComments: [fixtures.progressComment] });
  assert.equal(progress.phase, "reviewing");
  assert.equal(progress.signal, "progress-comment");

  const withFindings = strictEvaluate({ ...fixtures.base, reviews: [fixtures.terminalReview] });
  assert.equal(withFindings.phase, "awaiting-lgtm");
  assert.equal(withFindings.signal, "review:commented");

  const approved = strictEvaluate({
    ...fixtures.base,
    reviews: [{ ...fixtures.terminalReview, state: "APPROVED" }],
  });
  assert.equal(approved.phase, "awaiting-lgtm");
  assert.equal(approved.signal, "review:approved");

  const clean = strictEvaluate({ ...fixtures.base, issueComments: [fixtures.cleanComment] });
  assert.equal(clean.phase, "terminal");
  assert.equal(clean.signal, "clean-comment");

  const cleanReaction = strictEvaluate({ ...fixtures.base, reactions: [fixtures.cleanReaction] });
  assert.equal(cleanReaction.phase, "terminal");
  assert.equal(cleanReaction.signal, "clean-reaction");

  const requestCommentClean = strictEvaluate({
    ...fixtures.base,
    issueComments: [fixtures.completedReviewRequestComment],
  });
  assert.equal(requestCommentClean.phase, "terminal");
  assert.equal(requestCommentClean.signal, "clean-reaction");

  const mismatchedClean = strictEvaluate({
    ...fixtures.base,
    issueComments: [fixtures.mismatchedCleanComment],
  });
  assert.equal(mismatchedClean.phase, "missing");
});

test("strict mode lets follow-up review liveness supersede a completed review", () => {
  const followUpEyes = evaluate(
    {
      ...fixtures.base,
      reviews: [fixtures.terminalReview],
      reactions: [fixtures.followUpEyes],
    },
    true,
  );
  assert.equal(followUpEyes.phase, "reviewing");
  assert.equal(followUpEyes.signal, "eyes");

  const followUpProgress = evaluate(
    {
      ...fixtures.base,
      reviews: [fixtures.terminalReview],
      issueComments: [fixtures.followUpProgressComment],
    },
    true,
  );
  assert.equal(followUpProgress.phase, "reviewing");
  assert.equal(followUpProgress.signal, "progress-comment");

  const leftoverEyes = evaluate(
    {
      ...fixtures.base,
      reviews: [fixtures.terminalReview],
      reactions: [fixtures.eyes],
    },
    true,
  );
  assert.equal(leftoverEyes.phase, "awaiting-lgtm");
  assert.equal(leftoverEyes.signal, "review:commented");
});

test("lenient mode accepts stale terminal evidence of any supported kind", () => {
  const staleReview = evaluate({ ...fixtures.base, reviews: [fixtures.oldReview] });
  assert.equal(staleReview.phase, "terminal");
  assert.equal(staleReview.signal, "review:commented");

  const staleComment = evaluate(
    { ...fixtures.base, issueComments: [fixtures.mismatchedCleanComment] },
  );
  assert.equal(staleComment.phase, "terminal");
  assert.equal(staleComment.signal, "clean-comment");

  const staleReaction = evaluate(
    { ...fixtures.base, reactions: [fixtures.staleCleanReaction] },
  );
  assert.equal(staleReaction.phase, "terminal");
  assert.equal(staleReaction.signal, "clean-reaction");

  const currentReview = evaluate({ ...fixtures.base, reviews: [fixtures.terminalReview] });
  assert.equal(currentReview.phase, "terminal");
  assert.equal(currentReview.signal, "review:commented");
});

test("lenient mode reports the freshest verdict across evidence kinds", () => {
  const lgtmAfterReview = evaluate({
    ...fixtures.base,
    reviews: [fixtures.terminalReview],
    reactions: [fixtures.cleanReaction],
  });
  assert.equal(lgtmAfterReview.phase, "terminal");
  assert.equal(lgtmAfterReview.signal, "clean-reaction");

  const reviewAfterCleanComment = evaluate({
    ...fixtures.base,
    reviews: [fixtures.terminalReview],
    issueComments: [fixtures.cleanComment],
  });
  assert.equal(reviewAfterCleanComment.phase, "terminal");
  assert.equal(reviewAfterCleanComment.signal, "review:commented");
});

test("lenient mode waits when a review started after the latest verdict", () => {
  const staleReviewPlusEyes = evaluate({
    ...fixtures.base,
    reviews: [fixtures.oldReview],
    reactions: [fixtures.eyes],
  });
  assert.equal(staleReviewPlusEyes.phase, "reviewing");
  assert.equal(staleReviewPlusEyes.signal, "eyes");

  const staleReviewPlusStaleEyes = evaluate({
    ...fixtures.base,
    reviews: [fixtures.oldReview],
    reactions: [fixtures.staleEyes],
  });
  assert.equal(staleReviewPlusStaleEyes.phase, "terminal");

  const currentReviewPlusLeftoverEyes = evaluate({
    ...fixtures.base,
    reviews: [fixtures.terminalReview],
    reactions: [fixtures.eyes],
  });
  assert.equal(currentReviewPlusLeftoverEyes.phase, "terminal");
  assert.equal(currentReviewPlusLeftoverEyes.signal, "review:commented");

  const currentReviewPlusNewEyes = evaluate({
    ...fixtures.base,
    reviews: [fixtures.terminalReview],
    reactions: [fixtures.followUpEyes],
  });
  assert.equal(currentReviewPlusNewEyes.phase, "reviewing");
  assert.equal(currentReviewPlusNewEyes.signal, "eyes");
});

test("every unresolved Codex thread blocks, including outdated threads, in both modes", () => {
  for (const requireLgtm of [false, true]) {
    const blocked = evaluate(
      {
        ...fixtures.base,
        issueComments: [fixtures.cleanComment],
        threads: [fixtures.outdatedThread],
      },
      requireLgtm,
    );
    assert.equal(blocked.phase, "blocked");
    assert.equal(blocked.signal, "unresolved-threads");
    assert.equal(blocked.unresolvedThreads.length, 1);
  }
});

test("blocked results expose the configured terminal pass-condition", () => {
  const strictReview = evaluate(
    { ...fixtures.base, reviews: [fixtures.terminalReview], threads: [fixtures.unresolvedThread] },
    true,
  );
  assert.equal(strictReview.currentHeadTerminal, false);

  const strictLgtm = evaluate(
    { ...fixtures.base, issueComments: [fixtures.cleanComment], threads: [fixtures.unresolvedThread] },
    true,
  );
  assert.equal(strictLgtm.currentHeadTerminal, true);

  const lenientStaleReview = evaluate(
    { ...fixtures.base, reviews: [fixtures.oldReview], threads: [fixtures.unresolvedThread] },
  );
  assert.equal(lenientStaleReview.currentHeadTerminal, true);

  const lenientNoEvidence = evaluate({ ...fixtures.base, threads: [fixtures.unresolvedThread] });
  assert.equal(lenientNoEvidence.currentHeadTerminal, false);
});

test("blocked results preserve current-HEAD liveness", () => {
  const reviewRunning = evaluate({
    ...fixtures.base,
    reactions: [fixtures.eyes],
    threads: [fixtures.unresolvedThread],
  });
  assert.equal(reviewRunning.phase, "blocked");
  assert.equal(reviewRunning.currentHeadLiveness, true);

  const noReview = evaluate({ ...fixtures.base, threads: [fixtures.unresolvedThread] });
  assert.equal(noReview.phase, "blocked");
  assert.equal(noReview.currentHeadLiveness, false);
});
