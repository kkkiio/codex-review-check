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
  requireLgtm: boolean,
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
  const terminalReview = requireLgtm
    ? headTerminalReview
    : latestByDate(botTerminalReviews, (review) => review.submittedAt);

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
  const cleanSignal = requireLgtm
    ? headCleanSignal
    : latestByDate(botCleanSignals, ({ comment }) => comment.createdAt);

  const botCleanReactions = observedReactions.filter(
    (reaction) =>
      isBot(reaction.author) && new Set(["+1", "thumbs_up"]).has(reaction.content.toLowerCase()),
  );
  const isFresh = (record: { createdAt: string | null }) =>
    (record.createdAt ? Date.parse(record.createdAt) : Number.NEGATIVE_INFINITY) >= headCommittedAt;
  const headCleanReaction = latestByDate(botCleanReactions.filter(isFresh), (reaction) => reaction.createdAt);
  const cleanReaction = requireLgtm
    ? headCleanReaction
    : latestByDate(botCleanReactions, (reaction) => reaction.createdAt);

  const currentHeadTerminal = requireLgtm
    ? Boolean(headCleanSignal ?? headCleanReaction)
    : Boolean(terminalReview ?? cleanSignal ?? cleanReaction);

  const progressComment = latestByDate(
    snapshot.issueComments.filter((comment) => {
      if (!isBot(comment.author) || parseCodexIssueComment(comment).kind !== "liveness") {
        return false;
      }
      return isFresh(comment);
    }),
    (comment) => comment.createdAt,
  );
  const eyesReaction = latestByDate(
    observedReactions.filter((reaction) => {
      if (!isBot(reaction.author) || reaction.content.toLowerCase() !== "eyes") {
        return false;
      }
      return isFresh(reaction);
    }),
    (reaction) => reaction.createdAt,
  );
  const currentHeadLiveness = Boolean(progressComment ?? eyesReaction);

  // A review that started after the latest completed verdict keeps the job
  // waiting: it was paid for (auto-review on push, or an explicit @codex
  // review request), so its result must land before the gate opens. Liveness
  // predating the latest verdict is a leftover of that completed review.
  const latestTerminalAt = Math.max(
    Number.NEGATIVE_INFINITY,
    ...botTerminalReviews.map((review) =>
      review.submittedAt ? Date.parse(review.submittedAt) : Number.NEGATIVE_INFINITY,
    ),
    ...botCleanSignals.map(({ comment }) =>
      comment.createdAt ? Date.parse(comment.createdAt) : Number.NEGATIVE_INFINITY,
    ),
    ...botCleanReactions.map((reaction) =>
      reaction.createdAt ? Date.parse(reaction.createdAt) : Number.NEGATIVE_INFINITY,
    ),
  );
  const newReviewStarted = [progressComment, eyesReaction].some((record) => {
    const createdAt = record?.createdAt;
    return createdAt != null && Date.parse(createdAt) > latestTerminalAt;
  });

  const unresolvedThreads = snapshot.threads.filter(
    (thread) =>
      !thread.isResolved && thread.comments.some((comment) => isBot(comment.author)),
  );
  if (unresolvedThreads.length > 0) {
    return {
      phase: "blocked",
      signal: "unresolved-threads",
      unresolvedThreads,
      // A newer in-flight review may add findings, so resolving alone is not
      // known to be sufficient yet.
      currentHeadTerminal: currentHeadTerminal && !newReviewStarted,
      currentHeadLiveness,
      terminalAt: null,
    };
  }
  if (newReviewStarted) {
    const latestLiveness = latestByDate(
      [progressComment, eyesReaction].filter((record) => record != null),
      (record) => record.createdAt,
    );
    return {
      phase: "reviewing",
      signal: latestLiveness === progressComment ? "progress-comment" : "eyes",
      unresolvedThreads,
      currentHeadTerminal: false,
      currentHeadLiveness: true,
      terminalAt: null,
    };
  }

  // Lenient mode: report the freshest verdict across evidence kinds — a 👍
  // landing after a findings review means the latest word is an LGTM, not the
  // review. Ties prefer the later candidate, so clean evidence beats a review.
  const lenientVerdict = (): { name: string; time: number } | undefined => {
    const candidates: { name: string; time: number }[] = [];
    if (terminalReview) {
      candidates.push({
        name: `review:${terminalReview.state.toLowerCase()}`,
        time: terminalReview.submittedAt ? Date.parse(terminalReview.submittedAt) : 0,
      });
    }
    if (cleanSignal) {
      candidates.push({
        name: "clean-comment",
        time: cleanSignal.comment.createdAt ? Date.parse(cleanSignal.comment.createdAt) : 0,
      });
    }
    if (cleanReaction) {
      candidates.push({
        name: "clean-reaction",
        time: cleanReaction.createdAt ? Date.parse(cleanReaction.createdAt) : 0,
      });
    }
    let best = candidates[0];
    for (const candidate of candidates) {
      if (best === undefined || candidate.time >= best.time) best = candidate;
    }
    return best;
  };

  if (currentHeadTerminal) {
    const verdict = requireLgtm
      ? headCleanSignal
        ? {
            name: "clean-comment",
            time: headCleanSignal.comment.createdAt ? Date.parse(headCleanSignal.comment.createdAt) : 0,
          }
        : {
            name: "clean-reaction",
            time: headCleanReaction?.createdAt ? Date.parse(headCleanReaction.createdAt) : 0,
          }
      : lenientVerdict();
    return {
      phase: "terminal",
      signal: verdict?.name ?? "none",
      terminalAt: verdict?.time ?? null,
      unresolvedThreads,
      currentHeadTerminal: true,
      currentHeadLiveness,
    };
  }
  if (requireLgtm && headTerminalReview) {
    return {
      phase: "awaiting-lgtm",
      signal: `review:${headTerminalReview.state.toLowerCase()}`,
      unresolvedThreads,
      currentHeadTerminal: false,
      currentHeadLiveness,
      terminalAt: null,
    };
  }

  return {
    phase: "missing",
    signal: "none",
    unresolvedThreads,
    currentHeadTerminal: false,
    currentHeadLiveness: false,
    terminalAt: null,
  };
}
