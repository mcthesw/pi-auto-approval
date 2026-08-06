import type { UsageDisplay } from "./domain.ts";

export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
};

export type ModelUsageObserver = (usage: ModelUsage) => void;

type SessionUsageStats = {
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
};

function nonNegativeFinite(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function modelUsageFromStats(stats: SessionUsageStats): ModelUsage {
  return {
    inputTokens: nonNegativeFinite(stats.tokens.input),
    outputTokens: nonNegativeFinite(stats.tokens.output),
    cacheReadTokens: nonNegativeFinite(stats.tokens.cacheRead),
    cacheWriteTokens: nonNegativeFinite(stats.tokens.cacheWrite),
    totalTokens: nonNegativeFinite(stats.tokens.total),
    cost: nonNegativeFinite(stats.cost),
  };
}

function tokenCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 100_000 ? 1 : 0)}k`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}m`;
  return `${(value / 1_000_000_000).toFixed(value < 10_000_000_000 ? 1 : 0)}b`;
}

function estimatedCost(value: number): string {
  if (value === 0) return "est. —";
  if (value < 0.0001) return "est. <$0.0001";
  if (value < 0.01) return `est. $${value.toFixed(4)}`;
  if (value < 1) return `est. $${value.toFixed(3)}`;
  return `est. $${value.toFixed(2)}`;
}

export function formatModelUsage(usage: ModelUsage | undefined, display: UsageDisplay): string | undefined {
  if (!usage || display === "off") return undefined;
  if (display === "brief") return estimatedCost(usage.cost);
  const tokens = [
    `${tokenCount(usage.inputTokens)} in`,
    `${tokenCount(usage.outputTokens)} out`,
    ...(usage.cacheReadTokens ? [`${tokenCount(usage.cacheReadTokens)} cache read`] : []),
    ...(usage.cacheWriteTokens ? [`${tokenCount(usage.cacheWriteTokens)} cache write`] : []),
  ];
  return `${tokens.join(" · ")} · ${estimatedCost(usage.cost)}`;
}
