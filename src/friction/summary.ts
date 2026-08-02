import { randomUUID } from "node:crypto";
import type {
  FrictionRecord,
  JsonValue,
  ReviewDecision,
  ToolCall,
  ToolSourceIdentity,
  UserConfirmationChoice,
} from "../domain.ts";

const MAX_STRING_CHARS = 256;
const MAX_ARRAY_ITEMS = 10;
const MAX_DEPTH = 6;
const MAX_RECORD_BYTES = 4 * 1024;

type TruncationReason = "string" | "array" | "depth" | "cycle" | "unsupported";

function marker(reason: TruncationReason, details: Record<string, JsonValue> = {}): JsonValue {
  return { $truncated: { reason, ...details } };
}

function summarize(value: unknown, depth: number, ancestors: WeakSet<object>): JsonValue {
  if (typeof value === "string") {
    return value.length <= MAX_STRING_CHARS
      ? value
      : marker("string", { length: value.length, preview: value.slice(0, MAX_STRING_CHARS) });
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : marker("unsupported", { type: "number" });
  if (depth >= MAX_DEPTH) return marker("depth", { type: Array.isArray(value) ? "array" : typeof value });
  if (typeof value !== "object") return marker("unsupported", { type: typeof value });
  if (ancestors.has(value)) return marker("cycle");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const result = value.slice(0, MAX_ARRAY_ITEMS).map((item) => summarize(item, depth + 1, ancestors));
      if (value.length > MAX_ARRAY_ITEMS) result.push(marker("array", { length: value.length }));
      return result;
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, summarize(item, depth + 1, ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
}

export type FrictionRecordInput = {
  call: ToolCall;
  source?: ToolSourceIdentity;
  reviewDecision?: ReviewDecision;
  userChoice?: UserConfirmationChoice;
  now?: Date;
};

export function createFrictionRecord(input: FrictionRecordInput): FrictionRecord | undefined {
  if (!input.reviewDecision && !input.userChoice) return undefined;
  const record: FrictionRecord = {
    id: randomUUID(),
    timestamp: (input.now ?? new Date()).toISOString(),
    tool: { name: input.call.name, ...(input.source ? { source: input.source } : {}) },
    input: summarize(input.call.input, 0, new WeakSet()),
    ...(input.reviewDecision ? { reviewDecision: input.reviewDecision } : {}),
    ...(input.userChoice ? { userChoice: input.userChoice } : {}),
  };
  return Buffer.byteLength(JSON.stringify(record), "utf8") <= MAX_RECORD_BYTES ? record : undefined;
}
