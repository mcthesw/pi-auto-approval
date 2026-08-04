import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AutoApprovalConfigStore } from "../src/config/store.ts";
import { ConfigValidationError, parseAutoApprovalConfig } from "../src/config/schema.ts";
import { defaultAutoApprovalConfig } from "../src/domain.ts";
import { exactMatcherFor, matchesToolCall, validateToolMatcher } from "../src/matchers.ts";
import { resolveProjectIdentity, resolveProjectPath } from "../src/project.ts";

async function withTempDirectory(fn) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-auto-approval-"));
  try {
    await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const matcherContext = {
  resolvePath: async (value) => ({ inside: !value.startsWith("../"), relative: value }),
  tokenizeBash: (command) => command.trim().split(/\s+/),
};

test("config schema is strict and keeps reviewer settings explicit", () => {
  const config = parseAutoApprovalConfig({
    version: 1,
    reviewer: { provider: "openai", modelId: "gpt-test", thinkingLevel: "low" },
    projects: {},
  });
  assert.deepEqual(config.reviewer, { provider: "openai", modelId: "gpt-test", thinkingLevel: "low" });
  assert.throws(
    () => parseAutoApprovalConfig({ version: 1, projects: {}, enabled: true }),
    /config\.enabled: unknown property/,
  );
  assert.throws(
    () => parseAutoApprovalConfig({ version: 1, projects: {}, reviewer: { provider: "x", modelId: "y" } }),
    /thinkingLevel/,
  );
  assert.throws(() => parseAutoApprovalConfig({ version: 1, projects: { relative: { policyRules: [], approvalRules: [] } } }), /normalized absolute path/);
});

test("config store reports invalid files instead of silently replacing them", async () => {
  await withTempDirectory(async (directory) => {
    const file = path.join(directory, "auto-approval.json");
    const store = new AutoApprovalConfigStore(file);
    await writeFile(file, "{broken", "utf8");
    const result = await store.read();
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /Invalid JSON/);
    await assert.rejects(store.update(() => {}), ConfigValidationError);
  });
});

test("config store serializes concurrent read-modify-write updates", async () => {
  await withTempDirectory(async (directory) => {
    const store = new AutoApprovalConfigStore(path.join(directory, "auto-approval.json"));
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.update((config) => {
          const key = path.resolve(directory, `project-${index}`);
          config.projects[key] = { policyRules: [], approvalRules: [] };
        }),
      ),
    );
    const result = await store.read();
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(Object.keys(result.config.projects).length, 12);
  });
});

test("config replacement validates data and writes a private JSON document", async () => {
  await withTempDirectory(async (directory) => {
    const store = new AutoApprovalConfigStore(path.join(directory, "auto-approval.json"));
    await store.replace(defaultAutoApprovalConfig());
    const result = await store.read();
    assert.deepEqual(result, { ok: true, config: { version: 1, globalApprovalRules: [], projects: {} } });
    await assert.rejects(store.replace({ version: 1, projects: {}, extra: true }), /unknown property/);
  });
});

test("project identity uses the canonical Git root and non-Git cwd fallback", async () => {
  await withTempDirectory(async (directory) => {
    const child = path.join(directory, "a", "b");
    await mkdir(child, { recursive: true });
    const gitProject = await resolveProjectIdentity(child, async () => directory);
    assert.equal(gitProject.root, await resolveProjectIdentity(directory).then((value) => value.root));
    const nonGit = await resolveProjectIdentity(child, async () => undefined);
    assert.equal(nonGit.root, await resolveProjectIdentity(child).then((value) => value.root));
    const mixedCase = path.join(directory, "MixedCaseProject");
    await mkdir(mixedCase);
    const mixedIdentity = await resolveProjectIdentity(mixedCase);
    assert.equal(mixedIdentity.key, path.normalize(mixedIdentity.root));
    assert.equal(path.basename(mixedIdentity.key), "MixedCaseProject");
  });
});

test("project path checks resolve existing symlinks and missing descendants", async (t) => {
  await withTempDirectory(async (directory) => {
    const project = path.join(directory, "project");
    const outside = path.join(directory, "outside");
    await mkdir(project);
    await mkdir(outside);
    const link = path.join(project, "linked");
    try {
      await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      t.skip(`symlinks unavailable: ${error}`);
      return;
    }
    const root = (await resolveProjectIdentity(project)).root;
    assert.equal((await resolveProjectPath(root, project, "src/new.txt")).inside, true);
    assert.equal((await resolveProjectPath(root, project, "linked/new.txt")).inside, false);
    assert.equal((await resolveProjectPath(root, project, "../outside/file.txt")).inside, false);
    if (process.platform === "win32") {
      const otherDrive = root.toLowerCase().startsWith("c:") ? "D:/outside/file.txt" : "C:/outside/file.txt";
      assert.equal((await resolveProjectPath(root, project, otherDrive)).inside, false);
    }
  });
});

test("structured matchers enforce tool-specific operators", async () => {
  const call = { id: "1", name: "bash", input: { command: "git status --short" } };
  const matcher = {
    tool: "bash",
    input: { kind: "fields", fields: { command: { kind: "tokenPrefix", tokens: ["git", "status"] } } },
  };
  assert.equal(validateToolMatcher(matcher), undefined);
  assert.equal(await matchesToolCall(matcher, call, matcherContext), true);
  assert.match(
    validateToolMatcher({ tool: "custom", input: { kind: "fields", fields: { value: { kind: "exact", value: 1 } } } }),
    /custom tools require/,
  );
  assert.match(
    validateToolMatcher({ tool: "read", input: { kind: "fields", fields: { path: { kind: "pathGlob", pattern: "../*" } } } }),
    /must not traverse/,
  );
});

test("tool-wide matchers require the same non-builtin tool source", async () => {
  const matcher = {
    tool: "context7_query-docs",
    source: { source: "extension", path: "context7" },
    input: { kind: "any" },
  };
  const toolCall = { id: "1", name: "context7_query-docs", input: { query: "anything" } };
  assert.equal(validateToolMatcher(matcher), undefined);
  assert.equal(await matchesToolCall(matcher, toolCall, { ...matcherContext, source: matcher.source }), true);
  assert.equal(
    await matchesToolCall(matcher, toolCall, { ...matcherContext, source: { source: "extension", path: "replacement" } }),
    false,
  );
  assert.match(
    validateToolMatcher({ tool: "read", source: { source: "builtin", path: "read" }, input: { kind: "any" } }),
    /standard tools/,
  );
});

test("config accepts only source-bound tool-wide Global Approval Rules", () => {
  const config = parseAutoApprovalConfig({
    version: 1,
    globalApprovalRules: [{
      id: "context7",
      matcher: {
        tool: "context7_query-docs",
        source: { source: "extension", path: "context7" },
        input: { kind: "any" },
      },
    }],
    projects: {},
  });
  assert.equal(config.globalApprovalRules[0].matcher.input.kind, "any");
  assert.throws(() => parseAutoApprovalConfig({
    version: 1,
    globalApprovalRules: [{
      id: "too-broad",
      matcher: { tool: "read", source: { source: "builtin", path: "read" }, input: { kind: "any" } },
    }],
    projects: {},
  }), /standard tools/);
  assert.throws(() => parseAutoApprovalConfig({
    version: 1,
    globalApprovalRules: [{ id: "specific", matcher: { tool: "custom", input: { kind: "exact", value: {} } } }],
    projects: {},
  }), /must be tool-wide/);
});

test("exact fallback matcher copies JSON input and rejects non-JSON input", async () => {
  const call = { id: "1", name: "custom", input: { nested: [1, true, null] } };
  const matcher = exactMatcherFor(call);
  assert.ok(matcher);
  call.input.nested[0] = 2;
  assert.equal(await matchesToolCall(matcher, { ...call, input: { nested: [1, true, null] } }, matcherContext), true);
  assert.equal(exactMatcherFor({ id: "2", name: "custom", input: { invalid: undefined } }), undefined);
  const prototypeKey = JSON.parse('{"__proto__":{"approved":true}}');
  const prototypeMatcher = { tool: "custom", input: { kind: "exact", value: prototypeKey } };
  assert.equal(await matchesToolCall(prototypeMatcher, { id: "3", name: "custom", input: { junk: true } }, matcherContext), false);
});
