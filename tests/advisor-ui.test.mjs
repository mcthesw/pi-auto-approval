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

test("Rule Advisor editing does not source-bind standard tools", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-auto-advisor-standard-"));
  try {
    const projectKey = path.join(directory, "project");
    const store = new AutoApprovalConfigStore(path.join(directory, "config.json"));
    const history = new FrictionHistoryStore(path.join(directory, "history.json"));
    await store.replace({
      version: 2,
      reviewer: { provider: "test", modelId: "reviewer", thinkingLevel: "low" },
      usageDisplay: "off",
      globalRules: [],
      projects: { [projectKey]: { rules: [] } },
    });
    await history.append(projectKey, {
      id: "record-edit",
      timestamp: new Date().toISOString(),
      tool: { name: "edit", source: { source: "sdk", path: "<sdk:edit>" } },
      input: { path: "src/lib.ts", edits: [] },
      userChoice: "allow_once",
    });

    const advisor = {
      suggest: async () => [{
        action: "allow",
        matcher: { tool: "edit", input: { kind: "exact", value: { path: "src/lib.ts", edits: [] } } },
        scope: "project",
        rationale: "Repeated project edit.",
        supportingRecordIds: ["record-edit"],
        replacesRuleIds: [],
        stats: { calls: 1, userConfirmations: 1, automatedReviews: 0 },
      }],
    };
    let step = 0;
    const notifications = [];
    const select = async (_title, options) => {
      step += 1;
      if (step === 1) return options[0];
      if (step === 2) return "View / edit";
      if (step === 3) return "Save";
      if (step === 4) return "Save selected";
      throw new Error(`Unexpected selection step ${step}`);
    };

    await openRuleAdvisor(context(select, notifications), {
      store,
      history,
      advisor,
      projectKey,
      projectRoot: projectKey,
      tools: [{ name: "edit", source: { source: "sdk", path: "<sdk:edit>" } }],
      skills: [],
    });

    const loaded = await store.read();
    assert.equal(loaded.ok, true);
    const saved = loaded.config.projects[projectKey].rules;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].matcher.tool, "edit");
    assert.equal(saved[0].matcher.source, undefined);
    assert.equal(notifications.some((item) => item.message.includes("standard tools cannot be source-bound")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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
