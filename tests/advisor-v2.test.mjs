import assert from "node:assert/strict";
import { test } from "node:test";
import { RuleAdvisor } from "../src/advisor/advisor.ts";
import { parseAdvisorResponse } from "../src/advisor/schema.ts";
import { buildAdvisorPrompt } from "../src/advisor/prompt.ts";

const source = { source: "mcp", path: "context7" };
const records = [{
  id: "record-1",
  timestamp: "2026-01-01T00:00:00.000Z",
  tool: { name: "context7_query-docs", source },
  input: { libraryId: "/vercel/next.js", query: "routing" },
  reviewDecision: "allow",
  userChoice: "always",
}];
const tools = [{ name: "context7_query-docs", source }];
const anyMatcher = { tool: "context7_query-docs", source, input: { kind: "any" } };
const context = () => ({ records, tools, projectRules: [], globalRules: [] });

test("Advisor accepts all Rule actions and binds a known external source", () => {
  const suggestions = parseAdvisorResponse(JSON.stringify({
    proposals: [{
      action: "ask",
      matcher: { tool: "context7_query-docs", input: { kind: "any" } },
      scope: "global",
      rationale: "The user repeatedly wants to review these docs requests.",
      supportingRecordIds: ["record-1"],
      replacesRuleIds: [],
    }],
  }), context());
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].action, "ask");
  assert.deepEqual(suggestions[0].matcher.source, source);
});

test("Advisor retains valid siblings, rejects made-up sources, and allows project overrides", () => {
  const suggestions = parseAdvisorResponse(JSON.stringify({
    proposals: [
      {
        action: "ask",
        matcher: { tool: "context7_query-docs", input: { kind: "any" } },
        scope: "project",
        rationale: "This project needs confirmation.",
        supportingRecordIds: ["record-1"],
        replacesRuleIds: [],
      },
      {
        action: "review",
        matcher: { tool: "context7_query-docs", input: { kind: "any" } },
        scope: "global",
        rationale: "invalid action",
        supportingRecordIds: ["record-1"],
        replacesRuleIds: [],
      },
      {
        action: "allow",
        matcher: { tool: "context7_query-docs", source: { source: "mcp", path: "imposter" }, input: { kind: "any" } },
        scope: "global",
        rationale: "made-up source",
        supportingRecordIds: [],
        replacesRuleIds: [],
      },
    ],
  }), { ...context(), globalRules: [{ id: "global", action: "allow", matcher: anyMatcher }] });
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].action, "ask");
  assert.equal(suggestions[0].scope, "project");
});

test("Advisor ignores malformed matchers and retains valid sibling proposals", () => {
  const suggestions = parseAdvisorResponse(JSON.stringify({
    proposals: [
      {
        action: "allow",
        matcher: { tool: "context7_query-docs", input: [] },
        scope: "global",
        rationale: "invalid matcher",
        supportingRecordIds: ["record-1"],
        replacesRuleIds: [],
      },
      {
        action: "allow",
        matcher: { tool: "context7_query-docs", input: { kind: "any" } },
        scope: "global",
        rationale: "Repeated lookup.",
        supportingRecordIds: ["record-1"],
        replacesRuleIds: [],
      },
    ],
  }), context());
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].rationale, "Repeated lookup.");
});

test("Rule Advisor requests correction when every non-empty proposal is invalid", async () => {
  let parseAttempts = 0;
  const reviewer = {
    completeStructured: async (...args) => {
      const parse = args[5];
      parseAttempts += 1;
      assert.throws(() => parse(JSON.stringify({ proposals: [{ action: "review" }] })));
      parseAttempts += 1;
      return parse(JSON.stringify({ proposals: [{
        action: "allow",
        matcher: { tool: "context7_query-docs", input: { kind: "any" } },
        scope: "global",
        rationale: "Repeated lookup.",
        supportingRecordIds: ["record-1"],
        replacesRuleIds: [],
      }] }));
    },
  };
  const advisor = new RuleAdvisor(reviewer);
  const request = {
    projectKey: "/project",
    projectRoot: "/project",
    records,
    config: { version: 2, globalRules: [], projects: { "/project": { rules: [] } } },
    tools,
    skills: [],
  };
  const suggestions = await advisor.suggest({ provider: "test", modelId: "reviewer", thinkingLevel: "low" }, request);
  assert.equal(suggestions.length, 1);
  assert.equal(parseAttempts, 2);
});

test("Rule Advisor uses isolated completion and deterministic friction ordering", async () => {
  const reviewer = {
    completeStructured: async (...args) => args[5](JSON.stringify({ proposals: [{
      action: "allow",
      matcher: { tool: "context7_query-docs", input: { kind: "any" } },
      scope: "global",
      rationale: "Repeated lookup.",
      supportingRecordIds: ["record-1"],
      replacesRuleIds: [],
    }] })),
  };
  const advisor = new RuleAdvisor(reviewer);
  const request = {
    projectKey: "/project",
    projectRoot: "/project",
    records,
    config: { version: 2, globalRules: [], projects: { "/project": { rules: [] } } },
    tools,
    skills: [],
  };
  const suggestions = await advisor.suggest({ provider: "test", modelId: "reviewer", thinkingLevel: "low" }, request);
  assert.equal(suggestions[0].stats.calls, 1);
  const prompt = buildAdvisorPrompt(request);
  assert.match(prompt, /Rule Suggestions/);
  assert.ok(Buffer.byteLength(prompt, "utf8") < 128 * 1024);
});
