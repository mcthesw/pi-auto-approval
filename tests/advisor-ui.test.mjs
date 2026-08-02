import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AutoApprovalConfigStore } from "../src/config/store.ts";
import { openRuleAdvisor } from "../src/ui/advisor.ts";

async function withStore(fn) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-auto-advisor-ui-"));
  try {
    await fn(new AutoApprovalConfigStore(path.join(directory, "auto-approval.json")), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("RPC Rule Advisor keeps candidates unselected and atomically saves an explicitly global Tool-wide rule", async () => {
  await withStore(async (store, directory) => {
    const reviewer = { provider: "test", modelId: "advisor", thinkingLevel: "low" };
    await store.replace({ version: 1, reviewer, projects: {} });
    const source = { source: "extension", path: "context7" };
    const matcher = { tool: "context7_query-docs", source, input: { kind: "any" } };
    const frictionRecord = {
      id: "counter-1",
      timestamp: "2026-08-08T00:00:00.000Z",
      tool: { name: "context7_query-docs", source },
      input: { query: "Rust" },
      reviewDecision: "ask_user",
      userChoice: "deny",
    };
    const advisor = {
      suggest: async () => [{
        matcher,
        rationale: "Read-only documentation lookup",
        supportingRecordIds: [frictionRecord.id],
        stats: { calls: 1, userConfirmations: 1, automatedReviews: 1 },
      }],
    };
    let listVisits = 0;
    let detailVisits = 0;
    const notifications = [];
    const detailTitles = [];
    const ctx = {
      hasUI: true,
      mode: "rpc",
      ui: {
        select: async (title, options) => {
          if (title.startsWith("Approval Rule Suggestions")) {
            listVisits += 1;
            return listVisits <= 2 ? options[0] : "Review selected";
          }
          if (title.includes("Advisor rationale:")) {
            detailTitles.push(title);
            detailVisits += 1;
            return detailVisits === 1 ? "Edit rule" : "Select";
          }
          if (title.startsWith("Tool: context7_query-docs")) {
            return options.includes("Scope: Current project") ? "Scope: Current project" : "Save rule";
          }
          return undefined;
        },
        confirm: async () => true,
        editor: async (_title, value) => value,
        input: async () => undefined,
        notify: (message, level) => notifications.push({ message, level }),
        onTerminalInput: () => () => {},
        setWorkingMessage: () => {},
        setWorkingVisible: () => {},
      },
    };
    await openRuleAdvisor(ctx, {
      store,
      history: { readProject: async () => ({ ok: true, records: [frictionRecord] }) },
      advisor,
      projectKey: path.normalize(directory),
      projectRoot: directory,
      tools: [{ name: "context7_query-docs", source }],
      skills: [],
    });
    const loaded = await store.read();
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
      assert.equal(loaded.config.globalApprovalRules.length, 1);
      assert.deepEqual(loaded.config.globalApprovalRules[0].matcher, matcher);
      assert.equal(loaded.config.projects[path.normalize(directory)].approvalRules.length, 0);
    }
    assert.match(detailTitles[0], /Warning: cited evidence includes/);
    assert.match(notifications.at(-1).message, /Saved 1/);
  });
});
