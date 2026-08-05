import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FieldMatcher, JsonValue, ToolMatcher, ToolSourceIdentity } from "../domain.ts";
import { parseToolMatcher } from "../config/schema.ts";
import { isJsonValue, validateToolMatcher, type RuleScope } from "../matchers.ts";
import { tokenizeSingleCommand } from "../policy/bash.ts";
import { RuleActionComponent, type RuleAction } from "./rule-action-component.ts";

const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);

export type { RuleScope } from "../matchers.ts";
export type EditedRuleMatcher = { matcher: ToolMatcher; scope: RuleScope };

function displayToolName(tool: string): string {
  if (tool === "bash") return "Bash";
  if (["read", "write", "edit", "grep", "find", "ls"].includes(tool)) return `${tool[0]!.toUpperCase()}${tool.slice(1)}`;
  return tool.replace(/^([^_]+)_/, "$1:").replaceAll("_", "-");
}

function valueSummary(value: JsonValue): string {
  if (typeof value === "string") return value.length <= 72 ? JSON.stringify(value) : `${JSON.stringify(value.slice(0, 69))}…`;
  if (Array.isArray(value)) return `${value.length} items`;
  if (typeof value === "object" && value !== null) return `${Object.keys(value).length} fields`;
  return String(value);
}

function fieldSummary(field: string, matcher: FieldMatcher): string {
  if (matcher.kind === "exact") return `${field} = ${valueSummary(matcher.value)}`;
  if (matcher.kind === "tokenPrefix") return `${field} starts with ${matcher.tokens.join(" ")} *`;
  return `${field} matches ${matcher.pattern}`;
}

export function matcherSummary(matcher: ToolMatcher): string {
  const tool = displayToolName(matcher.tool);
  if (matcher.input.kind === "any") return tool;
  if (matcher.input.kind === "exact") {
    const input = objectInput(matcher.input.value);
    if (matcher.tool === "bash" && typeof input?.command === "string") return `Bash(${input.command})`;
    const fields = input
      ? Object.entries(input).slice(0, 2).map(([field, value]) => `${field}: ${valueSummary(value)}`).join("; ")
      : valueSummary(matcher.input.value);
    return `${tool}(${fields})`;
  }
  if (matcher.tool === "bash" && Object.keys(matcher.input.fields).length === 1) {
    const command = matcher.input.fields.command;
    if (command?.kind === "tokenPrefix") return `Bash(${command.tokens.join(" ")} *)`;
  }
  return `${tool}(${Object.entries(matcher.input.fields).map(([field, value]) => fieldSummary(field, value)).join("; ")})`;
}

export function matcherDetails(matcher: ToolMatcher, scope: RuleScope = "project"): string {
  const lines = [
    `Tool: ${displayToolName(matcher.tool)}`,
    `Scope: ${scope === "global" ? "Global (all projects)" : "Current project"}`,
  ];
  if (matcher.source) lines.push(`Source: ${matcher.source.source} · ${matcher.source.path}`);
  if (matcher.input.kind === "any") lines.push("Match: All calls");
  else if (matcher.input.kind === "exact") {
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
  if (PATH_TOOLS.has(tool) && field === "path") options.push("Path pattern");
  const current = initial?.kind === "tokenPrefix"
    ? "Command prefix"
    : initial?.kind === "pathGlob" ? "Path pattern" : "Exact value";
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
  if (selected === "Path pattern") {
    const edited = await ctx.ui.editor("Path glob", initial?.kind === "pathGlob" ? initial.pattern : "src/**");
    return edited?.trim() ? { kind: "pathGlob", pattern: edited.trim() } : undefined;
  }
  const value = await editJsonValue(ctx, `Exact value for ${field}`, initial?.kind === "exact" ? initial.value : "");
  return value === undefined ? undefined : { kind: "exact", value };
}

async function chooseField(ctx: ExtensionContext, matcher: ToolMatcher, exactInput?: unknown): Promise<string | undefined> {
  const input = matcher.input.kind === "exact" ? objectInput(matcher.input.value) : objectInput(exactInput);
  const current = matcher.input.kind === "fields" ? Object.keys(matcher.input.fields) : [];
  const available = Object.keys(input ?? {}).filter((field) => !current.includes(field));
  const selected = await ctx.ui.select("Add constraint", [...available, "Enter another field name", "Cancel"]);
  if (!selected || selected === "Cancel") return undefined;
  if (selected !== "Enter another field name") return selected;
  return (await ctx.ui.input("Field name"))?.trim() || undefined;
}

async function editConstraints(ctx: ExtensionContext, matcher: ToolMatcher, exactInput?: unknown): Promise<ToolMatcher> {
  if (matcher.input.kind !== "fields") return matcher;
  for (;;) {
    const entries = Object.entries(matcher.input.fields);
    const labels = ["Add constraint", ...entries.map(([field, value]) => fieldSummary(field, value)), "Back"];
    const selected = await ctx.ui.select(`Constraints for ${displayToolName(matcher.tool)}`, labels);
    if (!selected || selected === "Back") return matcher;
    if (selected === "Add constraint") {
      const field = await chooseField(ctx, matcher, exactInput);
      if (!field) continue;
      const initial = objectInput(exactInput)?.[field];
      const edited = await editField(ctx, matcher.tool, field, initial === undefined ? undefined : { kind: "exact", value: initial });
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

async function selectRuleAction(
  ctx: ExtensionContext,
  detail: string,
  scope: RuleScope,
): Promise<{ action: RuleAction; scope: RuleScope } | undefined> {
  if (ctx.mode !== "tui") {
    const actions = ["Change match type", "Edit constraints", `Scope: ${scope === "global" ? "Global" : "Current project"}`, "Advanced JSON", "Save rule", "Cancel"];
    const selected = await ctx.ui.select(detail, actions);
    if (!selected) return undefined;
    return {
      action: selected.startsWith("Scope:") ? "Scope" : selected as RuleAction,
      scope: selected.startsWith("Scope:") ? (scope === "project" ? "global" : "project") : scope,
    };
  }
  return await ctx.ui.custom<{ action: RuleAction; scope: RuleScope }>((tui, theme, _keybindings, done) =>
    new RuleActionComponent(tui, theme, done, { detail, allowScope: true, scope }),
  );
}

export async function editRuleMatcher(
  ctx: ExtensionContext,
  options: {
    initial: ToolMatcher;
    initialScope?: RuleScope;
    toolSource?: ToolSourceIdentity;
    exactInput?: unknown;
    validate?: (matcher: ToolMatcher, scope: RuleScope) => Promise<string | undefined>;
  },
): Promise<EditedRuleMatcher | undefined> {
  let matcher = structuredClone(options.initial);
  if (options.toolSource && !matcher.source) matcher.source = structuredClone(options.toolSource);
  let scope: RuleScope = options.initialScope ?? "project";
  for (;;) {
    const selected = await selectRuleAction(ctx, matcherDetails(matcher, scope), scope);
    if (!selected || selected.action === "Cancel") return undefined;
    scope = selected.scope;
    if (selected.action === "Change match type") {
      const type = await ctx.ui.select("Match type", ["All calls", "Exact call", "Selected constraints"]);
      const source = matcher.source;
      if (type === "All calls") matcher = { tool: matcher.tool, ...(source ? { source } : {}), input: { kind: "any" } };
      else if (type === "Exact call") {
        const exact = matcher.input.kind === "exact" ? matcher.input.value : objectInput(options.exactInput);
        if (exact === undefined) ctx.ui.notify("No exact input is available", "warning");
        else matcher = { tool: matcher.tool, ...(source ? { source } : {}), input: { kind: "exact", value: structuredClone(exact) } };
      } else if (type === "Selected constraints") {
        const exact = matcher.input.kind === "exact" ? objectInput(matcher.input.value) : objectInput(options.exactInput);
        matcher = {
          tool: matcher.tool,
          ...(source ? { source } : {}),
          input: { kind: "fields", fields: Object.fromEntries(Object.entries(exact ?? {}).map(([field, value]) => [field, { kind: "exact", value }])) },
        };
      }
    } else if (selected.action === "Edit constraints") {
      if (matcher.input.kind === "any") ctx.ui.notify("All calls has no constraints", "info");
      else if (matcher.input.kind === "exact") {
        const edited = await editJsonValue(ctx, "Exact Tool input", matcher.input.value);
        if (edited !== undefined) matcher.input.value = edited;
      } else matcher = await editConstraints(ctx, matcher, options.exactInput);
    } else if (selected.action === "Advanced JSON") {
      let source = JSON.stringify(matcher, null, 2);
      for (;;) {
        const edited = await ctx.ui.editor("Advanced matcher JSON", source);
        if (edited === undefined) break;
        source = edited;
        try {
          const parsed = parseToolMatcher(JSON.parse(edited), "matcher", scope);
          if (parsed.tool !== options.initial.tool) throw new Error("Tool name cannot be changed here");
          matcher = options.toolSource ? { ...parsed, source: structuredClone(options.toolSource) } : parsed;
          break;
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
      }
    } else if (selected.action === "Save rule") {
      const error = validateToolMatcher(matcher, { scope }) ?? await options.validate?.(matcher, scope);
      if (error) ctx.ui.notify(error, "error");
      else return { matcher, scope };
    }
  }
}
