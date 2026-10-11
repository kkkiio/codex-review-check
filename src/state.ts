import type {
  IssueCommentRecord,
  IssueCommentSignal,
  ReviewEvaluation,
  ReviewSnapshot,
  SummaryRow,
} from "./types.js";

const SUMMARY_MARKER = "<!-- codex-pull-request-review-summary -->";

export function parseCodexIssueComment(comment: IssueCommentRecord): IssueCommentSignal {
  const body = comment.body.trim().replace(/\r\n?/g, "\n");
  const firstLine = body.split("\n", 1)[0] ?? "";
  const codexHeadingOffset = firstLine.indexOf("Codex Review");
  const headingPrefix = codexHeadingOffset >= 0 ? firstLine.slice(0, codexHeadingOffset) : "";
  const headingLooksOfficial =
    codexHeadingOffset >= 0 &&
    codexHeadingOffset <= 96 &&
    !/[A-Za-z0-9]/u.test(headingPrefix.replace(/^#{1,6}[ \t]+/u, ""));

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

/**
 * Parses the connector's in-place "Codex Review Summary" comment. Returns null
 * when the comment lacks the summary marker. A row whose status is neither
 * Running nor Completed is reported as `unknown` so callers can fail closed.
 */
export function parseCodexReviewSummary(comment: IssueCommentRecord): SummaryRow[] | null {
  const lines = comment.body.replace(/\r\n?/g, "\n").split("\n");
  if (!lines.some((line) => line.trim() === SUMMARY_MARKER)) {
    return null;
  }
  const rows: SummaryRow[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) {
      continue;
    }
    const cells = trimmed
      .replace(/^\||\|$/gu, "")
      .split("|")
      .map((cell) => cell.trim());
    const label = cells[0] ?? "";
    const status = cells[1] ?? "";
    if (cells.length < 4 || label === "Review" || /^:?-+:?$/u.test(label)) {
      continue;
    }
    const statusWord = /\*\*(Running|Completed)\*\*/iu.exec(status)?.[1]?.toLowerCase();
    rows.push({
      review: label.replace(/\*\*/gu, "").replace(/^[^\p{L}\p{N}]+/u, "").trim(),
      status: statusWord === "running" || statusWord === "completed" ? statusWord : "unknown",
      at: /datetime="([^"]+)"/u.exec(status)?.[1] ?? null,
      commitRef: /`([0-9a-f]{7,40})`/iu.exec(cells[2] ?? "")?.[1]?.toLowerCase() ?? null,
      trigger: cells[3] ?? "",
    });
  }
  return rows;
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

  const botCleanReactions = snapshot.reactions.filter(
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

  // The summary keeps only the latest run per review kind, so a Code Review
  // row on the current HEAD that has not completed is an in-flight review.
  // Security Review rows are not gated on.
  const summary = latestByDate(
    snapshot.issueComments
      .filter((comment) => isBot(comment.author))
      .map((comment) => ({ comment, rows: parseCodexReviewSummary(comment) }))
      .filter((entry): entry is { comment: IssueCommentRecord; rows: SummaryRow[] } => entry.rows !== null),
    ({ comment }) => comment.createdAt,
  );
  const headCodeReviewRow = summary?.rows.find(
    (row) =>
      row.review.toLowerCase() === "code review" &&
      row.commitRef !== null &&
      currentHead.startsWith(row.commitRef),
  );
  const currentHeadLiveness =
    headCodeReviewRow !== undefined && headCodeReviewRow.status !== "completed";

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
      currentHeadTerminal: currentHeadTerminal && !currentHeadLiveness,
      currentHeadLiveness,
      terminalAt: null,
    };
  }
  // An in-flight review was paid for (auto-review on push, or an explicit
  // @codex review request), so its result must land before the gate opens.
  if (currentHeadLiveness) {
    return {
      phase: "reviewing",
      signal: `summary:${headCodeReviewRow?.status ?? "unknown"}`,
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
    return {
      phase: "terminal",
      signal: requireLgtm
        ? headCleanSignal
          ? "clean-comment"
          : "clean-reaction"
        : (lenientVerdict()?.name ?? "none"),
      // Track the newest completed artifact, not the pass evidence: in strict
      // mode a same-HEAD re-review can complete after the retained LGTM, and
      // its threads still need their own settle window.
      terminalAt: latestTerminalAt,
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
      terminalAt: latestTerminalAt,
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
