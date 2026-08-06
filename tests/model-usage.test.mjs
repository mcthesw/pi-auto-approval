import assert from "node:assert/strict";
import { test } from "node:test";
import { formatModelUsage, modelUsageFromStats } from "../src/model-usage.ts";

const stats = {
  tokens: { input: 12_400, output: 324, cacheRead: 8_100, cacheWrite: 0, total: 20_824 },
  cost: 0.0042,
};

test("Model Usage formats brief and detailed displays without zero cache noise", () => {
  const usage = modelUsageFromStats(stats);
  assert.equal(formatModelUsage(usage, "brief"), "est. $0.0042");
  assert.equal(formatModelUsage(modelUsageFromStats({
    tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
    cost: 0,
  }), "brief"), "est. —");
  assert.equal(formatModelUsage(usage, "detailed"), "12.4k in · 324 out · 8.1k cache read · est. $0.0042");
  assert.equal(formatModelUsage(usage, "off"), undefined);
});

test("Model Usage marks tiny estimated costs instead of rounding them to zero", () => {
  const usage = modelUsageFromStats({
    tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
    cost: 0.00001,
  });
  assert.equal(formatModelUsage(usage, "brief"), "est. <$0.0001");
});

test("Model Usage normalizes invalid provider values before display", () => {
  const usage = modelUsageFromStats({
    tokens: { input: -1, output: Number.NaN, cacheRead: 2, cacheWrite: 3, total: 4 },
    cost: Number.POSITIVE_INFINITY,
  });
  assert.deepEqual(usage, {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 2,
    cacheWriteTokens: 3,
    totalTokens: 4,
    cost: 0,
  });
});
