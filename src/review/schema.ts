import type { ReviewDecision, ToolMatcher } from "../domain.ts";
export type { ReviewDecision } from "../domain.ts";
import { parseToolMatcher } from "../config/schema.ts";
import type { RuleScope } from "../matchers.ts";

const MAX_RESPONSE_CHARS = 65_536;
const MAX_REASON_CHARS = 2_000;
const MAX_SUGGESTIONS = 10;

export const STRUCTURED_RESPONSE_CORRECTION_PROMPT = "Your previous response did not conform to the required JSON contract. Keep the original request and authorization boundaries unchanged. Return only one corrected JSON object in the required shape, with no markdown or explanation.";

export type ReviewRuleSuggestion = {
  matcher: ToolMatcher;
  scope: RuleScope;
};

export type ReviewResult = {
  decision: ReviewDecision;
  reason: string;
  ruleSuggestions?: ReviewRuleSuggestion[];
};

export type ReviewBatchResult = {
  decisions: Map<string, ReviewResult>;
};

export class ReviewResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewResponseError";
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function exactKeys(input: Record<string, unknown>, allowed: readonly string[], at: string): void {
  const names = new Set(allowed);
  const unknown = Object.keys(input).find((key) => !names.has(key));
  if (unknown) throw new ReviewResponseError(`${at} contains unknown property: ${unknown}`);
}

function parseSuggestion(value: unknown): ReviewRuleSuggestion | undefined {
  const input = record(value);
  if (!input || Object.keys(input).some((key) => key !== "matcher" && key !== "scope")) return undefined;
  if (input.scope !== "project" && input.scope !== "global") return undefined;
  try {
    return {
      scope: input.scope as RuleScope,
      matcher: parseToolMatcher(input.matcher, "ruleSuggestion.matcher", input.scope as RuleScope),
    };
  } catch {
    return undefined;
  }
}

function parseReviewResult(value: unknown, at: string): ReviewResult {
  const input = record(value);
  if (!input) throw new ReviewResponseError(`${at} must be an object`);
  exactKeys(input, ["decision", "reason", "ruleSuggestions"], at);
  if (!( ["allow", "deny", "ask"] as unknown[]).includes(input.decision)) {
    throw new ReviewResponseError(`${at}.decision must be allow, deny, or ask`);
  }
  if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > MAX_REASON_CHARS) {
    throw new ReviewResponseError(`${at}.reason must be a concise non-empty string`);
  }
  const decision = input.decision as ReviewDecision;
  const suggestions = decision === "ask" && Array.isArray(input.ruleSuggestions)
    ? input.ruleSuggestions.slice(0, MAX_SUGGESTIONS).flatMap((item) => {
      const suggestion = parseSuggestion(item);
      return suggestion ? [suggestion] : [];
    })
    : [];
  return {
    decision,
    reason: input.reason.trim(),
    ...(suggestions.length ? { ruleSuggestions: suggestions } : {}),
  };
}

export function parseReviewBatchResponse(source: string, expectedToolCallIds: readonly string[]): ReviewBatchResult {
  const trimmed = source.trim();
  if (!trimmed || trimmed.length > MAX_RESPONSE_CHARS) throw new ReviewResponseError("Reviewer response is empty or too large");
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    throw new ReviewResponseError(`Reviewer returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = record(value);
  if (!root) throw new ReviewResponseError("Reviewer response must be an object");
  exactKeys(root, ["decisions"], "response");
  if (!Array.isArray(root.decisions)) throw new ReviewResponseError("response.decisions must be an array");
  if (root.decisions.length !== expectedToolCallIds.length) {
    throw new ReviewResponseError("response.decisions must contain exactly one entry for every Tool Call");
  }
  const expected = new Set(expectedToolCallIds);
  if (expected.size !== expectedToolCallIds.length) throw new ReviewResponseError("Review Batch input contains duplicate Tool Call IDs");
  const decisions = new Map<string, ReviewResult>();
  for (let index = 0; index < root.decisions.length; index += 1) {
    const item = record(root.decisions[index]);
    if (!item) throw new ReviewResponseError(`response.decisions[${index}] must be an object`);
    exactKeys(item, ["toolCallId", "decision", "reason", "ruleSuggestions"], `response.decisions[${index}]`);
    if (typeof item.toolCallId !== "string" || !expected.has(item.toolCallId)) {
      throw new ReviewResponseError(`response.decisions[${index}].toolCallId is not an expected Tool Call ID`);
    }
    if (item.toolCallId !== expectedToolCallIds[index]) {
      throw new ReviewResponseError("response.decisions must follow Tool Call source order");
    }
    if (decisions.has(item.toolCallId)) {
      throw new ReviewResponseError(`response.decisions contains duplicate Tool Call ID: ${item.toolCallId}`);
    }
    const { toolCallId: _toolCallId, ...result } = item;
    decisions.set(item.toolCallId, parseReviewResult(result, `response.decisions[${index}]`));
  }
  if (decisions.size !== expected.size) throw new ReviewResponseError("response.decisions is missing a Tool Call ID");
  return { decisions };
}
