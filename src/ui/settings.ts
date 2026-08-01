import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ApprovalRule, AutoApprovalConfig, PolicyRule, ProjectConfig } from "../domain.ts";
import { defaultAutoApprovalConfig } from "../domain.ts";
import { parseApprovalRule, parseAutoApprovalConfig, parsePolicyRule } from "../config/schema.ts";
import type { AutoApprovalConfigStore } from "../config/store.ts";
import type { AutomatedReviewer } from "../review/reviewer.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

type SettingsDependencies = {
  store: AutoApprovalConfigStore;
  projectKey: string;
  reviewer?: AutomatedReviewer;
  reviewerUnavailableReason?: string;
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
  const labels = models.map((model) => model.label);
  const selected = await ctx.ui.select("Reviewer model", labels);
  const model = models.find((candidate) => candidate.label === selected);
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

async function editRule<T extends PolicyRule | ApprovalRule>(
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
    const labels = ["Add Approval Rule", ...rules.map((rule, index) => `${index + 1}. ${compact(rule.matcher)}`), "Back"];
    const selected = await ctx.ui.select("Project Approval Rules", labels);
    if (!selected || selected === "Back") return;
    if (selected === "Add Approval Rule") {
      const rule = await editRule(ctx, "New Approval Rule JSON", approvalTemplate(), parseApprovalRule);
      if (rule) await mutate(ctx, dependencies.store, (config) => { projectConfig(config, dependencies.projectKey).approvalRules.push(rule); });
      continue;
    }
    const index = labels.indexOf(selected) - 1;
    const rule = rules[index];
    if (!rule) continue;
    const action = await ctx.ui.select(`Approval Rule ${rule.id}`, ["Edit", "Delete", "Back"]);
    if (action === "Edit") {
      const edited = await editRule(ctx, "Edit Approval Rule JSON", rule, parseApprovalRule);
      if (edited) await mutate(ctx, dependencies.store, (config) => { projectConfig(config, dependencies.projectKey).approvalRules[index] = edited; });
    } else if (action === "Delete" && await ctx.ui.confirm("Delete Approval Rule?", rule.id)) {
      await mutate(ctx, dependencies.store, (config) => { projectConfig(config, dependencies.projectKey).approvalRules.splice(index, 1); });
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
      "Policy Rules",
      "Approval Rules",
      "Done",
    ]);
    if (!selected || selected === "Done") return;
    if (selected.startsWith("Reviewer model:")) await configureModel(ctx, dependencies, config);
    else if (selected.startsWith("Reviewer thinking:")) await configureThinking(ctx, dependencies, config);
    else if (selected === "Policy Rules") await managePolicyRules(ctx, dependencies);
    else if (selected === "Approval Rules") await manageApprovalRules(ctx, dependencies);
  }
}
