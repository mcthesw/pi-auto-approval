import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FrictionRecord, RuleAction, ToolMatcher } from "../domain.ts";
import { formatModelUsage, type ModelUsage } from "../model-usage.ts";
import type { AutoApprovalConfigStore } from "../config/store.ts";
import type { FrictionHistoryStore } from "../friction/store.ts";
import type { RuleAdvisor, AdvisorSuggestion } from "../advisor/advisor.ts";
import type { AdvisorSkillSummary, AdvisorToolMetadata } from "../advisor/prompt.ts";
import { validateToolMatcher, type RuleScope } from "../matchers.ts";
import { findMatchingRule, upsertRestrictiveRule } from "../rules.ts";
import { confirmRuleConflicts, type RuleConflict } from "./rule-conflicts.ts";
import { RuleReviewComponent, type RuleReviewResult } from "./rule-review-component.ts";
import { actionLabel, editRule, matcherSummary } from "./rule-editor.ts";
import { runWithAsyncLoader } from "./async-loader.ts";

export type AdvisorUiDependencies = {
  store: AutoApprovalConfigStore;
  history: FrictionHistoryStore;
  advisor?: RuleAdvisor;
  reviewerUnavailableReason?: string;
  projectKey: string;
  projectRoot: string;
  tools: readonly AdvisorToolMetadata[];
  skills: readonly AdvisorSkillSummary[];
};

type CandidateState = {
  suggestion: AdvisorSuggestion;
  action: RuleAction;
  matcher: ToolMatcher;
  scope: RuleScope;
  selected: boolean;
  edited: boolean;
  replacements: Array<{ id: string; summary: string }>;
};

function compact(value: unknown, max = 320): string {
  const text = JSON.stringify(value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function hasCounterevidence(suggestion: AdvisorSuggestion, records: Map<string, FrictionRecord>): boolean {
  return suggestion.supportingRecordIds.some((id) => {
    const record = records.get(id);
    return record?.reviewDecision === "deny"
      || record?.reviewDecision === "ask"
      || record?.userChoice === "deny"
      || record?.userChoice === "cancelled";
  });
}

function candidateContext(candidate: CandidateState, records: Map<string, FrictionRecord>): string[] {
  const stats = candidate.suggestion.stats;
  const evidence = candidate.suggestion.supportingRecordIds.slice(0, 3).flatMap((id) => {
    const record = records.get(id);
    return record ? [`Evidence: ${record.tool.name} ${compact(record.input)}`] : [];
  });
  return [
    `Rationale: ${candidate.suggestion.rationale}`,
    stats.calls
      ? `Observed: ${stats.calls} calls · ${stats.userConfirmations} user confirmations · ${stats.automatedReviews} AI reviews`
      : "Observed: no calls (Tool Catalog suggestion)",
    ...(candidate.replacements.length ? [`Replaces: ${candidate.replacements.map((rule) => rule.summary).join("; ")}`] : []),
    ...(hasCounterevidence(candidate.suggestion, records) ? ["Warning: evidence includes ask, deny, or cancelled outcomes"] : []),
    ...(candidate.edited ? ["Statistics refer to the original suggestion"] : []),
    ...evidence,
  ];
}

async function editCandidate(
  ctx: ExtensionContext,
  candidate: CandidateState,
  records: Map<string, FrictionRecord>,
  tools: readonly AdvisorToolMetadata[],
): Promise<void> {
  const tool = tools.find((item) => item.name === candidate.matcher.tool);
  const firstRecord = candidate.suggestion.supportingRecordIds.map((id) => records.get(id)).find(Boolean);
  const edited = await editRule(ctx, {
    initialAction: candidate.action,
    initial: candidate.matcher,
    initialScope: candidate.scope,
    toolSource: tool?.source,
    exactInput: firstRecord?.input,
    contextLines: candidateContext(candidate, records),
  });
  if (!edited) return;
  candidate.action = edited.action;
  candidate.matcher = edited.matcher;
  candidate.scope = edited.scope;
  candidate.selected = true;
  candidate.edited = true;
}

function applySelection(candidates: CandidateState[], selected: readonly boolean[]): void {
  selected.forEach((value, index) => { if (candidates[index]) candidates[index].selected = value; });
}

async function reviewInTui(
  ctx: ExtensionContext,
  candidates: CandidateState[],
  records: Map<string, FrictionRecord>,
  tools: readonly AdvisorToolMetadata[],
  usageText?: string,
): Promise<boolean> {
  for (;;) {
    const result = await ctx.ui.custom<RuleReviewResult>((tui, theme, _keybindings, done) => new RuleReviewComponent(
      tui,
      theme,
      candidates.map((candidate) => ({
        summary: `${actionLabel(candidate.action)} · ${matcherSummary(candidate.matcher)}`,
        selected: candidate.selected,
        scope: candidate.scope,
        suffix: candidate.suggestion.stats.calls ? `${candidate.suggestion.stats.calls} calls` : undefined,
        warning: hasCounterevidence(candidate.suggestion, records),
      })),
      done,
      { title: "Rule Suggestions", subtitle: `Nothing is selected by default${usageText ? ` · ${usageText}` : ""}` },
    ));
    if (!result) return false;
    applySelection(candidates, result.selected);
    if (result.kind === "cancelled") return false;
    if (result.kind === "save") {
      if (candidates.some((candidate) => candidate.selected)) return true;
      ctx.ui.notify("Select at least one Rule with Space", "info");
      continue;
    }
    const candidate = candidates[result.index];
    if (candidate) await editCandidate(ctx, candidate, records, tools);
  }
}

async function reviewWithMenus(
  ctx: ExtensionContext,
  candidates: CandidateState[],
  records: Map<string, FrictionRecord>,
  tools: readonly AdvisorToolMetadata[],
  usageText?: string,
): Promise<boolean> {
  for (;;) {
    const labels = [
      ...candidates.map((candidate) => `${candidate.selected ? "[x]" : "[ ]"} ${actionLabel(candidate.action)} · ${candidate.scope} · ${matcherSummary(candidate.matcher)}`),
      "Save selected",
      "Back",
    ];
    const selected = await ctx.ui.select(
      `Rule Suggestions (nothing selected by default${usageText ? ` · ${usageText}` : ""})`,
      labels,
    );
    if (!selected || selected === "Back") return false;
    if (selected === "Save selected") {
      if (candidates.some((candidate) => candidate.selected)) return true;
      ctx.ui.notify("Select at least one Rule", "info");
      continue;
    }
    const index = labels.indexOf(selected);
    const candidate = candidates[index];
    if (!candidate) continue;
    const action = await ctx.ui.select(selected, [candidate.selected ? "Unselect" : "Select", "View / edit", "Back"]);
    if (action === "Select") candidate.selected = true;
    else if (action === "Unselect") candidate.selected = false;
    else if (action === "View / edit") await editCandidate(ctx, candidate, records, tools);
  }
}

async function persistSelected(ctx: ExtensionContext, dependencies: AdvisorUiDependencies, candidates: CandidateState[]): Promise<void> {
  const selected = candidates.filter((candidate) => candidate.selected);
  if (!selected.length) {
    ctx.ui.notify("No Rule Suggestions selected", "info");
    return;
  }
  const latest = await dependencies.store.read();
  if (!latest.ok) {
    ctx.ui.notify(latest.error, "error");
    return;
  }
  const accepted: CandidateState[] = [];
  const conflicts: RuleConflict[] = [];
  const currentProjectRules = latest.config.projects[dependencies.projectKey]?.rules ?? [];
  for (const candidate of selected) {
    if (validateToolMatcher(candidate.matcher, { scope: candidate.scope })) continue;
    const replacementIds = new Set(candidate.suggestion.replacesRuleIds);
    const replacements = [...replacementIds].map((id) => currentProjectRules.find((rule) => rule.id === id));
    if (replacements.some((rule) => !rule || rule.matcher.tool !== candidate.matcher.tool)) continue;
    const target = candidate.scope === "global"
      ? latest.config.globalRules
      : currentProjectRules.filter((rule) => !replacementIds.has(rule.id));
    const conflict = findMatchingRule(target, candidate.matcher);
    if (conflict) conflicts.push({ existing: conflict, incoming: candidate });
    accepted.push(candidate);
  }
  if (!await confirmRuleConflicts(ctx, conflicts)) return;

  let saved = 0;
  try {
    await dependencies.store.update((config) => {
      const project = (config.projects[dependencies.projectKey] ??= { rules: [] });
      for (const candidate of accepted) {
        const replacementIds = new Set(candidate.suggestion.replacesRuleIds);
        const replacements = [...replacementIds].map((id) => project.rules.find((rule) => rule.id === id));
        if (replacements.some((rule) => !rule || rule.matcher.tool !== candidate.matcher.tool)) continue;
        if (replacementIds.size) project.rules = project.rules.filter((rule) => !replacementIds.has(rule.id));
        const target = candidate.scope === "global" ? config.globalRules : project.rules;
        upsertRestrictiveRule(target, candidate.action, candidate.matcher);
        saved += 1;
      }
    });
    ctx.ui.notify(`Saved ${saved} Rule${saved === 1 ? "" : "s"}`, "info");
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  }
}

export async function openRuleAdvisor(ctx: ExtensionContext, dependencies: AdvisorUiDependencies): Promise<void> {
  const loaded = await dependencies.store.read();
  if (!loaded.ok) {
    ctx.ui.notify(`Rule Advisor unavailable: ${loaded.error}`, "error");
    return;
  }
  if (!loaded.config.reviewer || !dependencies.advisor) {
    ctx.ui.notify(`Rule Advisor unavailable: ${dependencies.reviewerUnavailableReason ?? "configure a Reviewer model first"}`, "warning");
    return;
  }
  const history = await dependencies.history.readProject(dependencies.projectKey);
  if (!history.ok) {
    ctx.ui.notify(`Rule Advisor history is invalid: ${history.error}`, "error");
    return;
  }
  let usage: ModelUsage | undefined;
  const usageDisplay = loaded.config.usageDisplay;
  const outcome = await runWithAsyncLoader(ctx, "Rule Advisor: analyzing approval friction…", (signal) => dependencies.advisor!.suggest(
    loaded.config.reviewer!,
    {
      projectKey: dependencies.projectKey,
      projectRoot: dependencies.projectRoot,
      records: history.records,
      config: loaded.config,
      tools: dependencies.tools,
      skills: dependencies.skills,
    },
    signal,
    (value) => { usage = value; },
  ));
  const usageText = formatModelUsage(usage, usageDisplay);
  if (outcome.status === "cancelled") {
    ctx.ui.notify(`Rule Advisor cancelled${usageText ? ` · ${usageText}` : ""}`, "info");
    return;
  }
  if (outcome.status === "failed") {
    ctx.ui.notify(`Rule Advisor failed: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}${usageText ? ` · ${usageText}` : ""}`, "error");
    return;
  }
  if (!outcome.value.length) {
    ctx.ui.notify(`Rule Advisor found no worthwhile suggestions${usageText ? ` · ${usageText}` : ""}`, "info");
    return;
  }

  const records = new Map(history.records.map((record) => [record.id, record]));
  const rules = new Map((loaded.config.projects[dependencies.projectKey]?.rules ?? []).map((rule) => [rule.id, rule]));
  const candidates = outcome.value.map((suggestion) => ({
    suggestion,
    action: suggestion.action,
    matcher: structuredClone(suggestion.matcher),
    scope: suggestion.scope,
    selected: false,
    edited: false,
    replacements: suggestion.replacesRuleIds.flatMap((id) => {
      const rule = rules.get(id);
      return rule ? [{ id, summary: `${actionLabel(rule.action)} · ${matcherSummary(rule.matcher)}` }] : [];
    }),
  }));
  const proceed = ctx.mode === "tui"
    ? await reviewInTui(ctx, candidates, records, dependencies.tools, usageText)
    : await reviewWithMenus(ctx, candidates, records, dependencies.tools, usageText);
  if (proceed) await persistSelected(ctx, dependencies, candidates);
}
