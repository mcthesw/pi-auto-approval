import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAutoApprovalExtension } from "../index.ts";
import { autoApprovalConfigFile } from "../src/config/store.ts";

async function withHarness(fn, setup, harnessOptions = {}) {
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-auto-extension-"));
  const project = await mkdtemp(path.join(tmpdir(), "pi-auto-project-"));
  try {
    await setup?.({ agentDir, project });
    const handlers = new Map();
    const commands = new Map();
    const statuses = [];
    const notifications = [];
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
      usage: undefined,
      usageReports: 0,
      reviewBatch: async (_config, request, _signal, onUsage) => {
        reviewer.batches.push(request.calls.map((item) => item.toolCall.id));
        if (reviewer.usage && onUsage) {
          reviewer.usageReports += 1;
          onUsage(reviewer.usage);
        }
        if (harnessOptions.reviewBatchError) throw harnessOptions.reviewBatchError;
        return { decisions: new Map(request.calls.map((item) => [item.toolCall.id, { decision: "allow", reason: "safe" }])) };
      },
    };
    createAutoApprovalExtension({ agentDir, createReviewer: async () => reviewer })(pi);
    const ctx = {
      cwd: project,
      hasUI: harnessOptions.hasUI ?? false,
      mode: harnessOptions.mode ?? "print",
      signal: undefined,
      sessionManager: { buildContextEntries: () => [] },
      ui: {
        notify: (message, level) => { notifications.push({ message, level }); },
        setStatus: (key, value) => statuses.push({ key, value }),
        confirm: async () => false,
      },
    };
    await fn({ handlers, commands, ctx, setTools: (value) => { tools = value; }, statuses, notifications, reviewer });
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

test("extension shows one usage notification for a Review Batch", async () => {
  await withHarness(async ({ handlers, ctx, setTools, reviewer, notifications }) => {
    setTools([{ name: "todowrite", description: "Todos", parameters: {}, sourceInfo: { source: "sdk", path: "<sdk:todowrite>" } }]);
    reviewer.usage = {
      inputTokens: 1_200,
      outputTokens: 80,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1_280,
      cost: 0.0012,
    };
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
    await handlers.get("tool_call")(event("todowrite", { todos: [] }, "one"), ctx);
    await handlers.get("tool_call")(event("todowrite", { todos: [] }, "two"), ctx);
    const usageNotices = notifications.filter((item) => item.message.includes("Automated Review") && item.message.includes("est. $0.0012"));
    assert.equal(usageNotices.length, 1);
  }, async ({ agentDir }) => {
    await writeFile(autoApprovalConfigFile(agentDir), JSON.stringify({
      version: 2,
      reviewer: { provider: "test", modelId: "reviewer", thinkingLevel: "low" },
      usageDisplay: "brief",
      globalRules: [],
      projects: {},
    }));
  }, { hasUI: true });
});

test("extension still samples usage when display is Off without showing it", async () => {
  await withHarness(async ({ handlers, ctx, setTools, reviewer, notifications }) => {
    setTools([{ name: "todowrite", description: "Todos", parameters: {}, sourceInfo: { source: "sdk", path: "<sdk:todowrite>" } }]);
    reviewer.usage = {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 3,
      cost: 0.001,
    };
    await handlers.get("tool_call")(event("todowrite", { todos: [] }), ctx);
    assert.equal(reviewer.usageReports, 1);
    assert.equal(notifications.some((item) => item.message.includes("est.")), false);
  }, async ({ agentDir }) => {
    await writeFile(autoApprovalConfigFile(agentDir), JSON.stringify({
      version: 2,
      reviewer: { provider: "test", modelId: "reviewer", thinkingLevel: "low" },
      usageDisplay: "off",
      globalRules: [],
      projects: {},
    }));
  }, { hasUI: true });
});

test("extension shows started usage on Reviewer failure without putting it in block reason", async () => {
  await withHarness(async ({ handlers, ctx, setTools, reviewer, notifications }) => {
    setTools([{ name: "todowrite", description: "Todos", parameters: {}, sourceInfo: { source: "sdk", path: "<sdk:todowrite>" } }]);
    reviewer.usage = {
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 12,
      cost: 0.0003,
    };
    const result = await handlers.get("tool_call")(event("todowrite", { todos: [] }), ctx);
    assert.equal(result.block, true);
    assert.ok(notifications.some((item) => item.message.includes("Automated Review failed") && item.message.includes("est. $0.0003")));
    assert.doesNotMatch(result.reason, /est\. \$0\.0003/);
  }, async ({ agentDir }) => {
    await writeFile(autoApprovalConfigFile(agentDir), JSON.stringify({
      version: 2,
      reviewer: { provider: "test", modelId: "reviewer", thinkingLevel: "low" },
      usageDisplay: "brief",
      globalRules: [],
      projects: {},
    }));
  }, { hasUI: true, reviewBatchError: new Error("provider failed") });
});

test("extension reports started usage when Reviewer is cancelled", async () => {
  await withHarness(async ({ handlers, ctx, setTools, reviewer, notifications }) => {
    setTools([{ name: "todowrite", description: "Todos", parameters: {}, sourceInfo: { source: "sdk", path: "<sdk:todowrite>" } }]);
    reviewer.usage = {
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 12,
      cost: 0.0003,
    };
    await handlers.get("tool_call")(event("todowrite", { todos: [] }), ctx);
    assert.ok(notifications.some((item) => item.message.includes("Automated Review cancelled") && item.message.includes("est. $0.0003")));
  }, async ({ agentDir }) => {
    await writeFile(autoApprovalConfigFile(agentDir), JSON.stringify({
      version: 2,
      reviewer: { provider: "test", modelId: "reviewer", thinkingLevel: "low" },
      usageDisplay: "brief",
      globalRules: [],
      projects: {},
    }));
  }, { hasUI: true, reviewBatchError: Object.assign(new Error("cancelled"), { name: "AbortError" }) });
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
