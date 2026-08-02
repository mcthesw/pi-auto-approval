import type { FrictionRecord, ToolMatcher, ToolSourceIdentity } from "../domain.ts";
import { parseToolMatcher } from "../config/schema.ts";
import { isToolWideMatcher } from "../matchers.ts";

const MAX_RESPONSE_CHARS = 32_768;
const MAX_PROPOSALS = 10;
const MAX_RATIONALE_CHARS = 1_000;

export type AdvisorToolIdentity = {
  name: string;
  source?: ToolSourceIdentity;
};

export type ApprovalRuleProposal = {
  matcher: ToolMatcher;
  rationale: string;
  supportingRecordIds: string[];
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
    existingMatchers: readonly ToolMatcher[];
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
  const seenMatchers = new Set(context.existingMatchers.map(canonical));
  const proposals: ApprovalRuleProposal[] = [];
  for (let index = 0; index < root.proposals.length; index += 1) {
    const at = `response.proposals[${index}]`;
    const input = record(root.proposals[index], at);
    exactKeys(input, ["matcher", "rationale", "supportingRecordIds"], at);
    let matcher: ToolMatcher;
    try {
      matcher = parseToolMatcher(input.matcher, `${at}.matcher`);
    } catch (error) {
      throw new AdvisorResponseError(error instanceof Error ? error.message : String(error));
    }
    if (!toolExists(matcher, context.tools)) throw new AdvisorResponseError(`${at}.matcher does not identify a current Tool`);
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
    const key = canonical(matcher);
    if (seenMatchers.has(key)) continue;
    seenMatchers.add(key);
    proposals.push({ matcher, rationale: input.rationale.trim(), supportingRecordIds });
  }
  return proposals;
}
