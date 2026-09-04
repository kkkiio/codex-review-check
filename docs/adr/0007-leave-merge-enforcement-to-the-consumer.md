# ADR 0007: Leave merge enforcement to the consumer

- Status: Accepted
- Date: 2026-09-04

## Context

The README installation steps previously told consumers to mark the `Codex Review` job as a required status check in the repository ruleset, implying the Action's purpose is to block merges. ADR 0001 already frames the check result primarily as a control signal for an agent loop: the failure reason and job summary tell the agent the next step. Whether a failing check also disables the merge button is repository governance, configured and owned by the consumer.

## Decision

The installation guide ends at copying the workflow and enabling Codex auto-review. It does not instruct consumers to configure required status checks.

## Consequences

- Consumers who want hard merge gating configure rulesets themselves, as they would for any check.
- The README no longer teaches GitHub ruleset mechanics, which are GitHub's documentation surface and liable to drift.
- The Action's failure output remains the contract: an agent reads it via `gh run view --log-failed` regardless of ruleset configuration.
