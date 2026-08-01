import type { ToolCall } from "../domain.ts";

const MAX_TOOL_CALL_CHARS = 65_536;
const MAX_USER_EVIDENCE_CHARS = 30_000;
const MAX_RECENT_EVIDENCE_CHARS = 20_000;
const MAX_USER_ENTRY_CHARS = 8_000;
const MAX_OTHER_ENTRY_CHARS = 4_000;
const MAX_RECENT_NON_USER_ENTRIES = 40;
const MAX_TOOL_METADATA_CHARS = 8_000;

export class ReviewContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewContextError";
  }
}

export type ReviewToolMetadata = {
  name: string;
  description?: string;
  parameters?: unknown;
  sourceInfo?: unknown;
};

export type ReviewRequest = {
  toolCall: ToolCall;
  cwd: string;
  projectRoot: string;
  messages: readonly unknown[];
  tool?: ReviewToolMetadata;
};

export type PreparedReviewContext = {
  toolCallJson: string;
  cwd: string;
  projectRoot: string;
  transcript: string;
  toolMetadata: string;
};

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 18))}\n...[truncated]`;
}

function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function textFromContent(content: unknown, limit: number): string {
  if (typeof content === "string") return truncate(content, limit);
  if (!Array.isArray(content)) return truncate(safeJson(content) ?? "[unserializable content]", limit);
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const item = part as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
    else if (item.type === "thinking" && typeof item.thinking === "string") parts.push(`[thinking omitted: ${item.thinking.length} chars]`);
    else if (item.type === "toolCall") parts.push(`[tool call ${String(item.name ?? "unknown")}: ${truncate(safeJson(item.arguments) ?? "[unserializable]", 1_000)}]`);
    else if (item.type === "image") parts.push("[image omitted]");
  }
  return truncate(parts.join("\n"), limit);
}

function renderMessage(message: unknown): { role: "user" | "assistant" | "toolResult"; text: string } | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const input = message as Record<string, unknown>;
  if (input.role === "user") return { role: "user", text: textFromContent(input.content, MAX_USER_ENTRY_CHARS) };
  if (input.role === "assistant") return { role: "assistant", text: textFromContent(input.content, MAX_OTHER_ENTRY_CHARS) };
  if (input.role === "toolResult") {
    const tool = typeof input.toolName === "string" ? input.toolName : "unknown";
    return { role: "toolResult", text: `[${tool}] ${textFromContent(input.content, MAX_OTHER_ENTRY_CHARS)}` };
  }
  return undefined;
}

function selectWithinBudget<T extends { rendered: string }>(entries: T[], budget: number, newestFirst = false): T[] {
  const selected: T[] = [];
  let used = 0;
  const source = newestFirst ? [...entries].reverse() : entries;
  for (const entry of source) {
    if (used + entry.rendered.length > budget) continue;
    selected.push(entry);
    used += entry.rendered.length;
  }
  return newestFirst ? selected.reverse() : selected;
}

function buildTranscript(messages: readonly unknown[]): string {
  const rendered = messages
    .map((message, index) => {
      const entry = renderMessage(message);
      return entry ? { index, role: entry.role, rendered: `<${entry.role}>\n${entry.text}\n</${entry.role}>` } : undefined;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

  const users = rendered.filter((entry) => entry.role === "user");
  const nonUsers = rendered.filter((entry) => entry.role !== "user").slice(-MAX_RECENT_NON_USER_ENTRIES);
  const requiredUsers = users.length > 1 ? [users[0]!, users.at(-1)!] : users;
  const requiredIndexes = new Set(requiredUsers.map((entry) => entry.index));
  const requiredSize = requiredUsers.reduce((total, entry) => total + entry.rendered.length, 0);
  const remainingUsers = users.filter((entry) => !requiredIndexes.has(entry.index));
  const selectedUsers = [
    ...requiredUsers,
    ...selectWithinBudget(remainingUsers, Math.max(0, MAX_USER_EVIDENCE_CHARS - requiredSize), true),
  ];
  const selectedNonUsers = selectWithinBudget(nonUsers, MAX_RECENT_EVIDENCE_CHARS, true);
  return [...selectedUsers, ...selectedNonUsers]
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.rendered)
    .join("\n\n");
}

export function prepareReviewContext(request: ReviewRequest): PreparedReviewContext {
  const toolCallJson = safeJson(request.toolCall);
  if (!toolCallJson) throw new ReviewContextError("Tool Call input is not JSON-serializable");
  if (toolCallJson.length > MAX_TOOL_CALL_CHARS) {
    throw new ReviewContextError(`Tool Call exceeds the ${MAX_TOOL_CALL_CHARS}-character review limit`);
  }
  const metadata = request.tool ? safeJson(request.tool) ?? "[unserializable metadata]" : "[metadata unavailable]";
  return {
    toolCallJson,
    cwd: request.cwd,
    projectRoot: request.projectRoot,
    transcript: buildTranscript(request.messages),
    toolMetadata: truncate(metadata, MAX_TOOL_METADATA_CHARS),
  };
}
