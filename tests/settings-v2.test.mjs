import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AutoApprovalConfigStore } from "../src/config/store.ts";
import { openAutoApprovalSettings } from "../src/ui/settings.ts";

async function withSettings(fn) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-auto-settings-v2-"));
  try {
    const store = new AutoApprovalConfigStore(path.join(directory, "config.json"));
    await fn({ directory, store });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function ui(select, overrides = {}) {
  return {
    select,
    notify() {},
    confirm: async () => true,
    input: async () => undefined,
    editor: async () => undefined,
    ...overrides,
  };
}

async function openRulesOnce(store, directory, chooseRule, chooseAction, overrides = {}) {
  let settingsOpened = false;
  let ruleChosen = false;
  const select = async (title, options) => {
    if (title === "Pi Auto Approval") {
      if (settingsOpened) return undefined;
      settingsOpened = true;
      return "Rules";
    }
    if (title === "Rules") {
      if (ruleChosen) return "Back";
      ruleChosen = true;
      return chooseRule(options);
    }
    return await chooseAction(title, options);
  };
  await openAutoApprovalSettings({ hasUI: true, mode: "rpc", ui: ui(select, overrides) }, { store, projectKey: directory, tools: [] });
}

test("top-level Usage display setting persists the selected mode", async () => {
  await withSettings(async ({ directory, store }) => {
    let opened = false;
    const selectedTitles = [];
    await openAutoApprovalSettings({
      hasUI: true,
      mode: "rpc",
      ui: ui(async (title) => {
        selectedTitles.push(title);
        if (title === "Pi Auto Approval") return opened ? undefined : (opened = true, "Usage display: Brief");
        if (title === "Usage display") return "Detailed";
        return undefined;
      }),
    }, { store, projectKey: directory, tools: [] });
    const loaded = await store.read();
    assert.equal(loaded.ok, true);
    if (loaded.ok) assert.equal(loaded.config.usageDisplay, "detailed");
    assert.deepEqual(selectedTitles, ["Pi Auto Approval", "Usage display", "Pi Auto Approval"]);
  });
});

test("Rules UI updates the selected Rule by ID after another process reorders it", async () => {
  await withSettings(async ({ directory, store }) => {
    const first = { id: "first", action: "allow", matcher: { tool: "read", input: { kind: "any" } } };
    const second = { id: "second", action: "allow", matcher: { tool: "grep", input: { kind: "any" } } };
    await store.replace({ version: 2, globalRules: [], projects: { [directory]: { rules: [first, second] } } });
    let editorStep = 0;
    await openRulesOnce(store, directory, (options) => options.find((item) => item.includes("Read")), async (title) => {
      if (title.startsWith("Allow · Project · Read")) return "Edit";
      if (title.startsWith("Rule Editor")) {
        if (editorStep++ === 0) {
          await store.update((config) => { config.projects[directory].rules.reverse(); });
          return "Action: Allow";
        }
        return "Save";
      }
      if (title.startsWith("Rule action")) return "Deny";
      return undefined;
    });
    const loaded = await store.read();
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
      const rules = loaded.config.projects[directory].rules;
      assert.equal(rules.find((rule) => rule.id === "first").action, "deny");
      assert.equal(rules.find((rule) => rule.id === "second").action, "allow");
    }
  });
});

test("matcher edits retain the latest action from another Pi process", async () => {
  await withSettings(async ({ directory, store }) => {
    const first = { id: "first", action: "allow", matcher: { tool: "read", input: { kind: "any" } } };
    await store.replace({ version: 2, globalRules: [], projects: { [directory]: { rules: [first] } } });
    let editorStep = 0;
    await openRulesOnce(store, directory, (options) => options.find((item) => item.includes("Read")), async (title) => {
      if (title.startsWith("Allow · Project · Read")) return "Edit";
      if (title.startsWith("Rule Editor")) {
        if (editorStep++ === 0) {
          await store.update((config) => { config.projects[directory].rules[0].action = "deny"; });
          return "Advanced JSON";
        }
        return "Save";
      }
      return undefined;
    }, { editor: async () => JSON.stringify({ tool: "read", input: { kind: "exact", value: { path: "fresh" } } }) });
    const loaded = await store.read();
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
      const saved = loaded.config.projects[directory].rules[0];
      assert.equal(saved.id, "first");
      assert.equal(saved.action, "deny");
      assert.deepEqual(saved.matcher.input, { kind: "exact", value: { path: "fresh" } });
    }
  });
});

test("duplicate matcher edits require confirmation and keep the restrictive action", async () => {
  await withSettings(async ({ directory, store }) => {
    const first = { id: "first", action: "allow", matcher: { tool: "read", input: { kind: "any" } } };
    const second = { id: "second", action: "deny", matcher: { tool: "read", input: { kind: "exact", value: { path: "secret" } } } };
    await store.replace({ version: 2, globalRules: [], projects: { [directory]: { rules: [first, second] } } });
    let editorStep = 0;
    const confirmations = [];
    const notices = [];
    await openRulesOnce(store, directory, (options) => options.find((item) => item.includes("Read")), async (title) => {
      if (title.startsWith("Allow · Project · Read")) return "Edit";
      if (title.startsWith("Rule Editor")) return editorStep++ === 0 ? "Advanced JSON" : "Save";
      return undefined;
    }, {
      notify(message) { notices.push(message); },
      confirm: async (title) => { confirmations.push(title); return true; },
      editor: async () => JSON.stringify(second.matcher),
    });
    const loaded = await store.read();
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
      const rules = loaded.config.projects[directory].rules;
      assert.equal(rules.length, 1);
      assert.equal(rules[0].id, "second");
      assert.equal(rules[0].action, "deny");
    }
    assert.deepEqual(confirmations, ["Merge matching Rules?"]);
    assert.ok(notices.some((message) => message.includes("Merged matching Rules")));
  });
});

test("fallback Rules list distinguishes source-bound Rules without exposing IDs", async () => {
  await withSettings(async ({ directory, store }) => {
    const alpha = { id: "internal-alpha", action: "allow", matcher: { tool: "custom", source: { source: "mcp", path: "alpha" }, input: { kind: "any" } } };
    const beta = { id: "internal-beta", action: "allow", matcher: { tool: "custom", source: { source: "mcp", path: "beta" }, input: { kind: "any" } } };
    await store.replace({ version: 2, globalRules: [], projects: { [directory]: { rules: [alpha, beta] } } });
    await openRulesOnce(store, directory, (options) => {
      assert.ok(options.every((item) => !item.includes("internal-")));
      return options.find((item) => item.includes("mcp:beta"));
    }, async (title) => title.includes("mcp:beta") ? "Delete" : undefined);
    const loaded = await store.read();
    assert.equal(loaded.ok, true);
    if (loaded.ok) assert.deepEqual(loaded.config.projects[directory].rules.map((rule) => rule.id), ["internal-alpha"]);
  });
});
