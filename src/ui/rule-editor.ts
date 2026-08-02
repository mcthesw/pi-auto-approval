import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FieldMatcher, JsonValue, ToolMatcher, ToolSourceIdentity } from "../domain.ts";
import { parseToolMatcher } from "../config/schema.ts";
import { isJsonValue, isToolWideMatcher, validateToolMatcher } from "../matchers.ts";
import { tokenizeSingleCommand } from "../policy/bash.ts";

const STANDARD_TOOLS = new Set(["bash", "read", "write", "edit", "grep", "find", "ls"]);
const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);

export type RuleScope = "project" | "global";
export type EditedApprovalRule = { matcher: ToolMatcher; scope: RuleScope };

function valueSummary(value: JsonValue): string {
  if (typeof value === "string") return value.length <= 72 ? JSON.stringify(value) : `${JSON.stringify(value.slice(0, 69))}…`;
  if (Array.isArray(value)) return `${value.length} items`;
  if (typeof value === "object" && value !== null) return `${Object.keys(value).length} fields`;
  return String(value);
}

function fieldSummary(field: string, matcher: FieldMatcher): string {
  if (matcher.kind === "exact") return `${field} = ${valueSummary(matcher.value)}`;
  if (matcher.kind === "tokenPrefix") return `${field} starts with: ${matcher.tokens.join(" ")}`;
  return `${field} matches: ${matcher.pattern}`;
}

export function matcherSummary(matcher: ToolMatcher): string {
  if (isToolWideMatcher(matcher)) return `${matcher.tool} · All inputs`;
  if (matcher.input.kind === "exact") {
    const input = objectInput(matcher.input.value);
    const fields = input
      ? Object.entries(input).slice(0, 4).map(([field, value]) => `${field}: ${valueSummary(value)}`).join("; ")
      : valueSummary(matcher.input.value);
    return `${matcher.tool} · Exact call${fields ? ` · ${fields}` : ""}`;
  }
  return `${matcher.tool} · ${Object.entries(matcher.input.fields).map(([field, value]) => fieldSummary(field, value)).join("; ")}`;
}

export function matcherDetails(matcher: ToolMatcher, scope: RuleScope = "project"): string {
  const lines = [`Tool: ${matcher.tool}`, `Scope: ${scope === "global" ? "Global (all projects)" : "Current project"}`];
  if (isToolWideMatcher(matcher)) {
    lines.push("Match: All inputs", `Source: ${matcher.source.source} · ${matcher.source.path}`);
  } else if (matcher.input.kind === "exact") {
    lines.push("Match: Exact call");
    if (typeof matcher.input.value === "object" && matcher.input.value !== null && !Array.isArray(matcher.input.value)) {
      for (const [field, value] of Object.entries(matcher.input.value)) lines.push(`  ${field}: ${valueSummary(value)}`);
    } else lines.push(`  Input: ${valueSummary(matcher.input.value)}`);
  } else {
    lines.push("Match: Selected constraints");
    for (const [field, value] of Object.entries(matcher.input.fields)) lines.push(`  ${fieldSummary(field, value)}`);
  }
  return lines.join("\n");
}

function objectInput(value: unknown): Record<string, JsonValue> | undefined {
  if (!isJsonValue(value) || typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value;
}

function sourceMatches(left: ToolSourceIdentity, right: ToolSourceIdentity): boolean {
  return left.source === right.source && left.path === right.path;
}

async function editJsonValue(ctx: ExtensionContext, title: string, initial: JsonValue): Promise<JsonValue | undefined> {
  let source = JSON.stringify(initial, null, 2);
  for (;;) {
    const edited = await ctx.ui.editor(title, source);
    if (edited === undefined) return undefined;
    source = edited;
    try {
      const value: unknown = JSON.parse(edited);
      if (!isJsonValue(value)) throw new Error("Value must be JSON data");
      return value;
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }
}

async function editField(ctx: ExtensionContext, tool: string, field: string, initial?: FieldMatcher): Promise<FieldMatcher | undefined> {
  const options = ["Exact value"];
  if (tool === "bash" && field === "command") options.push("Command prefix");
  if (PATH_TOOLS.has(tool) && field === "path") options.push("Project path pattern");
  const current = initial?.kind === "tokenPrefix"
    ? "Command prefix"
    : initial?.kind === "pathGlob" ? "Project path pattern" : "Exact value";
  const selected = await ctx.ui.select(`Constraint: ${field}\nCurrent: ${current}`, options);
  if (!selected) return undefined;
  if (selected === "Command prefix") {
    const edited = await ctx.ui.editor("Command prefix", initial?.kind === "tokenPrefix" ? initial.tokens.join(" ") : "");
    if (edited === undefined) return undefined;
    const tokens = tokenizeSingleCommand(edited.trim());
    if (!tokens?.length) {
      ctx.ui.notify("Command prefix must be one conservatively parsed command", "error");
      return undefined;
    }
    return { kind: "tokenPrefix", tokens };
  }
  if (selected === "Project path pattern") {
    const edited = await ctx.ui.editor("Project-relative path glob", initial?.kind === "pathGlob" ? initial.pattern : "src/**");
    return edited?.trim() ? { kind: "pathGlob", pattern: edited.trim() } : undefined;
  }
  const value = await editJsonValue(ctx, `Exact value for ${field}`, initial?.kind === "exact" ? initial.value : "");
  return value === undefined ? undefined : { kind: "exact", value };
}

async function chooseField(ctx: ExtensionContext, matcher: ToolMatcher, exactInput?: unknown): Promise<string | undefined> {
  const input = !isToolWideMatcher(matcher) && matcher.input.kind === "exact"
    ? objectInput(matcher.input.value)
    : objectInput(exactInput);
  const current = !isToolWideMatcher(matcher) && matcher.input.kind === "fields" ? Object.keys(matcher.input.fields) : [];
  const available = Object.keys(input ?? {}).filter((field) => !current.includes(field));
  const custom = "Enter another field name";
  const selected = await ctx.ui.select("Add constraint", [...available, custom, "Cancel"]);
  if (!selected || selected === "Cancel") return undefined;
  if (selected !== custom) return selected;
  return (await ctx.ui.input("Field name"))?.trim() || undefined;
}

async function editConstraints(ctx: ExtensionContext, matcher: ToolMatcher, exactInput?: unknown): Promise<ToolMatcher> {
  if (isToolWideMatcher(matcher) || matcher.input.kind !== "fields") return matcher;
  for (;;) {
    const entries = Object.entries(matcher.input.fields);
    const labels = ["Add constraint", ...entries.map(([field, value]) => fieldSummary(field, value)), "Back"];
    const selected = await ctx.ui.select(`Constraints for ${matcher.tool}`, labels);
    if (!selected || selected === "Back") return matcher;
    if (selected === "Add constraint") {
      const field = await chooseField(ctx, matcher, exactInput);
      if (!field) continue;
      const initialValue = objectInput(exactInput)?.[field];
      const edited = await editField(ctx, matcher.tool, field, initialValue === undefined ? undefined : { kind: "exact", value: initialValue });
      if (edited) matcher.input.fields[field] = edited;
      continue;
    }
    const index = labels.indexOf(selected) - 1;
    const entry = entries[index];
    if (!entry) continue;
    const action = await ctx.ui.select(fieldSummary(entry[0], entry[1]), ["Edit", "Remove", "Back"]);
    if (action === "Edit") {
      const edited = await editField(ctx, matcher.tool, entry[0], entry[1]);
      if (edited) matcher.input.fields[entry[0]] = edited;
    } else if (action === "Remove") delete matcher.input.fields[entry[0]];
  }
}

export async function editApprovalRule(
  ctx: ExtensionContext,
  options: {
    initial: ToolMatcher;
    initialScope?: RuleScope;
    toolSource?: ToolSourceIdentity;
    exactInput?: unknown;
    validate?: (matcher: ToolMatcher) => Promise<string | undefined>;
  },
): Promise<EditedApprovalRule | undefined> {
  let matcher = structuredClone(options.initial);
  let scope: RuleScope = options.initialScope ?? "project";
  for (;;) {
    const actions = ["Change match type", "Edit constraints"];
    if (isToolWideMatcher(matcher)) actions.push(`Scope: ${scope === "global" ? "Global" : "Current project"}`);
    actions.push("Advanced JSON", "Save rule", "Cancel");
    const action = await ctx.ui.select(matcherDetails(matcher, scope), actions);
    if (!action || action === "Cancel") return undefined;

    if (action === "Change match type") {
      const types = ["Exact call"];
      if (STANDARD_TOOLS.has(matcher.tool)) types.push("Selected constraints");
      if (options.toolSource && !STANDARD_TOOLS.has(matcher.tool) && options.toolSource.source !== "builtin") types.push("All inputs");
      const selected = await ctx.ui.select("Match type", types);
      if (selected === "Exact call") {
        const exact = !isToolWideMatcher(matcher) && matcher.input.kind === "exact"
          ? matcher.input.value
          : objectInput(options.exactInput);
        if (exact === undefined) ctx.ui.notify("No exact input is available", "warning");
        else {
          matcher = { tool: matcher.tool, input: { kind: "exact", value: structuredClone(exact) } };
          scope = "project";
        }
      } else if (selected === "Selected constraints") {
        const exact = !isToolWideMatcher(matcher) && matcher.input.kind === "exact"
          ? objectInput(matcher.input.value)
          : objectInput(options.exactInput);
        matcher = {
          tool: matcher.tool,
          input: {
            kind: "fields",
            fields: Object.fromEntries(Object.entries(exact ?? {}).map(([field, value]) => [field, { kind: "exact", value }])),
          },
        };
        scope = "project";
      } else if (selected === "All inputs" && options.toolSource) {
        matcher = { tool: matcher.tool, source: structuredClone(options.toolSource), input: { kind: "any" } };
      }
    } else if (action === "Edit constraints") {
      if (isToolWideMatcher(matcher)) ctx.ui.notify("All inputs has no field constraints", "info");
      else if (matcher.input.kind === "exact") {
        const edited = await editJsonValue(ctx, "Exact Tool input", matcher.input.value);
        if (edited !== undefined) matcher.input.value = edited;
      } else matcher = await editConstraints(ctx, matcher, options.exactInput);
    } else if (action.startsWith("Scope:")) {
      scope = scope === "project" ? "global" : "project";
    } else if (action === "Advanced JSON") {
      let source = JSON.stringify(matcher, null, 2);
      for (;;) {
        const edited = await ctx.ui.editor("Advanced matcher JSON", source);
        if (edited === undefined) break;
        source = edited;
        try {
          const parsed = parseToolMatcher(JSON.parse(edited));
          if (parsed.tool !== options.initial.tool) throw new Error("Tool name cannot be changed here");
          if (isToolWideMatcher(parsed) && (!options.toolSource || !sourceMatches(parsed.source, options.toolSource))) {
            throw new Error("All-input rules must use the current Tool source");
          }
          matcher = parsed;
          if (!isToolWideMatcher(matcher)) scope = "project";
          break;
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
      }
    } else if (action === "Save rule") {
      const error = validateToolMatcher(matcher) ?? await options.validate?.(matcher);
      if (error) ctx.ui.notify(error, "error");
      else return { matcher, scope };
    }
  }
}
