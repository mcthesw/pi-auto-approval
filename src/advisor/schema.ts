import type { ApprovalRule, ApprovalRuleScope, FrictionRecord, ToolMatcher, ToolSourceIdentity } from "../domain.ts";
import { parseToolMatcher } from "../config/schema.ts";
import { isStandardToolName, isToolWideMatcher } from "../matchers.ts";

const MAX_RESPONSE_CHARS = 32_768;
const MAX_PROPOSALS = 10;
const MAX_RATIONALE_CHARS = 1_000;

export type AdvisorToolIdentity = {
  name: string;
  source?: ToolSourceIdentity;
};

export type ApprovalRuleProposal = {
  matcher: ToolMatcher;
  scope: ApprovalRuleScope;
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
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AdvisorResponseError(`${at} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], at: string): void {
  const names = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !names.has(key));
  if (unknown) throw new AdvisorResponseError(`${at} contains unknown property: ${unknown}`);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function toolExists(matcher: ToolMatcher, tools: readonly AdvisorToolIdentity[]): boolean {
  if (!isToolWideMatcher(matcher)) return tools.some((tool) => tool.name === matcher.tool);
  return tools.some((tool) =>
    tool.name === matcher.tool
    && tool.source?.source === matcher.source.source
    && tool.source.path === matcher.source.path);
}

export function parseAdvisorResponse(
  source: string,
  context: {
    records: readonly FrictionRecord[];
    tools: readonly AdvisorToolIdentity[];
    projectApprovalRules: readonly ApprovalRule[];
    globalMatchers: readonly ToolMatcher[];
  },
): ApprovalRuleProposal[] {
  const trimmed = source.trim();
  if (!trimmed || trimmed.length > MAX_RESPONSE_CHARS) {
    throw new AdvisorResponseError("Rule Advisor response is empty or too large");
  }
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
  const projectRules = new Map(context.projectApprovalRules.map((rule) => [rule.id, rule]));
  const seenMatchers = new Set([
    ...context.projectApprovalRules.map((rule) => canonical(rule.matcher)),
    ...context.globalMatchers.map(canonical),
  ]);
  const seenReplacementIds = new Set<string>();
  const proposals: ApprovalRuleProposal[] = [];
  for (let index = 0; index < root.proposals.length; index += 1) {
    const at = `response.proposals[${index}]`;
    try {
      const input = record(root.proposals[index], at);
      exactKeys(input, ["matcher", "scope", "rationale", "supportingRecordIds", "replacesRuleIds"], at);
      let matcher: ToolMatcher;
      try {
        matcher = parseToolMatcher(input.matcher, `${at}.matcher`);
      } catch (error) {
        throw new AdvisorResponseError(error instanceof Error ? error.message : String(error));
      }
      if (!toolExists(matcher, context.tools)) throw new AdvisorResponseError(`${at}.matcher does not identify a current Tool`);
      const tool = context.tools.find((candidate) => candidate.name === matcher.tool);
      if (tool?.source && !isStandardToolName(matcher.tool) && !isToolWideMatcher(matcher)) {
        throw new AdvisorResponseError(`${at}.matcher must use source-bound Tool-wide matching for an external Tool`);
      }
      if (input.scope !== "project" && input.scope !== "global") {
        throw new AdvisorResponseError(`${at}.scope must be project or global`);
      }
      if (input.scope === "global" && !isToolWideMatcher(matcher)) {
        throw new AdvisorResponseError(`${at}.scope can be global only for a Tool-wide matcher`);
      }
      if (typeof input.rationale !== "string" || !input.rationale.trim() || input.rationale.length > MAX_RATIONALE_CHARS) {
        throw new AdvisorResponseError(`${at}.rationale must be a concise non-empty string`);
      }
      if (!Array.isArray(input.supportingRecordIds) || input.supportingRecordIds.length > 50
        || input.supportingRecordIds.some((id) => typeof id !== "string" || !recordIds.has(id))) {
        throw new AdvisorResponseError(`${at}.supportingRecordIds must reference retained Friction Records`);
      }
      const supportingRecordIds = [...new Set(input.supportingRecordIds as string[])];
      if (!isToolWideMatcher(matcher) && !supportingRecordIds.length) {
        throw new AdvisorResponseError(`${at} needs historical evidence for a specific-input matcher`);
      }
      if (!Array.isArray(input.replacesRuleIds) || input.replacesRuleIds.length > 50
        || input.replacesRuleIds.some((id) => typeof id !== "string" || !projectRules.has(id))) {
        throw new AdvisorResponseError(`${at}.replacesRuleIds must reference current Project Approval Rules`);
      }
      const replacesRuleIds = [...new Set(input.replacesRuleIds as string[])];
      if (replacesRuleIds.some((id) => projectRules.get(id)?.matcher.tool !== matcher.tool)) {
        throw new AdvisorResponseError(`${at}.replacesRuleIds must target rules for the same Tool`);
      }
      if (replacesRuleIds.length && (!isToolWideMatcher(matcher)
        || replacesRuleIds.some((id) => projectRules.get(id)?.matcher.input.kind !== "exact"))) {
        throw new AdvisorResponseError(`${at}.replacesRuleIds may only consolidate exact rules into a Tool-wide matcher`);
      }
      if (replacesRuleIds.some((id) => seenReplacementIds.has(id))) {
        throw new AdvisorResponseError(`${at}.replacesRuleIds overlap another proposal`);
      }
      const replacedMatcherKeys = new Set(replacesRuleIds.map((id) => canonical(projectRules.get(id)!.matcher)));
      const key = canonical(matcher);
      if (seenMatchers.has(key) && !replacedMatcherKeys.has(key)) continue;
      replacesRuleIds.forEach((id) => seenReplacementIds.add(id));
      seenMatchers.add(key);
      proposals.push({
        matcher,
        scope: input.scope,
        rationale: input.rationale.trim(),
        supportingRecordIds,
        replacesRuleIds,
      });
    } catch (error) {
      if (!(error instanceof AdvisorResponseError)) throw error;
    }
  }
  return proposals;
}
