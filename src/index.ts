import * as core from "@actions/core";
import * as github from "@actions/github";
import { loadReviewSnapshot } from "./github.js";
import { evaluateReviewState } from "./state.js";
import type { OutdatedPolicy, ReviewEvaluation, ReviewSnapshot } from "./types.js";

interface RuntimeConfig {
  token: string;
  repository: string;
  pullRequest: number;
  botLogins: Set<string>;
  graceSeconds: number;
  reviewTimeoutSeconds: number;
  pollIntervalSeconds: number;
  terminalSettleSeconds: number;
  outdatedPolicy: OutdatedPolicy;
}

async function publishResult(
  snapshot: ReviewSnapshot,
  evaluation: ReviewEvaluation,
  state: "success" | "failure",
  reason: string,
): Promise<void> {
  const reviewHint = `gh pr comment ${snapshot.pullRequest} --body '@codex review'`;
  const rerunHint = process.env.GITHUB_RUN_ID
    ? `gh run rerun ${process.env.GITHUB_RUN_ID} --failed`
    : "Re-run the failed Codex Review job from GitHub Actions.";
  core.setOutput("state", state);
  core.setOutput("reason", reason);
  core.setOutput("head-sha", snapshot.headSha);
  core.setOutput("review-signal", evaluation.signal);
  core.setOutput("unresolved-count", evaluation.unresolvedThreads.length.toString());
  core.setOutput("review-hint", reason === "review-missing" ? reviewHint : "");

  core.summary
    .addHeading("Codex Review", 1)
    .addTable([
      [
        { data: "Pull request", header: true },
        { data: "HEAD", header: true },
        { data: "State", header: true },
        { data: "Signal", header: true },
      ],
      [
        `[${snapshot.repository}#${snapshot.pullRequest}](${snapshot.pullRequestUrl})`,
        `\`${snapshot.headSha}\``,
        state,
        evaluation.signal,
      ],
    ]);

  if (reason === "review-missing") {
    core.summary
      .addHeading("Agent next action", 2)
      .addRaw("No Codex review signal was found for the current PR HEAD after the grace period.\n\n")
      .addRaw("Request one explicitly; this Action will not spend Codex credits for you.\n\n")
      .addCodeBlock(reviewHint, "shell")
      .addRaw("Then re-run the failed check:\n\n")
      .addCodeBlock(rerunHint, "shell");
  } else if (reason === "unresolved-threads") {
    core.summary
      .addHeading("Blocking Codex review threads", 2)
      .addRaw("Resolve each handled GitHub review conversation, then re-run this check.\n\n");
    for (const thread of evaluation.unresolvedThreads) {
      const location = thread.line ? `${thread.path ?? "unknown"}:${thread.line}` : thread.path ?? "unknown";
      const codexComment = thread.comments.find((comment) => comment.url);
      const suffix = thread.isOutdated ? " (outdated)" : "";
      core.summary.addRaw(
        `- ${codexComment?.url ? `[${location}](${codexComment.url})` : location}${suffix}\n`,
      );
    }
    core.summary.addRaw("\n").addCodeBlock(rerunHint, "shell");
  } else if (reason === "review-timeout") {
    core.summary
      .addHeading("Review still in progress", 2)
      .addRaw("Codex liveness was observed, but no terminal current-HEAD result arrived before the configured timeout. Re-run the check after the review finishes.\n\n")
      .addCodeBlock(rerunHint, "shell");
  } else {
    core.summary
      .addHeading("Ready", 2)
      .addRaw("Codex produced a terminal signal for the current HEAD and no configured unresolved thread blocks.\n");
  }
  await core.summary.write();
}

async function run(): Promise<void> {
  const token = core.getInput("github-token", { required: true });
  const repository = process.env.GITHUB_REPOSITORY ?? github.context.payload.repository?.full_name;
  const explicitPullRequest = core.getInput("pull-request").trim();
  const eventPullRequest = github.context.payload.pull_request?.number;
  const eventIssue = github.context.payload.issue?.pull_request
    ? github.context.payload.issue.number
    : undefined;
  const pullRequest = Number(explicitPullRequest || eventPullRequest || eventIssue || 0);
  const integerInputs = {
    graceSeconds: Number(core.getInput("grace-seconds")),
    reviewTimeoutSeconds: Number(core.getInput("review-timeout-seconds")),
    pollIntervalSeconds: Number(core.getInput("poll-interval-seconds")),
    terminalSettleSeconds: Number(core.getInput("terminal-settle-seconds")),
  };
  const invalidInput = Object.entries(integerInputs).find(
    ([, value]) => !Number.isSafeInteger(value) || value < 0,
  );
  if (!repository) {
    throw new Error("GITHUB_REPOSITORY is missing.");
  }
  if (!Number.isSafeInteger(pullRequest) || pullRequest <= 0) {
    throw new Error("A positive pull-request input or pull request event is required.");
  }
  if (invalidInput) {
    throw new Error(`${invalidInput[0]} must be a non-negative integer.`);
  }
  if (integerInputs.pollIntervalSeconds === 0) {
    throw new Error("poll-interval-seconds must be greater than zero.");
  }
  const outdatedInput = core.getInput("outdated-threads").trim().toLowerCase();
  if (outdatedInput !== "block" && outdatedInput !== "ignore") {
    throw new Error("outdated-threads must be exactly block or ignore.");
  }

  const config: RuntimeConfig = {
    token,
    repository,
    pullRequest,
    botLogins: new Set(
      core
        .getInput("codex-bot-logins")
        .split(",")
        .map((login) => login.trim())
        .filter(Boolean),
    ),
    ...integerInputs,
    outdatedPolicy: outdatedInput,
  };
  if (config.botLogins.size === 0) {
    throw new Error("codex-bot-logins must contain at least one login.");
  }

  let headStartedAt = Date.now();
  let observedHeadSha = "";
  let livenessSeen = false;
  let terminalSeenAt: number | null = null;
  let lastPhase = "";
  while (true) {
    const snapshot = await loadReviewSnapshot(config.token, config.repository, config.pullRequest);
    if (snapshot.headSha !== observedHeadSha) {
      observedHeadSha = snapshot.headSha;
      headStartedAt = Date.now();
      livenessSeen = false;
      terminalSeenAt = null;
      lastPhase = "";
      core.info(`Evaluating live pull request HEAD ${observedHeadSha}.`);
    }
    const evaluation = evaluateReviewState(snapshot, config.botLogins, config.outdatedPolicy);
    const elapsedSeconds = Math.floor((Date.now() - headStartedAt) / 1000);
    livenessSeen ||= evaluation.phase !== "missing";
    if (evaluation.phase !== lastPhase) {
      core.info(
        `Codex Review state for ${snapshot.repository}#${snapshot.pullRequest} at ${snapshot.headSha}: ${evaluation.phase} (${evaluation.signal}).`,
      );
      lastPhase = evaluation.phase;
    }

    if (evaluation.phase === "blocked") {
      await publishResult(snapshot, evaluation, "failure", "unresolved-threads");
      core.setFailed(
        `${evaluation.unresolvedThreads.length} unresolved Codex review thread(s) must be resolved before requesting another review.`,
      );
      return;
    } else if (evaluation.phase === "terminal") {
      terminalSeenAt ??= Date.now();
      const settledSeconds = Math.floor((Date.now() - terminalSeenAt) / 1000);
      if (settledSeconds < config.terminalSettleSeconds) {
        core.info(
          `Terminal signal found; waiting ${config.terminalSettleSeconds - settledSeconds}s for review threads to settle.`,
        );
      } else {
        await publishResult(snapshot, evaluation, "success", "ready");
        return;
      }
    } else {
      terminalSeenAt = null;
    }

    if (evaluation.phase !== "terminal" && !livenessSeen && elapsedSeconds >= config.graceSeconds) {
      await publishResult(snapshot, evaluation, "failure", "review-missing");
      core.setFailed(
        `No Codex review signal for current HEAD ${snapshot.headSha}. Run: gh pr comment ${snapshot.pullRequest} --body '@codex review'`,
      );
      return;
    }
    if (
      evaluation.phase !== "terminal" &&
      livenessSeen &&
      elapsedSeconds >= config.reviewTimeoutSeconds
    ) {
      await publishResult(snapshot, evaluation, "failure", "review-timeout");
      core.setFailed("Codex review did not produce a terminal current-HEAD signal before timeout.");
      return;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(1, config.pollIntervalSeconds) * 1000),
    );
  }
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
