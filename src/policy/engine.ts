import type { ProjectConfig, Rule, RuleAction, ToolCall, ToolSourceIdentity } from "../domain.ts";
import type { MatcherContext } from "../matchers.ts";
import { matchesToolCall } from "../matchers.ts";
import { resolveProjectPath } from "../project.ts";
import { formatConservativeBashCommand, parseConservativeBash, tokenizeSingleCommand } from "./bash.ts";

export type PolicyDecision = {
  action: RuleAction | "review";
  source: "project_rule" | "global_rule" | "builtin" | "default";
  reason: string;
  ruleId?: string;
};

export type PolicyEvaluationContext = {
  projectRoot: string;
  cwd: string;
  project: ProjectConfig;
  globalRules: Rule[];
  toolSource?: ToolSourceIdentity;
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
    source: context.toolSource,
  };
}

function rank(action: RuleAction): number {
  return action === "deny" ? 2 : action === "ask" ? 1 : 0;
}

async function matchingRule(
  rules: readonly Rule[],
  call: ToolCall,
  context: MatcherContext,
): Promise<Rule | undefined> {
  let selected: Rule | undefined;
  for (const rule of rules) {
    if (!(await matchesToolCall(rule.matcher, call, context))) continue;
    if (!selected || rank(rule.action) > rank(selected.action)) selected = rule;
  }
  return selected;
}

async function evaluateRules(
  call: ToolCall,
  context: PolicyEvaluationContext,
): Promise<PolicyDecision | undefined> {
  const matcher = matcherContext(context);
  const project = await matchingRule(context.project.rules, call, { ...matcher, scope: "project" });
  if (project) return {
    action: project.action,
    source: "project_rule",
    reason: `matched Project Rule ${project.id}`,
    ruleId: project.id,
  };
  const global = await matchingRule(context.globalRules, call, { ...matcher, scope: "global" });
  if (global) return {
    action: global.action,
    source: "global_rule",
    reason: `matched Global Rule ${global.id}`,
    ruleId: global.id,
  };
  return undefined;
}

async function builtinDecision(call: ToolCall, context: PolicyEvaluationContext): Promise<PolicyDecision | undefined> {
  if (["read", "grep", "find", "ls"].includes(call.name)) {
    const target = callPath(call);
    if (call.name === "read" && target === undefined) {
      return { action: "review", source: "builtin", reason: "read input has no path" };
    }
    const resolved = await resolveProjectPath(context.projectRoot, context.cwd, target);
    return resolved.inside
      ? { action: "allow", source: "builtin", reason: `${call.name} is a project-local read-only tool` }
      : { action: "review", source: "builtin", reason: `${call.name} targets a path outside the project` };
  }

  if (["write", "edit"].includes(call.name)) {
    const target = callPath(call);
    if (target === undefined) return { action: "review", source: "builtin", reason: `${call.name} input has no path` };
    const resolved = await resolveProjectPath(context.projectRoot, context.cwd, target);
    if (!resolved.inside || !resolved.relative) {
      return { action: "review", source: "builtin", reason: `${call.name} targets a path outside the project` };
    }
    if (isControlPath(resolved.relative)) {
      return { action: "review", source: "builtin", reason: `${call.name} targets a project control path` };
    }
    return { action: "allow", source: "builtin", reason: `${call.name} targets a regular project path` };
  }

  return undefined;
}

function segmentCall(call: ToolCall, command: string): ToolCall | undefined {
  const input = record(call.input);
  if (!input || typeof input.command !== "string") return undefined;
  return { ...call, input: { ...input, command } };
}

async function matchingBashScope(
  rules: readonly Rule[],
  wholeCall: ToolCall,
  segment: ToolCall,
  context: MatcherContext,
): Promise<Rule | undefined> {
  let selected: Rule | undefined;
  for (const rule of rules) {
    const matchesWholeExact = rule.matcher.input.kind === "exact"
      && await matchesToolCall(rule.matcher, wholeCall, context);
    const matchesSegment = await matchesToolCall(rule.matcher, segment, context);
    if (!(matchesWholeExact || matchesSegment)) continue;
    if (!selected || rank(rule.action) > rank(selected.action)) selected = rule;
  }
  return selected;
}

async function evaluateBash(call: ToolCall, context: PolicyEvaluationContext): Promise<PolicyDecision> {
  const input = record(call.input);
  if (typeof input?.command !== "string") {
    return { action: "review", source: "default", reason: "bash input has no command string" };
  }
  const parsed = parseConservativeBash(input.command);
  if (!parsed) {
    const direct = await evaluateRules(call, context);
    return direct ?? { action: "review", source: "default", reason: "bash syntax could not be parsed conservatively" };
  }

  const matcher = matcherContext(context);
  const decisions: PolicyDecision[] = [];
  for (const tokens of parsed.commands) {
    const segment = segmentCall(call, formatConservativeBashCommand(tokens));
    if (!segment) return { action: "review", source: "default", reason: "bash input has no command string" };
    const project = await matchingBashScope(context.project.rules, call, segment, { ...matcher, scope: "project" });
    const global = project ? undefined : await matchingBashScope(context.globalRules, call, segment, { ...matcher, scope: "global" });
    const rule = project ?? global;
    if (!rule) return { action: "review", source: "default", reason: "a Bash command segment has no Rule" };
    decisions.push({
      action: rule.action,
      source: project ? "project_rule" : "global_rule",
      reason: `matched ${project ? "Project" : "Global"} Rule ${rule.id}`,
      ruleId: rule.id,
    });
  }
  const denied = decisions.find((decision) => decision.action === "deny");
  if (denied) return denied;
  const asked = decisions.find((decision) => decision.action === "ask");
  if (asked) return asked;
  return decisions.every((decision) => decision.action === "allow")
    ? { action: "allow", source: "project_rule", reason: "every Bash command segment matched an Allow Rule" }
    : { action: "review", source: "default", reason: "a Bash command segment has no Rule" };
}

export async function evaluatePolicy(call: ToolCall, context: PolicyEvaluationContext): Promise<PolicyDecision> {
  if (call.name === "bash") return await evaluateBash(call, context);
  return await evaluateRules(call, context)
    ?? await builtinDecision(call, context)
    ?? { action: "review", source: "default", reason: "no Rule or built-in default matched this Tool Call" };
}
