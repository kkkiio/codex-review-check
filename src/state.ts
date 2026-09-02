import type {
  IssueCommentRecord,
  IssueCommentSignal,
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
  passWithoutLgtm: boolean,
): ReviewEvaluation {
  const normalizedBots = new Set(
    [...botLogins].map((login) => login.trim().toLowerCase().replace(/\[bot\]$/u, "")),
  );
  const isBot = (author: string) =>
    normalizedBots.has(author.trim().toLowerCase().replace(/\[bot\]$/u, ""));
  const currentHead = snapshot.headSha.toLowerCase();
  const headCommittedAt = snapshot.headCommittedAt
    ? Date.parse(snapshot.headCommittedAt)
    : Number.NEGATIVE_INFINITY;
  const observedReactions = [
    ...snapshot.reactions,
    ...snapshot.issueComments.flatMap((comment) => comment.reactions),
  ];
  const terminalStates = new Set(["COMMENTED", "APPROVED", "CHANGES_REQUESTED"]);
  const botTerminalReviews = snapshot.reviews.filter(
    (review) => isBot(review.author) && terminalStates.has(review.state.toUpperCase()),
  );
  const latestByDate = <T>(records: T[], getDate: (record: T) => string | null): T | undefined => {
    let latest: T | undefined;
    let latestTime = Number.NEGATIVE_INFINITY;
    for (const record of records) {
      const time = getDate(record) ? Date.parse(getDate(record) as string) : Number.NEGATIVE_INFINITY;
      if (latest === undefined || time >= latestTime) {
        latest = record;
        latestTime = time;
      }
    }
    return latest;
  };
  const headTerminalReview = latestByDate(
    botTerminalReviews.filter((review) => review.commitId.toLowerCase() === currentHead),
    (review) => review.submittedAt,
  );
  const terminalReview = passWithoutLgtm
    ? latestByDate(botTerminalReviews, (review) => review.submittedAt)
    : headTerminalReview;

  const botCleanSignals = snapshot.issueComments
    .filter((comment) => isBot(comment.author))
    .map((comment) => ({ comment, signal: parseCodexIssueComment(comment) }))
    .filter(
      (entry): entry is {
        comment: IssueCommentRecord;
        signal: Extract<IssueCommentSignal, { kind: "terminal" }>;
      } => entry.signal.kind === "terminal",
    );
  const headCleanSignal = latestByDate(
    botCleanSignals.filter(
      ({ signal }) => signal.commitRef === currentHead || currentHead.startsWith(signal.commitRef),
    ),
    ({ comment }) => comment.createdAt,
  );
  const cleanSignal = passWithoutLgtm
    ? latestByDate(botCleanSignals, ({ comment }) => comment.createdAt)
    : headCleanSignal;

  const botCleanReactions = observedReactions.filter(
    (reaction) =>
      isBot(reaction.author) && new Set(["+1", "thumbs_up"]).has(reaction.content.toLowerCase()),
  );
  const isFresh = (record: { createdAt: string | null }) =>
    (record.createdAt ? Date.parse(record.createdAt) : Number.NEGATIVE_INFINITY) >= headCommittedAt;
  const headCleanReaction = latestByDate(botCleanReactions.filter(isFresh), (reaction) => reaction.createdAt);
  const cleanReaction = passWithoutLgtm
    ? latestByDate(botCleanReactions, (reaction) => reaction.createdAt)
    : headCleanReaction;

  const currentHeadTerminal = passWithoutLgtm
    ? Boolean(terminalReview ?? cleanSignal ?? cleanReaction)
    : Boolean(headCleanSignal ?? headCleanReaction);

  const progressComment = snapshot.issueComments.find((comment) => {
    if (!isBot(comment.author) || parseCodexIssueComment(comment).kind !== "liveness") {
      return false;
    }
    return isFresh(comment);
  });
  const eyesReaction = observedReactions.find((reaction) => {
    if (!isBot(reaction.author) || reaction.content.toLowerCase() !== "eyes") {
      return false;
    }
    return isFresh(reaction);
  });
  const currentHeadLiveness = Boolean(progressComment ?? eyesReaction);

  const unresolvedThreads = snapshot.threads.filter(
    (thread) =>
      !thread.isResolved && thread.comments.some((comment) => isBot(comment.author)),
  );
  if (unresolvedThreads.length > 0) {
    return {
      phase: "blocked",
      signal: "unresolved-threads",
      unresolvedThreads,
      currentHeadTerminal,
      currentHeadLiveness,
    };
  }
  if (currentHeadTerminal) {
    return {
      phase: "terminal",
      signal: passWithoutLgtm
        ? terminalReview
          ? `review:${terminalReview.state.toLowerCase()}`
          : cleanSignal
            ? "clean-comment"
            : "clean-reaction"
        : headCleanSignal
          ? "clean-comment"
          : "clean-reaction",
      unresolvedThreads,
      currentHeadTerminal: true,
      currentHeadLiveness,
    };
  }
  if (!passWithoutLgtm && headTerminalReview) {
    return {
      phase: "awaiting-lgtm",
      signal: `review:${headTerminalReview.state.toLowerCase()}`,
      unresolvedThreads,
      currentHeadTerminal: false,
      currentHeadLiveness,
    };
  }

  if (progressComment || eyesReaction) {
    return {
      phase: "reviewing",
      signal: progressComment ? "progress-comment" : "eyes",
      unresolvedThreads,
      currentHeadTerminal: false,
      currentHeadLiveness: true,
    };
  }

  return {
    phase: "missing",
    signal: "none",
    unresolvedThreads,
    currentHeadTerminal: false,
    currentHeadLiveness: false,
  };
}
