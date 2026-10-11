import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateReviewState, parseCodexIssueComment, parseCodexReviewSummary } from "../src/state.js";
import type {
  IssueCommentRecord,
  ReactionRecord,
  ReviewRecord,
  ReviewSnapshot,
  ReviewThreadRecord,
} from "../src/types.js";

interface Fixtures {
  base: ReviewSnapshot;
  cleanReaction: ReactionRecord;
  staleCleanReaction: ReactionRecord;
  cleanComment: IssueCommentRecord;
  mismatchedCleanComment: IssueCommentRecord;
  summaryRunning: IssueCommentRecord;
  summaryCompleted: IssueCommentRecord;
  summaryFollowUpRunning: IssueCommentRecord;
  summaryOldCommitRunning: IssueCommentRecord;
  summarySecurityRunning: IssueCommentRecord;
  summaryUnknownStatus: IssueCommentRecord;
  reviewRequest: IssueCommentRecord;
  securityReviewRequest: IssueCommentRecord;
  errorComment: IssueCommentRecord;
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

test("Codex issue comments expose only the supported clean signal", () => {
  const clean = parseCodexIssueComment(fixtures.cleanComment);
  assert.equal(clean.kind, "terminal");
  assert.equal(clean.name, "clean-comment");
  assert.equal(clean.commitRef, "aaaaaaaaaa");

  const legacyProgress = parseCodexIssueComment({
    ...fixtures.cleanComment,
    body: "👀 Codex Review still in progress: analyzing tests",
  });
  assert.equal(legacyProgress.kind, "none");

  const summary = parseCodexIssueComment(fixtures.summaryCompleted);
  assert.equal(summary.kind, "none");

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

test("the review summary comment parses into one row per review kind", () => {
  assert.deepEqual(parseCodexReviewSummary(fixtures.summarySecurityRunning), [
    {
      review: "Code Review",
      status: "completed",
      at: "2026-08-31T10:02:04.123456Z",
      commitRef: "aaaaaaa",
      trigger: "PR opened",
    },
    {
      review: "Security Review",
      status: "running",
      at: "2026-08-31T10:02:30.123456Z",
      commitRef: "aaaaaaa",
      trigger: "PR opened",
    },
  ]);
  assert.equal(parseCodexReviewSummary(fixtures.summaryUnknownStatus)?.[0]?.status, "unknown");
  assert.equal(parseCodexReviewSummary(fixtures.cleanComment), null);
  assert.equal(
    parseCodexReviewSummary({
      ...fixtures.summaryRunning,
      body: fixtures.summaryRunning.body.replace("<!-- codex-pull-request-review-summary -->", ""),
    }),
    null,
  );
});

test("strict mode requires a current-HEAD LGTM", () => {
  const strictEvaluate = (snapshot: ReviewSnapshot) => evaluate(snapshot, true);
  assert.equal(strictEvaluate(fixtures.base).phase, "missing");
  assert.equal(
    strictEvaluate({ ...fixtures.base, issueComments: [fixtures.summaryOldCommitRunning] }).phase,
    "missing",
  );
  assert.equal(
    strictEvaluate({ ...fixtures.base, reactions: [fixtures.staleCleanReaction] }).phase,
    "missing",
  );

  const reviewing = strictEvaluate({ ...fixtures.base, issueComments: [fixtures.summaryRunning] });
  assert.equal(reviewing.phase, "reviewing");
  assert.equal(reviewing.signal, "summary:running");

  const completedRowOnly = strictEvaluate({
    ...fixtures.base,
    issueComments: [fixtures.summaryCompleted],
  });
  assert.equal(completedRowOnly.phase, "missing");

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

  const mismatchedClean = strictEvaluate({
    ...fixtures.base,
    issueComments: [fixtures.mismatchedCleanComment],
  });
  assert.equal(mismatchedClean.phase, "missing");
});

test("strict mode waits for a follow-up review of an already reviewed HEAD", () => {
  const followUp = evaluate(
    {
      ...fixtures.base,
      reviews: [fixtures.terminalReview],
      issueComments: [fixtures.summaryFollowUpRunning],
    },
    true,
  );
  assert.equal(followUp.phase, "reviewing");
  assert.equal(followUp.signal, "summary:running");

  const completed = evaluate(
    {
      ...fixtures.base,
      reviews: [fixtures.terminalReview],
      issueComments: [fixtures.summaryCompleted],
    },
    true,
  );
  assert.equal(completed.phase, "awaiting-lgtm");
  assert.equal(completed.signal, "review:commented");
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

test("lenient mode waits while the current-HEAD Code Review row is running", () => {
  const staleReviewPlusRunning = evaluate({
    ...fixtures.base,
    reviews: [fixtures.oldReview],
    issueComments: [fixtures.summaryRunning],
  });
  assert.equal(staleReviewPlusRunning.phase, "reviewing");
  assert.equal(staleReviewPlusRunning.signal, "summary:running");

  const staleReviewPlusOldCommitRow = evaluate({
    ...fixtures.base,
    reviews: [fixtures.oldReview],
    issueComments: [fixtures.summaryOldCommitRunning],
  });
  assert.equal(staleReviewPlusOldCommitRow.phase, "terminal");

  const currentReviewPlusCompletedRow = evaluate({
    ...fixtures.base,
    reviews: [fixtures.terminalReview],
    issueComments: [fixtures.summaryCompleted],
  });
  assert.equal(currentReviewPlusCompletedRow.phase, "terminal");
  assert.equal(currentReviewPlusCompletedRow.signal, "review:commented");

  const currentReviewPlusFollowUp = evaluate({
    ...fixtures.base,
    reviews: [fixtures.terminalReview],
    issueComments: [fixtures.summaryFollowUpRunning],
  });
  assert.equal(currentReviewPlusFollowUp.phase, "reviewing");
});

test("only the Code Review row gates; an unknown status fails closed", () => {
  const securityRunning = evaluate({
    ...fixtures.base,
    reviews: [fixtures.terminalReview],
    issueComments: [fixtures.summarySecurityRunning],
  });
  assert.equal(securityRunning.phase, "terminal");
  assert.equal(securityRunning.currentHeadLiveness, false);

  const unknownStatus = evaluate({
    ...fixtures.base,
    reviews: [fixtures.terminalReview],
    issueComments: [fixtures.summaryUnknownStatus],
  });
  assert.equal(unknownStatus.phase, "reviewing");
  assert.equal(unknownStatus.signal, "summary:unknown");
});

test("terminal results expose the selected artifact timestamp", () => {
  const reviewOnly = evaluate({ ...fixtures.base, reviews: [fixtures.terminalReview] });
  assert.equal(reviewOnly.terminalAt, Date.parse("2026-08-31T10:02:00Z"));

  const lgtmLater = evaluate({
    ...fixtures.base,
    reviews: [fixtures.terminalReview],
    reactions: [fixtures.cleanReaction],
  });
  assert.equal(lgtmLater.terminalAt, Date.parse("2026-08-31T10:03:00Z"));

  const notTerminal = evaluate(fixtures.base);
  assert.equal(notTerminal.terminalAt, null);

  const strictRetainedLgtm = evaluate(
    {
      ...fixtures.base,
      reviews: [fixtures.terminalReview],
      issueComments: [fixtures.cleanComment],
    },
    true,
  );
  assert.equal(strictRetainedLgtm.phase, "terminal");
  assert.equal(strictRetainedLgtm.signal, "clean-comment");
  assert.equal(strictRetainedLgtm.terminalAt, Date.parse("2026-08-31T10:02:00Z"));

  const awaitingLgtm = evaluate({ ...fixtures.base, reviews: [fixtures.terminalReview] }, true);
  assert.equal(awaitingLgtm.phase, "awaiting-lgtm");
  assert.equal(awaitingLgtm.terminalAt, Date.parse("2026-08-31T10:02:00Z"));
});

test("blocked results discount terminal evidence when a newer review is running", () => {
  const blocked = evaluate({
    ...fixtures.base,
    reviews: [fixtures.terminalReview],
    issueComments: [fixtures.summaryFollowUpRunning],
    threads: [fixtures.unresolvedThread],
  });
  assert.equal(blocked.phase, "blocked");
  assert.equal(blocked.currentHeadTerminal, false);
  assert.equal(blocked.currentHeadLiveness, true);
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
    issueComments: [fixtures.summaryRunning],
    threads: [fixtures.unresolvedThread],
  });
  assert.equal(reviewRunning.phase, "blocked");
  assert.equal(reviewRunning.currentHeadLiveness, true);

  const noReview = evaluate({ ...fixtures.base, threads: [fixtures.unresolvedThread] });
  assert.equal(noReview.phase, "blocked");
  assert.equal(noReview.currentHeadLiveness, false);
});

test("a review request waits until Codex shows any activity after it", () => {
  const pending = evaluate({
    ...fixtures.base,
    reviews: [fixtures.oldReview],
    issueComments: [fixtures.summaryCompleted, fixtures.reviewRequest],
  });
  assert.equal(pending.phase, "reviewing");
  assert.equal(pending.signal, "review-requested");
  assert.equal(pending.currentHeadLiveness, true);

  const strictPending = evaluate(
    {
      ...fixtures.base,
      reactions: [fixtures.cleanReaction],
      issueComments: [fixtures.reviewRequest],
    },
    true,
  );
  assert.equal(strictPending.phase, "reviewing");

  const pickedUp = evaluate({
    ...fixtures.base,
    reviews: [fixtures.terminalReview],
    issueComments: [fixtures.summaryCompleted, { ...fixtures.reviewRequest, createdAt: "2026-08-31T10:01:30Z" }],
  });
  assert.equal(pickedUp.phase, "terminal");

  const errored = evaluate({
    ...fixtures.base,
    reviews: [fixtures.oldReview],
    issueComments: [fixtures.reviewRequest, fixtures.errorComment],
  });
  assert.equal(errored.phase, "terminal");
  assert.equal(errored.signal, "review:commented");
});

test("security review requests and connector text do not count as review requests", () => {
  for (const comment of [
    fixtures.securityReviewRequest,
    { ...fixtures.reviewRequest, author: "chatgpt-codex-connector[bot]" },
  ]) {
    const evaluation = evaluate({
      ...fixtures.base,
      reviews: [fixtures.oldReview],
      issueComments: [comment],
    });
    assert.equal(evaluation.phase, "terminal");
    assert.equal(evaluation.currentHeadLiveness, false);
  }
});
