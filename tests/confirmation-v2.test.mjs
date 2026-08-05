import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ApprovalConfirmationComponent } from "../src/approval/confirmation-component.ts";
import { ReadOnlyViewer } from "../src/ui/read-only-viewer.ts";

const theme = { fg: (_color, text) => text, bold: (text) => text, dim: (text) => text };
const tui = { requestRender() {} };

function component(done) {
  return new ApprovalConfirmationComponent(tui, theme, done, {
    title: "Tool approval required",
    reason: "needs a decision",
    callSummary: '{"name":"bash","input":{"command":"cargo fmt"}}',
  });
}

test("confirmation renders bounded reason and Tool Call summaries", () => {
  const view = new ApprovalConfirmationComponent(tui, theme, () => {}, {
    title: "Tool approval\nrequired",
    reason: "compound\nrequest ".repeat(20),
    callSummary: "git diff && git status ".repeat(20),
  });
  const lines = view.render(28);
  assert.ok(lines.every((line) => !line.includes("\n") && !line.includes("\r")));
  assert.ok(lines.every((line) => visibleWidth(line) <= 28));
  assert.ok(lines.some((line) => line.includes("Allow with Rule")));
  assert.ok(lines.some((line) => line.includes("V full call")));
  assert.ok(!lines.some((line) => line.includes("Optional feedback")));
});

test("confirmation offers allow once, Rule review, denial feedback, and full call view", () => {
  let result;
  const allow = component((value) => { result = value; });
  allow.handleInput("\r");
  assert.deepEqual(result, { kind: "allow_once" });

  const withRule = component((value) => { result = value; });
  withRule.handleInput("\x1b[B");
  withRule.handleInput("\r");
  assert.deepEqual(result, { kind: "allow_with_rule" });

  const deny = component((value) => { result = value; });
  deny.focused = true;
  deny.handleInput("\x1b[B");
  deny.handleInput("\x1b[B");
  assert.ok(deny.render(80).some((line) => line.includes("Optional feedback")));
  deny.handleInput("avoid this");
  deny.handleInput("\r");
  assert.deepEqual(result, { kind: "deny", feedback: "avoid this" });

  const details = component((value) => { result = value; });
  details.handleInput("v");
  assert.deepEqual(result, { kind: "view_call" });

  const denyDetails = component((value) => { result = value; });
  denyDetails.handleInput("\x1b[B");
  denyDetails.handleInput("\x1b[B");
  denyDetails.handleInput("V");
  assert.deepEqual(result, { kind: "view_call" });
});

test("full Tool Call viewer scrolls while keeping every line bounded", () => {
  const viewer = new ReadOnlyViewer(tui, theme, () => {}, "Full Tool Call", Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"), 4);
  const first = viewer.render(12);
  viewer.handleInput("\x1b[B");
  const second = viewer.render(12);
  assert.notDeepEqual(first, second);
  assert.ok(second.every((line) => visibleWidth(line) <= 12));
});
