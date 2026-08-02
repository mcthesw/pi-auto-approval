import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutoApprovalConfig, FrictionRecord, ToolMatcher } from "../domain.ts";
import type { AutoApprovalConfigStore } from "../config/store.ts";
import type { FrictionHistoryStore } from "../friction/store.ts";
import type { RuleAdvisor, AdvisorSuggestion } from "../advisor/advisor.ts";
import type { AdvisorSkillSummary, AdvisorToolMetadata } from "../advisor/prompt.ts";
import { isToolWideMatcher, validateToolMatcher } from "../matchers.ts";
import { AdvisorCandidateListComponent, type AdvisorListResult } from "./advisor-component.ts";
import { editApprovalRule, matcherDetails, matcherSummary, type RuleScope } from "./rule-editor.ts";
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
  matcher: ToolMatcher;
  scope: RuleScope;
  selected: boolean;
  edited: boolean;
  replacements: Array<{ id: string; summary: string }>;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function compact(value: unknown, max = 320): string {
  const text = JSON.stringify(value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function hasCounterevidence(suggestion: AdvisorSuggestion, records: Map<string, FrictionRecord>): boolean {
  return suggestion.supportingRecordIds.some((id) => {
    const record = records.get(id);
    return record?.reviewDecision === "deny"
      || record?.reviewDecision === "ask_user"
      || record?.userChoice === "deny"
      || record?.userChoice === "cancelled";
  });
}

async function showDetail(
  ctx: ExtensionContext,
  candidate: CandidateState,
  records: Map<string, FrictionRecord>,
  tools: readonly AdvisorToolMetadata[],
): Promise<void> {
  const evidence = candidate.suggestion.supportingRecordIds
    .slice(0, 3)
    .flatMap((id) => {
      const record = records.get(id);
      return record ? [`${record.tool.name}: ${compact(record.input)}`] : [];
    });
  const stats = candidate.suggestion.stats;
  const counterevidence = hasCounterevidence(candidate.suggestion, records);
  const detail = [
    matcherDetails(candidate.matcher, candidate.scope),
    "",
    `Advisor rationale: ${candidate.suggestion.rationale}`,
    stats.calls
      ? `Advisor evidence: ${stats.calls} calls · ${stats.userConfirmations} user confirmations · ${stats.automatedReviews} AI reviews`
      : "Advisor evidence: No observed calls (Tool Catalog suggestion)",
    ...(candidate.scope === "global" ? ["Warning: this proposal authorizes the Tool across all projects."] : []),
    ...(candidate.replacements.length
      ? [
          `Optimization: replaces ${candidate.replacements.length} existing Project Approval Rule(s):`,
          ...candidate.replacements.map((rule) => `  ${rule.id}: ${rule.summary}`),
        ]
      : []),
    ...(counterevidence ? ["Warning: cited evidence includes ask_user, deny, or cancelled outcomes."] : []),
    ...(candidate.edited ? ["Statistics and replacement targets refer to the original suggestion before editing."] : []),
    ...(evidence.length ? ["", "Recent evidence:", ...evidence.map((item) => `  ${item}`)] : []),
  ].join("\n");
  const action = await ctx.ui.select(detail, [candidate.selected ? "Unselect" : "Select", "Edit rule", "Back"]);
  if (action === "Select") candidate.selected = true;
  else if (action === "Unselect") candidate.selected = false;
  else if (action === "Edit rule") {
    const tool = tools.find((item) => item.name === candidate.matcher.tool);
    const firstRecord = candidate.suggestion.supportingRecordIds.map((id) => records.get(id)).find(Boolean);
    const edited = await editApprovalRule(ctx, {
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
        summary: matcherSummary(candidate.matcher),
        stats: candidate.suggestion.stats,
        selected: candidate.selected,
        scope: candidate.scope,
        replaces: candidate.suggestion.replacesRuleIds.length,
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
        `${candidate.selected ? "[x]" : "[ ]"} ${index + 1}. ${matcherSummary(candidate.matcher)} · ${candidate.scope}${candidate.suggestion.replacesRuleIds.length ? ` · replaces ${candidate.suggestion.replacesRuleIds.length}` : ""} · Calls ${candidate.suggestion.stats.calls}${hasCounterevidence(candidate.suggestion, records) ? " · counterevidence" : ""}`),
      "Review selected",
      "Cancel",
    ];
    const selected = await ctx.ui.select("Approval Rule Suggestions (none selected by default)", labels);
    if (!selected || selected === "Cancel") return false;
    if (selected === "Review selected") return true;
    const index = labels.indexOf(selected);
    if (candidates[index]) await showDetail(ctx, candidates[index], records, tools);
  }
}

async function persistSelected(
  ctx: ExtensionContext,
  dependencies: AdvisorUiDependencies,
  candidates: CandidateState[],
): Promise<void> {
  const selected = candidates.filter((candidate) => candidate.selected);
  if (!selected.length) {
    ctx.ui.notify("No Approval Rule Proposals selected", "info");
    return;
  }
  const summary = selected.flatMap((candidate) => [
    `• ${matcherSummary(candidate.matcher)} · ${candidate.scope}${candidate.replacements.length ? ` · replaces ${candidate.replacements.length}` : ""}`,
    ...candidate.replacements.map((rule) => `    remove ${rule.id}: ${rule.summary}`),
  ]).join("\n");
  if (!await ctx.ui.confirm("Save Approval Rules?", summary)) return;
  let added = 0;
  try {
    await dependencies.store.update((config) => {
      const project = (config.projects[dependencies.projectKey] ??= { policyRules: [], approvalRules: [] });
      for (const candidate of selected) {
        const replacementIds = new Set(candidate.suggestion.replacesRuleIds);
        const replacements = project.approvalRules.filter((rule) =>
          replacementIds.has(rule.id) && rule.matcher.tool === candidate.matcher.tool);
        if (replacements.length !== replacementIds.size) continue;
        if (replacementIds.size && (!isToolWideMatcher(candidate.matcher)
          || replacements.some((rule) => rule.matcher.input.kind !== "exact"))) continue;
        if (validateToolMatcher(candidate.matcher)) continue;
        const matcher = candidate.matcher;
        if (isToolWideMatcher(matcher)) {
          const currentTool = dependencies.tools.find((tool) => tool.name === matcher.tool
            && tool.source?.source === matcher.source.source
            && tool.source?.path === matcher.source.path);
          if (!currentTool) continue;
        }
        const existing = new Set([
          ...project.approvalRules.filter((rule) => !replacementIds.has(rule.id)).map((rule) => canonical(rule.matcher)),
          ...config.globalApprovalRules.map((rule) => canonical(rule.matcher)),
        ]);
        const key = canonical(candidate.matcher);
        if (existing.has(key)) continue;
        if (candidate.scope === "global" && !isToolWideMatcher(candidate.matcher)) continue;

        if (replacementIds.size) {
          project.approvalRules = project.approvalRules.filter((rule) => !replacementIds.has(rule.id));
        }
        const rule = { id: randomUUID(), matcher: structuredClone(candidate.matcher) };
        if (candidate.scope === "global" && isToolWideMatcher(rule.matcher)) {
          config.globalApprovalRules.push({ ...rule, matcher: rule.matcher });
        } else project.approvalRules.push(rule);
        added += 1;
      }
    });
    ctx.ui.notify(`Saved ${added} Approval Rule${added === 1 ? "" : "s"}`, "info");
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
  const suggestions = outcome.value;
  if (!suggestions.length) {
    ctx.ui.notify("Rule Advisor found no worthwhile Approval Rule Proposals", "info");
    return;
  }

  const records = new Map(history.records.map((record) => [record.id, record]));
  const projectRules = new Map(
    (loaded.config.projects[dependencies.projectKey]?.approvalRules ?? []).map((rule) => [rule.id, rule]),
  );
  const candidates = suggestions.map((suggestion) => ({
    suggestion,
    matcher: structuredClone(suggestion.matcher),
    scope: suggestion.scope,
    selected: false,
    edited: false,
    replacements: suggestion.replacesRuleIds.flatMap((id) => {
      const rule = projectRules.get(id);
      return rule ? [{ id, summary: matcherSummary(rule.matcher) }] : [];
    }),
  }));
  const proceed = ctx.mode === "tui"
    ? await reviewInTui(ctx, candidates, records, dependencies.tools)
    : await reviewWithMenus(ctx, candidates, records, dependencies.tools);
  if (proceed) await persistSelected(ctx, dependencies, candidates);
}
