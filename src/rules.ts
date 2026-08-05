import { randomUUID } from "node:crypto";
import type { Rule, RuleAction, ToolMatcher } from "./domain.ts";
import { matcherKey } from "./matchers.ts";

export function moreRestrictiveAction(left: RuleAction, right: RuleAction): RuleAction {
  const rank: Record<RuleAction, number> = { allow: 0, ask: 1, deny: 2 };
  return rank[left] >= rank[right] ? left : right;
}

export function findMatchingRule(rules: readonly Rule[], matcher: ToolMatcher, excludeId?: string): Rule | undefined {
  const key = matcherKey(matcher);
  return rules.find((rule) => rule.id !== excludeId && matcherKey(rule.matcher) === key);
}

export function upsertRestrictiveRule(rules: Rule[], action: RuleAction, matcher: ToolMatcher): Rule {
  const existing = findMatchingRule(rules, matcher);
  if (existing) {
    existing.action = moreRestrictiveAction(existing.action, action);
    return existing;
  }
  const rule = { id: randomUUID(), action, matcher: structuredClone(matcher) };
  rules.push(rule);
  return rule;
}
