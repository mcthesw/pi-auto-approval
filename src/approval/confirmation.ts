import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ToolCall, ToolMatcher, ToolSourceIdentity } from "../domain.ts";
import type { ReviewRuleSuggestion } from "../review/schema.ts";
import { ApprovalConfirmationComponent, type ConfirmationResult } from "./confirmation-component.ts";
import { isStandardToolName } from "../matchers.ts";
import { editRuleMatcher, matcherSummary } from "../ui/rule-editor.ts";

export type UserConfirmationRequest = {
  call: ToolCall;
  reason: string;
  proposals: readonly ReviewRuleSuggestion[];
  toolSource?: ToolSourceIdentity;
  validateProposal: (matcher: ToolMatcher, scope: ReviewRuleSuggestion["scope"]) => Promise<string | undefined>;
};

function previewCall(call: ToolCall): string {
  let input: string;
  try {
    input = JSON.stringify(call.input);
  } catch {
    input = "[unserializable input]";
  }
  const preview = `${call.name} ${input}`;
  return preview.length > 500 ? `${preview.slice(0, 482)}…[truncated]` : preview;
}

async function customConfirmation(ctx: ExtensionContext, request: UserConfirmationRequest): Promise<ConfirmationResult> {
  const result = await ctx.ui.custom<ConfirmationResult>((tui, theme, _keybindings, done) =>
    new ApprovalConfirmationComponent(tui, theme, done, {
      title: "Tool approval required",
      detail: `${request.reason} — ${previewCall(request.call)}`,
      matcherSummary: request.proposals.map((proposal) => matcherSummary(proposal.matcher)).join("\n    "),
    }),
  );
  return result ?? { kind: "cancelled" };
}

async function standardConfirmation(ctx: ExtensionContext, request: UserConfirmationRequest): Promise<ConfirmationResult> {
  const selection = await ctx.ui.select(`Tool approval required: ${request.reason}\n${previewCall(request.call)}`, [
    "Allow once",
    "Always allow with Rule",
    "Deny",
  ]);
  if (selection === "Allow once") return { kind: "allow_once" };
  if (selection === "Always allow with Rule") return { kind: "always" };
  if (selection === "Deny") {
    const feedback = (await ctx.ui.input("Optional feedback for the Main Agent"))?.trim();
    return { kind: "deny", ...(feedback ? { feedback } : {}) };
  }
  return { kind: "cancelled" };
}

async function editSuggestions(
  ctx: ExtensionContext,
  request: UserConfirmationRequest,
): Promise<ReviewRuleSuggestion[] | undefined> {
  const edited: ReviewRuleSuggestion[] = [];
  for (const proposal of request.proposals) {
    const result = await editRuleMatcher(ctx, {
      initial: proposal.matcher,
      initialScope: proposal.scope,
      toolSource: isStandardToolName(request.call.name) ? undefined : request.toolSource,
      exactInput: request.call.input,
      validate: request.validateProposal,
    });
    if (!result) return undefined;
    edited.push(result);
  }
  return edited;
}

export async function confirmToolCall(
  ctx: ExtensionContext,
  request: UserConfirmationRequest,
): Promise<ConfirmationResult & { rules?: ReviewRuleSuggestion[] }> {
  if (!ctx.hasUI) return { kind: "deny", feedback: "Tool Call requires confirmation but no UI is available" };
  const result = ctx.mode === "tui"
    ? await customConfirmation(ctx, request)
    : await standardConfirmation(ctx, request);
  if (result.kind !== "always") return result;
  const rules = await editSuggestions(ctx, request);
  return rules ? { kind: "always", rules } : { kind: "cancelled" };
}
