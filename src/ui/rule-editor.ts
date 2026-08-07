import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FieldMatcher, JsonValue, RuleAction, ToolMatcher, ToolSourceIdentity } from "../domain.ts";
import { parseToolMatcher } from "../config/schema.ts";
import { isJsonValue, isStandardToolName, validateToolMatcher, type RuleScope } from "../matchers.ts";
import { tokenizeSingleCommand } from "../policy/bash.ts";
import { RuleEditorComponent, type RuleEditorResult, type RuleMatchKind } from "./rule-editor-component.ts";
import { singleLine } from "./text.ts";

const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);

export type { RuleScope } from "../matchers.ts";
export type EditedRule = { action: RuleAction; matcher: ToolMatcher; scope: RuleScope };

export function actionLabel(action: RuleAction): string {
  return action === "allow" ? "Allow" : action === "ask" ? "Ask" : "Deny";
}

function displayToolName(tool: string): string {
  if (tool === "bash") return "Bash";
  if (["read", "write", "edit", "grep", "find", "ls"].includes(tool)) return `${tool[0]!.toUpperCase()}${tool.slice(1)}`;
  return singleLine(tool.replace(/^([^_]+)_/, "$1:").replaceAll("_", "-"));
}

function valueSummary(value: JsonValue): string {
  if (typeof value === "string") return value.length <= 72 ? JSON.stringify(value) : `${JSON.stringify(value.slice(0, 69))}…`;
  if (Array.isArray(value)) return `${value.length} items`;
  if (typeof value === "object" && value !== null) return `${Object.keys(value).length} fields`;
  return String(value);
}

function fieldSummary(field: string, matcher: FieldMatcher): string {
  const name = singleLine(field);
  if (matcher.kind === "exact") return `${name} = ${valueSummary(matcher.value)}`;
  if (matcher.kind === "tokenPrefix") return `${name} starts with ${matcher.tokens.join(" ")} *`;
  return `${name} matches ${singleLine(matcher.pattern)}`;
}

export function matcherSummary(matcher: ToolMatcher): string {
  const tool = displayToolName(matcher.tool);
  if (matcher.input.kind === "any") return tool;
  if (matcher.input.kind === "exact") {
    const input = objectInput(matcher.input.value);
    if (matcher.tool === "bash" && typeof input?.command === "string") return `Bash(${singleLine(input.command)})`;
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
    const entry = entries[labels.indexOf(selected) - 1];
    if (!entry) continue;
    const action = await ctx.ui.select(fieldSummary(entry[0], entry[1]), ["Edit", "Remove", "Back"]);
    if (action === "Edit") {
      const edited = await editField(ctx, matcher.tool, entry[0], entry[1]);
      if (edited) matcher.input.fields[entry[0]] = edited;
    } else if (action === "Remove") delete matcher.input.fields[entry[0]];
  }
}

function setMatchKind(matcher: ToolMatcher, kind: RuleMatchKind, exactInput?: unknown): ToolMatcher | undefined {
  if (matcher.input.kind === kind) return matcher;
  const base = { tool: matcher.tool, ...(matcher.source ? { source: matcher.source } : {}) };
  if (kind === "any") return { ...base, input: { kind: "any" } };
  if (kind === "exact") {
    const value = matcher.input.kind === "exact" ? matcher.input.value : isJsonValue(exactInput) ? exactInput : undefined;
    return value === undefined ? undefined : { ...base, input: { kind: "exact", value: structuredClone(value) } };
  }
  const exact = matcher.input.kind === "exact" ? objectInput(matcher.input.value) : objectInput(exactInput);
  return {
    ...base,
    input: { kind: "fields", fields: Object.fromEntries(Object.entries(exact ?? {}).map(([field, value]) => [field, { kind: "exact", value }])) },
  };
}

async function chooseAction(ctx: ExtensionContext, current: RuleAction): Promise<RuleAction | undefined> {
  const selected = await ctx.ui.select(`Rule action\nCurrent: ${actionLabel(current)}`, ["Allow", "Ask", "Deny"]);
  if (!selected) return undefined;
  return selected === "Allow" ? "allow" : selected === "Ask" ? "ask" : "deny";
}

async function chooseScope(ctx: ExtensionContext, current: RuleScope): Promise<RuleScope | undefined> {
  const selected = await ctx.ui.select(`Rule scope\nCurrent: ${current === "global" ? "Global" : "Project"}`, ["Project", "Global"]);
  return selected === "Project" ? "project" : selected === "Global" ? "global" : undefined;
}

async function chooseMatchKind(ctx: ExtensionContext, current: RuleMatchKind): Promise<RuleMatchKind | undefined> {
  const label = current === "any" ? "All calls" : current === "exact" ? "Exact call" : "Selected constraints";
  const selected = await ctx.ui.select(`Match type\nCurrent: ${label}`, ["All calls", "Exact call", "Selected constraints"]);
  return selected === "All calls" ? "any" : selected === "Exact call" ? "exact" : selected === "Selected constraints" ? "fields" : undefined;
}

async function selectEditorAction(
  ctx: ExtensionContext,
  state: { action: RuleAction; matcher: ToolMatcher; scope: RuleScope },
  options: { actionFixed?: boolean; contextLines?: readonly string[] },
): Promise<RuleEditorResult | undefined> {
  if (ctx.mode === "tui") {
    return await ctx.ui.custom<RuleEditorResult>((tui, theme, _keybindings, done) => new RuleEditorComponent(
      tui,
      theme,
      done,
      {
        action: state.action,
        scope: state.scope,
        matchKind: state.matcher.input.kind,
        tool: displayToolName(state.matcher.tool),
        matcherSummary: matcherSummary(state.matcher),
        actionFixed: options.actionFixed,
        contextLines: options.contextLines,
      },
    ));
  }
  const labels = [
    ...(options.actionFixed ? [] : [`Action: ${actionLabel(state.action)}`]),
    `Scope: ${state.scope === "global" ? "Global" : "Project"}`,
    `Match type: ${state.matcher.input.kind === "any" ? "All calls" : state.matcher.input.kind === "exact" ? "Exact call" : "Selected constraints"}`,
    `Matcher: ${matcherSummary(state.matcher)}`,
    "Advanced JSON",
    "Save",
    "Cancel",
  ];
  const selected = await ctx.ui.select([
    "Rule Editor",
    `Tool: ${displayToolName(state.matcher.tool)}`,
    ...(options.actionFixed ? [`Action: ${actionLabel(state.action)} (fixed)`] : []),
    ...(options.contextLines ?? []),
  ].join("\n"), labels);
  if (!selected || selected === "Cancel") return { kind: "cancelled" };
  const base = { action: state.action, scope: state.scope, matchKind: state.matcher.input.kind };
  return {
    kind: selected.startsWith("Action:") ? "choose_action"
      : selected.startsWith("Scope:") ? "choose_scope"
      : selected.startsWith("Match type:") ? "choose_match"
      : selected.startsWith("Matcher:") ? "edit_matcher"
      : selected === "Advanced JSON" ? "advanced"
      : "save",
    ...base,
  };
}

export async function editRule(
  ctx: ExtensionContext,
  options: {
    initialAction: RuleAction;
    initial: ToolMatcher;
    initialScope?: RuleScope;
    actionFixed?: boolean;
    toolSource?: ToolSourceIdentity;
    exactInput?: unknown;
    contextLines?: readonly string[];
    validate?: (matcher: ToolMatcher, scope: RuleScope) => Promise<string | undefined>;
  },
): Promise<EditedRule | undefined> {
  let action = options.initialAction;
  let matcher = structuredClone(options.initial);
  const toolSource = isStandardToolName(matcher.tool) ? undefined : options.toolSource;
  if (isStandardToolName(matcher.tool)) delete matcher.source;
  else if (toolSource && !matcher.source) matcher.source = structuredClone(toolSource);
  let scope: RuleScope = options.initialScope ?? "project";
  for (;;) {
    const selected = await selectEditorAction(ctx, { action, matcher, scope }, options);
    if (!selected || selected.kind === "cancelled") return undefined;
    action = selected.action;
    scope = selected.scope;
    const changedMatcher = setMatchKind(matcher, selected.matchKind, options.exactInput);
    if (!changedMatcher) {
      ctx.ui.notify("No exact Tool input is available", "warning");
      continue;
    }
    matcher = changedMatcher;

    if (selected.kind === "choose_action") {
      const next = await chooseAction(ctx, action);
      if (next) action = next;
    } else if (selected.kind === "choose_scope") {
      const next = await chooseScope(ctx, scope);
      if (next) scope = next;
    } else if (selected.kind === "choose_match") {
      const next = await chooseMatchKind(ctx, matcher.input.kind);
      if (next) {
        const changed = setMatchKind(matcher, next, options.exactInput);
        if (changed) matcher = changed;
        else ctx.ui.notify("No exact Tool input is available", "warning");
      }
    } else if (selected.kind === "edit_matcher") {
      if (matcher.input.kind === "any") ctx.ui.notify("All calls has no constraints", "info");
      else if (matcher.input.kind === "exact") {
        const edited = await editJsonValue(ctx, "Exact Tool input", matcher.input.value);
        if (edited !== undefined) matcher.input.value = edited;
      } else matcher = await editConstraints(ctx, matcher, options.exactInput);
    } else if (selected.kind === "advanced") {
      let source = JSON.stringify(matcher, null, 2);
      for (;;) {
        const edited = await ctx.ui.editor("Advanced matcher JSON", source);
        if (edited === undefined) break;
        source = edited;
        try {
          const parsed = parseToolMatcher(JSON.parse(edited), "matcher", scope);
          if (parsed.tool !== options.initial.tool) throw new Error("Tool name cannot be changed here");
          matcher = toolSource ? { ...parsed, source: structuredClone(toolSource) } : parsed;
          break;
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
      }
    } else if (selected.kind === "save") {
      const error = validateToolMatcher(matcher, { scope }) ?? await options.validate?.(matcher, scope);
      if (error) ctx.ui.notify(error, "error");
      else return { action, matcher, scope };
    }
  }
}
