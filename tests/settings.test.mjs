import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AutoApprovalConfigStore } from "../src/config/store.ts";
import { resolveProjectIdentity } from "../src/project.ts";
import { openAutoApprovalSettings } from "../src/ui/settings.ts";

async function withSettings(fn) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-auto-settings-"));
  try {
    const project = await resolveProjectIdentity(directory);
    const store = new AutoApprovalConfigStore(path.join(directory, "auto-approval.json"));
    await fn({ directory, project, store });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function mockContext(onSelect, onEditor = async (_title, source) => source, onConfirm = async () => true) {
  const notifications = [];
  return {
    notifications,
    ctx: {
      hasUI: true,
      mode: "rpc",
      ui: {
        select: onSelect,
        editor: onEditor,
        confirm: onConfirm,
        notify: (message, level) => notifications.push({ message, level }),
      },
    },
  };
}

const reviewer = {
  availableModels: async () => [{ provider: "openai", modelId: "reviewer", label: "Reviewer (openai/reviewer)" }],
};

test("settings UI configures explicit reviewer model and thinking level", async () => {
  await withSettings(async ({ project, store }) => {
    const menus = [
      "Reviewer model: not configured",
      "Reviewer (openai/reviewer)",
      "Reviewer thinking: low",
      "high",
      "Done",
    ];
    const { ctx } = mockContext(async () => menus.shift());
    await openAutoApprovalSettings(ctx, { store, projectKey: project.key, reviewer });
    const result = await store.read();
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.config.reviewer, { provider: "openai", modelId: "reviewer", thinkingLevel: "high" });
  });
});

test("settings UI adds project Policy and Approval Rules", async () => {
  await withSettings(async ({ project, store }) => {
    const menus = [
      "Policy Rules",
      "Add Policy Rule",
      "Back",
      "Approval Rules",
      "Add Approval Rule",
      "Back",
      "Done",
    ];
    const { ctx } = mockContext(async () => menus.shift());
    await openAutoApprovalSettings(ctx, { store, projectKey: project.key, reviewer });
    const result = await store.read();
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.config.projects[project.key].policyRules.length, 1);
      assert.equal(result.config.projects[project.key].approvalRules.length, 1);
    }
  });
});

test("settings UI remains usable when Reviewer runtime is unavailable", async () => {
  await withSettings(async ({ project, store }) => {
    const menus = ["Reviewer model: not configured", "Done"];
    const { ctx, notifications } = mockContext(async () => menus.shift());
    await openAutoApprovalSettings(ctx, {
      store,
      projectKey: project.key,
      reviewer: undefined,
      reviewerUnavailableReason: "runtime failed",
    });
    assert.match(notifications[0].message, /runtime failed/);
  });
});

test("settings UI repairs invalid config only after explicit confirmation", async () => {
  await withSettings(async ({ project, store }) => {
    await writeFile(store.filePath, "{broken", "utf8");
    const menus = ["Reset to empty configuration", "Done"];
    const { ctx, notifications } = mockContext(async () => menus.shift());
    await openAutoApprovalSettings(ctx, { store, projectKey: project.key, reviewer });
    const result = await store.read();
    assert.deepEqual(result, { ok: true, config: { version: 1, globalApprovalRules: [], projects: {} } });
    assert.match(notifications[0].message, /Invalid auto-approval config/);
  });
});
