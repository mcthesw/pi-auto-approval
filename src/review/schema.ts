import type { ToolMatcher } from "../domain.ts";
import { parseToolMatcher } from "../config/schema.ts";

const MAX_RESPONSE_CHARS = 16_384;
const MAX_REASON_CHARS = 2_000;

export type ReviewDecision = "approve" | "deny" | "ask_user";

export type ReviewResult = {
  decision: ReviewDecision;
  reason: string;
  approvalRuleProposal?: ToolMatcher;
};

export class ReviewResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewResponseError";
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
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ReviewResponseError("Reviewer response must be an object");
  const input = value as Record<string, unknown>;
  const allowed = new Set(["decision", "reason", "approvalRuleProposal"]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new ReviewResponseError(`Reviewer response contains unknown property: ${unknown}`);
  if (!(["approve", "deny", "ask_user"] as unknown[]).includes(input.decision)) {
    throw new ReviewResponseError("Reviewer decision must be approve, deny, or ask_user");
  }
  if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > MAX_REASON_CHARS) {
    throw new ReviewResponseError("Reviewer reason must be a concise non-empty string");
  }
  if (input.decision !== "ask_user" && input.approvalRuleProposal !== undefined) {
    throw new ReviewResponseError("Only ask_user may include an Approval Rule Proposal");
  }
  return {
    decision: input.decision as ReviewDecision,
    reason: input.reason.trim(),
    ...(input.approvalRuleProposal === undefined
      ? {}
      : { approvalRuleProposal: parseToolMatcher(input.approvalRuleProposal, "approvalRuleProposal") }),
  };
}
