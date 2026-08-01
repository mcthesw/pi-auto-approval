import type { ApprovalRule, DecisionRoute, PolicyRule, ProjectConfig, ToolCall } from "../domain.ts";
import type { MatcherContext } from "../matchers.ts";
import { matchesToolCall } from "../matchers.ts";
import { resolveProjectPath } from "../project.ts";
import { classifyBash, tokenizeSingleCommand } from "./bash.ts";

export type ToolProvenance = "builtin" | "extension" | "unknown";

export type PolicyDecision = {
  route: DecisionRoute;
  source: "approval_rule" | "policy_rule" | "builtin_policy" | "default";
  reason: string;
  ruleId?: string;
};

export type BashExecutionGuard = {
  trusted: boolean;
  reason?: string;
  isExecutableTrusted: (command: string) => Promise<boolean>;
};

export type PolicyEvaluationContext = {
  projectRoot: string;
  cwd: string;
  project: ProjectConfig;
  provenance: ToolProvenance;
  bash?: BashExecutionGuard;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function callPath(call: ToolCall): string | undefined {
  const input = record(call.input);
  return typeof input?.path === "string" ? input.path : undefined;
}

function isControlPath(relative: string): boolean {
  const segments = relative.replaceAll("\\", "/").split("/");
  return segments.some((segment) => {
    const comparable = process.platform === "win32" ? segment.toLowerCase() : segment;
    const agentsFile = process.platform === "win32" ? "agents.md" : "AGENTS.md";
    return comparable === ".git" || comparable === ".pi" || comparable === ".agents" || comparable === agentsFile;
  });
}

function matcherContext(context: PolicyEvaluationContext): MatcherContext {
  return {
    resolvePath: async (value) => resolveProjectPath(context.projectRoot, context.cwd, value),
    tokenizeBash: tokenizeSingleCommand,
  };
}

async function firstMatchingApproval(
  rules: ApprovalRule[],
  call: ToolCall,
  context: MatcherContext,
): Promise<ApprovalRule | undefined> {
  for (const rule of rules) if (await matchesToolCall(rule.matcher, call, context)) return rule;
  return undefined;
}

async function firstMatchingPolicy(
  rules: PolicyRule[],
  call: ToolCall,
  context: MatcherContext,
): Promise<PolicyRule | undefined> {
  for (const rule of rules) if (await matchesToolCall(rule.matcher, call, context)) return rule;
  return undefined;
}

async function builtinDecision(call: ToolCall, context: PolicyEvaluationContext): Promise<PolicyDecision | undefined> {
  if (context.provenance !== "builtin") return undefined;

  if (["read", "grep", "find", "ls"].includes(call.name)) {
    const target = callPath(call);
    if (call.name === "read" && target === undefined) {
      return { route: "auto_review", source: "builtin_policy", reason: "read input has no path" };
    }
    const resolved = await resolveProjectPath(context.projectRoot, context.cwd, target);
    return resolved.inside
      ? { route: "approve", source: "builtin_policy", reason: `${call.name} is a project-local read-only tool` }
      : { route: "auto_review", source: "builtin_policy", reason: `${call.name} targets a path outside the project` };
  }

  if (["write", "edit"].includes(call.name)) {
    const target = callPath(call);
    if (target === undefined) {
      return { route: "auto_review", source: "builtin_policy", reason: `${call.name} input has no path` };
    }
    const resolved = await resolveProjectPath(context.projectRoot, context.cwd, target);
    if (!resolved.inside || !resolved.relative) {
      return { route: "auto_review", source: "builtin_policy", reason: `${call.name} targets a path outside the project` };
    }
    if (isControlPath(resolved.relative)) {
      return { route: "auto_review", source: "builtin_policy", reason: `${call.name} targets a project control path` };
    }
    return { route: "approve", source: "builtin_policy", reason: `${call.name} targets a regular project path` };
  }

  if (call.name === "bash") {
    if (!context.bash?.trusted) {
      return {
        route: "auto_review",
        source: "builtin_policy",
        reason: context.bash?.reason ?? "the Bash execution environment could not be verified",
      };
    }
    const input = record(call.input);
    if (typeof input?.command !== "string") {
      return { route: "auto_review", source: "builtin_policy", reason: "bash input has no command string" };
    }
    const classification = await classifyBash(
      input.command,
      async (value) => resolveProjectPath(context.projectRoot, context.cwd, value),
      context.bash.isExecutableTrusted,
    );
    return classification.safe
      ? { route: "approve", source: "builtin_policy", reason: classification.reason }
      : { route: "auto_review", source: "builtin_policy", reason: classification.reason };
  }

  return undefined;
}

export async function evaluatePolicy(call: ToolCall, context: PolicyEvaluationContext): Promise<PolicyDecision> {
  const matchContext = matcherContext(context);
  const approval = await firstMatchingApproval(context.project.approvalRules, call, matchContext);
  if (approval) {
    return { route: "approve", source: "approval_rule", reason: "matched an authoritative project Approval Rule", ruleId: approval.id };
  }

  const policy = await firstMatchingPolicy(context.project.policyRules, call, matchContext);
  if (policy) {
    return { route: policy.route, source: "policy_rule", reason: `matched project Policy Rule ${policy.id}`, ruleId: policy.id };
  }

  return (
    (await builtinDecision(call, context)) ?? {
      route: "auto_review",
      source: "default",
      reason: "no deterministic policy matched this Tool Call",
    }
  );
}
