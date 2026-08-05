import type { FrictionRecord, Rule, RuleAction, ToolMatcher, ToolSourceIdentity } from "../domain.ts";
import { ConfigValidationError, parseToolMatcher } from "../config/schema.ts";
import { isStandardToolName, matcherKey, type RuleScope } from "../matchers.ts";

const MAX_RESPONSE_CHARS = 32_768;
const MAX_PROPOSALS = 10;
const MAX_RATIONALE_CHARS = 1_000;

export type AdvisorToolIdentity = {
  name: string;
  source?: ToolSourceIdentity;
};

export type RuleSuggestion = {
  action: RuleAction;
  matcher: ToolMatcher;
  scope: RuleScope;
  rationale: string;
  supportingRecordIds: string[];
  replacesRuleIds: string[];
};

export class AdvisorResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdvisorResponseError";
  }
}

function record(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AdvisorResponseError(`${at} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], at: string): void {
  const names = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !names.has(key));
  if (unknown) throw new AdvisorResponseError(`${at} contains unknown property: ${unknown}`);
}

function sameSource(left: ToolSourceIdentity, right: ToolSourceIdentity): boolean {
  return left.source === right.source && left.path === right.path;
}

function bindKnownSource(matcher: ToolMatcher, tools: readonly AdvisorToolIdentity[]): ToolMatcher {
  if (isStandardToolName(matcher.tool)) {
    const { source: _source, ...unbound } = matcher;
    return unbound;
  }
  const sources = tools.filter((candidate) => candidate.name === matcher.tool && candidate.source)
    .map((candidate) => candidate.source!);
  if (matcher.source) {
    if (!sources.some((source) => sameSource(source, matcher.source!))) {
      throw new AdvisorResponseError(`matcher source is not a current source for ${matcher.tool}`);
    }
    return matcher;
  }
  return sources.length === 1 ? { ...matcher, source: structuredClone(sources[0]!) } : matcher;
}

export function parseAdvisorResponse(
  source: string,
  context: {
    records: readonly FrictionRecord[];
    tools: readonly AdvisorToolIdentity[];
    projectRules: readonly Rule[];
    globalRules: readonly Rule[];
  },
): RuleSuggestion[] {
  const trimmed = source.trim();
  if (!trimmed || trimmed.length > MAX_RESPONSE_CHARS) throw new AdvisorResponseError("Rule Advisor response is empty or too large");
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    throw new AdvisorResponseError(`Rule Advisor returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = record(value, "response");
  exactKeys(root, ["proposals"], "response");
  if (!Array.isArray(root.proposals) || root.proposals.length > MAX_PROPOSALS) {
    throw new AdvisorResponseError(`response.proposals must be an array with at most ${MAX_PROPOSALS} items`);
  }

  const recordIds = new Set(context.records.map((item) => item.id));
  const projectRules = new Map(context.projectRules.map((rule) => [rule.id, rule]));
  const scopedMatcherKey = (scope: RuleScope, matcher: ToolMatcher) => `${scope}:${matcherKey(matcher)}`;
  const existing = new Set([
    ...context.projectRules.map((rule) => scopedMatcherKey("project", rule.matcher)),
    ...context.globalRules.map((rule) => scopedMatcherKey("global", rule.matcher)),
  ]);
  const seenMatchers = new Set(existing);
  const seenReplacementIds = new Set<string>();
  const suggestions: RuleSuggestion[] = [];
  for (let index = 0; index < root.proposals.length; index += 1) {
    const at = `response.proposals[${index}]`;
    try {
      const input = record(root.proposals[index], at);
      exactKeys(input, ["action", "matcher", "scope", "rationale", "supportingRecordIds", "replacesRuleIds"], at);
      if (input.action !== "allow" && input.action !== "ask" && input.action !== "deny") {
        throw new AdvisorResponseError(`${at}.action must be allow, ask, or deny`);
      }
      if (input.scope !== "project" && input.scope !== "global") {
        throw new AdvisorResponseError(`${at}.scope must be project or global`);
      }
      let matcher = parseToolMatcher(input.matcher, `${at}.matcher`, input.scope as RuleScope);
      matcher = bindKnownSource(matcher, context.tools);
      if (!context.tools.some((tool) => tool.name === matcher.tool)) {
        throw new AdvisorResponseError(`${at}.matcher does not identify a current Tool`);
      }
      if (typeof input.rationale !== "string" || !input.rationale.trim() || input.rationale.length > MAX_RATIONALE_CHARS) {
        throw new AdvisorResponseError(`${at}.rationale must be a concise non-empty string`);
      }
      if (!Array.isArray(input.supportingRecordIds) || input.supportingRecordIds.length > 50
        || input.supportingRecordIds.some((id) => typeof id !== "string" || !recordIds.has(id))) {
        throw new AdvisorResponseError(`${at}.supportingRecordIds must reference retained Friction Records`);
      }
      if (!Array.isArray(input.replacesRuleIds) || input.replacesRuleIds.length > 50
        || input.replacesRuleIds.some((id) => typeof id !== "string" || !projectRules.has(id))) {
        throw new AdvisorResponseError(`${at}.replacesRuleIds must reference current Project Rules`);
      }
      const supportingRecordIds = [...new Set(input.supportingRecordIds as string[])];
      const replacesRuleIds = [...new Set(input.replacesRuleIds as string[])];
      if (replacesRuleIds.some((id) => projectRules.get(id)?.matcher.tool !== matcher.tool)) {
        throw new AdvisorResponseError(`${at}.replacesRuleIds must target Rules for the same Tool`);
      }
      if (replacesRuleIds.some((id) => seenReplacementIds.has(id))) {
        throw new AdvisorResponseError(`${at}.replacesRuleIds overlap another proposal`);
      }
      const replacedKeys = new Set(replacesRuleIds.map((id) => scopedMatcherKey("project", projectRules.get(id)!.matcher)));
      const key = scopedMatcherKey(input.scope as RuleScope, matcher);
      if (seenMatchers.has(key) && !replacedKeys.has(key)) continue;
      replacesRuleIds.forEach((id) => seenReplacementIds.add(id));
      seenMatchers.add(key);
      suggestions.push({
        action: input.action as RuleAction,
        matcher,
        scope: input.scope as RuleScope,
        rationale: input.rationale.trim(),
        supportingRecordIds,
        replacesRuleIds,
      });
    } catch (error) {
      if (!(error instanceof AdvisorResponseError) && !(error instanceof ConfigValidationError)) throw error;
    }
  }
  return suggestions;
}
