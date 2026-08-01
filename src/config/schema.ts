import path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  ApprovalRule,
  AutoApprovalConfig,
  DecisionRoute,
  FieldMatcher,
  PolicyRule,
  ProjectConfig,
  ReviewerConfig,
  ToolMatcher,
} from "../domain.ts";
import { isJsonValue, validateToolMatcher } from "../matchers.ts";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);
const ROUTES = new Set<DecisionRoute>(["approve", "deny", "ask_user", "auto_review"]);

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

function fail(path: string, message: string): never {
  throw new ConfigValidationError(`${path}: ${message}`);
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

export function parseToolMatcher(value: unknown, at = "matcher"): ToolMatcher {
  const input = record(value, at);
  exactKeys(input, ["tool", "input"], at);
  const tool = nonEmptyString(input.tool, `${at}.tool`);
  const inputMatcher = record(input.input, `${at}.input`);

  let matcher: ToolMatcher;
  if (inputMatcher.kind === "exact") {
    exactKeys(inputMatcher, ["kind", "value"], `${at}.input`);
    if (!("value" in inputMatcher) || !isJsonValue(inputMatcher.value)) fail(`${at}.input.value`, "expected JSON data");
    matcher = { tool, input: { kind: "exact", value: structuredClone(inputMatcher.value) } };
  } else if (inputMatcher.kind === "fields") {
    exactKeys(inputMatcher, ["kind", "fields"], `${at}.input`);
    const fields = record(inputMatcher.fields, `${at}.input.fields`);
    matcher = {
      tool,
      input: {
        kind: "fields",
        fields: Object.fromEntries(
          Object.entries(fields).map(([field, fieldMatcher]) => [field, parseFieldMatcher(fieldMatcher, `${at}.input.fields.${field}`)]),
        ),
      },
    };
  } else {
    fail(`${at}.input.kind`, "expected exact or fields");
  }

  const matcherError = validateToolMatcher(matcher);
  if (matcherError) fail(at, matcherError);
  return matcher;
}

export function parseApprovalRule(value: unknown, at = "approvalRule"): ApprovalRule {
  const input = record(value, at);
  exactKeys(input, ["id", "matcher"], at);
  return { id: nonEmptyString(input.id, `${at}.id`), matcher: parseToolMatcher(input.matcher, `${at}.matcher`) };
}

export function parsePolicyRule(value: unknown, at = "policyRule"): PolicyRule {
  const input = record(value, at);
  exactKeys(input, ["id", "matcher", "route"], at);
  if (!ROUTES.has(input.route as DecisionRoute)) fail(`${at}.route`, "expected approve, deny, ask_user, or auto_review");
  return {
    id: nonEmptyString(input.id, `${at}.id`),
    matcher: parseToolMatcher(input.matcher, `${at}.matcher`),
    route: input.route as DecisionRoute,
  };
}

function parseProject(value: unknown, at: string): ProjectConfig {
  const input = record(value, at);
  exactKeys(input, ["policyRules", "approvalRules"], at);
  if (!Array.isArray(input.policyRules)) fail(`${at}.policyRules`, "expected an array");
  if (!Array.isArray(input.approvalRules)) fail(`${at}.approvalRules`, "expected an array");
  const policyRules = input.policyRules.map((rule, index) => parsePolicyRule(rule, `${at}.policyRules[${index}]`));
  const approvalRules = input.approvalRules.map((rule, index) => parseApprovalRule(rule, `${at}.approvalRules[${index}]`));
  const ids = [...policyRules, ...approvalRules].map((rule) => rule.id);
  if (new Set(ids).size !== ids.length) fail(at, "rule ids must be unique within a project");
  return { policyRules, approvalRules };
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

export function parseAutoApprovalConfig(value: unknown): AutoApprovalConfig {
  const input = record(value, "config");
  exactKeys(input, ["version", "reviewer", "projects"], "config");
  if (input.version !== 1) fail("config.version", "expected 1");
  const projectsInput = record(input.projects, "config.projects");
  const projects: Record<string, ProjectConfig> = {};
  for (const [key, project] of Object.entries(projectsInput)) {
    if (!key.trim()) fail("config.projects", "project key must not be empty");
    if (!path.isAbsolute(key) || path.normalize(key) !== key) fail(`config.projects[${JSON.stringify(key)}]`, "project key must be a normalized absolute path");
    if (process.platform === "win32" && key !== key.toLowerCase()) fail(`config.projects[${JSON.stringify(key)}]`, "Windows project keys must use canonical lowercase form");
    Object.defineProperty(projects, key, {
      value: parseProject(project, `config.projects[${JSON.stringify(key)}]`),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return {
    version: 1,
    ...(input.reviewer === undefined ? {} : { reviewer: parseReviewer(input.reviewer, "config.reviewer") }),
    projects,
  };
}
