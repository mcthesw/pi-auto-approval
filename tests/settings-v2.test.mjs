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

test("Rules UI updates the selected Rule by ID after another process reorders it", async () => {
  await withSettings(async ({ directory, store }) => {
    const first = { id: "first", action: "allow", matcher: { tool: "read", input: { kind: "any" } } };
    const second = { id: "second", action: "allow", matcher: { tool: "grep", input: { kind: "any" } } };
    await store.replace({ version: 2, globalRules: [], projects: { [directory]: { rules: [first, second] } } });
    let reordered = false;
    let rulesOpened = false;
    const select = async (title, options) => {
      if (title === "Pi Auto Approval") return rulesOpened ? "Done" : "Rules";
      if (title === "Rules") {
        if (rulesOpened) return "Back";
        rulesOpened = true;
        return options.find((item) => item.includes("first"));
      }
      if (title.includes("Allow · Project")) {
        if (!reordered) {
          reordered = true;
          await store.update((config) => { config.projects[directory].rules.reverse(); });
        }
        return "Edit action";
      }
      if (title === "Rule action") return "Deny";
      return "Back";
    };
    await openAutoApprovalSettings({
      hasUI: true,
      mode: "rpc",
      ui: { select, notify() {}, confirm: async () => true, input: async () => undefined, editor: async () => undefined },
    }, { store, projectKey: directory, tools: [] });
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
    let rulesOpened = false;
    let advanced = false;
    const select = async (title, options) => {
      if (title === "Pi Auto Approval") return rulesOpened ? "Done" : "Rules";
      if (title === "Rules") {
        if (rulesOpened) return "Back";
        rulesOpened = true;
        return options.find((item) => item.includes("first"));
      }
      if (title.includes("Allow · Project")) return "Edit matcher";
      if (title.startsWith("Tool: Read")) {
        if (!advanced) {
          advanced = true;
          await store.update((config) => { config.projects[directory].rules[0].action = "deny"; });
          return "Advanced JSON";
        }
        return "Save rule";
      }
      return "Back";
    };
    await openAutoApprovalSettings({
      hasUI: true,
      mode: "rpc",
      ui: {
        select,
        notify() {},
        confirm: async () => true,
        input: async () => undefined,
        editor: async () => JSON.stringify({ tool: "read", input: { kind: "exact", value: { path: "fresh" } } }),
      },
    }, { store, projectKey: directory, tools: [] });
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

test("matcher edits merge duplicates and preserve the more restrictive action", async () => {
  await withSettings(async ({ directory, store }) => {
    const first = { id: "first", action: "allow", matcher: { tool: "read", input: { kind: "any" } } };
    const second = { id: "second", action: "deny", matcher: { tool: "read", input: { kind: "exact", value: { path: "secret" } } } };
    await store.replace({ version: 2, globalRules: [], projects: { [directory]: { rules: [first, second] } } });
    let rulesOpened = false;
    let editorSaved = false;
    const notices = [];
    const select = async (title, options) => {
      if (title === "Pi Auto Approval") return rulesOpened ? "Done" : "Rules";
      if (title === "Rules") {
        if (rulesOpened) return "Back";
        rulesOpened = true;
        return options.find((item) => item.includes("first"));
      }
      if (title.includes("Allow · Project")) return "Edit matcher";
      if (title.startsWith("Tool: Read")) {
        if (!editorSaved) {
          editorSaved = true;
          return "Advanced JSON";
        }
        return "Save rule";
      }
      return "Back";
    };
    await openAutoApprovalSettings({
      hasUI: true,
      mode: "rpc",
      ui: {
        select,
        notify(message) { notices.push(message); },
        confirm: async () => true,
        input: async () => undefined,
        editor: async () => JSON.stringify(second.matcher),
      },
    }, { store, projectKey: directory, tools: [] });
    const loaded = await store.read();
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
      const rules = loaded.config.projects[directory].rules;
      assert.equal(rules.length, 1);
      assert.equal(rules[0].id, "second");
      assert.equal(rules[0].action, "deny");
      assert.deepEqual(rules[0].matcher, second.matcher);
    }
    assert.ok(notices.some((message) => message.includes("Merged with the matching Rule")));
  });
});
