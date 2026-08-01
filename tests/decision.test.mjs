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
    provenance: "extension",
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

test("Always approve validates and persists a project Approval Rule", async () => {
  await withDecision(async ({ directory, project, store }) => {
    await store.replace({ version: 1, reviewer: reviewerConfig, projects: {} });
    const proposal = { tool: "custom", input: { kind: "exact", value: { action: "run" } } };
    const reviewer = { review: async () => ({ decision: "ask_user", reason: "confirm scope", approvalRuleProposal: proposal }) };
    const ctx = context({
      cwd: directory,
      hasUI: true,
      mode: "rpc",
      select: async () => "Always approve with rule",
      editor: async (_title, source) => source,
      input: async () => undefined,
    });
    assert.equal(await decideToolCall(ctx, call, dependencies(project, store, reviewer)), undefined);
    const loaded = await store.read();
    assert.equal(loaded.ok, true);
    if (loaded.ok) assert.deepEqual(loaded.config.projects[project.key].approvalRules[0].matcher, proposal);
    const failingReviewer = { review: async () => { throw new Error("should not run"); } };
    assert.equal(await decideToolCall(context({ cwd: directory }), call, dependencies(project, store, failingReviewer)), undefined);
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
