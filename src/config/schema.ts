import path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  AutoApprovalConfig,
  FieldMatcher,
  JsonValue,
  ProjectConfig,
  ReviewerConfig,
  Rule,
  RuleAction,
  ToolMatcher,
  ToolSourceIdentity,
  UsageDisplay,
} from "../domain.ts";
import { isJsonValue, isToolWideMatcher, matcherKey, validateToolMatcher, type RuleScope } from "../matchers.ts";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);
const ACTIONS = new Set<RuleAction>(["allow", "ask", "deny"]);
const USAGE_DISPLAYS = new Set<UsageDisplay>(["detailed", "brief", "off"]);
const LEGACY_ROUTES = new Map<string, RuleAction>([
  ["approve", "allow"],
  ["ask_user", "ask"],
  ["deny", "deny"],
]);

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

function fail(at: string, message: string): never {
  throw new ConfigValidationError(`${at}: ${message}`);
}

function record(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(at, "expected an object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(at, "expected a plain JSON object");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], at: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown) fail(`${at}.${unknown}`, "unknown property");
}

function nonEmptyString(value: unknown, at: string): string {
  if (typeof value !== "string" || !value.trim()) fail(at, "expected a non-empty string");
  return value;
}

function parseFieldMatcher(value: unknown, at: string): FieldMatcher {
  const input = record(value, at);
  if (input.kind === "exact") {
    exactKeys(input, ["kind", "value"], at);
    if (!("value" in input) || !isJsonValue(input.value)) fail(`${at}.value`, "expected JSON data");
    return { kind: "exact", value: structuredClone(input.value) };
  }
  if (input.kind === "tokenPrefix") {
    exactKeys(input, ["kind", "tokens"], at);
    if (!Array.isArray(input.tokens) || !input.tokens.length || input.tokens.some((token) => typeof token !== "string" || !token)) {
      fail(`${at}.tokens`, "expected non-empty string tokens");
    }
    return { kind: "tokenPrefix", tokens: [...input.tokens] as string[] };
  }
  if (input.kind === "pathGlob") {
    exactKeys(input, ["kind", "pattern"], at);
    return { kind: "pathGlob", pattern: nonEmptyString(input.pattern, `${at}.pattern`) };
  }
  return fail(`${at}.kind`, "expected exact, tokenPrefix, or pathGlob");
}

function parseToolSourceIdentity(value: unknown, at: string): ToolSourceIdentity {
  const input = record(value, at);
  exactKeys(input, ["source", "path"], at);
  return {
    source: nonEmptyString(input.source, `${at}.source`),
    path: nonEmptyString(input.path, `${at}.path`),
  };
}

export function parseToolMatcher(value: unknown, at = "matcher", scope: RuleScope = "project"): ToolMatcher {
  const input = record(value, at);
  exactKeys(input, ["tool", "source", "input"], at);
  const tool = nonEmptyString(input.tool, `${at}.tool`);
  const source = input.source === undefined ? undefined : parseToolSourceIdentity(input.source, `${at}.source`);
  const inputMatcher = record(input.input, `${at}.input`);

  let matcher: ToolMatcher;
  if (inputMatcher.kind === "any") {
    exactKeys(inputMatcher, ["kind"], `${at}.input`);
    matcher = { tool, ...(source ? { source } : {}), input: { kind: "any" } };
  } else if (inputMatcher.kind === "exact") {
    exactKeys(inputMatcher, ["kind", "value"], `${at}.input`);
    if (!("value" in inputMatcher) || !isJsonValue(inputMatcher.value)) fail(`${at}.input.value`, "expected JSON data");
    matcher = { tool, ...(source ? { source } : {}), input: { kind: "exact", value: structuredClone(inputMatcher.value) } };
  } else if (inputMatcher.kind === "fields") {
    exactKeys(inputMatcher, ["kind", "fields"], `${at}.input`);
    const fields = record(inputMatcher.fields, `${at}.input.fields`);
    matcher = {
      tool,
      ...(source ? { source } : {}),
      input: {
        kind: "fields",
        fields: Object.fromEntries(
          Object.entries(fields).map(([field, fieldMatcher]) => [field, parseFieldMatcher(fieldMatcher, `${at}.input.fields.${field}`)]),
        ),
      },
    };
  } else {
    fail(`${at}.input.kind`, "expected any, exact, or fields");
  }

  const matcherError = validateToolMatcher(matcher, { scope });
  if (matcherError) fail(at, matcherError);
  return matcher;
}

function parseRule(value: unknown, at: string, scope: RuleScope): Rule {
  const input = record(value, at);
  exactKeys(input, ["id", "action", "matcher"], at);
  if (!ACTIONS.has(input.action as RuleAction)) fail(`${at}.action`, "expected allow, ask, or deny");
  return {
    id: nonEmptyString(input.id, `${at}.id`),
    action: input.action as RuleAction,
    matcher: parseToolMatcher(input.matcher, `${at}.matcher`, scope),
  };
}

function uniqueId(id: string, used: Set<string>): string {
  if (!used.has(id)) {
    used.add(id);
    return id;
  }
  let suffix = 2;
  while (used.has(`${id}-${suffix}`)) suffix += 1;
  const unique = `${id}-${suffix}`;
  used.add(unique);
  return unique;
}

function deduplicateRules(candidates: Rule[], usedIds: Set<string>): Rule[] {
  const byMatcher = new Map<string, Rule>();
  const priority: Record<RuleAction, number> = { allow: 0, ask: 1, deny: 2 };
  for (const candidate of candidates) {
    const key = matcherKey(candidate.matcher);
    const current = byMatcher.get(key);
    if (!current || priority[candidate.action] > priority[current.action]) byMatcher.set(key, candidate);
  }
  return [...byMatcher.values()].map((rule) => ({ ...rule, id: uniqueId(rule.id, usedIds) }));
}

function parseReviewer(value: unknown, at: string): ReviewerConfig {
  const input = record(value, at);
  exactKeys(input, ["provider", "modelId", "thinkingLevel"], at);
  if (!THINKING_LEVELS.has(input.thinkingLevel as ThinkingLevel)) fail(`${at}.thinkingLevel`, "unsupported thinking level");
  return {
    provider: nonEmptyString(input.provider, `${at}.provider`),
    modelId: nonEmptyString(input.modelId, `${at}.modelId`),
    thinkingLevel: input.thinkingLevel as ThinkingLevel,
  };
}

function parseUsageDisplay(value: unknown, at: string): UsageDisplay {
  if (!USAGE_DISPLAYS.has(value as UsageDisplay)) {
    fail(at, "expected detailed, brief, or off");
  }
  return value as UsageDisplay;
}

function parseProjects(
  value: unknown,
  parseProject: (value: unknown, at: string) => ProjectConfig,
): Record<string, ProjectConfig> {
  const projectsInput = record(value, "config.projects");
  const projects: Record<string, ProjectConfig> = {};
  for (const [key, project] of Object.entries(projectsInput)) {
    if (!key.trim()) fail("config.projects", "project key must not be empty");
    if (!path.isAbsolute(key) || path.normalize(key) !== key) fail(`config.projects[${JSON.stringify(key)}]`, "project key must be a normalized absolute path");
    Object.defineProperty(projects, key, {
      value: parseProject(project, `config.projects[${JSON.stringify(key)}]`),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return projects;
}

function parseV2(input: Record<string, unknown>): AutoApprovalConfig {
  exactKeys(input, ["version", "reviewer", "usageDisplay", "globalRules", "projects"], "config");
  if (!Array.isArray(input.globalRules)) fail("config.globalRules", "expected an array");
  const usedIds = new Set<string>();
  const globalRules = input.globalRules.map((rule, index) => parseRule(rule, `config.globalRules[${index}]`, "global"));
  for (const rule of globalRules) {
    if (usedIds.has(rule.id)) fail("config.globalRules", "rule ids must be globally unique");
    usedIds.add(rule.id);
  }
  const projects = parseProjects(input.projects, (project, at) => {
    const projectInput = record(project, at);
    exactKeys(projectInput, ["rules"], at);
    if (!Array.isArray(projectInput.rules)) fail(`${at}.rules`, "expected an array");
    const rules = projectInput.rules.map((rule, index) => parseRule(rule, `${at}.rules[${index}]`, "project"));
    for (const rule of rules) {
      if (usedIds.has(rule.id)) fail(at, "rule ids must be globally unique");
      usedIds.add(rule.id);
    }
    if (new Set(rules.map((rule) => matcherKey(rule.matcher))).size !== rules.length) fail(at, "rule matchers must be unique within a scope");
    return { rules };
  });
  if (new Set(globalRules.map((rule) => matcherKey(rule.matcher))).size !== globalRules.length) {
    fail("config.globalRules", "rule matchers must be unique within a scope");
  }
  return {
    version: 2,
    ...(input.reviewer === undefined ? {} : { reviewer: parseReviewer(input.reviewer, "config.reviewer") }),
    usageDisplay: input.usageDisplay === undefined ? "brief" : parseUsageDisplay(input.usageDisplay, "config.usageDisplay"),
    globalRules,
    projects,
  };
}

function parseLegacyRule(value: unknown, at: string, action: RuleAction): Rule {
  const input = record(value, at);
  exactKeys(input, ["id", "matcher"], at);
  return { id: nonEmptyString(input.id, `${at}.id`), action, matcher: parseToolMatcher(input.matcher, `${at}.matcher`) };
}

function migrateV1(input: Record<string, unknown>): AutoApprovalConfig {
  exactKeys(input, ["version", "reviewer", "globalApprovalRules", "projects"], "config");
  if (input.globalApprovalRules !== undefined && !Array.isArray(input.globalApprovalRules)) {
    fail("config.globalApprovalRules", "expected an array");
  }
  const usedIds = new Set<string>();
  const globalCandidates = (input.globalApprovalRules ?? []).map((rule, index) => {
    const candidate = parseLegacyRule(rule, `config.globalApprovalRules[${index}]`, "allow");
    if (!isToolWideMatcher(candidate.matcher) || !candidate.matcher.source) {
      fail(`config.globalApprovalRules[${index}]`, "expected a source-bound tool-wide matcher");
    }
    return candidate;
  });
  const globalRules = deduplicateRules(globalCandidates, usedIds);
  const projects = parseProjects(input.projects, (project, at) => {
    const projectInput = record(project, at);
    exactKeys(projectInput, ["policyRules", "approvalRules"], at);
    if (!Array.isArray(projectInput.policyRules) || !Array.isArray(projectInput.approvalRules)) {
      fail(at, "expected policyRules and approvalRules arrays");
    }
    const policies = projectInput.policyRules.flatMap((rule, index) => {
      const policy = record(rule, `${at}.policyRules[${index}]`);
      exactKeys(policy, ["id", "matcher", "route"], `${at}.policyRules[${index}]`);
      if (policy.route === "auto_review") return [];
      const action = LEGACY_ROUTES.get(policy.route as string);
      if (!action) fail(`${at}.policyRules[${index}].route`, "expected approve, deny, ask_user, or auto_review");
      return [parseLegacyRule({ id: policy.id, matcher: policy.matcher }, `${at}.policyRules[${index}]`, action)];
    });
    const approvals = projectInput.approvalRules.map((rule, index) => parseLegacyRule(rule, `${at}.approvalRules[${index}]`, "allow"));
    return { rules: deduplicateRules([...policies, ...approvals], usedIds) };
  });
  return {
    version: 2,
    ...(input.reviewer === undefined ? {} : { reviewer: parseReviewer(input.reviewer, "config.reviewer") }),
    usageDisplay: "brief" as const,
    globalRules,
    projects,
  };
}

export function parseAutoApprovalConfig(value: unknown): AutoApprovalConfig {
  const input = record(value, "config");
  if (input.version === 2) return parseV2(input);
  if (input.version === 1) return migrateV1(input);
  return fail("config.version", "expected 1 or 2");
}
