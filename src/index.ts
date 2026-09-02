import * as core from "@actions/core";
import * as github from "@actions/github";
import { loadReviewSnapshot } from "./github.js";
import {
  failureOutput,
  reviewRequestCommand,
  suggestsReviewRequest,
  summaryMarkdown,
} from "./messages.js";
import { evaluateReviewState } from "./state.js";
import type { ReviewEvaluation, ReviewHintPolicy, ReviewSnapshot } from "./types.js";

interface RuntimeConfig {
  token: string;
  repository: string;
  pullRequest: number;
  botLogins: Set<string>;
  graceSeconds: number;
  reviewTimeoutSeconds: number;
  pollIntervalSeconds: number;
  terminalSettleSeconds: number;
  passWithoutLgtm: boolean;
  reviewHintPolicy: ReviewHintPolicy;
}

async function publishResult(
  snapshot: ReviewSnapshot,
  evaluation: ReviewEvaluation,
  state: "success" | "failure",
  reason: string,
  reviewHintPolicy: ReviewHintPolicy,
  passWithoutLgtm: boolean,
): Promise<void> {
  core.setOutput("state", state);
  core.setOutput("reason", reason);
  core.setOutput("head-sha", snapshot.headSha);
  core.setOutput("review-signal", evaluation.signal);
  core.setOutput("unresolved-count", evaluation.unresolvedThreads.length.toString());
  const suggestReviewRequest = suggestsReviewRequest(reason, evaluation, reviewHintPolicy);
  core.setOutput(
    "review-hint",
    suggestReviewRequest ? reviewRequestCommand(snapshot.pullRequest) : "",
  );
  core.summary.addRaw(
    summaryMarkdown(
      snapshot,
      evaluation,
      state,
      reason,
      process.env.GITHUB_RUN_ID,
      reviewHintPolicy,
      passWithoutLgtm,
    ),
  );
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
  const passWithoutLgtmInput = core.getInput("pass-without-lgtm").trim().toLowerCase();
  if (passWithoutLgtmInput !== "true" && passWithoutLgtmInput !== "false") {
    throw new Error("pass-without-lgtm must be exactly true or false.");
  }
  const reviewHintInput = core.getInput("review-hint").trim().toLowerCase();
  if (reviewHintInput !== "suggest" && reviewHintInput !== "suppress") {
    throw new Error("review-hint must be exactly suggest or suppress.");
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
    passWithoutLgtm: passWithoutLgtmInput === "true",
    reviewHintPolicy: reviewHintInput,
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
    const evaluation = evaluateReviewState(snapshot, config.botLogins, config.passWithoutLgtm);
    const elapsedSeconds = Math.floor((Date.now() - headStartedAt) / 1000);
    livenessSeen ||= evaluation.phase === "reviewing";
    if (evaluation.phase !== lastPhase) {
      core.info(
        `Codex Review state for ${snapshot.repository}#${snapshot.pullRequest} at ${snapshot.headSha}: ${evaluation.phase} (${evaluation.signal}).`,
      );
      lastPhase = evaluation.phase;
    }

    if (evaluation.phase === "blocked") {
      const output = failureOutput(
        "unresolved-threads",
        snapshot,
        evaluation,
        process.env.GITHUB_RUN_ID,
        config.reviewHintPolicy,
        config.passWithoutLgtm,
      );
      for (const line of output.logLines) {
        core.info(line);
      }
      await publishResult(
        snapshot,
        evaluation,
        "failure",
        "unresolved-threads",
        config.reviewHintPolicy,
        config.passWithoutLgtm,
      );
      core.setFailed(output.annotation);
      return;
    } else if (evaluation.phase === "terminal") {
      terminalSeenAt ??= Date.now();
      const settledSeconds = Math.floor((Date.now() - terminalSeenAt) / 1000);
      if (settledSeconds < config.terminalSettleSeconds) {
        core.info(
          `Terminal signal found; waiting ${config.terminalSettleSeconds - settledSeconds}s for review threads to settle.`,
        );
      } else {
        await publishResult(
          snapshot,
          evaluation,
          "success",
          "ready",
          config.reviewHintPolicy,
          config.passWithoutLgtm,
        );
        return;
      }
    } else if (evaluation.phase === "awaiting-lgtm") {
      terminalSeenAt ??= Date.now();
    } else {
      terminalSeenAt = null;
    }

    if (evaluation.phase === "awaiting-lgtm" && elapsedSeconds >= config.graceSeconds) {
      const settledSeconds =
        terminalSeenAt === null ? 0 : Math.floor((Date.now() - terminalSeenAt) / 1000);
      if (settledSeconds < config.terminalSettleSeconds) {
        core.info(
          `Terminal review found; waiting ${config.terminalSettleSeconds - settledSeconds}s for review threads to settle before reporting a missing LGTM.`,
        );
      } else {
        await publishResult(
          snapshot,
          evaluation,
          "failure",
          "lgtm-missing",
          config.reviewHintPolicy,
          config.passWithoutLgtm,
        );
        core.setFailed(
          failureOutput(
            "lgtm-missing",
            snapshot,
            evaluation,
            process.env.GITHUB_RUN_ID,
            config.reviewHintPolicy,
            config.passWithoutLgtm,
          ).annotation,
        );
        return;
      }
    }
    if (
      (evaluation.phase === "missing" || evaluation.phase === "reviewing") &&
      !livenessSeen &&
      elapsedSeconds >= config.graceSeconds
    ) {
      await publishResult(
        snapshot,
        evaluation,
        "failure",
        "review-missing",
        config.reviewHintPolicy,
        config.passWithoutLgtm,
      );
      core.setFailed(
        failureOutput(
          "review-missing",
          snapshot,
          evaluation,
          process.env.GITHUB_RUN_ID,
          config.reviewHintPolicy,
          config.passWithoutLgtm,
        ).annotation,
      );
      return;
    }
    if (
      (evaluation.phase === "missing" || evaluation.phase === "reviewing") &&
      livenessSeen &&
      elapsedSeconds >= config.reviewTimeoutSeconds
    ) {
      await publishResult(
        snapshot,
        evaluation,
        "failure",
        "review-timeout",
        config.reviewHintPolicy,
        config.passWithoutLgtm,
      );
      core.setFailed(
        failureOutput(
          "review-timeout",
          snapshot,
          evaluation,
          process.env.GITHUB_RUN_ID,
          config.reviewHintPolicy,
          config.passWithoutLgtm,
        ).annotation,
      );
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
