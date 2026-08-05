import type { ReviewDecision, ToolMatcher } from "../domain.ts";
export type { ReviewDecision } from "../domain.ts";
import { parseToolMatcher } from "../config/schema.ts";
import type { RuleScope } from "../matchers.ts";

const MAX_RESPONSE_CHARS = 16_384;
const MAX_REASON_CHARS = 2_000;
const MAX_SUGGESTIONS = 10;

export type ReviewRuleSuggestion = {
  matcher: ToolMatcher;
  scope: RuleScope;
};

export type ReviewResult = {
  decision: ReviewDecision;
  reason: string;
  ruleSuggestions?: ReviewRuleSuggestion[];
};

export class ReviewResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewResponseError";
  }
}

function record(value: unknown, at: string): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseSuggestion(value: unknown): ReviewRuleSuggestion | undefined {
  const input = record(value, "ruleSuggestion");
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

export function parseReviewResponse(source: string): ReviewResult {
  const trimmed = source.trim();
  if (!trimmed || trimmed.length > MAX_RESPONSE_CHARS) throw new ReviewResponseError("Reviewer response is empty or too large");
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    throw new ReviewResponseError(`Reviewer returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const input = record(value, "response");
  if (!input) throw new ReviewResponseError("Reviewer response must be an object");
  const allowed = new Set(["decision", "reason", "ruleSuggestions"]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new ReviewResponseError(`Reviewer response contains unknown property: ${unknown}`);
  if (!( ["allow", "deny", "ask"] as unknown[]).includes(input.decision)) {
    throw new ReviewResponseError("Reviewer decision must be allow, deny, or ask");
  }
  if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > MAX_REASON_CHARS) {
    throw new ReviewResponseError("Reviewer reason must be a concise non-empty string");
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
