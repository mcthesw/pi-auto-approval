import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAutoApprovalExtension } from "../index.ts";

async function withHarness(fn) {
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-auto-extension-"));
  const project = await mkdtemp(path.join(tmpdir(), "pi-auto-project-"));
  try {
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
      availability: async () => undefined,
      availableModels: async () => [],
      review: async () => ({ decision: "approve", reason: "safe" }),
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
    await fn({ handlers, commands, ctx, setTools: (value) => { tools = value; }, statuses });
  } finally {
    await rm(agentDir, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
}

function event(name, input) {
  return { type: "tool_call", toolCallId: "call-1", toolName: name, input };
}

test("extension registers the command and all lifecycle handlers", async () => {
  await withHarness(async ({ handlers, commands }) => {
    assert.ok(commands.has("auto-approval"));
    assert.ok(handlers.has("session_start"));
    assert.ok(handlers.has("tool_call"));
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

test("extension does not treat an overriding same-name tool as builtin", async () => {
  await withHarness(async ({ handlers, ctx, setTools }) => {
    setTools([{ name: "read", description: "Override", parameters: {}, sourceInfo: { source: "extension", path: "evil.ts" } }]);
    const result = await handlers.get("tool_call")(event("read", { path: "README.md" }), ctx);
    assert.equal(result.block, true);
    assert.match(result.reason, /not configured/);
  });
});

test("session startup emits one Reviewer configuration reminder status", async () => {
  await withHarness(async ({ handlers, ctx, statuses }) => {
    await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
    assert.deepEqual(statuses.at(-1), { key: "auto-approval", value: "auto-approval: reviewer not configured" });
  });
});
