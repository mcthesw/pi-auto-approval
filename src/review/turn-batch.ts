import { EMPTY_PROJECT_CONFIG, type AutoApprovalConfig, type ToolCall, type ToolSourceIdentity } from "../domain.ts";
import { evaluatePolicy } from "../policy/engine.ts";
import type { ProjectIdentity } from "../project.ts";
import {
  MAX_REVIEW_BATCH_TOOL_CALL_BYTES,
  ReviewContextError,
  reviewToolCallBytes,
  reviewToolCallSignature,
  type ReviewBatchRequest,
  type ReviewToolMetadata,
} from "./context.ts";
import type { ReviewBatchResult, ReviewResult } from "./schema.ts";

export const MAX_REVIEW_BATCH_CALLS = 16;

export type TurnReviewCall = {
  call: ToolCall;
  toolSource?: ToolSourceIdentity;
  tool?: ReviewToolMetadata;
};

type CachedReview = {
  signature: string;
  batch: Promise<ReviewBatchResult>;
};

export type TurnReviewBatchInput = {
  current: TurnReviewCall;
  siblings: readonly TurnReviewCall[];
  config: AutoApprovalConfig;
  project: ProjectIdentity;
  cwd: string;
  messages: readonly unknown[];
  run: (request: ReviewBatchRequest) => Promise<ReviewBatchResult>;
};

function chunks(calls: readonly TurnReviewCall[]): TurnReviewCall[][] {
  const result: TurnReviewCall[][] = [];
  let current: TurnReviewCall[] = [];
  let totalBytes = 0;
  for (const call of calls) {
    let size: number;
    try {
      size = reviewToolCallBytes(call.call);
    } catch {
      continue;
    }
    if (!current.length || (current.length < MAX_REVIEW_BATCH_CALLS && totalBytes + size <= MAX_REVIEW_BATCH_TOOL_CALL_BYTES)) {
      current.push(call);
      totalBytes += size;
      continue;
    }
    result.push(current);
    current = [call];
    totalBytes = size;
  }
  if (current.length) result.push(current);
  return result;
}

async function reviewEligibleCalls(input: TurnReviewBatchInput): Promise<TurnReviewCall[]> {
  const project = input.config.projects[input.project.key] ?? EMPTY_PROJECT_CONFIG;
  const eligible: TurnReviewCall[] = [];
  for (const candidate of input.siblings) {
    try {
      if (reviewToolCallBytes(candidate.call) > MAX_REVIEW_BATCH_TOOL_CALL_BYTES) continue;
      const policy = await evaluatePolicy(candidate.call, {
        projectRoot: input.project.root,
        cwd: input.cwd,
        project,
        globalRules: input.config.globalRules,
        toolSource: candidate.toolSource,
      });
      if (policy.action === "review") eligible.push(candidate);
    } catch {
      // An unserializable sibling cannot be safely passed to the Reviewer.
    }
  }
  return eligible;
}

function decisionFor(batch: Promise<ReviewBatchResult>, toolCallId: string): Promise<ReviewResult> {
  return batch.then((review) => {
    const decision = review.decisions.get(toolCallId);
    if (!decision) throw new ReviewContextError(`Reviewer omitted Tool Call ${toolCallId}`);
    return decision;
  });
}

export class TurnReviewBatchCoordinator {
  private readonly cached = new Map<string, CachedReview>();

  clear(toolCallIds: readonly string[]): void {
    toolCallIds.forEach((id) => this.cached.delete(id));
  }

  clearAll(): void {
    this.cached.clear();
  }

  async review(input: TurnReviewBatchInput): Promise<ReviewResult> {
    const signature = reviewToolCallSignature(input.current.call);
    const existing = this.cached.get(input.current.call.id);
    if (existing && existing.signature === signature) return decisionFor(existing.batch, input.current.call.id);
    if (existing) this.cached.delete(input.current.call.id);

    const eligible = await reviewEligibleCalls(input);
    const batch = chunks(eligible).find((candidate) => candidate.some((item) => item.call.id === input.current.call.id));
    if (!batch) {
      throw new ReviewContextError("Tool Call cannot be safely included in an Automated Review Batch");
    }
    const result = input.run({
      cwd: input.cwd,
      projectRoot: input.project.root,
      messages: input.messages,
      calls: batch.map((item) => ({ toolCall: item.call, tool: item.tool })),
    });
    for (const item of batch) {
      const itemSignature = reviewToolCallSignature(item.call);
      this.cached.set(item.call.id, { signature: itemSignature, batch: result });
    }
    return decisionFor(result, input.current.call.id);
  }
}
