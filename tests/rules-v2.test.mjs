import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseAutoApprovalConfig } from "../src/config/schema.ts";
import { AutoApprovalConfigStore } from "../src/config/store.ts";
import { defaultAutoApprovalConfig } from "../src/domain.ts";
import { exactMatcherFor, matchesToolCall, validateToolMatcher } from "../src/matchers.ts";
import { evaluatePolicy } from "../src/policy/engine.ts";
import { formatConservativeBashCommand, parseConservativeBash } from "../src/policy/bash.ts";
import { resolveProjectPath } from "../src/project.ts";
import { matcherDetails, matcherSummary } from "../src/ui/rule-editor.ts";

async function withTempDirectory(fn) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-auto-rules-v2-"));
  try {
    await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function rule(id, action, matcher) {
  return { id, action, matcher };
}

const cargoFmt = { tool: "bash", input: { kind: "fields", fields: { command: { kind: "tokenPrefix", tokens: ["cargo", "fmt"] } } } };
const cargoClippy = { tool: "bash", input: { kind: "fields", fields: { command: { kind: "tokenPrefix", tokens: ["cargo", "clippy"] } } } };

async function policy(directory, call, projectRules = [], globalRules = []) {
  return await evaluatePolicy(call, {
    projectRoot: directory,
    cwd: directory,
    project: { rules: projectRules },
    globalRules,
  });
}

test("v1 configuration migrates to v2 with restricted actions winning duplicate matchers", () => {
  const matcher = { tool: "read", input: { kind: "fields", fields: { path: { kind: "pathGlob", pattern: "src/**" } } } };
  const config = parseAutoApprovalConfig({
    version: 1,
    reviewer: { provider: "openai", modelId: "reviewer", thinkingLevel: "low" },
    globalApprovalRules: [{ id: "global", matcher: { tool: "context7_query-docs", source: { source: "mcp", path: "context7" }, input: { kind: "any" } } }],
    projects: {
      [path.resolve("project")]: {
        approvalRules: [{ id: "allow", matcher }],
        policyRules: [
          { id: "ask", matcher, route: "ask_user" },
          { id: "deny", matcher, route: "deny" },
          { id: "review", matcher: { tool: "read", input: { kind: "exact", value: { path: "x" } } }, route: "auto_review" },
        ],
      },
    },
  });
  assert.equal(config.version, 2);
  assert.equal(config.globalRules[0].action, "allow");
  const rules = config.projects[path.resolve("project")].rules;
  assert.deepEqual(rules.map((item) => [item.id, item.action]), [["deny", "deny"]]);
});

test("v2 store writes only v2 and serializes concurrent updates", async () => {
  await withTempDirectory(async (directory) => {
    const store = new AutoApprovalConfigStore(path.join(directory, "auto-approval.json"));
    await store.replace(defaultAutoApprovalConfig());
    await Promise.all(Array.from({ length: 8 }, (_, index) => store.update((config) => {
      config.projects[path.join(directory, `project-${index}`)] = { rules: [] };
    })));
    const source = JSON.parse(await readFile(store.filePath, "utf8"));
    assert.equal(source.version, 2);
    assert.equal(source.globalRules.length, 0);
    assert.equal(Object.keys(source.projects).length, 8);
  });
});

test("matcher validation scopes path globs and source binding is respected", async () => {
  const globalRelative = { tool: "read", input: { kind: "fields", fields: { path: { kind: "pathGlob", pattern: "src/**" } } } };
  assert.match(validateToolMatcher(globalRelative, { scope: "global" }), /absolute or home-anchored/);
  const projectAbsolute = { tool: "read", input: { kind: "fields", fields: { path: { kind: "pathGlob", pattern: path.resolve("src/**") } } } };
  assert.match(validateToolMatcher(projectAbsolute, { scope: "project" }), /project-relative/);
  assert.match(validateToolMatcher({ tool: "read", source: { source: "mcp", path: "other" }, input: { kind: "any" } }), /standard tools cannot be source-bound/);
  const matcher = { tool: "context7_query-docs", source: { source: "mcp", path: "context7" }, input: { kind: "any" } };
  const context = { resolvePath: async () => ({ inside: true, relative: "x", canonical: "x" }), tokenizeBash: () => undefined, source: { source: "mcp", path: "context7" } };
  assert.equal(await matchesToolCall(matcher, { id: "1", name: "context7_query-docs", input: {} }, context), true);
  assert.equal(await matchesToolCall(matcher, { id: "1", name: "context7_query-docs", input: {} }, { ...context, source: { source: "mcp", path: "other" } }), false);
  const pathMatcher = { tool: "read", input: { kind: "fields", fields: { path: { kind: "pathGlob", pattern: "src/**" } } } };
  assert.equal(await matchesToolCall(pathMatcher, { id: "windows", name: "read", input: { path: "src\\\\main.ts" } }, {
    resolvePath: async () => ({ inside: true, relative: "src\\\\main.ts", canonical: "C:\\\\work\\\\src\\\\main.ts" }),
    tokenizeBash: () => undefined,
  }), true);
});

test("project Rules override global Rules and overlapping Rules use restrictive actions", async () => {
  await withTempDirectory(async (directory) => {
    const call = { id: "1", name: "read", input: { path: "src/a.ts" } };
    const matcher = { tool: "read", input: { kind: "fields", fields: { path: { kind: "pathGlob", pattern: "src/**" } } } };
    const result = await policy(directory, call, [rule("project-allow", "allow", matcher), rule("project-deny", "deny", matcher)], [rule("global", "allow", matcher)]);
    assert.equal(result.action, "deny");
    const global = await policy(directory, call, [], [rule("global", "ask", { tool: "read", input: { kind: "any" } })]);
    assert.equal(global.action, "ask");
  });
});

test("minimal built-ins allow ordinary project operations and defer control paths", async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(path.join(directory, "src"));
    assert.equal((await policy(directory, { id: "read", name: "read", input: { path: ".env" } })).action, "allow");
    assert.equal((await policy(directory, { id: "write", name: "write", input: { path: "src/a.ts", content: "x" } })).action, "allow");
    assert.equal((await policy(directory, { id: "control", name: "write", input: { path: ".pi/config", content: "x" } })).action, "review");
    assert.equal((await policy(directory, { id: "outside", name: "read", input: { path: path.join(directory, "..", "outside") } })).action, "review");
  });
});

test("Bash resolves whole exact calls first and otherwise requires every segment to have a Rule", async () => {
  await withTempDirectory(async (directory) => {
    const call = { id: "bash", name: "bash", input: { command: "cargo fmt --all && cargo clippy --workspace" } };
    assert.equal((await policy(directory, call, [rule("fmt", "allow", cargoFmt)], [rule("clippy", "allow", cargoClippy)])).action, "allow");
    assert.equal((await policy(directory, call, [rule("fmt", "allow", cargoFmt)], [rule("clippy", "ask", cargoClippy)])).action, "ask");
    assert.equal((await policy(directory, call, [rule("fmt", "allow", cargoFmt)])).action, "review");
    const mixed = { id: "mixed", name: "bash", input: { command: "echo ok && rm -rf target" } };
    const bashAny = { tool: "bash", input: { kind: "any" } };
    const remove = { tool: "bash", input: { kind: "fields", fields: { command: { kind: "tokenPrefix", tokens: ["rm"] } } } };
    assert.equal((await policy(directory, mixed, [rule("all-bash", "allow", bashAny), rule("deny-remove", "deny", remove)])).action, "deny");
    assert.equal((await policy(directory, mixed, [rule("project-deny", "deny", bashAny)], [rule("global-exact", "allow", exactMatcherFor(mixed))])).action, "deny");
    const quoted = { id: "quoted", name: "bash", input: { command: "echo '$HOME' && echo 'a;b'" } };
    const parsed = parseConservativeBash(quoted.input.command);
    assert.deepEqual(parsed?.commands, [["echo", "$HOME"], ["echo", "a;b"]]);
    assert.ok(parsed);
    assert.equal(formatConservativeBashCommand(parsed.commands[0]), "'echo' '$HOME'");
    const literalRule = rule("literal", "allow", exactMatcherFor({ ...quoted, input: { command: "'echo' '$HOME'" } }));
    assert.equal((await policy(directory, { ...quoted, input: { command: "echo '$HOME'" } }, [literalRule])).action, "allow");
    assert.equal(parseConservativeBash("echo $HOME"), undefined);
    assert.equal(parseConservativeBash("echo *"), undefined);
    const opaque = { id: "opaque", name: "bash", input: { command: "echo $HOME" } };
    assert.equal((await policy(directory, opaque, [literalRule])).action, "review");
    const exact = exactMatcherFor(opaque);
    assert.ok(exact);
    assert.equal((await policy(directory, opaque, [rule("exact", "allow", exact)])).action, "allow");
  });
});

test("global absolute path glob matches canonical targets and rule summaries stay human-readable", async () => {
  await withTempDirectory(async (directory) => {
    const target = path.join(directory, "config", "settings.json");
    const matcher = { tool: "read", input: { kind: "fields", fields: { path: { kind: "pathGlob", pattern: path.join(directory, "config", "**") } } } };
    const context = { resolvePath: async (value) => await resolveProjectPath(directory, directory, value), tokenizeBash: () => undefined, scope: "global" };
    assert.equal(await matchesToolCall(matcher, { id: "1", name: "read", input: { path: target } }, context), true);
    assert.equal(matcherSummary(cargoFmt), "Bash(cargo fmt *)");
    assert.match(matcherDetails({ tool: "context7_query-docs", input: { kind: "any" } }), /context7:query-docs/);
  });
});
