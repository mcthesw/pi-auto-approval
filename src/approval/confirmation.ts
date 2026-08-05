import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ToolCall, ToolMatcher, ToolSourceIdentity } from "../domain.ts";
import type { ReviewRuleSuggestion } from "../review/schema.ts";
import { isStandardToolName } from "../matchers.ts";
import { RuleReviewComponent, type RuleReviewResult } from "../ui/rule-review-component.ts";
import { editRule, matcherSummary } from "../ui/rule-editor.ts";
import { ReadOnlyViewer } from "../ui/read-only-viewer.ts";
import { ApprovalConfirmationComponent, type ConfirmationResult } from "./confirmation-component.ts";

export type UserConfirmationRequest = {
  call: ToolCall;
  reason: string;
  proposals: readonly ReviewRuleSuggestion[];
  toolSource?: ToolSourceIdentity;
  validateProposal: (matcher: ToolMatcher, scope: ReviewRuleSuggestion["scope"]) => Promise<string | undefined>;
};

type FinalConfirmationResult =
  | { kind: "allow_once" }
  | { kind: "always"; rules: ReviewRuleSuggestion[] }
  | { kind: "deny"; feedback?: string }
  | { kind: "cancelled" };

type ProposalState = ReviewRuleSuggestion & { selected: boolean };

function serializedCall(call: ToolCall, pretty = false): string {
  try {
    return JSON.stringify({ toolCallId: call.id, name: call.name, input: call.input }, null, pretty ? 2 : undefined);
  } catch {
    return `${call.name} [unserializable input]`;
  }
}

function previewCall(call: ToolCall): string {
  const value = serializedCall(call);
  return value.length > 500 ? `${value.slice(0, 482)}…[truncated]` : value;
}

async function showFullCall(ctx: ExtensionContext, call: ToolCall): Promise<void> {
  const content = serializedCall(call, true);
  if (ctx.mode !== "tui") {
    const lines = content.split("\n");
    const pageSize = 16;
    const pageCount = Math.max(1, Math.ceil(lines.length / pageSize));
    let page = 0;
    for (;;) {
      const options = [
        ...(page > 0 ? ["Previous"] : []),
        ...(page + 1 < pageCount ? ["Next"] : []),
        "Back",
      ];
      const selected = await ctx.ui.select(
        `Full Tool Call (${page + 1}/${pageCount})\n${lines.slice(page * pageSize, (page + 1) * pageSize).join("\n")}`,
        options,
      );
      if (!selected || selected === "Back") return;
      if (selected === "Previous") page -= 1;
      else if (selected === "Next") page += 1;
    }
  }
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new ReadOnlyViewer(
    tui,
    theme,
    done,
    "Full Tool Call",
    content,
  ));
}

async function customConfirmation(ctx: ExtensionContext, request: UserConfirmationRequest): Promise<ConfirmationResult> {
  const result = await ctx.ui.custom<ConfirmationResult>((tui, theme, _keybindings, done) =>
    new ApprovalConfirmationComponent(tui, theme, done, {
      title: "Tool approval required",
      reason: request.reason,
      callSummary: previewCall(request.call),
    }),
  );
  return result ?? { kind: "cancelled" };
}

async function standardConfirmation(ctx: ExtensionContext, request: UserConfirmationRequest): Promise<ConfirmationResult> {
  const selection = await ctx.ui.select(`Tool approval required\nReason: ${request.reason}\nTool Call: ${previewCall(request.call)}`, [
    "Allow once",
    "Allow with Rule",
    "Deny",
    "View full Tool Call",
  ]);
  if (selection === "Allow once") return { kind: "allow_once" };
  if (selection === "Allow with Rule") return { kind: "allow_with_rule" };
  if (selection === "Deny") {
    const feedback = (await ctx.ui.input("Optional feedback for the Main Agent"))?.trim();
    return { kind: "deny", ...(feedback ? { feedback } : {}) };
  }
  if (selection === "View full Tool Call") return { kind: "view_call" };
  return { kind: "cancelled" };
}

function applySelection(proposals: ProposalState[], selected: readonly boolean[]): void {
  selected.forEach((value, index) => { if (proposals[index]) proposals[index].selected = value; });
}

async function editProposal(ctx: ExtensionContext, request: UserConfirmationRequest, proposal: ProposalState): Promise<void> {
  const edited = await editRule(ctx, {
    initialAction: "allow",
    initial: proposal.matcher,
    initialScope: proposal.scope,
    actionFixed: true,
    toolSource: isStandardToolName(request.call.name) ? undefined : request.toolSource,
    exactInput: request.call.input,
    contextLines: [`Current call: ${previewCall(request.call)}`],
    validate: request.validateProposal,
  });
  if (!edited) return;
  proposal.matcher = edited.matcher;
  proposal.scope = edited.scope;
  proposal.selected = true;
}

async function reviewProposalsInTui(
  ctx: ExtensionContext,
  request: UserConfirmationRequest,
  proposals: ProposalState[],
): Promise<ReviewRuleSuggestion[] | undefined> {
  for (;;) {
    const result = await ctx.ui.custom<RuleReviewResult>((tui, theme, _keybindings, done) => new RuleReviewComponent(
      tui,
      theme,
      proposals.map((proposal) => ({
        summary: `Allow · ${matcherSummary(proposal.matcher)}`,
        selected: proposal.selected,
        scope: proposal.scope,
      })),
      done,
      { title: "Review Rules", subtitle: "Selected Rules will be saved for future matching calls" },
    ));
    if (!result) return undefined;
    applySelection(proposals, result.selected);
    if (result.kind === "cancelled") return undefined;
    if (result.kind === "save") {
      const selected = proposals.filter((proposal) => proposal.selected);
      if (selected.length) return selected.map(({ selected: _selected, ...proposal }) => proposal);
      ctx.ui.notify("Select at least one Rule with Space", "info");
      continue;
    }
    const proposal = proposals[result.index];
    if (proposal) await editProposal(ctx, request, proposal);
  }
}

async function reviewProposalsWithMenus(
  ctx: ExtensionContext,
  request: UserConfirmationRequest,
  proposals: ProposalState[],
): Promise<ReviewRuleSuggestion[] | undefined> {
  for (;;) {
    const labels = [
      ...proposals.map((proposal) => `${proposal.selected ? "[x]" : "[ ]"} Allow · ${proposal.scope} · ${matcherSummary(proposal.matcher)}`),
      "Save selected",
      "Back",
    ];
    const selected = await ctx.ui.select("Review Rules (all selected by default)", labels);
    if (!selected || selected === "Back") return undefined;
    if (selected === "Save selected") {
      const rules = proposals.filter((proposal) => proposal.selected);
      if (rules.length) return rules.map(({ selected: _selected, ...proposal }) => proposal);
      ctx.ui.notify("Select at least one Rule", "info");
      continue;
    }
    const index = labels.indexOf(selected);
    const proposal = proposals[index];
    if (!proposal) continue;
    const action = await ctx.ui.select(selected, [proposal.selected ? "Unselect" : "Select", "View / edit", "Back"]);
    if (action === "Select") proposal.selected = true;
    else if (action === "Unselect") proposal.selected = false;
    else if (action === "View / edit") await editProposal(ctx, request, proposal);
  }
}

async function reviewProposals(
  ctx: ExtensionContext,
  request: UserConfirmationRequest,
): Promise<ReviewRuleSuggestion[] | undefined> {
  const proposals = request.proposals.map((proposal) => ({ ...structuredClone(proposal), selected: true }));
  if (!proposals.length) {
    ctx.ui.notify("No valid Rules are available for this Tool Call", "warning");
    return undefined;
  }
  return ctx.mode === "tui"
    ? await reviewProposalsInTui(ctx, request, proposals)
    : await reviewProposalsWithMenus(ctx, request, proposals);
}

export async function confirmToolCall(
  ctx: ExtensionContext,
  request: UserConfirmationRequest,
): Promise<FinalConfirmationResult> {
  if (!ctx.hasUI) return { kind: "deny", feedback: "Tool Call requires confirmation but no UI is available" };
  for (;;) {
    const result = ctx.mode === "tui"
      ? await customConfirmation(ctx, request)
      : await standardConfirmation(ctx, request);
    if (result.kind === "view_call") {
      await showFullCall(ctx, request.call);
      continue;
    }
    if (result.kind !== "allow_with_rule") return result;
    const rules = await reviewProposals(ctx, request);
    if (rules) return { kind: "always", rules };
  }
}
