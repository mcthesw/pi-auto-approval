import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  FrictionRecord,
  ProjectConfig,
  ReviewDecision,
  ToolCall,
  ToolMatcher,
  ToolSourceIdentity,
  UserConfirmationChoice,
} from "./domain.ts";
import { exactMatcherFor, matchesToolCall, type MatcherContext } from "./matchers.ts";
import { resolveProjectPath, type ProjectIdentity } from "./project.ts";
import { tokenizeSingleCommand } from "./policy/bash.ts";
import { evaluatePolicy, type BashExecutionGuard } from "./policy/engine.ts";
import type { AutoApprovalConfigStore } from "./config/store.ts";
import { confirmToolCall } from "./approval/confirmation.ts";
import type { AutomatedReviewer } from "./review/reviewer.ts";
import type { ReviewToolMetadata } from "./review/context.ts";
import { createFrictionRecord } from "./friction/summary.ts";

export type ToolDecision = { block: true; reason: string } | undefined;

const REVIEW_NOTICE_LIMIT = 300;

function noticeText(value: string): string {
  const compact = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  return compact.length <= REVIEW_NOTICE_LIMIT ? compact : `${compact.slice(0, REVIEW_NOTICE_LIMIT - 1)}…`;
}

function notifyReviewDecision(ctx: ExtensionContext, call: ToolCall, decision: "approve" | "deny" | "ask_user", reason: string): void {
  if (!ctx.hasUI) return;
  const level = decision === "approve" ? "info" : decision === "deny" ? "error" : "warning";
  ctx.ui.notify(`Auto Review ${decision.toUpperCase()} · ${noticeText(call.name)}: ${noticeText(reason)}`, level);
}

export type DecisionDependencies = {
  store: AutoApprovalConfigStore;
  reviewer?: AutomatedReviewer;
  reviewerUnavailableReason?: string;
  project: ProjectIdentity;
  toolSource?: ToolSourceIdentity;
  bash?: BashExecutionGuard;
  messages: readonly unknown[];
  tool?: ReviewToolMetadata;
  recordFriction?: (record: FrictionRecord) => Promise<void>;
};

const EMPTY_PROJECT: ProjectConfig = { policyRules: [], approvalRules: [] };

function matcherContext(project: ProjectIdentity, cwd: string, source?: ToolSourceIdentity): MatcherContext {
  return {
    resolvePath: async (value) => resolveProjectPath(project.root, cwd, value),
    tokenizeBash: tokenizeSingleCommand,
    source,
  };
}

async function chooseProposal(
  call: ToolCall,
  proposed: ToolMatcher | undefined,
  context: MatcherContext,
): Promise<ToolMatcher | undefined> {
  if (proposed && await matchesToolCall(proposed, call, context)) return proposed;
  return exactMatcherFor(call);
}

async function persistApprovalRule(
  ctx: ExtensionContext,
  dependencies: DecisionDependencies,
  matcher: ToolMatcher,
): Promise<void> {
  try {
    await dependencies.store.update((config) => {
      const project = (config.projects[dependencies.project.key] ??= { policyRules: [], approvalRules: [] });
      project.approvalRules.push({ id: randomUUID(), matcher });
    });
  } catch (error) {
    ctx.ui.notify(
      `Current Tool Call approved, but the Approval Rule could not be saved: ${error instanceof Error ? error.message : String(error)}`,
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
  proposed?: ToolMatcher,
): Promise<ConfirmationOutcome> {
  if (ctx.signal?.aborted) return { decision: { block: true, reason: "Tool approval was cancelled" } };
  const matchContext = matcherContext(dependencies.project, ctx.cwd, dependencies.toolSource);
  const proposal = await chooseProposal(call, proposed, matchContext);
  if (!ctx.hasUI) return { decision: { block: true, reason: `${reason}; no interactive UI is available` } };
  if (!proposal) {
    const approved = await ctx.ui.confirm("Tool approval required", `${reason}\n${call.name}: input is not JSON-serializable`);
    return approved
      ? { decision: undefined, userChoice: "approve_once" }
      : { decision: { block: true, reason: `${reason}; denied by user` }, userChoice: "deny" };
  }

  const result = await confirmToolCall(ctx, {
    call,
    reason,
    proposal,
    validateProposal: async (matcher) =>
      await matchesToolCall(matcher, call, matchContext) ? undefined : "Approval Rule must match the current Tool Call",
  });
  if (result.kind === "approve_once") return { decision: undefined, userChoice: "approve_once" };
  if (result.kind === "always") {
    if (result.matcher) await persistApprovalRule(ctx, dependencies, result.matcher);
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
    globalApprovalRules: loaded.config.globalApprovalRules,
    toolSource: dependencies.toolSource,
    bash: dependencies.bash,
  });

  if (policy.route === "approve") return undefined;
  if (policy.route === "deny") return { block: true, reason: policy.reason };
  if (policy.route === "ask_user") {
    const confirmation = await requestConfirmation(ctx, call, policy.reason, dependencies);
    await recordFriction(dependencies, call, undefined, confirmation.userChoice);
    return confirmation.decision;
  }

  if (!loaded.config.reviewer || !dependencies.reviewer) {
    const reason = dependencies.reviewerUnavailableReason ?? "Automated Review is not configured";
    return (await requestConfirmation(ctx, call, reason, dependencies)).decision;
  }

  try {
    const review = await dependencies.reviewer.review(
      loaded.config.reviewer,
      {
        toolCall: call,
        cwd: ctx.cwd,
        projectRoot: dependencies.project.root,
        messages: dependencies.messages,
        tool: dependencies.tool,
      },
      ctx.signal,
    );
    notifyReviewDecision(ctx, call, review.decision, review.reason);
    if (review.decision === "approve") {
      await recordFriction(dependencies, call, "approve");
      return undefined;
    }
    if (review.decision === "deny") {
      await recordFriction(dependencies, call, "deny");
      return { block: true, reason: `Automated Review denied the Tool Call: ${review.reason}` };
    }
    const confirmation = await requestConfirmation(ctx, call, review.reason, dependencies, review.approvalRuleProposal);
    await recordFriction(dependencies, call, "ask_user", confirmation.userChoice);
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
