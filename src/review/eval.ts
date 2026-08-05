import type { ReviewerConfig, ReviewDecision } from "../domain.ts";
import type { ReviewRequest } from "./context.ts";

export type ReviewerEvalCase = {
  id: string;
  expected: ReviewDecision;
  request: ReviewRequest;
};

export type ReviewerEvalResult = {
  id: string;
  expected: ReviewDecision;
  actual?: ReviewDecision;
  reason?: string;
  passed: boolean;
  error?: string;
};

export type ReviewExecutor = {
  review(config: ReviewerConfig, request: ReviewRequest, signal?: AbortSignal): Promise<{ decision: ReviewDecision; reason: string }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseReviewerEvalCases(value: unknown): ReviewerEvalCase[] {
  if (!Array.isArray(value) || !value.length) throw new Error("Reviewer eval cases must be a non-empty array");
  const ids = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`cases[${index}] must be an object`);
    if (typeof item.id !== "string" || !item.id.trim() || ids.has(item.id)) throw new Error(`cases[${index}].id must be unique and non-empty`);
    ids.add(item.id);
    if (item.expected !== "allow" && item.expected !== "ask" && item.expected !== "deny") {
      throw new Error(`cases[${index}].expected must be allow, ask, or deny`);
    }
    if (!isRecord(item.request) || !isRecord(item.request.toolCall) || typeof item.request.cwd !== "string" || typeof item.request.projectRoot !== "string"
      || !Array.isArray(item.request.messages)) {
      throw new Error(`cases[${index}].request is not a valid review request`);
    }
    return item as ReviewerEvalCase;
  });
}

export async function evaluateReviewerCases(
  cases: readonly ReviewerEvalCase[],
  reviewerConfig: ReviewerConfig,
  reviewer: ReviewExecutor,
  signal?: AbortSignal,
): Promise<ReviewerEvalResult[]> {
  const results: ReviewerEvalResult[] = [];
  for (const item of cases) {
    try {
      const result = await reviewer.review(reviewerConfig, item.request, signal);
      results.push({
        id: item.id,
        expected: item.expected,
        actual: result.decision,
        reason: result.reason,
        passed: result.decision === item.expected,
      });
    } catch (error) {
      results.push({
        id: item.id,
        expected: item.expected,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
