import assert from "node:assert/strict";
import { test } from "node:test";
import { editApprovalRule, matcherDetails, matcherSummary } from "../src/ui/rule-editor.ts";

function context(selections, edits = []) {
  const notices = [];
  return {
    notices,
    ctx: {
      ui: {
        select: async () => selections.shift(),
        editor: async () => edits.shift(),
        input: async () => undefined,
        notify: (message) => notices.push(message),
      },
    },
  };
}

test("human-readable matcher summaries expose exact input fields without raw JSON", () => {
  const matcher = {
    tool: "grep",
    input: { kind: "exact", value: { pattern: "room_members_ui(", path: "crates/bridge-gui/src/app/pages.rs", literal: true, context: 8 } },
  };
  const summary = matcherSummary(matcher);
  assert.match(summary, /grep · Exact call/);
  assert.match(summary, /pattern:/);
  assert.match(summary, /path:/);
  assert.doesNotMatch(summary, /\{"tool"/);
  assert.match(matcherDetails(matcher), /context: 8/);
});

test("rule editor can convert a standard exact call into structured constraints", async () => {
  const selections = [
    "Change match type",
    "Selected constraints",
    "Edit constraints",
    'path = "src/file.ts"',
    "Edit",
    "Project path pattern",
    "Back",
    "Save rule",
  ];
  const { ctx } = context(selections, ["src/**"]);
  const result = await editApprovalRule(ctx, {
    initial: { tool: "read", input: { kind: "exact", value: { path: "src/file.ts" } } },
    exactInput: { path: "src/file.ts" },
  });
  assert.deepEqual(result, {
    scope: "project",
    matcher: { tool: "read", input: { kind: "fields", fields: { path: { kind: "pathGlob", pattern: "src/**" } } } },
  });
});

test("rule editor requires an explicit scope switch for Global Tool-wide authorization", async () => {
  const selections = ["Change match type", "All inputs", "Scope: Current project", "Save rule"];
  const { ctx } = context(selections);
  const source = { source: "extension", path: "context7" };
  const result = await editApprovalRule(ctx, {
    initial: { tool: "context7_query-docs", input: { kind: "exact", value: { query: "Rust" } } },
    toolSource: source,
    exactInput: { query: "Rust" },
  });
  assert.deepEqual(result, {
    scope: "global",
    matcher: { tool: "context7_query-docs", source, input: { kind: "any" } },
  });
});
