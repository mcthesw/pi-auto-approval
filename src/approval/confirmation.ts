import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ToolCall, ToolMatcher, ToolSourceIdentity } from "../domain.ts";
import { ApprovalConfirmationComponent, type ConfirmationResult } from "./confirmation-component.ts";
import { editApprovalRule, matcherSummary, type RuleScope } from "../ui/rule-editor.ts";

export type UserConfirmationRequest = {
  call: ToolCall;
  reason: string;
  proposal: ToolMatcher;
  toolSource?: ToolSourceIdentity;
  validateProposal: (matcher: ToolMatcher) => Promise<string | undefined>;
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
      matcherSummary: matcherSummary(request.proposal),
    }),
  );
  return result ?? { kind: "cancelled" };
}

async function standardConfirmation(ctx: ExtensionContext, request: UserConfirmationRequest): Promise<ConfirmationResult> {
  const selection = await ctx.ui.select(`Tool approval required: ${request.reason}\n${previewCall(request.call)}`, [
    "Approve once",
    "Always approve with rule",
    "Deny",
  ]);
  if (selection === "Approve once") return { kind: "approve_once" };
  if (selection === "Always approve with rule") return { kind: "always" };
  if (selection === "Deny") {
    const feedback = (await ctx.ui.input("Optional feedback for the Main Agent"))?.trim();
    return { kind: "deny", ...(feedback ? { feedback } : {}) };
  }
  return { kind: "cancelled" };
}

export async function confirmToolCall(
  ctx: ExtensionContext,
  request: UserConfirmationRequest,
): Promise<ConfirmationResult & { matcher?: ToolMatcher; scope?: RuleScope }> {
  if (!ctx.hasUI) return { kind: "deny", feedback: "Tool Call requires confirmation but no UI is available" };
  const result = ctx.mode === "tui"
    ? await customConfirmation(ctx, request)
    : await standardConfirmation(ctx, request);
  if (result.kind !== "always") return result;
  const edited = await editApprovalRule(ctx, {
    initial: request.proposal,
    toolSource: request.toolSource,
    exactInput: request.call.input,
    validate: request.validateProposal,
  });
  return edited ? { kind: "always", matcher: edited.matcher, scope: edited.scope } : { kind: "cancelled" };
}
