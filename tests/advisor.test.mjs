import assert from "node:assert/strict";
import { test } from "node:test";
import { RuleAdvisor } from "../src/advisor/advisor.ts";
import { ADVISOR_SYSTEM_PROMPT, buildAdvisorPrompt } from "../src/advisor/prompt.ts";
import { AdvisorResponseError, parseAdvisorResponse } from "../src/advisor/schema.ts";
import { defaultAutoApprovalConfig } from "../src/domain.ts";

const source = { source: "extension", path: "context7" };
const records = [
  {
    id: "r1",
    timestamp: "2026-08-08T00:00:00.000Z",
    tool: { name: "custom", source: { source: "extension", path: "custom" } },
    input: { operation: "read" },
    reviewDecision: "ask_user",
    userChoice: "approve_once",
  },
  {
    id: "r2",
    timestamp: "2026-08-08T00:01:00.000Z",
    tool: { name: "custom", source: { source: "extension", path: "custom" } },
    input: { operation: "read" },
    reviewDecision: "approve",
  },
];
const customSource = { source: "extension", path: "custom" };
const tools = [
  { name: "custom", source: customSource },
  { name: "context7_query-docs", source },
  { name: "bash", source: { source: "builtin", path: "<builtin:bash>" } },
];

function response(proposals) {
  return JSON.stringify({ proposals });
}

test("Advisor response validates consolidation, scope, evidence, and current Tool Identity", () => {
  const exact = { tool: "custom", input: { kind: "exact", value: { operation: "read" } } };
  const existingRule = { id: "old-custom", matcher: exact };
  const consolidated = { tool: "custom", source: customSource, input: { kind: "any" } };
  const toolWide = { tool: "context7_query-docs", source, input: { kind: "any" } };
  const proposals = parseAdvisorResponse(response([
    {
      matcher: consolidated,
      scope: "global",
      rationale: "Replace volatile snapshots",
      supportingRecordIds: ["r1", "r2"],
      replacesRuleIds: [existingRule.id],
    },
    { matcher: toolWide, scope: "project", rationale: "Read-only docs", supportingRecordIds: [], replacesRuleIds: [] },
  ]), { records, tools, projectApprovalRules: [existingRule], globalMatchers: [] });
  assert.equal(proposals[0].scope, "global");
  assert.deepEqual(proposals[0].replacesRuleIds, [existingRule.id]);

  const filtered = parseAdvisorResponse(response([
    {
      matcher: { tool: "bash", source: { source: "builtin", path: "<builtin:bash>" }, input: { kind: "any" } },
      scope: "global",
      rationale: "Invalid standard Tool-wide matcher",
      supportingRecordIds: [],
      replacesRuleIds: [],
    },
    {
      matcher: { tool: "bash", input: { kind: "exact", value: { command: "echo ok" } } },
      scope: "project",
      rationale: "Missing evidence",
      supportingRecordIds: ["gone"],
      replacesRuleIds: [],
    },
    { matcher: toolWide, scope: "project", rationale: "Valid remainder", supportingRecordIds: [], replacesRuleIds: [] },
  ]), { records, tools, projectApprovalRules: [], globalMatchers: [] });
  assert.deepEqual(filtered, [{
    matcher: toolWide,
    scope: "project",
    rationale: "Valid remainder",
    supportingRecordIds: [],
    replacesRuleIds: [],
  }]);

  assert.deepEqual(parseAdvisorResponse(response([
    {
      matcher: consolidated,
      scope: "project",
      rationale: "Invalid replacement",
      supportingRecordIds: ["r1"],
      replacesRuleIds: ["wide-rule"],
    },
    {
      matcher: { tool: "context7_query-docs", source: { source: "extension", path: "replacement" }, input: { kind: "any" } },
      scope: "global",
      rationale: "Wrong source",
      supportingRecordIds: [],
      replacesRuleIds: [],
    },
  ]), {
    records,
    tools,
    projectApprovalRules: [{ id: "wide-rule", matcher: consolidated }],
    globalMatchers: [],
  }), []);
  assert.throws(() => parseAdvisorResponse("[]", {
    records,
    tools,
    projectApprovalRules: [],
    globalMatchers: [],
  }), AdvisorResponseError);
});

test("Rule Advisor uses an isolated prompt and sorts by deterministic friction counts", async () => {
  const seen = {};
  const runtime = {
    complete: async (_config, _cwd, systemPrompt, prompt, operation) => {
      Object.assign(seen, { systemPrompt, prompt, operation });
      return response([
        {
          matcher: { tool: "context7_query-docs", source, input: { kind: "any" } },
          scope: "project",
          rationale: "Read-only docs",
          supportingRecordIds: [],
          replacesRuleIds: [],
        },
        {
          matcher: { tool: "custom", source: customSource, input: { kind: "any" } },
          scope: "global",
          rationale: "Repeated read",
          supportingRecordIds: ["r1", "r2"],
          replacesRuleIds: [],
        },
      ]);
    },
  };
  const config = defaultAutoApprovalConfig();
  const suggestions = await new RuleAdvisor(runtime).suggest(
    { provider: "test", modelId: "advisor", thinkingLevel: "low" },
    { projectKey: "C:\\project", projectRoot: "C:\\project", records, config, tools, skills: [] },
  );
  assert.equal(seen.systemPrompt, ADVISOR_SYSTEM_PROMPT);
  assert.equal(seen.operation, "Rule Advisor");
  assert.match(seen.prompt, /friction_records/);
  assert.equal(suggestions[0].stats.calls, 2);
  assert.equal(suggestions[0].stats.userConfirmations, 1);
  assert.equal(suggestions[0].stats.automatedReviews, 2);
  assert.equal(suggestions[1].stats.calls, 0);
});

test("Advisor prompt keeps complete bounded evidence below 128 KiB", () => {
  const escapedPayload = Object.fromEntries(
    Array.from({ length: 8 }, (_, field) => [`field-${field}`, "<".repeat(256)]),
  );
  const largeRecords = Array.from({ length: 50 }, (_, index) => ({
    ...records[0],
    id: `large-${index}`,
    input: escapedPayload,
  }));
  const prompt = buildAdvisorPrompt({
    projectKey: "C:\\project",
    projectRoot: "<".repeat(10_000),
    records: largeRecords,
    config: defaultAutoApprovalConfig(),
    tools: Array.from({ length: 30 }, (_, index) => ({
      name: `external-${index}`,
      description: "<".repeat(500),
      parameters: escapedPayload,
      source: { source: "extension", path: `tool-${index}` },
    })),
    skills: Array.from({ length: 30 }, (_, index) => ({ name: `skill-${index}`, description: "<".repeat(500) })),
  });
  const bytes = Buffer.byteLength(prompt, "utf8");
  assert.ok(bytes > 64 * 1024, `expected substantial bounded evidence, received ${bytes} bytes`);
  assert.ok(bytes < 128 * 1024, `expected prompt below 128 KiB, received ${bytes} bytes`);
});
