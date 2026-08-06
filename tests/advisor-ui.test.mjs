import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AutoApprovalConfigStore } from "../src/config/store.ts";
import { FrictionHistoryStore } from "../src/friction/store.ts";
import { openRuleAdvisor } from "../src/ui/advisor.ts";

function context(select, notifications) {
  return {
    hasUI: true,
    mode: "rpc",
    signal: undefined,
    ui: {
      select,
      notify: (message, level) => notifications.push({ message, level }),
    },
  };
}

test("Rule Advisor places usage in Suggestions and empty-result notifications", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-auto-advisor-ui-"));
  try {
    const projectKey = path.join(directory, "project");
    const store = new AutoApprovalConfigStore(path.join(directory, "config.json"));
    const history = new FrictionHistoryStore(path.join(directory, "history.json"));
    await store.replace({
      version: 2,
      reviewer: { provider: "test", modelId: "reviewer", thinkingLevel: "low" },
      usageDisplay: "detailed",
      globalRules: [],
      projects: { [projectKey]: { rules: [] } },
    });
    await history.append(projectKey, {
      id: "record-1",
      timestamp: new Date().toISOString(),
      tool: { name: "custom" },
      input: { query: "lookup" },
      reviewDecision: "allow",
    });

    let runs = 0;
    const usage = {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 0,
      totalTokens: 150,
      cost: 0.002,
    };
    const advisor = {
      suggest: async (_config, _request, _signal, onUsage) => {
        onUsage?.(usage);
        runs += 1;
        return runs === 1 ? [{
          action: "allow",
          matcher: { tool: "custom", input: { kind: "any" } },
          scope: "project",
          rationale: "Repeated lookup.",
          supportingRecordIds: ["record-1"],
          replacesRuleIds: [],
          stats: { calls: 1, userConfirmations: 0, automatedReviews: 1 },
        }] : [];
      },
    };
    const titles = [];
    const notifications = [];
    const select = async (title) => {
      titles.push(title);
      return "Back";
    };
    const dependencies = {
      store,
      history,
      advisor,
      projectKey,
      projectRoot: projectKey,
      tools: [{ name: "custom" }],
      skills: [],
    };

    await openRuleAdvisor(context(select, notifications), dependencies);
    await openRuleAdvisor(context(select, notifications), dependencies);
    advisor.suggest = async (_config, _request, _signal, onUsage) => {
      onUsage?.(usage);
      throw new Error("provider failed");
    };
    await openRuleAdvisor(context(select, notifications), dependencies);
    advisor.suggest = async (_config, _request, _signal, onUsage) => {
      onUsage?.(usage);
      throw Object.assign(new Error("cancelled"), { name: "AbortError" });
    };
    await openRuleAdvisor(context(select, notifications), dependencies);

    assert.match(titles[0], /100 in · 20 out · 30 cache read · est\. \$0\.002/);
    assert.ok(notifications.some((item) => item.message.includes("no worthwhile suggestions") && item.message.includes("est. $0.002")));
    assert.ok(notifications.some((item) => item.message.includes("Rule Advisor failed") && item.message.includes("est. $0.002")));
    assert.ok(notifications.some((item) => item.message.includes("Rule Advisor cancelled") && item.message.includes("est. $0.002")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
