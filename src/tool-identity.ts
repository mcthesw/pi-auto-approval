import type { ToolSourceIdentity } from "./domain.ts";

export function toolSourceIdentity(value: unknown): ToolSourceIdentity | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const sourceInfo = (value as { sourceInfo?: unknown }).sourceInfo;
  if (typeof sourceInfo !== "object" || sourceInfo === null) return undefined;
  const { source, path } = sourceInfo as { source?: unknown; path?: unknown };
  if (typeof source !== "string" || !source.trim() || typeof path !== "string" || !path.trim()) return undefined;
  return { source, path };
}
