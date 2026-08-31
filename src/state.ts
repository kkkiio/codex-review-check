import type {
  IssueCommentRecord,
  IssueCommentSignal,
  OutdatedPolicy,
  ReviewEvaluation,
  ReviewSnapshot,
} from "./types.js";

export function parseCodexIssueComment(comment: IssueCommentRecord): IssueCommentSignal {
  const body = comment.body.trim().replace(/\r\n?/g, "\n");
  const firstLine = body.split("\n", 1)[0] ?? "";
  const codexHeadingOffset = firstLine.indexOf("Codex Review");
  const headingPrefix = codexHeadingOffset >= 0 ? firstLine.slice(0, codexHeadingOffset) : "";
  const headingLooksOfficial =
    codexHeadingOffset >= 0 &&
    codexHeadingOffset <= 96 &&
    !/[A-Za-z0-9]/u.test(headingPrefix.replace(/^#{1,6}[ \t]+/u, ""));

  if (headingLooksOfficial) {
    const heading = firstLine.slice(codexHeadingOffset);
    const progressPattern =
      /^Codex Review[ \t]+(?:still[ \t]+)?in[ \t]+progress(?:\.|:[ \t]*[^\n]{1,160})?$/iu;
    if (body === firstLine && progressPattern.test(heading)) {
      return {
        kind: "liveness",
        name: "progress-comment",
        commitRef: null,
      };
    }
  }

  const cleanLead = "Codex Review: Didn't find any major issues.";
  const commitMarkers = [
    ...body.matchAll(/^\*\*Reviewed commit:\*\*[ \t]*`([0-9a-f]{10}|[0-9a-f]{40})`[ \t]*$/gim),
  ];
  if (
    headingLooksOfficial &&
    firstLine.slice(codexHeadingOffset).startsWith(cleanLead) &&
    commitMarkers.length === 1 &&
    commitMarkers[0]?.[1]
  ) {
    return {
      kind: "terminal",
      name: "clean-comment",
      commitRef: commitMarkers[0][1].toLowerCase(),
    };
  }

  return {
    kind: "none",
    name: "none",
    commitRef: null,
  };
}

export function evaluateReviewState(
  snapshot: ReviewSnapshot,
  botLogins: ReadonlySet<string>,
  outdatedPolicy: OutdatedPolicy,
): ReviewEvaluation {
  const normalizedBots = new Set(
    [...botLogins].map((login) => login.trim().toLowerCase().replace(/\[bot\]$/u, "")),
  );
  const currentHead = snapshot.headSha.toLowerCase();
  const headCommittedAt = snapshot.headCommittedAt
    ? Date.parse(snapshot.headCommittedAt)
    : Number.NEGATIVE_INFINITY;
  const observedReactions = [
    ...snapshot.reactions,
    ...snapshot.issueComments.flatMap((comment) => comment.reactions),
  ];

  const currentHeadReview = snapshot.reviews.find((review) => {
    const terminalStates = new Set(["COMMENTED", "APPROVED", "CHANGES_REQUESTED"]);
    return (
      normalizedBots.has(review.author.trim().toLowerCase().replace(/\[bot\]$/u, "")) &&
      terminalStates.has(review.state.toUpperCase()) &&
      review.commitId.toLowerCase() === currentHead
    );
  });
  const currentHeadCleanComment = snapshot.issueComments.find((comment) => {
    if (!normalizedBots.has(comment.author.trim().toLowerCase().replace(/\[bot\]$/u, ""))) {
      return false;
    }
    const signal = parseCodexIssueComment(comment);
    return (
      signal.kind === "terminal" &&
      (signal.commitRef === currentHead || currentHead.startsWith(signal.commitRef))
    );
  });
  const freshCleanReaction = observedReactions.find((reaction) => {
    if (
      !normalizedBots.has(reaction.author.trim().toLowerCase().replace(/\[bot\]$/u, "")) ||
      !new Set(["+1", "thumbs_up"]).has(reaction.content.toLowerCase())
    ) {
      return false;
    }
    const createdAt = reaction.createdAt ? Date.parse(reaction.createdAt) : Number.NEGATIVE_INFINITY;
    return createdAt >= headCommittedAt;
  });

  const unresolvedThreads = snapshot.threads.filter((thread) => {
    if (thread.isResolved || (outdatedPolicy === "ignore" && thread.isOutdated)) {
      return false;
    }
    return thread.comments.some((comment) =>
      normalizedBots.has(comment.author.trim().toLowerCase().replace(/\[bot\]$/u, "")),
    );
  });
  if (unresolvedThreads.length > 0) {
    return {
      phase: "blocked",
      signal: "unresolved-threads",
      unresolvedThreads,
    };
  }
  if (currentHeadReview || currentHeadCleanComment || freshCleanReaction) {
    return {
      phase: "terminal",
      signal: currentHeadReview
        ? `review:${currentHeadReview.state.toLowerCase()}`
        : currentHeadCleanComment
          ? "clean-comment"
          : "clean-reaction",
      unresolvedThreads,
    };
  }

  const progressComment = snapshot.issueComments.find((comment) => {
    if (
      !normalizedBots.has(comment.author.trim().toLowerCase().replace(/\[bot\]$/u, "")) ||
      parseCodexIssueComment(comment).kind !== "liveness"
    ) {
      return false;
    }
    const createdAt = comment.createdAt ? Date.parse(comment.createdAt) : Number.NEGATIVE_INFINITY;
    return createdAt >= headCommittedAt;
  });
  const eyesReaction = observedReactions.find((reaction) => {
    if (
      !normalizedBots.has(reaction.author.trim().toLowerCase().replace(/\[bot\]$/u, "")) ||
      reaction.content.toLowerCase() !== "eyes"
    ) {
      return false;
    }
    const createdAt = reaction.createdAt ? Date.parse(reaction.createdAt) : Number.NEGATIVE_INFINITY;
    return createdAt >= headCommittedAt;
  });
  if (progressComment || eyesReaction) {
    return {
      phase: "reviewing",
      signal: progressComment ? "progress-comment" : "eyes",
      unresolvedThreads,
    };
  }

  return {
    phase: "missing",
    signal: "none",
    unresolvedThreads,
  };
}
