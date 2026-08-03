import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  DynamicBorder,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";
import type { ApprovalRule, AutoApprovalConfig, PolicyRule, ProjectConfig } from "../domain.ts";
import { defaultAutoApprovalConfig } from "../domain.ts";
import { parseAutoApprovalConfig, parsePolicyRule } from "../config/schema.ts";
import type { AutoApprovalConfigStore } from "../config/store.ts";
import type { AutomatedReviewer, ReviewerModelOption } from "../review/reviewer.ts";
import type { RuleAdvisor } from "../advisor/advisor.ts";
import type { AdvisorSkillSummary, AdvisorToolMetadata } from "../advisor/prompt.ts";
import type { FrictionHistoryStore } from "../friction/store.ts";
import { isToolWideMatcher, validateToolMatcher } from "../matchers.ts";
import { openRuleAdvisor } from "./advisor.ts";
import { editApprovalRule, matcherSummary } from "./rule-editor.ts";

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

function projectConfig(config: AutoApprovalConfig, key: string): ProjectConfig {
  return (config.projects[key] ??= { policyRules: [], approvalRules: [] });
}

function compact(value: unknown, max = 100): string {
  const text = JSON.stringify(value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

async function mutate(
  ctx: ExtensionContext,
  store: AutoApprovalConfigStore,
  change: (config: AutoApprovalConfig) => void,
): Promise<boolean> {
  try {
    await store.update(change);
    return true;
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    return false;
  }
}

async function chooseReviewerModel(
  ctx: ExtensionContext,
  models: ReviewerModelOption[],
): Promise<ReviewerModelOption | undefined> {
  if (ctx.mode !== "tui") {
    const selected = await ctx.ui.select("Reviewer model", models.map((model) => model.label));
    return models.find((model) => model.label === selected);
  }

  const selected = await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Search Reviewer Models")), 1, 0));
    const items: SettingItem[] = models.map((model, index) => ({
      id: String(index),
      label: model.label,
      currentValue: "select",
      values: ["select"],
    }));
    const list = new SettingsList(
      items,
      Math.min(items.length, 12),
      {
        label: (text, active) => active ? theme.fg("accent", text) : text,
        value: (text, active) => active ? theme.fg("accent", text) : theme.fg("muted", text),
        description: (text) => theme.fg("dim", text),
        cursor: theme.fg("accent", "→ "),
        hint: (text) => theme.fg("dim", text),
      },
      (id) => done(id),
      () => done(undefined),
      { enableSearch: true },
    );
    container.addChild(list);
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });
  const index = Number(selected);
  return Number.isInteger(index) ? models[index] : undefined;
}

async function configureModel(ctx: ExtensionContext, dependencies: SettingsDependencies, config: AutoApprovalConfig): Promise<void> {
  if (!dependencies.reviewer) {
    ctx.ui.notify(`Reviewer runtime unavailable: ${dependencies.reviewerUnavailableReason ?? "unknown error"}`, "warning");
    return;
  }
  const models = await dependencies.reviewer.availableModels();
  if (!models.length) {
    ctx.ui.notify("No authenticated Reviewer models are available", "warning");
    return;
  }
  const model = await chooseReviewerModel(ctx, models);
  if (!model) return;
  await mutate(ctx, dependencies.store, (next) => {
    next.reviewer = {
      provider: model.provider,
      modelId: model.modelId,
      thinkingLevel: config.reviewer?.thinkingLevel ?? "low",
    };
  });
}

async function configureThinking(ctx: ExtensionContext, dependencies: SettingsDependencies, config: AutoApprovalConfig): Promise<void> {
  if (!config.reviewer) {
    ctx.ui.notify("Configure a Reviewer model first", "warning");
    return;
  }
  const selected = await ctx.ui.select("Reviewer thinking level", [...THINKING_LEVELS]);
  if (!selected || !THINKING_LEVELS.includes(selected as (typeof THINKING_LEVELS)[number])) return;
  await mutate(ctx, dependencies.store, (next) => {
    if (next.reviewer) next.reviewer.thinkingLevel = selected as (typeof THINKING_LEVELS)[number];
  });
}

function policyTemplate(): PolicyRule {
  return {
    id: randomUUID(),
    route: "auto_review",
    matcher: { tool: "read", input: { kind: "fields", fields: { path: { kind: "pathGlob", pattern: "src/**" } } } },
  };
}

function approvalTemplate(): ApprovalRule {
  return {
    id: randomUUID(),
    matcher: { tool: "read", input: { kind: "fields", fields: { path: { kind: "pathGlob", pattern: "src/**" } } } },
  };
}

async function editRule<T extends PolicyRule>(
  ctx: ExtensionContext,
  title: string,
  initial: T,
  parse: (value: unknown) => T,
): Promise<T | undefined> {
  let source = JSON.stringify(initial, null, 2);
  for (;;) {
    const edited = await ctx.ui.editor(title, source);
    if (edited === undefined) return undefined;
    source = edited;
    try {
      return parse(JSON.parse(edited));
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }
}

async function managePolicyRule(
  ctx: ExtensionContext,
  dependencies: SettingsDependencies,
  rule: PolicyRule,
  index: number,
  count: number,
): Promise<void> {
  const action = await ctx.ui.select(`Policy Rule ${rule.id}`, ["Edit", "Move up", "Move down", "Delete", "Back"]);
  if (action === "Edit") {
    const edited = await editRule(ctx, "Edit Policy Rule JSON", rule, parsePolicyRule);
    if (edited) await mutate(ctx, dependencies.store, (config) => { projectConfig(config, dependencies.projectKey).policyRules[index] = edited; });
  } else if (action === "Move up" && index > 0) {
    await mutate(ctx, dependencies.store, (config) => {
      const rules = projectConfig(config, dependencies.projectKey).policyRules;
      [rules[index - 1], rules[index]] = [rules[index]!, rules[index - 1]!];
    });
  } else if (action === "Move down" && index < count - 1) {
    await mutate(ctx, dependencies.store, (config) => {
      const rules = projectConfig(config, dependencies.projectKey).policyRules;
      [rules[index], rules[index + 1]] = [rules[index + 1]!, rules[index]!];
    });
  } else if (action === "Delete" && await ctx.ui.confirm("Delete Policy Rule?", rule.id)) {
    await mutate(ctx, dependencies.store, (config) => { projectConfig(config, dependencies.projectKey).policyRules.splice(index, 1); });
  }
}

async function managePolicyRules(ctx: ExtensionContext, dependencies: SettingsDependencies): Promise<void> {
  for (;;) {
    const result = await dependencies.store.read();
    if (!result.ok) return;
    const rules = result.config.projects[dependencies.projectKey]?.policyRules ?? [];
    const labels = ["Add Policy Rule", ...rules.map((rule, index) => `${index + 1}. ${rule.route} — ${compact(rule.matcher)}`), "Back"];
    const selected = await ctx.ui.select("Ordered Policy Rules", labels);
    if (!selected || selected === "Back") return;
    if (selected === "Add Policy Rule") {
      const rule = await editRule(ctx, "New Policy Rule JSON", policyTemplate(), parsePolicyRule);
      if (rule) await mutate(ctx, dependencies.store, (config) => { projectConfig(config, dependencies.projectKey).policyRules.push(rule); });
      continue;
    }
    const index = labels.indexOf(selected) - 1;
    if (index >= 0 && rules[index]) await managePolicyRule(ctx, dependencies, rules[index], index, rules.length);
  }
}

async function manageApprovalRules(ctx: ExtensionContext, dependencies: SettingsDependencies): Promise<void> {
  for (;;) {
    const result = await dependencies.store.read();
    if (!result.ok) return;
    const rules = result.config.projects[dependencies.projectKey]?.approvalRules ?? [];
    const labels = ["Add Approval Rule", ...rules.map((rule, index) => `${index + 1}. ${matcherSummary(rule.matcher)}`), "Back"];
    const selected = await ctx.ui.select("Project Approval Rules", labels);
    if (!selected || selected === "Back") return;
    if (selected === "Add Approval Rule") {
      const template = approvalTemplate();
      const edited = await editApprovalRule(ctx, { initial: template.matcher });
      if (edited) await mutate(ctx, dependencies.store, (config) => {
        const rule = { id: template.id, matcher: edited.matcher };
        if (edited.scope === "global" && isToolWideMatcher(rule.matcher)) {
          config.globalApprovalRules.push({ ...rule, matcher: rule.matcher });
        } else projectConfig(config, dependencies.projectKey).approvalRules.push(rule);
      });
      continue;
    }
    const index = labels.indexOf(selected) - 1;
    const rule = rules[index];
    if (!rule) continue;
    const action = await ctx.ui.select(`Approval Rule\n${matcherSummary(rule.matcher)}`, ["Edit", "Delete", "Back"]);
    if (action === "Edit") {
      const edited = await editApprovalRule(ctx, {
        initial: rule.matcher,
        toolSource: isToolWideMatcher(rule.matcher) ? rule.matcher.source : undefined,
      });
      if (edited) await mutate(ctx, dependencies.store, (config) => {
        const projectRules = projectConfig(config, dependencies.projectKey).approvalRules;
        if (edited.scope === "global" && isToolWideMatcher(edited.matcher)) {
          projectRules.splice(index, 1);
          config.globalApprovalRules.push({ id: rule.id, matcher: edited.matcher });
        } else projectRules[index] = { id: rule.id, matcher: edited.matcher };
      });
    } else if (action === "Delete" && await ctx.ui.confirm("Delete Approval Rule?", rule.id)) {
      await mutate(ctx, dependencies.store, (config) => { projectConfig(config, dependencies.projectKey).approvalRules.splice(index, 1); });
    }
  }
}

async function chooseGlobalTool(
  ctx: ExtensionContext,
  tools: ReadonlyArray<{ tool: AdvisorToolMetadata; matcher: ApprovalRule["matcher"] }>,
): Promise<number | undefined> {
  if (ctx.mode !== "tui") {
    const labels = tools.map(({ tool }) => `${tool.name} · ${tool.source!.source} · ${tool.source!.path}`);
    const chosen = await ctx.ui.select("Approve all inputs globally for which Tool?", [...labels, "Cancel"]);
    const index = labels.indexOf(chosen ?? "");
    return index >= 0 ? index : undefined;
  }

  const selected = await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Search Tool Catalog")), 1, 0));
    const items: SettingItem[] = tools.map(({ tool }, index) => ({
      id: String(index),
      label: tool.name,
      currentValue: "",
      values: ["select"],
      description: `${tool.source!.source} · ${tool.source!.path}`,
    }));
    const list = new SettingsList(
      items,
      Math.min(items.length, 12),
      {
        label: (text, active) => active ? theme.fg("accent", text) : text,
        value: (text, active) => active ? theme.fg("accent", text) : theme.fg("muted", text),
        description: (text) => theme.fg("dim", text),
        cursor: theme.fg("accent", "→ "),
        hint: (text) => theme.fg("dim", text),
      },
      (id) => done(id),
      () => done(undefined),
      { enableSearch: true },
    );
    container.addChild(list);
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });
  if (selected === undefined) return undefined;
  const index = Number(selected);
  return Number.isInteger(index) && tools[index] ? index : undefined;
}

async function manageGlobalApprovalRules(ctx: ExtensionContext, dependencies: SettingsDependencies): Promise<void> {
  for (;;) {
    const result = await dependencies.store.read();
    if (!result.ok) return;
    const rules = result.config.globalApprovalRules;
    const labels = ["Add Tool-wide Rule", ...rules.map((rule, index) => `${index + 1}. ${matcherSummary(rule.matcher)}`), "Back"];
    const selected = await ctx.ui.select("Global Tool-wide Approval Rules", labels);
    if (!selected || selected === "Back") return;
    if (selected === "Add Tool-wide Rule") {
      const tools = (dependencies.tools ?? []).flatMap((tool) => {
        if (!tool.source) return [];
        const matcher = { tool: tool.name, source: tool.source, input: { kind: "any" as const } };
        const exists = rules.some((rule) => rule.matcher.tool === matcher.tool
          && rule.matcher.source.source === matcher.source.source
          && rule.matcher.source.path === matcher.source.path);
        return validateToolMatcher(matcher) || exists ? [] : [{ tool, matcher }];
      });
      const candidateIndex = await chooseGlobalTool(ctx, tools);
      const candidate = candidateIndex === undefined ? undefined : tools[candidateIndex];
      if (candidate && await ctx.ui.confirm("Create Global Tool-wide Approval Rule?", matcherSummary(candidate.matcher))) {
        await mutate(ctx, dependencies.store, (config) => {
          config.globalApprovalRules.push({ id: randomUUID(), matcher: candidate.matcher });
        });
      }
      continue;
    }
    const index = labels.indexOf(selected) - 1;
    const rule = rules[index];
    if (!rule) continue;
    const action = await ctx.ui.select(`Global Approval Rule\n${matcherSummary(rule.matcher)}`, ["Edit", "Delete", "Back"]);
    if (action === "Edit") {
      const edited = await editApprovalRule(ctx, {
        initial: rule.matcher,
        initialScope: "global",
        toolSource: rule.matcher.source,
      });
      if (edited) await mutate(ctx, dependencies.store, (config) => {
        if (edited.scope === "global" && isToolWideMatcher(edited.matcher)) {
          config.globalApprovalRules[index] = { id: rule.id, matcher: edited.matcher };
        } else {
          config.globalApprovalRules.splice(index, 1);
          projectConfig(config, dependencies.projectKey).approvalRules.push({ id: rule.id, matcher: edited.matcher });
        }
      });
    } else if (action === "Delete" && await ctx.ui.confirm("Delete Global Approval Rule?", rule.id)) {
      await mutate(ctx, dependencies.store, (config) => { config.globalApprovalRules.splice(index, 1); });
    }
  }
}

async function repairConfig(ctx: ExtensionContext, store: AutoApprovalConfigStore, error: string): Promise<boolean> {
  ctx.ui.notify(`Invalid auto-approval config: ${error}`, "error");
  const action = await ctx.ui.select("Repair auto-approval configuration", ["Edit raw JSON", "Reset to empty configuration", "Cancel"]);
  if (action === "Cancel" || !action) return false;
  try {
    if (action === "Reset to empty configuration") {
      if (!await ctx.ui.confirm("Reset configuration?", "All Policy and Approval Rules will be removed.")) return false;
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
        ctx.ui.notify(repairError instanceof Error ? repairError.message : String(repairError), "error");
      }
    }
  } catch (repairError) {
    ctx.ui.notify(repairError instanceof Error ? repairError.message : String(repairError), "error");
    return false;
  }
}

export async function openAutoApprovalSettings(ctx: ExtensionContext, dependencies: SettingsDependencies): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/auto-approval requires an interactive UI", "warning");
    return;
  }
  for (;;) {
    const result = await dependencies.store.read();
    if (!result.ok) {
      if (!(await repairConfig(ctx, dependencies.store, result.error))) return;
      continue;
    }
    const config = result.config;
    const reviewer = config.reviewer
      ? `${config.reviewer.provider}/${config.reviewer.modelId}`
      : "not configured";
    const selected = await ctx.ui.select("Pi Auto Approval", [
      `Reviewer model: ${reviewer}`,
      `Reviewer thinking: ${config.reviewer?.thinkingLevel ?? "not configured"}`,
      "Rule Advisor",
      "Policy Rules",
      "Project Approval Rules",
      "Global Approval Rules",
      "Done",
    ]);
    if (!selected || selected === "Done") return;
    if (selected.startsWith("Reviewer model:")) await configureModel(ctx, dependencies, config);
    else if (selected.startsWith("Reviewer thinking:")) await configureThinking(ctx, dependencies, config);
    else if (selected === "Rule Advisor") {
      if (!dependencies.history || !dependencies.projectRoot) {
        ctx.ui.notify("Rule Advisor runtime unavailable", "warning");
      } else {
        await openRuleAdvisor(ctx, {
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
    } else if (selected === "Policy Rules") await managePolicyRules(ctx, dependencies);
    else if (selected === "Project Approval Rules") await manageApprovalRules(ctx, dependencies);
    else if (selected === "Global Approval Rules") await manageGlobalApprovalRules(ctx, dependencies);
  }
}
