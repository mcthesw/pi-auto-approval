import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FrictionRecord, Rule, RuleAction, ToolMatcher } from "../domain.ts";
import type { AutoApprovalConfigStore } from "../config/store.ts";
import type { FrictionHistoryStore } from "../friction/store.ts";
import type { RuleAdvisor, AdvisorSuggestion } from "../advisor/advisor.ts";
import type { AdvisorSkillSummary, AdvisorToolMetadata } from "../advisor/prompt.ts";
import { matcherKey, validateToolMatcher, type RuleScope } from "../matchers.ts";
import { AdvisorCandidateListComponent, type AdvisorListResult } from "./advisor-component.ts";
import { editRuleMatcher, matcherDetails, matcherSummary } from "./rule-editor.ts";
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

function actionLabel(action: RuleAction): string {
  return action === "allow" ? "Allow" : action === "ask" ? "Ask" : "Deny";
}

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

async function editAction(ctx: ExtensionContext, action: RuleAction): Promise<RuleAction | undefined> {
  const selected = await ctx.ui.select("Rule action", ["Allow", "Ask", "Deny"]);
  if (!selected) return undefined;
  return selected === "Allow" ? "allow" : selected === "Ask" ? "ask" : "deny";
}

async function showDetail(
  ctx: ExtensionContext,
  candidate: CandidateState,
  records: Map<string, FrictionRecord>,
  tools: readonly AdvisorToolMetadata[],
): Promise<void> {
  const evidence = candidate.suggestion.supportingRecordIds.slice(0, 3).flatMap((id) => {
    const record = records.get(id);
    return record ? [`${record.tool.name}: ${compact(record.input)}`] : [];
  });
  const stats = candidate.suggestion.stats;
  const detail = [
    `Action: ${actionLabel(candidate.action)}`,
    matcherDetails(candidate.matcher, candidate.scope),
    "",
    `Advisor rationale: ${candidate.suggestion.rationale}`,
    stats.calls
      ? `Advisor evidence: ${stats.calls} calls · ${stats.userConfirmations} user confirmations · ${stats.automatedReviews} AI reviews`
      : "Advisor evidence: No observed calls (Tool Catalog suggestion)",
    ...(candidate.replacements.length
      ? ["Replaces:", ...candidate.replacements.map((rule) => `  ${rule.id}: ${rule.summary}`)]
      : []),
    ...(hasCounterevidence(candidate.suggestion, records) ? ["Warning: cited evidence includes ask, deny, or cancelled outcomes."] : []),
    ...(candidate.edited ? ["Statistics and replacements refer to the original suggestion before editing."] : []),
    ...(evidence.length ? ["", "Recent evidence:", ...evidence.map((item) => `  ${item}`)] : []),
  ].join("\n");
  const selection = await ctx.ui.select(detail, [candidate.selected ? "Unselect" : "Select", "Edit action", "Edit matcher", "Back"]);
  if (selection === "Select") candidate.selected = true;
  else if (selection === "Unselect") candidate.selected = false;
  else if (selection === "Edit action") {
    const action = await editAction(ctx, candidate.action);
    if (action) {
      candidate.action = action;
      candidate.edited = true;
    }
  } else if (selection === "Edit matcher") {
    const tool = tools.find((item) => item.name === candidate.matcher.tool);
    const firstRecord = candidate.suggestion.supportingRecordIds.map((id) => records.get(id)).find(Boolean);
    const edited = await editRuleMatcher(ctx, {
      initial: candidate.matcher,
      initialScope: candidate.scope,
      toolSource: tool?.source,
      exactInput: firstRecord?.input,
    });
    if (edited) {
      candidate.matcher = edited.matcher;
      candidate.scope = edited.scope;
      candidate.edited = true;
    }
  }
}

async function reviewInTui(
  ctx: ExtensionContext,
  candidates: CandidateState[],
  records: Map<string, FrictionRecord>,
  tools: readonly AdvisorToolMetadata[],
): Promise<boolean> {
  for (;;) {
    const result = await ctx.ui.custom<AdvisorListResult>((tui, theme, _keybindings, done) => new AdvisorCandidateListComponent(
      tui,
      theme,
      candidates.map((candidate) => ({
        summary: `${actionLabel(candidate.action)} · ${matcherSummary(candidate.matcher)}`,
        stats: candidate.suggestion.stats,
        selected: candidate.selected,
        scope: candidate.scope,
        replaces: candidate.replacements.length,
        warning: hasCounterevidence(candidate.suggestion, records),
      })),
      done,
    ));
    if (!result || result.kind === "cancelled") return false;
    result.selected.forEach((selected, index) => { if (candidates[index]) candidates[index].selected = selected; });
    if (result.kind === "continue") return true;
    const candidate = candidates[result.index];
    if (candidate) await showDetail(ctx, candidate, records, tools);
  }
}

async function reviewWithMenus(
  ctx: ExtensionContext,
  candidates: CandidateState[],
  records: Map<string, FrictionRecord>,
  tools: readonly AdvisorToolMetadata[],
): Promise<boolean> {
  for (;;) {
    const labels = [
      ...candidates.map((candidate, index) =>
        `${candidate.selected ? "[x]" : "[ ]"} ${index + 1}. ${actionLabel(candidate.action)} · ${matcherSummary(candidate.matcher)} · ${candidate.scope}`),
      "Review selected",
      "Cancel",
    ];
    const selected = await ctx.ui.select("Rule Suggestions (none selected by default)", labels);
    if (!selected || selected === "Cancel") return false;
    if (selected === "Review selected") return true;
    const index = labels.indexOf(selected);
    if (candidates[index]) await showDetail(ctx, candidates[index], records, tools);
  }
}

function upsertRule(rules: Rule[], action: RuleAction, matcher: ToolMatcher): void {
  const existing = rules.find((rule) => matcherKey(rule.matcher) === matcherKey(matcher));
  if (existing) {
    existing.action = action;
    existing.matcher = structuredClone(matcher);
  } else {
    rules.push({ id: randomUUID(), action, matcher: structuredClone(matcher) });
  }
}

async function persistSelected(ctx: ExtensionContext, dependencies: AdvisorUiDependencies, candidates: CandidateState[]): Promise<void> {
  const selected = candidates.filter((candidate) => candidate.selected);
  if (!selected.length) {
    ctx.ui.notify("No Rule Suggestions selected", "info");
    return;
  }
  const summary = selected.map((candidate) =>
    `• ${actionLabel(candidate.action)} · ${candidate.scope} · ${matcherSummary(candidate.matcher)}`).join("\n");
  if (!await ctx.ui.confirm("Save Rules?", summary)) return;
  let saved = 0;
  try {
    await dependencies.store.update((config) => {
      const project = (config.projects[dependencies.projectKey] ??= { rules: [] });
      for (const candidate of selected) {
        if (validateToolMatcher(candidate.matcher, { scope: candidate.scope })) continue;
        const replacementIds = new Set(candidate.suggestion.replacesRuleIds);
        const replacements = [...replacementIds].map((id) => project.rules.find((rule) => rule.id === id));
        if (replacements.some((rule) => !rule || rule.matcher.tool !== candidate.matcher.tool)) continue;
        if (replacementIds.size) project.rules = project.rules.filter((rule) => !replacementIds.has(rule.id));
        const target = candidate.scope === "global" ? config.globalRules : project.rules;
        upsertRule(target, candidate.action, candidate.matcher);
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
  ));
  if (outcome.status === "cancelled") {
    ctx.ui.notify("Rule Advisor cancelled", "info");
    return;
  }
  if (outcome.status === "failed") {
    ctx.ui.notify(`Rule Advisor failed: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`, "error");
    return;
  }
  if (!outcome.value.length) {
    ctx.ui.notify("Rule Advisor found no worthwhile suggestions", "info");
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
    ? await reviewInTui(ctx, candidates, records, dependencies.tools)
    : await reviewWithMenus(ctx, candidates, records, dependencies.tools);
  if (proceed) await persistSelected(ctx, dependencies, candidates);
}
