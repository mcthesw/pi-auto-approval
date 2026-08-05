import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAutoApprovalExtension } from "../index.ts";
import { autoApprovalConfigFile } from "../src/config/store.ts";

async function withHarness(fn, setup) {
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-auto-extension-"));
  const project = await mkdtemp(path.join(tmpdir(), "pi-auto-project-"));
  try {
    await setup?.({ agentDir, project });
    const handlers = new Map();
    const commands = new Map();
    const statuses = [];
    let tools = [];
    const pi = {
      on: (event, handler) => handlers.set(event, handler),
      registerCommand: (name, command) => commands.set(name, command),
      getAllTools: () => tools,
      exec: async (command, args) => {
        if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: project, stderr: "", killed: false };
        return { code: 1, stdout: "", stderr: "", killed: false };
      },
    };
    const reviewer = {
      batches: [],
      availability: async () => undefined,
      availableModels: async () => [],
      review: async () => ({ decision: "allow", reason: "safe" }),
      reviewBatch: async (_config, request) => {
        reviewer.batches.push(request.calls.map((item) => item.toolCall.id));
        return { decisions: new Map(request.calls.map((item) => [item.toolCall.id, { decision: "allow", reason: "safe" }])) };
      },
    };
    createAutoApprovalExtension({ agentDir, createReviewer: async () => reviewer })(pi);
    const ctx = {
      cwd: project,
      hasUI: false,
      mode: "print",
      signal: undefined,
      sessionManager: { buildContextEntries: () => [] },
      ui: {
        notify: () => {},
        setStatus: (key, value) => statuses.push({ key, value }),
        confirm: async () => false,
      },
    };
    await fn({ handlers, commands, ctx, setTools: (value) => { tools = value; }, statuses, reviewer });
  } finally {
    await rm(agentDir, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
}

function event(name, input, id = "call-1") {
  return { type: "tool_call", toolCallId: id, toolName: name, input };
}

test("extension registers the command and all lifecycle handlers", async () => {
  await withHarness(async ({ handlers, commands }) => {
    assert.ok(commands.has("auto-approval"));
    assert.ok(handlers.has("session_start"));
    assert.ok(handlers.has("tool_call"));
    assert.ok(handlers.has("turn_end"));
    assert.ok(handlers.has("session_shutdown"));
  });
});

test("extension approves project-local builtin reads without Reviewer configuration", async () => {
  await withHarness(async ({ handlers, ctx, setTools }) => {
    setTools([{ name: "read", description: "Read", parameters: {}, sourceInfo: { source: "builtin" } }]);
    const result = await handlers.get("tool_call")(event("read", { path: "README.md" }), ctx);
    assert.equal(result, undefined);
  });
});

test("extension applies standard policy to SDK-provided Pi tools", async () => {
  await withHarness(async ({ handlers, ctx, setTools }) => {
    setTools([{ name: "edit", description: "Edit", parameters: {}, sourceInfo: { source: "sdk", path: "<sdk:edit>" } }]);
    const result = await handlers.get("tool_call")(event("edit", { path: "src/lib.ts", edits: [] }), ctx);
    assert.equal(result, undefined);
  });
});

test("extension sends SDK custom tools to Automated Review", async () => {
  await withHarness(async ({ handlers, ctx, setTools }) => {
    setTools([{ name: "todowrite", description: "Todos", parameters: {}, sourceInfo: { source: "sdk", path: "<sdk:todowrite>" } }]);
    const result = await handlers.get("tool_call")(event("todowrite", { todos: [] }), ctx);
    assert.equal(result.block, true);
    assert.match(result.reason, /not configured/);
  });
});

test("extension batches Review-Eligible siblings from one assistant message", async () => {
  await withHarness(async ({ handlers, ctx, setTools, reviewer }) => {
    setTools([{ name: "todowrite", description: "Todos", parameters: {}, sourceInfo: { source: "sdk", path: "<sdk:todowrite>" } }]);
    ctx.sessionManager.buildContextEntries = async () => [{
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "one", name: "todowrite", arguments: { todos: [] } },
          { type: "toolCall", id: "two", name: "todowrite", arguments: { todos: [] } },
        ],
      },
    }];
    assert.equal(await handlers.get("tool_call")(event("todowrite", { todos: [] }, "one"), ctx), undefined);
    assert.equal(await handlers.get("tool_call")(event("todowrite", { todos: [] }, "two"), ctx), undefined);
    assert.deepEqual(reviewer.batches, [["one", "two"]]);
  }, async ({ agentDir }) => {
    await writeFile(autoApprovalConfigFile(agentDir), JSON.stringify({
      version: 2,
      reviewer: { provider: "test", modelId: "reviewer", thinkingLevel: "low" },
      globalRules: [],
      projects: {},
    }));
  });
});

test("extension applies standard read policy regardless of tool source", async () => {
  await withHarness(async ({ handlers, ctx, setTools }) => {
    setTools([{ name: "read", description: "Override", parameters: {}, sourceInfo: { source: "extension", path: "evil.ts" } }]);
    const result = await handlers.get("tool_call")(event("read", { path: "README.md" }), ctx);
    assert.equal(result, undefined);
  });
});

test("session startup emits one Reviewer configuration reminder status", async () => {
  await withHarness(async ({ handlers, ctx, statuses }) => {
    await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
    assert.deepEqual(statuses.at(-1), { key: "auto-approval", value: "auto-approval: reviewer not configured" });
  });
});
