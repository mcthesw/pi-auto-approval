import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ToolCall, ToolMatcher } from "../domain.ts";
import { parseToolMatcher } from "../config/schema.ts";
import { ApprovalConfirmationComponent, type ConfirmationResult } from "./confirmation-component.ts";

export type UserConfirmationRequest = {
  call: ToolCall;
  reason: string;
  proposal: ToolMatcher;
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

function matcherFromText(source: string): ToolMatcher {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid matcher JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseToolMatcher(value);
}

function matcherSyntaxError(source: string): string | undefined {
  try {
    matcherFromText(source);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function customConfirmation(ctx: ExtensionContext, request: UserConfirmationRequest, matcherText: string): Promise<ConfirmationResult> {
  const result = await ctx.ui.custom<ConfirmationResult>((tui, theme, _keybindings, done) =>
    new ApprovalConfirmationComponent(tui, theme, done, {
      title: "Tool approval required",
      detail: `${request.reason} — ${previewCall(request.call)}`,
      matcherText,
      validateMatcherText: matcherSyntaxError,
    }),
  );
  return result ?? { kind: "deny", feedback: "Approval dialog closed" };
}

async function standardConfirmation(ctx: ExtensionContext, request: UserConfirmationRequest, matcherText: string): Promise<ConfirmationResult> {
  const selection = await ctx.ui.select(`Tool approval required: ${request.reason}\n${previewCall(request.call)}`, [
    "Approve once",
    "Always approve with rule",
    "Deny",
  ]);
  if (selection === "Approve once") return { kind: "approve_once" };
  if (selection === "Always approve with rule") {
    const edited = await ctx.ui.editor("Edit Approval Rule matcher JSON", matcherText);
    return edited === undefined
      ? { kind: "deny", feedback: "Approval Rule editing cancelled" }
      : { kind: "always", matcherText: edited };
  }
  if (selection === "Deny") {
    const feedback = (await ctx.ui.input("Optional feedback for the Main Agent"))?.trim();
    return { kind: "deny", ...(feedback ? { feedback } : {}) };
  }
  return { kind: "deny", feedback: "Approval dialog closed" };
}

export async function confirmToolCall(ctx: ExtensionContext, request: UserConfirmationRequest): Promise<ConfirmationResult & { matcher?: ToolMatcher }> {
  if (!ctx.hasUI) return { kind: "deny", feedback: "Tool Call requires confirmation but no UI is available" };
  let matcherText = JSON.stringify(request.proposal);

  for (;;) {
    const result = ctx.mode === "tui"
      ? await customConfirmation(ctx, request, matcherText)
      : await standardConfirmation(ctx, request, matcherText);
    if (result.kind !== "always") return result;
    matcherText = result.matcherText;
    let matcher: ToolMatcher;
    try {
      matcher = matcherFromText(matcherText);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      continue;
    }
    const mismatch = await request.validateProposal(matcher);
    if (mismatch) {
      ctx.ui.notify(mismatch, "error");
      continue;
    }
    return { ...result, matcher };
  }
}
