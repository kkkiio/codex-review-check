import type {
  ReviewEvaluation,
  ReviewHintPolicy,
  ReviewSnapshot,
  ReviewThreadRecord,
} from "./types.js";

export type FailureReason = "unresolved-threads" | "review-missing" | "review-timeout";

/** True when the failure guidance includes a manual review request for the current HEAD. */
export function suggestsReviewRequest(
  reason: string,
  evaluation: ReviewEvaluation,
  reviewHint: ReviewHintPolicy,
): boolean {
  if (reviewHint !== "suggest") {
    return false;
  }
  if (reason === "review-missing") {
    return true;
  }
  return (
    reason === "unresolved-threads" &&
    !evaluation.currentHeadTerminal &&
    !evaluation.currentHeadLiveness
  );
}

export interface FailureOutput {
  /** Lines written to the job log via core.info before the failure annotation. */
  logLines: string[];
  /** Single-line failure annotation passed to core.setFailed; the primary agent-facing message. */
  annotation: string;
}

export function rerunCommand(runId: string | undefined): string {
  return runId
    ? `gh run rerun ${runId} --failed`
    : "Re-run the failed Codex Review job from GitHub Actions.";
}

export function reviewRequestCommand(pullRequest: number): string {
  return `gh pr comment ${pullRequest} --body '@codex review'`;
}

function threadLocation(thread: ReviewThreadRecord): string {
  return thread.line ? `${thread.path ?? "unknown"}:${thread.line}` : (thread.path ?? "unknown");
}

function threadUrl(thread: ReviewThreadRecord): string | undefined {
  return thread.comments.find((comment) => comment.url)?.url ?? undefined;
}

/**
 * Compose everything an agent can see when the check fails: job-log lines plus the
 * single-line failure annotation. The job summary never reaches CLI agents, so any
 * next-action guidance must live here.
 */
export function failureOutput(
  reason: FailureReason,
  snapshot: ReviewSnapshot,
  evaluation: ReviewEvaluation,
  runId: string | undefined,
  reviewHint: ReviewHintPolicy,
): FailureOutput {
  const rerun = rerunCommand(runId);
  if (reason === "unresolved-threads") {
    const logLines = evaluation.unresolvedThreads.map((thread) => {
      const suffix = thread.isOutdated ? " (outdated)" : "";
      return `Blocking Codex review thread: ${threadUrl(thread) ?? threadLocation(thread)}${suffix}`;
    });
    const count = `${evaluation.unresolvedThreads.length} unresolved Codex review thread(s) are blocking (listed above).`;
    if (evaluation.currentHeadTerminal) {
      return {
        logLines,
        annotation:
          `${count} Resolve each handled conversation, then re-run: ${rerun}. ` +
          "If you already resolved them after this run started, no further action is needed — just re-run.",
      };
    }
    if (evaluation.currentHeadLiveness) {
      return {
        logLines,
        annotation:
          `${count} A Codex review of the current HEAD is already in progress. ` +
          `Next steps: 1) resolve each handled conversation 2) ${rerun}. ` +
          "If you already resolved them after this run started, no further action is needed — just re-run.",
      };
    }
    if (reviewHint === "suggest") {
      return {
        logLines,
        annotation:
          `${count} The current HEAD has no Codex review yet. Next steps: ` +
          `1) resolve each handled conversation 2) ${reviewRequestCommand(snapshot.pullRequest)} 3) ${rerun}. ` +
          "If you already resolved the threads after this run started, start at step 2.",
      };
    }
    return {
      logLines,
      annotation:
        `${count} Next steps: 1) resolve each handled conversation 2) ${rerun}. ` +
        "Codex is expected to review each push automatically; if no review for the current HEAD arrives, check the connector configuration.",
    };
  }
  if (reason === "review-missing") {
    if (reviewHint === "suggest") {
      return {
        logLines: [],
        annotation:
          `No Codex review signal for current HEAD ${snapshot.headSha}. ` +
          `Run: ${reviewRequestCommand(snapshot.pullRequest)} — then re-run: ${rerun}`,
      };
    }
    return {
      logLines: [],
      annotation:
        `No Codex review signal for current HEAD ${snapshot.headSha}. ` +
        "This setup expects Codex to review each push automatically — verify the connector triggered for this HEAD, " +
        `then re-run: ${rerun}`,
    };
  }
  return {
    logLines: [],
    annotation:
      "Codex review did not produce a terminal current-HEAD signal before timeout. " +
      `Re-run after the review finishes: ${rerun}`,
  };
}

/** Render the job summary shown to humans in the GitHub Actions web UI. */
export function summaryMarkdown(
  snapshot: ReviewSnapshot,
  evaluation: ReviewEvaluation,
  state: "success" | "failure",
  reason: string,
  runId: string | undefined,
  reviewHint: ReviewHintPolicy,
): string {
  const rerun = rerunCommand(runId);
  const lines = [
    "# Codex Review",
    "",
    "| Pull request | HEAD | State | Signal |",
    "| --- | --- | --- | --- |",
    `| [${snapshot.repository}#${snapshot.pullRequest}](${snapshot.pullRequestUrl}) | \`${snapshot.headSha}\` | ${state} | ${evaluation.signal} |`,
    "",
  ];
  if (reason === "review-missing") {
    if (reviewHint === "suggest") {
      lines.push(
        "## Agent next action",
        "",
        "No Codex review signal was found for the current PR HEAD after the grace period.",
        "",
        "Request one explicitly; this Action will not spend Codex credits for you.",
        "",
        "```shell",
        reviewRequestCommand(snapshot.pullRequest),
        "```",
        "",
        "Then re-run the failed check:",
        "",
        "```shell",
        rerun,
        "```",
      );
    } else {
      lines.push(
        "## Review not observed",
        "",
        "No Codex review signal was found for the current PR HEAD after the grace period.",
        "",
        "This setup expects Codex to review each push automatically, so no manual review request is suggested. Verify the connector triggered for this HEAD, then re-run the failed check:",
        "",
        "```shell",
        rerun,
        "```",
      );
    }
  } else if (reason === "unresolved-threads") {
    lines.push(
      "## Blocking Codex review threads",
      "",
      "Resolve each handled GitHub review conversation, then re-run this check.",
      "",
    );
    for (const thread of evaluation.unresolvedThreads) {
      const url = threadUrl(thread);
      const location = threadLocation(thread);
      const suffix = thread.isOutdated ? " (outdated)" : "";
      lines.push(`- ${url ? `[${location}](${url})` : location}${suffix}`);
    }
    lines.push("");
    if (evaluation.currentHeadTerminal) {
      lines.push(
        "If these conversations are already resolved — for example, you resolved them after this run started — no further action is needed. This failure reflects the state observed during the run; re-run the failed job to re-evaluate the live state:",
        "",
        "```shell",
        rerun,
        "```",
      );
    } else if (evaluation.currentHeadLiveness) {
      lines.push(
        "A Codex review of the current HEAD is already in progress, so no new review request is needed. Resolve the conversations above, then re-run the failed job:",
        "",
        "```shell",
        rerun,
        "```",
        "",
        "If you already resolved the conversations after this run started, just re-run.",
      );
    } else if (reviewHint === "suggest") {
      lines.push(
        "The current HEAD also has no Codex review yet, so resolving alone is not enough. After resolving, request a fresh review:",
        "",
        "```shell",
        reviewRequestCommand(snapshot.pullRequest),
        "```",
        "",
        "Then re-run the failed check:",
        "",
        "```shell",
        rerun,
        "```",
        "",
        "If you already resolved the conversations after this run started, start with the review request.",
      );
    } else {
      lines.push(
        "Codex is expected to review each push automatically, so no manual review request is suggested. If these conversations are already resolved — for example, you resolved them after this run started — just re-run the failed job:",
        "",
        "```shell",
        rerun,
        "```",
      );
    }
  } else if (reason === "review-timeout") {
    lines.push(
      "## Review still in progress",
      "",
      "Codex liveness was observed, but no terminal current-HEAD result arrived before the configured timeout. Re-run the check after the review finishes.",
      "",
      "```shell",
      rerun,
      "```",
    );
  } else {
    lines.push("## Ready", "");
    if (evaluation.currentHeadAttested) {
      lines.push(
        "Codex produced a terminal signal for the current HEAD and no configured unresolved thread blocks.",
      );
    } else {
      lines.push(
        "Codex produced terminal evidence accepted under the configured stale-reviews policy, and no configured unresolved thread blocks. The evidence may attest an older HEAD rather than the current one.",
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
