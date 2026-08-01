import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ApprovalConfirmationComponent } from "../src/approval/confirmation-component.ts";
import { confirmToolCall } from "../src/approval/confirmation.ts";

const theme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
  italic: (text) => text,
  underline: (text) => text,
  strikethrough: (text) => text,
  getFgAnsi: () => "",
  getBgAnsi: () => "",
};

function component(matcherText = '{"tool":"read","input":{"kind":"exact","value":{"path":"README.md"}}}') {
  const state = { renders: 0, result: undefined };
  const tui = { requestRender: () => { state.renders += 1; } };
  const instance = new ApprovalConfirmationComponent(tui, theme, (result) => { state.result = result; }, {
    title: "Tool approval required",
    detail: "read README.md",
    matcherText,
    validateMatcherText: (value) => {
      try { JSON.parse(value); return undefined; } catch { return "invalid JSON"; }
    },
  });
  return { instance, state };
}

test("confirmation component supports approve once, always, and denial feedback", () => {
  const once = component();
  once.instance.handleInput("\r");
  assert.deepEqual(once.state.result, { kind: "approve_once" });

  const always = component();
  always.instance.handleInput("\x1b[B");
  always.instance.handleInput("\r");
  assert.equal(always.state.result.kind, "always");
  assert.match(always.state.result.matcherText, /README\.md/);

  const deny = component();
  deny.instance.handleInput("\x1b[B");
  deny.instance.handleInput("\x1b[B");
  deny.instance.handleInput("use read instead");
  deny.instance.handleInput("\r");
  assert.deepEqual(deny.state.result, { kind: "deny", feedback: "use read instead" });
});

test("confirmation component keeps invalid inline matcher open and renders within width", () => {
  const { instance, state } = component("{");
  instance.handleInput("\x1b[B");
  instance.handleInput("\r");
  assert.equal(state.result, undefined);
  assert.match(instance.render(50).join("\n"), /invalid JSON/);
  assert.ok(instance.render(24).every((line) => visibleWidth(line) <= 24));
});

test("confirmation component treats Escape as denial", () => {
  const { instance, state } = component();
  instance.handleInput("\x1b");
  assert.deepEqual(state.result, { kind: "deny", feedback: "Approval cancelled" });
});

test("RPC confirmation validates edited proposal and retries mismatches", async () => {
  const selections = ["Always approve with rule", "Always approve with rule"];
  const edits = [
    '{"tool":"read","input":{"kind":"exact","value":{"path":"other.md"}}}',
    '{"tool":"read","input":{"kind":"exact","value":{"path":"README.md"}}}',
  ];
  const notices = [];
  const ctx = {
    hasUI: true,
    mode: "rpc",
    ui: {
      select: async () => selections.shift(),
      editor: async () => edits.shift(),
      input: async () => undefined,
      notify: (message) => notices.push(message),
    },
  };
  const result = await confirmToolCall(ctx, {
    call: { id: "1", name: "read", input: { path: "README.md" } },
    reason: "needs confirmation",
    proposal: { tool: "read", input: { kind: "exact", value: { path: "README.md" } } },
    validateProposal: async (matcher) => matcher.input.kind === "exact" && matcher.input.value.path === "README.md"
      ? undefined
      : "rule does not match current call",
  });
  assert.equal(result.kind, "always");
  assert.equal(notices.length, 1);
});

test("confirmation without UI denies the call", async () => {
  const result = await confirmToolCall({ hasUI: false }, {
    call: { id: "1", name: "read", input: { path: "README.md" } },
    reason: "needs confirmation",
    proposal: { tool: "read", input: { kind: "exact", value: { path: "README.md" } } },
    validateProposal: async () => undefined,
  });
  assert.equal(result.kind, "deny");
});
