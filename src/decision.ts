import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  AutoApprovalConfig,
  FrictionRecord,
  ProjectConfig,
  ReviewDecision,
  ToolCall,
  ToolMatcher,
  ToolSourceIdentity,
  UserConfirmationChoice,
} from "./domain.ts";
import {
  exactMatcherFor,
  isStandardToolName,
  matcherKey,
  matchesToolCall,
  validateToolMatcher,
  type MatcherContext,
  type RuleScope,
} from "./matchers.ts";
import { resolveProjectPath, type ProjectIdentity } from "./project.ts";
import { findMatchingRule, upsertRestrictiveRule } from "./rules.ts";
import { formatConservativeBashCommand, parseConservativeBash, tokenizeSingleCommand } from "./policy/bash.ts";
import { evaluatePolicy } from "./policy/engine.ts";
import { confirmRuleConflicts, type RuleConflict } from "./ui/rule-conflicts.ts";
import type { AutoApprovalConfigStore } from "./config/store.ts";
import { confirmToolCall } from "./approval/confirmation.ts";
import type { AutomatedReviewer } from "./review/reviewer.ts";
import type { ReviewRuleSuggestion } from "./review/schema.ts";
import type { ReviewRequest, ReviewToolMetadata } from "./review/context.ts";
import type { ReviewResult } from "./review/schema.ts";
import { createFrictionRecord } from "./friction/summary.ts";
import { runWithAsyncLoader } from "./ui/async-loader.ts";
import { boundedSingleLine } from "./ui/text.ts";

export type ToolDecision = { block: true; reason: string } | undefined;

function notifyReviewDecision(ctx: ExtensionContext, call: ToolCall, decision: ReviewDecision, reason: string): void {
  if (!ctx.hasUI) return;
  const level = decision === "allow" ? "info" : decision === "deny" ? "error" : "warning";
  ctx.ui.notify(`Auto Review ${decision.toUpperCase()} · ${boundedSingleLine(call.name)}: ${boundedSingleLine(reason)}`, level);
}

export type DecisionDependencies = {
  store: AutoApprovalConfigStore;
  reviewer?: AutomatedReviewer;
  reviewerUnavailableReason?: string;
  project: ProjectIdentity;
  toolSource?: ToolSourceIdentity;
  messages: readonly unknown[];
  tool?: ReviewToolMetadata;
  review?: (config: AutoApprovalConfig, request: ReviewRequest, signal?: AbortSignal) => Promise<ReviewResult>;
  recordFriction?: (record: FrictionRecord) => Promise<void>;
};

const EMPTY_PROJECT: ProjectConfig = { rules: [] };

function matcherContext(project: ProjectIdentity, cwd: string, source?: ToolSourceIdentity): MatcherContext {
  return {
    resolvePath: async (value) => resolveProjectPath(project.root, cwd, value),
    tokenizeBash: tokenizeSingleCommand,
    source,
  };
}

function sourceBoundMatcher(matcher: ToolMatcher, call: ToolCall, source?: ToolSourceIdentity): ToolMatcher {
  if (!source || isStandardToolName(call.name) || matcher.source) return matcher;
  return { ...matcher, source: structuredClone(source) };
}

function segmentCalls(call: ToolCall): ToolCall[] | undefined {
  if (call.name !== "bash") return [call];
  const input = typeof call.input === "object" && call.input !== null && !Array.isArray(call.input)
    ? call.input as Record<string, unknown>
    : undefined;
  if (typeof input?.command !== "string") return undefined;
  const parsed = parseConservativeBash(input.command);
  if (!parsed) return undefined;
  return parsed.commands.map((tokens) => ({
    ...call,
    input: {
      ...input,
      command: formatConservativeBashCommand(tokens),
    },
  }));
}

async function suggestionMatchesCall(
  suggestion: ReviewRuleSuggestion,
  calls: readonly ToolCall[],
  context: MatcherContext,
): Promise<boolean> {
  for (const call of calls) {
    if (await matchesToolCall(suggestion.matcher, call, { ...context, scope: suggestion.scope })) return true;
  }
  return false;
}

async function chooseProposals(
  call: ToolCall,
  suggested: readonly ReviewRuleSuggestion[] | undefined,
  context: MatcherContext,
  source?: ToolSourceIdentity,
): Promise<ReviewRuleSuggestion[]> {
  const calls = segmentCalls(call) ?? [call];
  const proposals: ReviewRuleSuggestion[] = [];
  for (const item of suggested ?? []) {
    const matcher = sourceBoundMatcher(item.matcher, call, source);
    const candidate = { matcher, scope: item.scope };
    if (validateToolMatcher(matcher, { scope: candidate.scope })) continue;
    if (await suggestionMatchesCall(candidate, calls, context)) proposals.push(candidate);
  }
  const covered = new Set<number>();
  for (let index = 0; index < calls.length; index += 1) {
    for (const proposal of proposals) {
      if (await suggestionMatchesCall(proposal, [calls[index]!], context)) {
        covered.add(index);
        break;
      }
    }
  }
  for (let index = 0; index < calls.length; index += 1) {
    if (covered.has(index)) continue;
    const matcher = exactMatcherFor(calls[index]!, source && !isStandardToolName(call.name) ? source : undefined);
    if (matcher) proposals.push({ matcher, scope: "project" });
  }
  const unique = new Map<string, ReviewRuleSuggestion>();
  for (const proposal of proposals) unique.set(`${proposal.scope}:${matcherKey(proposal.matcher)}`, proposal);
  return [...unique.values()];
}

async function persistRules(
  ctx: ExtensionContext,
  dependencies: DecisionDependencies,
  rules: readonly ReviewRuleSuggestion[],
): Promise<void> {
  const latest = await dependencies.store.read();
  if (!latest.ok) {
    ctx.ui.notify(`Current Tool Call allowed, but its Rule could not be saved: ${latest.error}`, "error");
    return;
  }
  const conflicts: RuleConflict[] = [];
  for (const candidate of rules) {
    const target = candidate.scope === "global"
      ? latest.config.globalRules
      : latest.config.projects[dependencies.project.key]?.rules ?? [];
    const existing = findMatchingRule(target, candidate.matcher);
    if (existing) conflicts.push({ existing, incoming: { action: "allow", ...candidate } });
  }
  if (!await confirmRuleConflicts(ctx, conflicts)) {
    ctx.ui.notify("Current Tool Call allowed once; no Rules were saved", "info");
    return;
  }
  try {
    await dependencies.store.update((config) => {
      for (const candidate of rules) {
        const target = candidate.scope === "global"
          ? config.globalRules
          : (config.projects[dependencies.project.key] ??= { rules: [] }).rules;
        upsertRestrictiveRule(target, "allow", candidate.matcher);
      }
    });
  } catch (error) {
    ctx.ui.notify(
      `Current Tool Call allowed, but its Rule could not be saved: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

type ConfirmationOutcome = {
  decision: ToolDecision;
  userChoice?: UserConfirmationChoice;
};

async function requestConfirmation(
  ctx: ExtensionContext,
  call: ToolCall,
  reason: string,
  dependencies: DecisionDependencies,
  suggestions?: readonly ReviewRuleSuggestion[],
): Promise<ConfirmationOutcome> {
  if (ctx.signal?.aborted) return { decision: { block: true, reason: "Tool approval was cancelled" } };
  const context = matcherContext(dependencies.project, ctx.cwd, dependencies.toolSource);
  const proposals = await chooseProposals(call, suggestions, context, dependencies.toolSource);
  if (!ctx.hasUI) return { decision: { block: true, reason: `${reason}; no interactive UI is available` } };
  if (!proposals.length) {
    const allowed = await ctx.ui.confirm("Tool approval required", `${reason}\n${call.name}: input is not JSON-serializable`);
    return allowed
      ? { decision: undefined, userChoice: "allow_once" }
      : { decision: { block: true, reason: `${reason}; denied by user` }, userChoice: "deny" };
  }

  const result = await confirmToolCall(ctx, {
    call,
    reason,
    proposals,
    toolSource: dependencies.toolSource,
    validateProposal: async (matcher, scope) => {
      if (validateToolMatcher(matcher, { scope })) return "Rule is not valid";
      const calls = segmentCalls(call) ?? [call];
      return await suggestionMatchesCall({ matcher, scope }, calls, context) ? undefined : "Rule must match the current Tool Call";
    },
  });
  if (result.kind === "allow_once") return { decision: undefined, userChoice: "allow_once" };
  if (result.kind === "always") {
    if (result.rules?.length) await persistRules(ctx, dependencies, result.rules);
    return { decision: undefined, userChoice: "always" };
  }
  if (result.kind === "cancelled") {
    return { decision: { block: true, reason: `${reason}; approval cancelled` }, userChoice: "cancelled" };
  }
  return {
    decision: {
      block: true,
      reason: result.feedback ? `${reason}; denied by user: ${result.feedback}` : `${reason}; denied by user`,
    },
    userChoice: "deny",
  };
}

async function recordFriction(
  dependencies: DecisionDependencies,
  call: ToolCall,
  reviewDecision?: ReviewDecision,
  userChoice?: UserConfirmationChoice,
): Promise<void> {
  const record = createFrictionRecord({ call, source: dependencies.toolSource, reviewDecision, userChoice });
  if (!record || !dependencies.recordFriction) return;
  try {
    await dependencies.recordFriction(record);
  } catch {
    // Friction History is advisory evidence and must never affect the authorization decision.
  }
}

export async function decideToolCall(
  ctx: ExtensionContext,
  call: ToolCall,
  dependencies: DecisionDependencies,
): Promise<ToolDecision> {
  const loaded = await dependencies.store.read();
  if (!loaded.ok) {
    return (await requestConfirmation(ctx, call, `Auto Approval configuration is invalid: ${loaded.error}`, dependencies)).decision;
  }
  const project = loaded.config.projects[dependencies.project.key] ?? EMPTY_PROJECT;
  const policy = await evaluatePolicy(call, {
    projectRoot: dependencies.project.root,
    cwd: ctx.cwd,
    project,
    globalRules: loaded.config.globalRules,
    toolSource: dependencies.toolSource,
  });

  if (policy.action === "allow") return undefined;
  if (policy.action === "deny") return { block: true, reason: policy.reason };
  if (policy.action === "ask") {
    const confirmation = await requestConfirmation(ctx, call, policy.reason, dependencies);
    await recordFriction(dependencies, call, undefined, confirmation.userChoice);
    return confirmation.decision;
  }

  if (!loaded.config.reviewer || !dependencies.reviewer) {
    const reason = dependencies.reviewerUnavailableReason ?? "Automated Review is not configured";
    return (await requestConfirmation(ctx, call, reason, dependencies)).decision;
  }

  try {
    const request: ReviewRequest = {
      toolCall: call,
      cwd: ctx.cwd,
      projectRoot: dependencies.project.root,
      messages: dependencies.messages,
      tool: dependencies.tool,
    };
    const review = dependencies.review
      ? await dependencies.review(loaded.config, request, ctx.signal)
      : await (async () => {
        const outcome = await runWithAsyncLoader(ctx, `Automated Review: ${boundedSingleLine(call.name)}…`, (signal) =>
          dependencies.reviewer!.review(loaded.config.reviewer!, request, signal));
        if (outcome.status === "cancelled") throw new DOMException("Automated Review was cancelled", "AbortError");
        if (outcome.status === "failed") throw outcome.error;
        return outcome.value;
      })();
    if (!dependencies.review) notifyReviewDecision(ctx, call, review.decision, review.reason);
    if (review.decision === "allow") {
      await recordFriction(dependencies, call, "allow");
      return undefined;
    }
    if (review.decision === "deny") {
      await recordFriction(dependencies, call, "deny");
      return { block: true, reason: `Automated Review denied the Tool Call: ${review.reason}` };
    }
    const confirmation = await requestConfirmation(ctx, call, review.reason, dependencies, review.ruleSuggestions);
    await recordFriction(dependencies, call, "ask", confirmation.userChoice);
    return confirmation.decision;
  } catch (error) {
    if (ctx.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      return { block: true, reason: "Automated Review was cancelled" };
    }
    return (await requestConfirmation(
      ctx,
      call,
      `Automated Review unavailable: ${error instanceof Error ? error.message : String(error)}`,
      dependencies,
    )).decision;
  }
}
