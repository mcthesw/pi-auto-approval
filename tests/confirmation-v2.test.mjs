import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ApprovalConfirmationComponent } from "../src/approval/confirmation-component.ts";
import { confirmToolCall } from "../src/approval/confirmation.ts";
import { ReadOnlyViewer } from "../src/ui/read-only-viewer.ts";

const theme = { fg: (_color, text) => text, bold: (text) => text, dim: (text) => text };
const tui = { requestRender() {} };

function component(done) {
  return new ApprovalConfirmationComponent(tui, theme, done, {
    title: "Tool approval required",
    reason: "needs a decision",
    toolName: "bash",
    callSummary: "command: cargo fmt",
    ruleSummaries: ["Project · Bash(cargo fmt *)"],
  });
}

test("confirmation renders bounded reason and Tool Call summaries", () => {
  const view = new ApprovalConfirmationComponent(tui, theme, () => {}, {
    title: "Tool approval\nrequired",
    reason: "compound\nrequest ".repeat(20),
    toolName: "bash\nInjected",
    callSummary: "git diff && git status ".repeat(20),
    ruleSummaries: ["Project · Bash(git diff *)\nInjected"],
  });
  const lines = view.render(28);
  assert.ok(lines.every((line) => !line.includes("\n") && !line.includes("\r")));
  assert.ok(lines.every((line) => visibleWidth(line) <= 28));
  assert.ok(lines.some((line) => line.includes("Allow and create Rule")));
  assert.ok(lines.some((line) => line.includes("V details")));
  assert.ok(lines.some((line) => line.includes("Why approval is needed")));
  assert.ok(!lines.some((line) => line.includes("Run only this Tool Call")));
  assert.ok(!lines.some((line) => line.includes("Optional feedback")));
});

test("confirmation offers allow once, Rule review, denial feedback, and full call view", () => {
  let result;
  const allow = component((value) => { result = value; });
  allow.handleInput("\r");
  assert.deepEqual(result, { kind: "allow_once" });

  const withRule = component((value) => { result = value; });
  assert.ok(!withRule.render(80).some((line) => line.includes("E edit")));
  withRule.handleInput("\x1b[B");
  const ruleLines = withRule.render(80);
  assert.ok(ruleLines.some((line) => line.includes("Project · Bash(cargo fmt *)")));
  assert.ok(ruleLines.some((line) => line.includes("E edit • V details • Esc block")));
  assert.ok(!ruleLines.some((line) => line.includes("[x]")));
  assert.ok(!ruleLines.some((line) => line.includes("Enter allow & save")));
  withRule.handleInput("\r");
  assert.deepEqual(result, { kind: "allow_with_rule" });

  const review = component((value) => { result = value; });
  review.handleInput("\x1b[B");
  review.handleInput("e");
  assert.deepEqual(result, { kind: "review_rules" });

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

test("more than three proposed Rules require review before saving", () => {
  let result;
  const view = new ApprovalConfirmationComponent(tui, theme, (value) => { result = value; }, {
    title: "Tool approval required",
    reason: "needs a decision",
    toolName: "bash",
    callSummary: "command: git status",
    ruleSummaries: Array.from({ length: 4 }, (_, index) => `Project · Bash(command ${index} *)`),
  });
  view.handleInput("\x1b[B");
  assert.ok(view.render(80).some((line) => line.includes("+1 more · Enter reviews all")));
  const narrow = view.render(32);
  assert.ok(narrow.some((line) => line.includes("command 0")));
  assert.ok(narrow.some((line) => line.includes("command 1")));
  assert.ok(!narrow.some((line) => line.includes("E review Rules")));
  view.handleInput("\r");
  assert.deepEqual(result, { kind: "review_rules" });
});

test("TUI confirmation shows readable input and directly saves visible Rules", async () => {
  let rendered = [];
  const proposal = { scope: "project", matcher: { tool: "bash", input: { kind: "any" } } };
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      async custom(factory) {
        let result;
        const view = factory(tui, theme, undefined, (value) => { result = value; });
        view.handleInput("\x1b[B");
        rendered = view.render(80);
        view.handleInput("\r");
        return result;
      },
    },
  };
  const result = await confirmToolCall(ctx, {
    call: { id: "call-secret", name: "bash", input: { command: "git status", timeout: 10 } },
    reason: "Outside the requested scope",
    proposals: [proposal],
    validateProposal: async () => undefined,
  });
  assert.deepEqual(result, { kind: "always", rules: [proposal] });
  assert.ok(rendered.some((line) => line.includes("command: git status · timeout: 10")));
  assert.ok(!rendered.some((line) => line.includes("call-secret")));
});

test("full Tool Call viewer scrolls while keeping every line bounded", () => {
  const viewer = new ReadOnlyViewer(tui, theme, () => {}, "Full Tool Call", Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"), 4);
  const first = viewer.render(12);
  viewer.handleInput("\x1b[B");
  const second = viewer.render(12);
  assert.notDeepEqual(first, second);
  assert.ok(second.every((line) => visibleWidth(line) <= 12));
});
