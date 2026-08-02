import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AutoApprovalConfigStore } from "../src/config/store.ts";
import { decideToolCall } from "../src/decision.ts";
import { resolveProjectIdentity } from "../src/project.ts";

async function withDecision(fn) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-auto-decision-"));
  try {
    const project = await resolveProjectIdentity(directory);
    const store = new AutoApprovalConfigStore(path.join(directory, "auto-approval.json"));
    await fn({ directory, project, store });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function context(overrides = {}) {
  return {
    cwd: overrides.cwd,
    hasUI: overrides.hasUI ?? false,
    mode: overrides.mode ?? "print",
    signal: overrides.signal,
    ui: {
      notify: overrides.notify ?? (() => {}),
      select: overrides.select,
      editor: overrides.editor,
      input: overrides.input,
      confirm: overrides.confirm ?? (async () => false),
    },
  };
}

function dependencies(project, store, reviewer) {
  return {
    project,
    store,
    reviewer,
    toolSource: { source: "extension", path: "custom.ts" },
    messages: [{ role: "user", content: "do the task" }],
    tool: { name: "custom", sourceInfo: { source: "extension" } },
  };
}

const call = { id: "call-1", name: "custom", input: { action: "run" } };
const reviewerConfig = { provider: "test", modelId: "reviewer", thinkingLevel: "low" };

test("invalid configuration fails closed without UI", async () => {
  await withDecision(async ({ directory, project, store }) => {
    await writeFile(store.filePath, "{broken", "utf8");
    const result = await decideToolCall(context({ cwd: directory }), call, dependencies(project, store));
    assert.equal(result.block, true);
    assert.match(result.reason, /configuration is invalid/);
  });
});

test("Automated Review approve and deny decisions are final", async () => {
  await withDecision(async ({ directory, project, store }) => {
    await store.replace({ version: 1, reviewer: reviewerConfig, projects: {} });
    const approveReviewer = { review: async () => ({ decision: "approve", reason: "safe" }) };
    assert.equal(await decideToolCall(context({ cwd: directory }), call, dependencies(project, store, approveReviewer)), undefined);
    const denyReviewer = { review: async () => ({ decision: "deny", reason: "unsafe" }) };
    const denied = await decideToolCall(context({ cwd: directory }), call, dependencies(project, store, denyReviewer));
    assert.equal(denied.block, true);
    assert.match(denied.reason, /unsafe/);
  });
});

test("valid Automated Review and confirmation outcomes produce one Friction Record", async () => {
  await withDecision(async ({ directory, project, store }) => {
    await store.replace({ version: 1, reviewer: reviewerConfig, projects: {} });
    const records = [];
    const reviewer = { review: async () => ({ decision: "ask_user", reason: "confirm" }) };
    const deps = {
      ...dependencies(project, store, reviewer),
      recordFriction: async (record) => records.push(record),
    };
    const result = await decideToolCall(
      context({ cwd: directory, hasUI: true, mode: "rpc", select: async () => "Approve once" }),
      call,
      deps,
    );
    assert.equal(result, undefined);
    assert.equal(records.length, 1);
    assert.equal(records[0].reviewDecision, "ask_user");
    assert.equal(records[0].userChoice, "approve_once");
    assert.deepEqual(records[0].tool.source, { source: "extension", path: "custom.ts" });
  });
});

test("direct project ask_user records user friction without an Automated Review", async () => {
  await withDecision(async ({ directory, project, store }) => {
    await store.replace({
      version: 1,
      projects: {
        [project.key]: {
          approvalRules: [],
          policyRules: [{
            id: "confirm-custom",
            matcher: { tool: "custom", input: { kind: "exact", value: { action: "run" } } },
            route: "ask_user",
          }],
        },
      },
    });
    const records = [];
    const deps = {
      ...dependencies(project, store),
      recordFriction: async (record) => records.push(record),
    };
    await decideToolCall(
      context({ cwd: directory, hasUI: true, mode: "rpc", select: async () => "Deny", input: async () => undefined }),
      call,
      deps,
    );
    assert.equal(records.length, 1);
    assert.equal(records[0].reviewDecision, undefined);
    assert.equal(records[0].userChoice, "deny");
  });
});

test("Friction History failures do not alter authorization decisions", async () => {
  await withDecision(async ({ directory, project, store }) => {
    await store.replace({ version: 1, reviewer: reviewerConfig, projects: {} });
    const reviewer = { review: async () => ({ decision: "approve", reason: "safe" }) };
    const deps = {
      ...dependencies(project, store, reviewer),
      recordFriction: async () => { throw new Error("disk full"); },
    };
    assert.equal(await decideToolCall(context({ cwd: directory }), call, deps), undefined);
  });
});

test("interactive sessions show every Automated Review decision", async () => {
  await withDecision(async ({ directory, project, store }) => {
    await store.replace({ version: 1, reviewer: reviewerConfig, projects: {} });
    const notifications = [];
    const ctx = context({
      cwd: directory,
      hasUI: true,
      mode: "rpc",
      notify: (message, level) => notifications.push({ message, level }),
      select: async () => "Approve once",
    });
    for (const [decision, reason] of [
      ["approve", "safe\noperation"],
      ["deny", "unsafe"],
      ["ask_user", "intent unclear"],
    ]) {
      const reviewer = { review: async () => ({ decision, reason }) };
      await decideToolCall(ctx, call, dependencies(project, store, reviewer));
    }
    assert.deepEqual(notifications, [
      { message: "Auto Review APPROVE · custom: safe operation", level: "info" },
      { message: "Auto Review DENY · custom: unsafe", level: "error" },
      { message: "Auto Review ASK_USER · custom: intent unclear", level: "warning" },
    ]);
  });
});

test("Always approve replaces volatile external exact proposals with a project Tool-wide Rule", async () => {
  await withDecision(async ({ directory, project, store }) => {
    await store.replace({ version: 1, reviewer: reviewerConfig, projects: {} });
    const proposal = { tool: "custom", input: { kind: "exact", value: { action: "run" } } };
    const reviewer = { review: async () => ({ decision: "ask_user", reason: "confirm scope", approvalRuleProposal: proposal }) };
    const selections = ["Always approve with rule", "Save rule"];
    const ctx = context({
      cwd: directory,
      hasUI: true,
      mode: "rpc",
      select: async () => selections.shift(),
      editor: async (_title, source) => source,
      input: async () => undefined,
    });
    assert.equal(await decideToolCall(ctx, call, dependencies(project, store, reviewer)), undefined);
    const loaded = await store.read();
    assert.equal(loaded.ok, true);
    if (loaded.ok) assert.deepEqual(loaded.config.projects[project.key].approvalRules[0].matcher, {
      tool: "custom",
      source: { source: "extension", path: "custom.ts" },
      input: { kind: "any" },
    });
    const failingReviewer = { review: async () => { throw new Error("should not run"); } };
    assert.equal(await decideToolCall(context({ cwd: directory }), call, dependencies(project, store, failingReviewer)), undefined);
  });
});

test("Always approve persists an explicitly Global Tool-wide Rule in Global Scope", async () => {
  await withDecision(async ({ directory, project, store }) => {
    await store.replace({ version: 1, reviewer: reviewerConfig, projects: {} });
    const reviewer = { review: async () => ({ decision: "ask_user", reason: "confirm scope" }) };
    const selections = [
      "Always approve with rule",
      "Change match type",
      "All inputs",
      "Scope: Current project",
      "Save rule",
    ];
    const ctx = context({
      cwd: directory,
      hasUI: true,
      mode: "rpc",
      select: async () => selections.shift(),
      editor: async (_title, source) => source,
    });
    assert.equal(await decideToolCall(ctx, call, dependencies(project, store, reviewer)), undefined);
    const loaded = await store.read();
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
      assert.deepEqual(loaded.config.globalApprovalRules[0].matcher, {
        tool: "custom",
        source: { source: "extension", path: "custom.ts" },
        input: { kind: "any" },
      });
      assert.equal(loaded.config.projects[project.key], undefined);
    }
  });
});

test("a mismatched external Reviewer proposal is replaced by a source-bound Tool-wide matcher", async () => {
  await withDecision(async ({ directory, project, store }) => {
    await store.replace({ version: 1, reviewer: reviewerConfig, projects: {} });
    const reviewer = {
      review: async () => ({
        decision: "ask_user",
        reason: "confirm scope",
        approvalRuleProposal: { tool: "custom", input: { kind: "exact", value: { action: "other" } } },
      }),
    };
    const selections = ["Always approve with rule", "Save rule"];
    const ctx = context({
      cwd: directory,
      hasUI: true,
      mode: "rpc",
      select: async () => selections.shift(),
      editor: async (_title, source) => source,
    });
    assert.equal(await decideToolCall(ctx, call, dependencies(project, store, reviewer)), undefined);
    const loaded = await store.read();
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
      assert.deepEqual(loaded.config.projects[project.key].approvalRules[0].matcher, {
        tool: "custom",
        source: { source: "extension", path: "custom.ts" },
        input: { kind: "any" },
      });
    }
  });
});

test("Reviewer failure asks with UI and denies without UI", async () => {
  await withDecision(async ({ directory, project, store }) => {
    await store.replace({ version: 1, reviewer: reviewerConfig, projects: {} });
    const reviewer = { review: async () => { throw new Error("offline"); } };
    const denied = await decideToolCall(context({ cwd: directory }), call, dependencies(project, store, reviewer));
    assert.equal(denied.block, true);
    assert.match(denied.reason, /offline/);
    const approved = await decideToolCall(
      context({ cwd: directory, hasUI: true, mode: "rpc", select: async () => "Approve once" }),
      call,
      dependencies(project, store, reviewer),
    );
    assert.equal(approved, undefined);
  });
});

test("user denial feedback is returned to the Main Agent", async () => {
  await withDecision(async ({ directory, project, store }) => {
    await store.replace({ version: 1, reviewer: reviewerConfig, projects: {} });
    const reviewer = { review: async () => ({ decision: "ask_user", reason: "confirm" }) };
    const denied = await decideToolCall(
      context({
        cwd: directory,
        hasUI: true,
        mode: "rpc",
        select: async () => "Deny",
        input: async () => "use read instead",
      }),
      call,
      dependencies(project, store, reviewer),
    );
    assert.equal(denied.block, true);
    assert.match(denied.reason, /use read instead/);
  });
});
