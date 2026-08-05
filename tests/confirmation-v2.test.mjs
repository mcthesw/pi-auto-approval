import assert from "node:assert/strict";
import { test } from "node:test";
import { ApprovalConfirmationComponent } from "../src/approval/confirmation-component.ts";

const theme = { fg: (_color, text) => text, bold: (text) => text, dim: (text) => text };
const tui = { requestRender() {} };

function component(done) {
  return new ApprovalConfirmationComponent(tui, theme, done, {
    title: "Tool approval required",
    detail: "needs a decision",
    matcherSummary: "Bash(cargo fmt *)",
  });
}

test("confirmation offers allow once, persistent Rule, and denial feedback", () => {
  let result;
  const allow = component((value) => { result = value; });
  allow.handleInput("\r");
  assert.deepEqual(result, { kind: "allow_once" });

  const always = component((value) => { result = value; });
  always.handleInput("\x1b[B");
  always.handleInput("\r");
  assert.deepEqual(result, { kind: "always" });

  const deny = component((value) => { result = value; });
  deny.handleInput("\x1b[B");
  deny.handleInput("\x1b[B");
  deny.handleInput("not this");
  deny.handleInput("\r");
  assert.deepEqual(result, { kind: "deny", feedback: "not this" });
});
