import { readFile } from "node:fs/promises";
import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";
import type { AutoApprovalConfig, Rule, RuleAction, ToolMatcher } from "../domain.ts";
import { defaultAutoApprovalConfig } from "../domain.ts";
import { parseAutoApprovalConfig } from "../config/schema.ts";
import type { AutoApprovalConfigStore } from "../config/store.ts";
import type { AutomatedReviewer, ReviewerModelOption } from "../review/reviewer.ts";
import type { RuleAdvisor } from "../advisor/advisor.ts";
import type { AdvisorSkillSummary, AdvisorToolMetadata } from "../advisor/prompt.ts";
import type { FrictionHistoryStore } from "../friction/store.ts";
import { isStandardToolName, matcherKey, type RuleScope } from "../matchers.ts";
import { findMatchingRule, moreRestrictiveAction, upsertRestrictiveRule } from "../rules.ts";
import { openRuleAdvisor } from "./advisor.ts";
import { actionLabel, editRule, matcherSummary } from "./rule-editor.ts";
import { confirmRuleConflicts } from "./rule-conflicts.ts";
import { RuleListComponent, type RuleListResult } from "./rule-list-component.ts";
import { singleLine } from "./text.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

type SettingsDependencies = {
  store: AutoApprovalConfigStore;
  projectKey: string;
  reviewer?: AutomatedReviewer;
  reviewerUnavailableReason?: string;
  advisor?: RuleAdvisor;
  history?: FrictionHistoryStore;
  projectRoot?: string;
  tools?: readonly AdvisorToolMetadata[];
  skills?: readonly AdvisorSkillSummary[];
};

type RuleLocation = { scope: RuleScope; rule: Rule };

function projectRules(config: AutoApprovalConfig, key: string): Rule[] {
  return (config.projects[key] ??= { rules: [] }).rules;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function mutate(ctx: ExtensionContext, store: AutoApprovalConfigStore, change: (config: AutoApprovalConfig) => void): Promise<boolean> {
  try {
    await store.update(change);
    return true;
  } catch (error) {
    ctx.ui.notify(errorMessage(error), "error");
    return false;
  }
}

function locateRule(config: AutoApprovalConfig, projectKey: string, id: string): RuleLocation | undefined {
  const project = config.projects[projectKey]?.rules.find((rule) => rule.id === id);
  if (project) return { scope: "project", rule: project };
  const global = config.globalRules.find((rule) => rule.id === id);
  return global ? { scope: "global", rule: global } : undefined;
}

function replaceRule(
  config: AutoApprovalConfig,
  projectKey: string,
  id: string,
  edited: { action: RuleAction; matcher: ToolMatcher; scope: RuleScope },
  actionChanged: boolean,
  confirmedConflictId?: string,
): boolean {
  const current = locateRule(config, projectKey, id);
  if (!current) throw new Error("Rule changed or was removed by another Pi process");
  const source = current.scope === "global" ? config.globalRules : projectRules(config, projectKey);
  const sourceIndex = source.findIndex((rule) => rule.id === id);
  if (sourceIndex < 0) throw new Error("Rule changed or was removed by another Pi process");
  const target = edited.scope === "global" ? config.globalRules : projectRules(config, projectKey);
  const existing = target.find((rule) => rule.id !== id && matcherKey(rule.matcher) === matcherKey(edited.matcher));
  const desiredAction = actionChanged ? edited.action : current.rule.action;
  if (existing) {
    if (existing.id !== confirmedConflictId) throw new Error("A matching Rule appeared in another Pi process; review the edit again");
    existing.action = moreRestrictiveAction(existing.action, desiredAction);
    source.splice(sourceIndex, 1);
    return true;
  }
  source.splice(sourceIndex, 1);
  target.push({ id, action: desiredAction, matcher: structuredClone(edited.matcher) });
  return false;
}

async function chooseReviewerModel(ctx: ExtensionContext, models: ReviewerModelOption[]): Promise<ReviewerModelOption | undefined> {
  if (ctx.mode !== "tui") {
    const selected = await ctx.ui.select("Reviewer model", models.map((model) => model.label));
    return models.find((model) => model.label === selected);
  }
  const selected = await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Search Reviewer Models")), 1, 0));
    const items: SettingItem[] = models.map((model, index) => ({ id: String(index), label: model.label, currentValue: "select", values: ["select"] }));
    const list = new SettingsList(items, Math.min(items.length, 12), {
      label: (text, active) => active ? theme.fg("accent", text) : text,
      value: (text, active) => active ? theme.fg("accent", text) : theme.fg("muted", text),
      description: (text) => theme.fg("dim", text),
      cursor: theme.fg("accent", "→ "),
      hint: (text) => theme.fg("dim", text),
    }, (id) => done(id), () => done(undefined), { enableSearch: true });
    container.addChild(list);
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    return { render: (width: number) => container.render(width), invalidate: () => container.invalidate(), handleInput: (data: string) => { list.handleInput(data); tui.requestRender(); } };
  });
  const index = Number(selected);
  return Number.isInteger(index) ? models[index] : undefined;
}

async function manageReviewer(ctx: ExtensionContext, dependencies: SettingsDependencies): Promise<void> {
  for (;;) {
    const loaded = await dependencies.store.read();
    if (!loaded.ok) return;
    const config = loaded.config;
    const selected = await ctx.ui.select("Reviewer", [
      `Model: ${config.reviewer ? `${config.reviewer.provider}/${config.reviewer.modelId}` : "not configured"}`,
      `Thinking: ${config.reviewer?.thinkingLevel ?? "not configured"}`,
      "Back",
    ]);
    if (!selected || selected === "Back") return;
    if (selected.startsWith("Model:")) {
      if (!dependencies.reviewer) {
        ctx.ui.notify(`Reviewer runtime unavailable: ${dependencies.reviewerUnavailableReason ?? "unknown error"}`, "warning");
        continue;
      }
      const model = await chooseReviewerModel(ctx, await dependencies.reviewer.availableModels());
      if (model) await mutate(ctx, dependencies.store, (next) => {
        next.reviewer = { provider: model.provider, modelId: model.modelId, thinkingLevel: config.reviewer?.thinkingLevel ?? "low" };
      });
    } else if (!config.reviewer) {
      ctx.ui.notify("Configure a Reviewer model first", "warning");
    } else {
      const thinking = await ctx.ui.select("Reviewer thinking level", [...THINKING_LEVELS]);
      if (thinking && THINKING_LEVELS.includes(thinking as (typeof THINKING_LEVELS)[number])) {
        await mutate(ctx, dependencies.store, (next) => { if (next.reviewer) next.reviewer.thinkingLevel = thinking as (typeof THINKING_LEVELS)[number]; });
      }
    }
  }
}

async function chooseAction(ctx: ExtensionContext, title = "Rule action"): Promise<RuleAction | undefined> {
  const selected = await ctx.ui.select(title, ["Allow", "Ask", "Deny"]);
  if (!selected) return undefined;
  return selected === "Allow" ? "allow" : selected === "Ask" ? "ask" : "deny";
}

async function chooseTool(ctx: ExtensionContext, tools: readonly AdvisorToolMetadata[]): Promise<AdvisorToolMetadata | undefined> {
  const labels = tools.map((tool) => tool.name);
  const selected = await ctx.ui.select("Tool", [...labels, "Enter tool name", "Cancel"]);
  if (!selected || selected === "Cancel") return undefined;
  if (selected === "Enter tool name") {
    const name = (await ctx.ui.input("Tool name"))?.trim();
    return name ? { name } : undefined;
  }
  return tools[labels.indexOf(selected)];
}

async function addRule(ctx: ExtensionContext, dependencies: SettingsDependencies): Promise<void> {
  const tool = await chooseTool(ctx, dependencies.tools ?? []);
  if (!tool) return;
  const action = await chooseAction(ctx);
  if (!action) return;
  const toolSource = isStandardToolName(tool.name) ? undefined : tool.source;
  const edited = await editRule(ctx, {
    initialAction: action,
    initial: { tool: tool.name, ...(toolSource ? { source: toolSource } : {}), input: { kind: "any" } },
    toolSource,
  });
  if (!edited) return;
  const loaded = await dependencies.store.read();
  if (!loaded.ok) {
    ctx.ui.notify(loaded.error, "error");
    return;
  }
  const currentTarget = edited.scope === "global" ? loaded.config.globalRules : projectRules(loaded.config, dependencies.projectKey);
  const conflict = findMatchingRule(currentTarget, edited.matcher);
  if (!await confirmRuleConflicts(ctx, conflict ? [{ existing: conflict, incoming: edited }] : [])) return;
  await mutate(ctx, dependencies.store, (config) => {
    const target = edited.scope === "global" ? config.globalRules : projectRules(config, dependencies.projectKey);
    upsertRestrictiveRule(target, edited.action, edited.matcher);
  });
}

function ruleSummary(location: RuleLocation): string {
  const source = location.rule.matcher.source;
  const sourceLabel = source ? ` · ${singleLine(source.source)}:${singleLine(source.path)}` : "";
  return `${actionLabel(location.rule.action)} · ${location.scope === "global" ? "Global" : "Project"} · ${matcherSummary(location.rule.matcher)}${sourceLabel}`;
}

async function deleteRule(ctx: ExtensionContext, dependencies: SettingsDependencies, initial: RuleLocation): Promise<void> {
  if (!await ctx.ui.confirm("Delete Rule?", ruleSummary(initial))) return;
  await mutate(ctx, dependencies.store, (config) => {
    const current = locateRule(config, dependencies.projectKey, initial.rule.id);
    if (!current) throw new Error("Rule changed or was removed by another Pi process");
    const rules = current.scope === "global" ? config.globalRules : projectRules(config, dependencies.projectKey);
    const index = rules.findIndex((rule) => rule.id === initial.rule.id);
    if (index < 0) throw new Error("Rule changed or was removed by another Pi process");
    rules.splice(index, 1);
  });
}

async function manageRule(ctx: ExtensionContext, dependencies: SettingsDependencies, initial: RuleLocation): Promise<void> {
  const edited = await editRule(ctx, {
    initialAction: initial.rule.action,
    initial: initial.rule.matcher,
    initialScope: initial.scope,
    toolSource: initial.rule.matcher.source,
  });
  if (!edited) return;

  const latest = await dependencies.store.read();
  if (!latest.ok) {
    ctx.ui.notify(latest.error, "error");
    return;
  }
  const current = locateRule(latest.config, dependencies.projectKey, initial.rule.id);
  if (!current) {
    ctx.ui.notify("Rule changed or was removed by another Pi process", "error");
    return;
  }
  const target = edited.scope === "global" ? latest.config.globalRules : projectRules(latest.config, dependencies.projectKey);
  const conflict = target.find((rule) => rule.id !== initial.rule.id && matcherKey(rule.matcher) === matcherKey(edited.matcher));
  const actionChanged = edited.action !== initial.rule.action;
  const desiredAction = actionChanged ? edited.action : current.rule.action;
  if (conflict) {
    const mergedAction = moreRestrictiveAction(conflict.action, desiredAction);
    const detail = [
      `Existing: ${actionLabel(conflict.action)} · ${edited.scope === "global" ? "Global" : "Project"} · ${matcherSummary(conflict.matcher)}`,
      `Merged action: ${actionLabel(mergedAction)}`,
    ].join("\n");
    if (!await ctx.ui.confirm("Merge matching Rules?", detail)) return;
  }

  let merged = false;
  const saved = await mutate(ctx, dependencies.store, (config) => {
    merged = replaceRule(config, dependencies.projectKey, initial.rule.id, edited, actionChanged, conflict?.id);
  });
  if (saved && merged) ctx.ui.notify("Merged matching Rules and kept the more restrictive action", "info");
}

async function chooseRuleListAction(
  ctx: ExtensionContext,
  locations: readonly RuleLocation[],
): Promise<RuleListResult | undefined> {
  if (ctx.mode === "tui") {
    return await ctx.ui.custom<RuleListResult>((tui, theme, _keybindings, done) => new RuleListComponent(
      tui,
      theme,
      locations.map((location) => ({ summary: ruleSummary(location), scope: location.scope })),
      done,
    ));
  }
  const labels = ["+ Add Rule", ...locations.map(ruleSummary), "Back"];
  const selected = await ctx.ui.select("Rules", labels);
  if (!selected || selected === "Back") return { kind: "cancelled" };
  if (selected === "+ Add Rule") return { kind: "add" };
  const index = labels.indexOf(selected) - 1;
  const action = await ctx.ui.select(ruleSummary(locations[index]!), ["Edit", "Delete", "Back"]);
  return action === "Edit" ? { kind: "edit", index }
    : action === "Delete" ? { kind: "delete", index }
    : undefined;
}

async function manageRules(ctx: ExtensionContext, dependencies: SettingsDependencies): Promise<void> {
  for (;;) {
    const loaded = await dependencies.store.read();
    if (!loaded.ok) return;
    const locations: RuleLocation[] = [
      ...(loaded.config.projects[dependencies.projectKey]?.rules ?? []).map((rule) => ({ scope: "project" as const, rule })),
      ...loaded.config.globalRules.map((rule) => ({ scope: "global" as const, rule })),
    ];
    const selected = await chooseRuleListAction(ctx, locations);
    if (!selected || selected.kind === "cancelled") return;
    if (selected.kind === "add") await addRule(ctx, dependencies);
    else {
      const location = locations[selected.index];
      if (!location) continue;
      if (selected.kind === "delete") await deleteRule(ctx, dependencies, location);
      else await manageRule(ctx, dependencies, location);
    }
  }
}

async function repairConfig(ctx: ExtensionContext, store: AutoApprovalConfigStore, error: string): Promise<boolean> {
  ctx.ui.notify(`Invalid auto-approval config: ${error}`, "error");
  const action = await ctx.ui.select("Repair auto-approval configuration", ["Edit raw JSON", "Reset to empty configuration", "Cancel"]);
  if (action === "Cancel" || !action) return false;
  try {
    if (action === "Reset to empty configuration") {
      if (!await ctx.ui.confirm("Reset configuration?", "All Rules will be removed.")) return false;
      await store.replace(defaultAutoApprovalConfig());
      return true;
    }
    let source = await readFile(store.filePath, "utf8");
    for (;;) {
      const edited = await ctx.ui.editor("Repair auto-approval.json", source);
      if (edited === undefined) return false;
      source = edited;
      try {
        await store.replace(parseAutoApprovalConfig(JSON.parse(edited)));
        return true;
      } catch (repairError) {
        ctx.ui.notify(errorMessage(repairError), "error");
      }
    }
  } catch (repairError) {
    ctx.ui.notify(errorMessage(repairError), "error");
    return false;
  }
}

export async function openAutoApprovalSettings(ctx: ExtensionContext, dependencies: SettingsDependencies): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/auto-approval requires an interactive UI", "warning");
    return;
  }
  for (;;) {
    const loaded = await dependencies.store.read();
    if (!loaded.ok) {
      if (!(await repairConfig(ctx, dependencies.store, loaded.error))) return;
      continue;
    }
    const selected = await ctx.ui.select("Pi Auto Approval", ["Rules", "Suggestions", "Reviewer"]);
    if (!selected) return;
    if (selected === "Rules") await manageRules(ctx, dependencies);
    else if (selected === "Reviewer") await manageReviewer(ctx, dependencies);
    else if (!dependencies.history || !dependencies.projectRoot) ctx.ui.notify("Rule Advisor runtime unavailable", "warning");
    else await openRuleAdvisor(ctx, {
      store: dependencies.store,
      history: dependencies.history,
      advisor: dependencies.advisor,
      reviewerUnavailableReason: dependencies.reviewerUnavailableReason,
      projectKey: dependencies.projectKey,
      projectRoot: dependencies.projectRoot,
      tools: dependencies.tools ?? [],
      skills: dependencies.skills ?? [],
    });
  }
}
