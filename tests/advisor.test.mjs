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
const tools = [
  { name: "custom", source: { source: "extension", path: "custom" } },
  { name: "context7_query-docs", source },
];

function response(proposals) {
  return JSON.stringify({ proposals });
}

test("Advisor response validates evidence, current Tool Identity, and duplicate rules", () => {
  const exact = { tool: "custom", input: { kind: "exact", value: { operation: "read" } } };
  const toolWide = { tool: "context7_query-docs", source, input: { kind: "any" } };
  const proposals = parseAdvisorResponse(response([
    { matcher: exact, rationale: "Repeated read", supportingRecordIds: ["r1", "r2"] },
    { matcher: toolWide, rationale: "Read-only docs", supportingRecordIds: [] },
  ]), { records, tools, existingMatchers: [exact] });
  assert.deepEqual(proposals, [{ matcher: toolWide, rationale: "Read-only docs", supportingRecordIds: [] }]);

  assert.throws(() => parseAdvisorResponse(response([
    { matcher: exact, rationale: "Missing evidence", supportingRecordIds: ["gone"] },
  ]), { records, tools, existingMatchers: [] }), AdvisorResponseError);
  assert.throws(() => parseAdvisorResponse(response([
    {
      matcher: { tool: "context7_query-docs", source: { source: "extension", path: "replacement" }, input: { kind: "any" } },
      rationale: "Wrong source",
      supportingRecordIds: [],
    },
  ]), { records, tools, existingMatchers: [] }), /current Tool/);
});

test("Rule Advisor uses an isolated prompt and sorts by deterministic friction counts", async () => {
  const seen = {};
  const runtime = {
    complete: async (_config, _cwd, systemPrompt, prompt, operation) => {
      Object.assign(seen, { systemPrompt, prompt, operation });
      return response([
        {
          matcher: { tool: "context7_query-docs", source, input: { kind: "any" } },
          rationale: "Read-only docs",
          supportingRecordIds: [],
        },
        {
          matcher: { tool: "custom", input: { kind: "exact", value: { operation: "read" } } },
          rationale: "Repeated read",
          supportingRecordIds: ["r1", "r2"],
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
