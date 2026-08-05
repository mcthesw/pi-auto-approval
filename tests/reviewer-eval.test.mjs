import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { evaluateReviewerCases, parseReviewerEvalCases } from "../src/review/eval.ts";

test("Reviewer eval corpus has a valid schema and covers adversarial cases", async () => {
  const cases = parseReviewerEvalCases(JSON.parse(await readFile(new URL("../eval/reviewer-cases.json", import.meta.url), "utf8")));
  assert.ok(cases.length >= 5);
  assert.ok(cases.some((item) => item.id === "revoked-authorization"));
  assert.ok(cases.some((item) => item.id === "tool-argument-injection"));
});

test("Reviewer eval reports decisions and failures without stopping later cases", async () => {
  const cases = parseReviewerEvalCases([
    { id: "allow", expected: "allow", request: { toolCall: { id: "1", name: "read", input: {} }, cwd: "/x", projectRoot: "/x", messages: [] } },
    { id: "error", expected: "deny", request: { toolCall: { id: "2", name: "read", input: {} }, cwd: "/x", projectRoot: "/x", messages: [] } },
  ]);
  const reviewer = {
    review: async (_config, request) => {
      if (request.toolCall.id === "2") throw new Error("offline");
      return { decision: "allow", reason: "expected" };
    },
  };
  const result = await evaluateReviewerCases(cases, { provider: "test", modelId: "reviewer", thinkingLevel: "low" }, reviewer);
  assert.deepEqual(result.map((item) => [item.id, item.passed, item.error]), [["allow", true, undefined], ["error", false, "offline"]]);
});
