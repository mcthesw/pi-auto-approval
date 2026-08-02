import path from "node:path";
import { minimatch } from "minimatch";
import type { FieldMatcher, JsonValue, ToolCall, ToolMatcher, ToolSourceIdentity, ToolWideMatcher } from "./domain.ts";

const KNOWN_TOOLS = new Set(["bash", "read", "write", "edit", "grep", "find", "ls"]);
const PATH_FIELDS = new Map<string, ReadonlySet<string>>([
  ["read", new Set(["path"])],
  ["write", new Set(["path"])],
  ["edit", new Set(["path"])],
  ["grep", new Set(["path"])],
  ["find", new Set(["path"])],
  ["ls", new Set(["path"])],
]);

export type MatcherContext = {
  resolvePath: (value: string) => Promise<{ inside: boolean; relative?: string }>;
  tokenizeBash: (command: string) => string[] | undefined;
  source?: ToolSourceIdentity;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function equalJson(left: unknown, right: JsonValue): boolean {
  if (!isJsonValue(left)) return false;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return left === right;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((v, i) => equalJson(v, right[i]!));
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && rightKeys.every((key) => Object.hasOwn(left, key) && equalJson(left[key], right[key]!));
}

export function validatePathGlob(pattern: string): string | undefined {
  if (!pattern.trim()) return "pathGlob pattern must not be empty";
  const normalized = pattern.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return "pathGlob must be project-relative";
  if (normalized.split("/").includes("..")) return "pathGlob must not traverse outside the project";
  return undefined;
}

function validateFieldMatcher(tool: string, field: string, matcher: FieldMatcher): string | undefined {
  if (matcher.kind === "exact") return isJsonValue(matcher.value) ? undefined : "exact matcher value must be JSON";
  if (matcher.kind === "tokenPrefix") {
    if (tool !== "bash" || field !== "command") return "tokenPrefix is only valid for bash.command";
    if (!matcher.tokens.length || matcher.tokens.some((token) => !token)) return "tokenPrefix requires non-empty tokens";
    return undefined;
  }
  if (matcher.kind === "pathGlob") {
    if (!PATH_FIELDS.get(tool)?.has(field)) return `pathGlob is not valid for ${tool}.${field}`;
    return validatePathGlob(matcher.pattern);
  }
  return "unknown field matcher";
}

export function isToolWideMatcher(matcher: ToolMatcher): matcher is ToolWideMatcher {
  return matcher.input.kind === "any";
}

export function validateToolMatcher(matcher: ToolMatcher): string | undefined {
  if (!matcher.tool.trim()) return "matcher tool must not be empty";
  if (isToolWideMatcher(matcher)) {
    if (!matcher.source.source.trim() || !matcher.source.path.trim()) return "tool-wide matcher source must not be empty";
    if (matcher.source.source === "builtin") return "built-in tools cannot use tool-wide approval";
    return undefined;
  }
  if (matcher.input.kind === "exact") {
    return isJsonValue(matcher.input.value) ? undefined : "exact input matcher value must be JSON";
  }
  if (!KNOWN_TOOLS.has(matcher.tool)) return "custom tools require an exact whole-input matcher";
  const entries = Object.entries(matcher.input.fields);
  if (!entries.length) return "fields matcher must contain at least one field";
  for (const [field, fieldMatcher] of entries) {
    const error = validateFieldMatcher(matcher.tool, field, fieldMatcher);
    if (error) return error;
  }
  return undefined;
}

async function matchesField(
  tool: string,
  field: string,
  matcher: FieldMatcher,
  actual: unknown,
  context: MatcherContext,
): Promise<boolean> {
  if (matcher.kind === "exact") return equalJson(actual, matcher.value);
  if (typeof actual !== "string") return false;
  if (matcher.kind === "tokenPrefix") {
    const tokens = context.tokenizeBash(actual);
    return Boolean(tokens && matcher.tokens.every((token, index) => tokens[index] === token));
  }

  const resolved = await context.resolvePath(actual);
  if (!resolved.inside || !resolved.relative) return false;
  return minimatch(resolved.relative, matcher.pattern.replaceAll("\\", "/"), {
    dot: true,
    matchBase: false,
    nocase: false,
    nocomment: true,
    nonegate: true,
    platform: "linux",
  });
}

export async function matchesToolCall(
  matcher: ToolMatcher,
  call: ToolCall,
  context: MatcherContext,
): Promise<boolean> {
  if (validateToolMatcher(matcher) || matcher.tool !== call.name) return false;
  if (isToolWideMatcher(matcher)) {
    return context.source?.source === matcher.source.source && context.source?.path === matcher.source.path;
  }
  if (matcher.input.kind === "exact") return equalJson(call.input, matcher.input.value);
  if (!isRecord(call.input)) return false;

  for (const [field, fieldMatcher] of Object.entries(matcher.input.fields)) {
    if (!(await matchesField(call.name, field, fieldMatcher, call.input[field], context))) return false;
  }
  return true;
}

export function exactMatcherFor(call: ToolCall): ToolMatcher | undefined {
  if (!isJsonValue(call.input)) return undefined;
  return { tool: call.name, input: { kind: "exact", value: structuredClone(call.input) } };
}

export function pathFieldForTool(tool: string): string | undefined {
  return PATH_FIELDS.get(tool)?.values().next().value;
}

export function normalizeProjectRelativePattern(value: string): string {
  return value.split(path.sep).join("/");
}
