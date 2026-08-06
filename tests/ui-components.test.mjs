import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { RuleEditorComponent } from "../src/ui/rule-editor-component.ts";
import { RuleListComponent } from "../src/ui/rule-list-component.ts";
import { RuleReviewComponent } from "../src/ui/rule-review-component.ts";
import { SettingsMenuComponent } from "../src/ui/settings-menu-component.ts";

const theme = { fg: (_color, text) => text, bold: (text) => text, dim: (text) => text };
const tui = { requestRender() {} };

function bounded(component, width) {
  const lines = component.render(width);
  assert.ok(lines.every((line) => !line.includes("\n") && !line.includes("\r")));
  assert.ok(lines.every((line) => visibleWidth(line) <= width));
  return lines;
}

test("Settings menu changes Usage display with left and right arrows", async () => {
  const changes = [];
  let result;
  const menu = new SettingsMenuComponent(theme, {
    usageDisplay: "brief",
    onUsageDisplayChange: async (value) => {
      changes.push(value);
      return true;
    },
  }, (action) => { result = action; });

  menu.handleInput("\x1b[B");
  menu.handleInput("\x1b[B");
  menu.handleInput("\x1b[B");
  menu.handleInput("\x1b[D");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(changes, ["detailed"]);
  assert.ok(bounded(menu, 48).some((line) => line.includes("Detailed")));

  menu.handleInput("\x1b[A");
  menu.handleInput("\r");
  assert.equal(result, "reviewer");
});

test("Rule Editor uses arrows for fields, Enter for actions, and ignores Space", () => {
  let result;
  const editor = new RuleEditorComponent(tui, theme, (value) => { result = value; }, {
    action: "allow",
    scope: "project",
    matchKind: "any",
    tool: "Bash\nInjected",
    matcherSummary: "Bash\r\nInjected",
  });
  editor.handleInput(" ");
  assert.equal(result, undefined);
  editor.handleInput("\x1b[C");
  editor.handleInput("\r");
  assert.deepEqual(result, { kind: "choose_action", action: "ask", scope: "project", matchKind: "any" });
  bounded(editor, 36);
});

test("fixed-action Rule Editor starts on Scope and can cycle it", () => {
  let result;
  const editor = new RuleEditorComponent(tui, theme, (value) => { result = value; }, {
    action: "allow",
    scope: "project",
    matchKind: "exact",
    tool: "Read",
    matcherSummary: "Read(path: x)",
    actionFixed: true,
  });
  editor.handleInput("\x1b[C");
  editor.handleInput("\r");
  assert.deepEqual(result, { kind: "choose_scope", action: "allow", scope: "global", matchKind: "exact" });
});

test("Rule Review uses Space to select, E to edit, and Enter to save", () => {
  let result;
  const items = [
    { summary: "Allow · Bash(git diff *)\nInjected", selected: false, scope: "project" },
    { summary: "Allow · context7:query-docs", selected: true, scope: "global", suffix: "2 calls\r\nInjected" },
  ];
  const review = new RuleReviewComponent(tui, theme, items, (value) => { result = value; }, {
    title: "Rule\nSuggestions",
    subtitle: "Nothing selected\r\nby default",
  });
  review.handleInput(" ");
  review.handleInput("e");
  assert.deepEqual(result, { kind: "edit", index: 0, selected: [true, true] });

  result = undefined;
  const save = new RuleReviewComponent(tui, theme, items, (value) => { result = value; }, {
    title: "Rule Suggestions",
    subtitle: "Nothing selected by default",
  });
  save.handleInput("\r");
  assert.deepEqual(result, { kind: "save", selected: [false, true] });
  bounded(save, 42);
});

test("Rule Review keeps a bounded eight-row viewport", () => {
  const review = new RuleReviewComponent(tui, theme, Array.from({ length: 12 }, (_, index) => ({
    summary: `Allow · Tool ${index}`,
    selected: false,
    scope: "project",
  })), () => {}, { title: "Rules", subtitle: "Review" });
  const lines = bounded(review, 28);
  assert.ok(lines.some((line) => line.includes("1-8 of 12")));
  assert.equal(lines.filter((line) => line.includes("[ ]")).length, 8);
});

test("Rules list opens with Enter and deletes with D", () => {
  let result;
  const items = [{ summary: "Allow · Project · Read\r\nInjected", scope: "project" }];
  const list = new RuleListComponent(tui, theme, items, (value) => { result = value; });
  list.handleInput("\x1b[B");
  list.handleInput("d");
  assert.deepEqual(result, { kind: "delete", index: 0 });
  bounded(list, 32);
});
