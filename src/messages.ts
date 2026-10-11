import type {
  ReviewEvaluation,
  ReviewHintPolicy,
  ReviewSnapshot,
  ReviewThreadRecord,
} from "./types.js";

export type FailureReason =
  | "unresolved-threads"
  | "review-missing"
  | "review-timeout"
  | "lgtm-missing";

/** True when the failure guidance includes a manual review request for the current HEAD. */
export function suggestsReviewRequest(
  reason: string,
  evaluation: ReviewEvaluation,
  reviewHint: ReviewHintPolicy,
): boolean {
  if (reviewHint !== "suggest") {
    return false;
  }
  if (reason === "review-missing" || reason === "lgtm-missing") {
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

/** Run-level settings that shape the next-action guidance. */
export interface MessageOptions {
  runId: string | undefined;
  reviewHint: ReviewHintPolicy;
  requireLgtm: boolean;
  reviewTimeoutSeconds: number;
}

export function reviewRequestCommand(pullRequest: number): string {
  return `gh pr comment ${pullRequest} --body '@codex review'`;
}

/**
 * The next-action commands in run order: an optional review request, the rerun, and
 * the check watch. The rerun is the step that waits for Codex, so the commands are
 * chained rather than separated by an external wait.
 */
export function nextStepCommands(
  pullRequest: number,
  runId: string | undefined,
  requestReview: boolean,
): string[] {
  return [
    ...(requestReview ? [reviewRequestCommand(pullRequest)] : []),
    runId ? `gh run rerun ${runId} --failed` : "re-run the failed Codex Review job from GitHub Actions",
    `gh pr checks ${pullRequest} --watch`,
  ];
}

/** Explain that the rerun owns the wait, with the configured timeout. */
export function rerunWaitGuidance(reviewTimeoutSeconds: number): string {
  const timeout =
    reviewTimeoutSeconds >= 60 && reviewTimeoutSeconds % 60 === 0
      ? `${reviewTimeoutSeconds / 60} min`
      : `${reviewTimeoutSeconds}s`;
  return (
    `The re-run check itself waits up to ${timeout} for the Codex review to finish, then passes or reports the next action. ` +
    "Start it right away and wait on the check; read Codex reviews or comments directly only if the check result looks wrong."
  );
}

function threadLocation(thread: ReviewThreadRecord): string {
  return thread.line ? `${thread.path ?? "unknown"}:${thread.line}` : (thread.path ?? "unknown");
}

function threadUrl(thread: ReviewThreadRecord): string | undefined {
  return thread.comments.find((comment) => comment.url)?.url ?? undefined;
}

const auditTrailGuidance =
  "Resolve each thread: fix the finding, or reply with your reasoning on the thread, then resolve. Silent resolves are not auditable.";

/**
 * Compose everything an agent can see when the check fails: job-log lines plus the
 * single-line failure annotation. The job summary never reaches CLI agents, so any
 * next-action guidance must live here.
 */
export function failureOutput(
  reason: FailureReason,
  snapshot: ReviewSnapshot,
  evaluation: ReviewEvaluation,
  options: MessageOptions,
): FailureOutput {
  const requestReview = suggestsReviewRequest(reason, evaluation, options.reviewHint);
  const steps =
    "run these back to back, without waiting in between: " +
    `${nextStepCommands(snapshot.pullRequest, options.runId, requestReview).join(" && ")}. ` +
    rerunWaitGuidance(options.reviewTimeoutSeconds);
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
          `${count} ${auditTrailGuidance} Then ${steps} ` +
          "If you already resolved them after this run started, skip straight to these commands.",
      };
    }
    if (evaluation.currentHeadLiveness) {
      return {
        logLines,
        annotation:
          `${count} A Codex review of the current HEAD is already in progress. ${auditTrailGuidance} ` +
          `Then ${steps} If you already resolved them after this run started, skip straight to these commands.`,
      };
    }
    if (requestReview) {
      return {
        logLines,
        annotation:
          `${count} Codex has not reviewed the current HEAD yet. ${auditTrailGuidance} Then ${steps} ` +
          "If you already resolved the threads after this run started, skip straight to these commands.",
      };
    }
    return {
      logLines,
      annotation:
        `${count} ${auditTrailGuidance} Then ${steps} ` +
        "Codex is expected to review each push automatically; if no review for the current HEAD arrives, check the connector configuration.",
    };
  }
  if (reason === "review-missing") {
    if (requestReview) {
      return {
        logLines: [],
        annotation: `No Codex review signal for current HEAD ${snapshot.headSha}. Request one and ${steps}`,
      };
    }
    return {
      logLines: [],
      annotation:
        `No Codex review signal for current HEAD ${snapshot.headSha}. ` +
        `This setup expects Codex to review each push automatically — verify the connector triggered for this HEAD, then ${steps}`,
    };
  }
  if (reason === "lgtm-missing") {
    const message =
      `Codex reviewed the current HEAD ${snapshot.headSha} but left no LGTM (a 👍 reaction or a 'Didn't find any major issues' comment).`;
    if (requestReview) {
      return {
        logLines: [message],
        annotation:
          `${message} After handling its threads, request a fresh review and ${steps} ` +
          "Or drop require-lgtm to accept a completed review without an LGTM.",
      };
    }
    return {
      logLines: [message],
      annotation:
        `${message} Verify the connector triggered a fresh review after handling its threads, then ${steps} ` +
        "Or drop require-lgtm to accept a completed review without an LGTM.",
    };
  }
  return {
    logLines: [],
    annotation:
      `A Codex review of current HEAD ${snapshot.headSha} started but produced no terminal signal before the timeout. ` +
      `To keep waiting, ${steps}`,
  };
}

/** Render the job summary shown to humans in the GitHub Actions web UI. */
export function summaryMarkdown(
  snapshot: ReviewSnapshot,
  evaluation: ReviewEvaluation,
  state: "success" | "failure",
  reason: string,
  options: MessageOptions,
): string {
  const lines = [
    "# Codex Review",
    "",
    "| Pull request | HEAD | State | Signal |",
    "| --- | --- | --- | --- |",
    `| [${snapshot.repository}#${snapshot.pullRequest}](${snapshot.pullRequestUrl}) | \`${snapshot.headSha}\` | ${state} | ${evaluation.signal} |`,
    "",
  ];
  const requestReview = suggestsReviewRequest(reason, evaluation, options.reviewHint);
  if (reason === "review-missing") {
    if (requestReview) {
      lines.push(
        "## Agent next action",
        "",
        "No Codex review signal was found for the current PR HEAD after the grace period.",
        "",
        "Request one explicitly; this Action will not spend Codex credits for you. Run these back to back, without waiting in between:",
      );
    } else {
      lines.push(
        "## Review not observed",
        "",
        "No Codex review signal was found for the current PR HEAD after the grace period.",
        "",
        "This setup expects Codex to review each push automatically, so no manual review request is suggested. Verify the connector triggered for this HEAD, then run:",
      );
    }
  } else if (reason === "unresolved-threads") {
    lines.push(
      "## Blocking Codex review threads",
      "",
      auditTrailGuidance,
      "",
    );
    for (const thread of evaluation.unresolvedThreads) {
      const url = threadUrl(thread);
      const location = threadLocation(thread);
      const suffix = thread.isOutdated ? " (outdated)" : "";
      lines.push(`- ${url ? `[${location}](${url})` : location}${suffix}`);
    }
    lines.push(
      "",
      evaluation.currentHeadTerminal
        ? "The terminal pass-condition is already satisfied. After the threads are handled, re-run the failed job to re-evaluate the live state:"
        : evaluation.currentHeadLiveness
          ? "A Codex review of the current HEAD is already in progress, so no new review request is needed. After the threads are handled, re-run the failed job:"
          : requestReview
            ? "Codex has not reviewed the current HEAD yet. After the threads are handled, run these back to back, without waiting in between:"
            : "Codex is expected to review each push automatically, so no manual review request is suggested. After the threads are handled, verify the connector and re-run the failed job:",
    );
  } else if (reason === "lgtm-missing") {
    lines.push(
      "## LGTM missing",
      "",
      `Codex reviewed the current HEAD \`${snapshot.headSha}\` but left no LGTM (a 👍 reaction or a \'Didn't find any major issues\' comment).`,
      "",
      requestReview
        ? "After handling its threads, request a fresh review and re-run the failed check, back to back:"
        : "Verify the connector triggered a fresh review after handling its threads, then re-run the failed check:",
    );
  } else if (reason === "review-timeout") {
    lines.push(
      "## Review still in progress",
      "",
      "Codex liveness was observed, but no terminal current-HEAD result arrived before the configured timeout. Re-run the check to keep waiting:",
    );
  } else {
    lines.push("## Ready", "");
    if (!options.requireLgtm) {
      const lgtmObserved =
        evaluation.signal === "clean-comment" || evaluation.signal === "clean-reaction";
      lines.push(
        lgtmObserved
          ? "Codex left an LGTM and no unresolved Codex review thread blocks. Lenient mode did not require the LGTM to attest the current HEAD."
          : "Codex completed a review and it was accepted under the default lenient mode without an LGTM. No unresolved Codex review thread blocks.",
      );
    } else {
      lines.push(
        "Codex left an LGTM attesting the current HEAD and no unresolved Codex review thread blocks.",
      );
    }
  }
  if (state === "failure") {
    lines.push(
      "",
      "```shell",
      nextStepCommands(snapshot.pullRequest, options.runId, requestReview).join(" && "),
      "```",
      "",
      rerunWaitGuidance(options.reviewTimeoutSeconds),
    );
    if (reason === "lgtm-missing") {
      lines.push("", "Or drop `require-lgtm` to accept a completed review without an LGTM.");
    }
  }
  return `${lines.join("\n")}\n`;
}
