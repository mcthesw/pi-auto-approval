import os from "node:os";
import path from "node:path";
import { minimatch } from "minimatch";
import type { FieldMatcher, JsonValue, ToolCall, ToolMatcher, ToolSourceIdentity } from "./domain.ts";

const KNOWN_TOOLS = new Set(["bash", "read", "write", "edit", "grep", "find", "ls"]);
const PATH_FIELDS = new Map<string, ReadonlySet<string>>([
  ["read", new Set(["path"])],
  ["write", new Set(["path"])],
  ["edit", new Set(["path"])],
  ["grep", new Set(["path"])],
  ["find", new Set(["path"])],
  ["ls", new Set(["path"])],
]);

export type RuleScope = "project" | "global";

export type MatcherContext = {
  resolvePath: (value: string) => Promise<{ inside: boolean; relative?: string; canonical: string }>;
  tokenizeBash: (command: string) => string[] | undefined;
  source?: ToolSourceIdentity;
  scope?: RuleScope;
};

export function isStandardToolName(name: string): boolean {
  return KNOWN_TOOLS.has(name);
}

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

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function equalJson(left: unknown, right: JsonValue): boolean {
  return canonicalJson(left) === canonicalJson(right) && isJsonValue(left);
}

function isHomePattern(pattern: string): boolean {
  return pattern === "~" || pattern.startsWith("~/") || pattern.startsWith("~\\");
}

function isAbsolutePattern(pattern: string): boolean {
  return path.isAbsolute(pattern) || /^[A-Za-z]:[\\/]/.test(pattern) || /^\\\\/.test(pattern);
}

export function isGlobalPathPattern(pattern: string): boolean {
  return isHomePattern(pattern) || isAbsolutePattern(pattern);
}

function expandHomePattern(pattern: string): string {
  if (!isHomePattern(pattern)) return pattern;
  return pattern === "~" ? os.homedir() : path.join(os.homedir(), pattern.slice(2));
}

function posixPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function normalizedAbsolutePattern(pattern: string): string {
  return posixPath(path.normalize(path.resolve(expandHomePattern(pattern))));
}

export function validatePathGlob(pattern: string, scope: RuleScope = "project"): string | undefined {
  if (!pattern.trim()) return "pathGlob pattern must not be empty";
  const global = isGlobalPathPattern(pattern);
  if (scope === "global") {
    if (!global) return "Global pathGlob must be absolute or home-anchored";
    return undefined;
  }
  if (global) return "Project pathGlob must be project-relative";
  if (posixPath(pattern).split("/").includes("..")) return "pathGlob must not traverse outside the project";
  return undefined;
}

function validateFieldMatcher(
  tool: string,
  field: string,
  matcher: FieldMatcher,
  scope: RuleScope,
): string | undefined {
  if (matcher.kind === "exact") return isJsonValue(matcher.value) ? undefined : "exact matcher value must be JSON";
  if (matcher.kind === "tokenPrefix") {
    if (tool !== "bash" || field !== "command") return "tokenPrefix is only valid for bash.command";
    if (!matcher.tokens.length || matcher.tokens.some((token) => !token)) return "tokenPrefix requires non-empty tokens";
    return undefined;
  }
  if (matcher.kind === "pathGlob") {
    if (!PATH_FIELDS.get(tool)?.has(field)) return `pathGlob is not valid for ${tool}.${field}`;
    return validatePathGlob(matcher.pattern, scope);
  }
  return "unknown field matcher";
}

export function isToolWideMatcher(matcher: ToolMatcher): boolean {
  return matcher.input.kind === "any";
}

export function validateToolMatcher(matcher: ToolMatcher, options: { scope?: RuleScope } = {}): string | undefined {
  const scope = options.scope ?? "project";
  if (!matcher.tool.trim()) return "matcher tool must not be empty";
  if (matcher.source && isStandardToolName(matcher.tool)) return "standard tools cannot be source-bound";
  if (matcher.source && (!matcher.source.source.trim() || !matcher.source.path.trim())) return "matcher source must not be empty";
  if (matcher.input.kind === "any") return undefined;
  if (matcher.input.kind === "exact") return isJsonValue(matcher.input.value) ? undefined : "exact input matcher value must be JSON";
  const entries = Object.entries(matcher.input.fields);
  if (!entries.length) return "fields matcher must contain at least one field";
  for (const [field, fieldMatcher] of entries) {
    const error = validateFieldMatcher(matcher.tool, field, fieldMatcher, scope);
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
  const pattern = matcher.pattern;
  if (isGlobalPathPattern(pattern)) {
    return minimatch(posixPath(resolved.canonical), normalizedAbsolutePattern(pattern), {
      dot: true,
      matchBase: false,
      nocase: false,
      nocomment: true,
      nonegate: true,
      platform: "linux",
    });
  }
  return Boolean(resolved.inside && resolved.relative && minimatch(posixPath(resolved.relative), posixPath(pattern), {
    dot: true,
    matchBase: false,
    nocase: false,
    nocomment: true,
    nonegate: true,
    platform: "linux",
  }));
}

export async function matchesToolCall(
  matcher: ToolMatcher,
  call: ToolCall,
  context: MatcherContext,
): Promise<boolean> {
  if (validateToolMatcher(matcher, { scope: context.scope ?? "project" }) || matcher.tool !== call.name) return false;
  if (matcher.source && (context.source?.source !== matcher.source.source || context.source?.path !== matcher.source.path)) return false;
  if (matcher.input.kind === "any") return true;
  if (matcher.input.kind === "exact") return equalJson(call.input, matcher.input.value);
  if (!isRecord(call.input)) return false;

  for (const [field, fieldMatcher] of Object.entries(matcher.input.fields)) {
    if (!(await matchesField(call.name, field, fieldMatcher, call.input[field], context))) return false;
  }
  return true;
}

export function exactMatcherFor(call: ToolCall, source?: ToolSourceIdentity): ToolMatcher | undefined {
  if (!isJsonValue(call.input)) return undefined;
  return { tool: call.name, ...(source ? { source: structuredClone(source) } : {}), input: { kind: "exact", value: structuredClone(call.input) } };
}

export function matcherKey(matcher: ToolMatcher): string {
  return canonicalJson(matcher);
}

export function pathFieldForTool(tool: string): string | undefined {
  return PATH_FIELDS.get(tool)?.values().next().value;
}

export function normalizeProjectRelativePattern(value: string): string {
  return posixPath(value);
}
