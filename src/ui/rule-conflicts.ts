import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Rule, RuleAction, ToolMatcher } from "../domain.ts";
import type { RuleScope } from "../matchers.ts";
import { moreRestrictiveAction } from "../rules.ts";
import { actionLabel, matcherSummary } from "./rule-editor.ts";

export type RuleConflict = {
  existing: Rule;
  incoming: { action: RuleAction; matcher: ToolMatcher; scope: RuleScope };
};

export async function confirmRuleConflicts(ctx: ExtensionContext, conflicts: readonly RuleConflict[]): Promise<boolean> {
  if (!conflicts.length) return true;
  const detail = conflicts.map(({ existing, incoming }) => {
    const kept = moreRestrictiveAction(existing.action, incoming.action);
    return [
      `${actionLabel(existing.action)} · ${incoming.scope === "global" ? "Global" : "Project"} · ${matcherSummary(existing.matcher)}`,
      `  → keep ${actionLabel(kept)}`,
    ].join("\n");
  }).join("\n");
  return await ctx.ui.confirm("Merge matching Rules?", detail);
}
