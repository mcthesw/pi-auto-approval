import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AutoApprovalConfigStore } from "../src/config/store.ts";
import { decideToolCall } from "../src/decision.ts";

async function withDecision(fn) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-auto-decision-v2-"));
  try {
    const store = new AutoApprovalConfigStore(path.join(directory, "config.json"));
    await store.replace({ version: 2, reviewer: { provider: "test", modelId: "reviewer", thinkingLevel: "low" }, globalRules: [], projects: {} });
    await fn({ directory, store });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function context(directory, select = async () => undefined, uiOverrides = {}) {
  return {
    cwd: directory,
    mode: "rpc",
    hasUI: true,
    signal: undefined,
    ui: {
      notify() {},
      select,
      confirm: async () => true,
      input: async () => undefined,
      editor: async () => undefined,
      ...uiOverrides,
    },
  };
}

test("Reviewer allow remains final for project-external Tool Calls", async () => {
  await withDecision(async ({ directory, store }) => {
    const result = await decideToolCall(context(directory), { id: "1", name: "write", input: { path: path.join(directory, "..", "other", "x"), content: "x" } }, {
      store,
      project: { key: directory, root: directory },
      messages: [],
      reviewer: { review: async () => ({ decision: "allow", reason: "explicit user target" }) },
    });
    assert.equal(result, undefined);
  });
});

test("ask without a usable suggestion falls back to a source-bound Project exact Rule", async () => {
  await withDecision(async ({ directory, store }) => {
    const select = async (_title, options) => options.includes("Allow with Rule") ? "Allow with Rule" : "Save selected";
    const call = { id: "1", name: "context7_query-docs", input: { libraryId: "/vercel/next.js", query: "routing" } };
    const result = await decideToolCall(context(directory, select), call, {
      store,
      project: { key: directory, root: directory },
      messages: [],
      toolSource: { source: "mcp", path: "context7" },
      reviewer: { review: async () => ({ decision: "ask", reason: "save a Rule" }) },
    });
    assert.equal(result, undefined);
    const loaded = await store.read();
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
      const rule = loaded.config.projects[directory].rules[0];
      assert.equal(rule.action, "allow");
      assert.deepEqual(rule.matcher.source, { source: "mcp", path: "context7" });
      assert.equal(rule.matcher.input.kind, "exact");
    }
  });
});

test("composite Bash suggestions persist a Rule for every uncovered segment", async () => {
  await withDecision(async ({ directory, store }) => {
    const select = async (_title, options) => options.includes("Allow with Rule") ? "Allow with Rule" : "Save selected";
    const call = { id: "1", name: "bash", input: { command: "cargo fmt --all && cargo clippy --workspace" } };
    const result = await decideToolCall(context(directory, select), call, {
      store,
      project: { key: directory, root: directory },
      messages: [],
      reviewer: {
        review: async () => ({
          decision: "ask",
          reason: "persist segments",
          ruleSuggestions: [{ scope: "project", matcher: { tool: "bash", input: { kind: "fields", fields: { command: { kind: "tokenPrefix", tokens: ["cargo", "fmt"] } } } } }],
        }),
      },
    });
    assert.equal(result, undefined);
    const loaded = await store.read();
    assert.equal(loaded.ok, true);
    if (loaded.ok) assert.equal(loaded.config.projects[directory].rules.length, 2);
  });
});

test("Allow with Rule previews a matching Rule and keeps its restrictive action", async () => {
  await withDecision(async ({ directory, store }) => {
    const call = { id: "1", name: "context7_query-docs", input: { libraryId: "/vercel/next.js", query: "routing" } };
    const matcher = { tool: call.name, input: { kind: "exact", value: call.input } };
    await store.update((config) => {
      config.projects[directory] = { rules: [{ id: "ask-existing", action: "ask", matcher }] };
    });
    const confirmations = [];
    const select = async (_title, options) => options.includes("Allow with Rule") ? "Allow with Rule" : "Save selected";
    const result = await decideToolCall(context(directory, select, {
      confirm: async (title) => { confirmations.push(title); return true; },
    }), call, {
      store,
      project: { key: directory, root: directory },
      messages: [],
    });
    assert.equal(result, undefined);
    assert.deepEqual(confirmations, ["Merge matching Rules?"]);
    const loaded = await store.read();
    assert.equal(loaded.ok, true);
    if (loaded.ok) assert.equal(loaded.config.projects[directory].rules[0].action, "ask");
  });
});
