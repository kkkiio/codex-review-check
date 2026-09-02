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
  readFileSync(fileURLToPath(new URL("./fixtures/review-states.json", import.meta.url)), "utf8"),
) as Fixtures;
const bots = new Set(["chatgpt-codex-connector", "chatgpt-codex-connector[bot]"]);
const evaluate = (snapshot: ReviewSnapshot, passWithoutLgtm = false) =>
  evaluateReviewState(snapshot, bots, passWithoutLgtm);

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
  assert.equal(evaluate(fixtures.base).phase, "missing");
  assert.equal(evaluate({ ...fixtures.base, reactions: [fixtures.staleEyes] }).phase, "missing");
  assert.equal(
    evaluate({ ...fixtures.base, reactions: [fixtures.staleCleanReaction] }).phase,
    "missing",
  );

  const reviewing = evaluate({ ...fixtures.base, reactions: [fixtures.eyes] });
  assert.equal(reviewing.phase, "reviewing");
  assert.equal(reviewing.signal, "eyes");

  const progress = evaluate({ ...fixtures.base, issueComments: [fixtures.progressComment] });
  assert.equal(progress.phase, "reviewing");
  assert.equal(progress.signal, "progress-comment");

  const withFindings = evaluate({ ...fixtures.base, reviews: [fixtures.terminalReview] });
  assert.equal(withFindings.phase, "awaiting-lgtm");
  assert.equal(withFindings.signal, "review:commented");

  const approved = evaluate({
    ...fixtures.base,
    reviews: [{ ...fixtures.terminalReview, state: "APPROVED" }],
  });
  assert.equal(approved.phase, "awaiting-lgtm");
  assert.equal(approved.signal, "review:approved");

  const clean = evaluate({ ...fixtures.base, issueComments: [fixtures.cleanComment] });
  assert.equal(clean.phase, "terminal");
  assert.equal(clean.signal, "clean-comment");

  const cleanReaction = evaluate({ ...fixtures.base, reactions: [fixtures.cleanReaction] });
  assert.equal(cleanReaction.phase, "terminal");
  assert.equal(cleanReaction.signal, "clean-reaction");

  const requestCommentClean = evaluate({
    ...fixtures.base,
    issueComments: [fixtures.completedReviewRequestComment],
  });
  assert.equal(requestCommentClean.phase, "terminal");
  assert.equal(requestCommentClean.signal, "clean-reaction");

  const mismatchedClean = evaluate({
    ...fixtures.base,
    issueComments: [fixtures.mismatchedCleanComment],
  });
  assert.equal(mismatchedClean.phase, "missing");
});

test("lenient mode accepts stale terminal evidence of any supported kind", () => {
  const staleReview = evaluate({ ...fixtures.base, reviews: [fixtures.oldReview] }, true);
  assert.equal(staleReview.phase, "terminal");
  assert.equal(staleReview.signal, "review:commented");

  const staleComment = evaluate(
    { ...fixtures.base, issueComments: [fixtures.mismatchedCleanComment] },
    true,
  );
  assert.equal(staleComment.phase, "terminal");
  assert.equal(staleComment.signal, "clean-comment");

  const staleReaction = evaluate(
    { ...fixtures.base, reactions: [fixtures.staleCleanReaction] },
    true,
  );
  assert.equal(staleReaction.phase, "terminal");
  assert.equal(staleReaction.signal, "clean-reaction");

  const currentReview = evaluate({ ...fixtures.base, reviews: [fixtures.terminalReview] }, true);
  assert.equal(currentReview.phase, "terminal");
  assert.equal(currentReview.signal, "review:commented");
});

test("every unresolved Codex thread blocks, including outdated threads, in both modes", () => {
  for (const passWithoutLgtm of [false, true]) {
    const blocked = evaluate(
      {
        ...fixtures.base,
        issueComments: [fixtures.cleanComment],
        threads: [fixtures.outdatedThread],
      },
      passWithoutLgtm,
    );
    assert.equal(blocked.phase, "blocked");
    assert.equal(blocked.signal, "unresolved-threads");
    assert.equal(blocked.unresolvedThreads.length, 1);
  }
});

test("blocked results expose the configured terminal pass-condition", () => {
  const strictReview = evaluate(
    { ...fixtures.base, reviews: [fixtures.terminalReview], threads: [fixtures.unresolvedThread] },
    false,
  );
  assert.equal(strictReview.currentHeadTerminal, false);

  const strictLgtm = evaluate(
    { ...fixtures.base, issueComments: [fixtures.cleanComment], threads: [fixtures.unresolvedThread] },
    false,
  );
  assert.equal(strictLgtm.currentHeadTerminal, true);

  const lenientStaleReview = evaluate(
    { ...fixtures.base, reviews: [fixtures.oldReview], threads: [fixtures.unresolvedThread] },
    true,
  );
  assert.equal(lenientStaleReview.currentHeadTerminal, true);

  const lenientNoEvidence = evaluate(
    { ...fixtures.base, threads: [fixtures.unresolvedThread] },
    true,
  );
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
