import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { classifyBash, parseConservativeBash, tokenizeSingleCommand } from "../src/policy/bash.ts";
import { evaluatePolicy } from "../src/policy/engine.ts";
import { resolveProjectIdentity, resolveProjectPath } from "../src/project.ts";

async function withProject(fn) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-auto-policy-"));
  const project = path.join(directory, "project");
  await mkdir(path.join(project, "src"), { recursive: true });
  try {
    const identity = await resolveProjectIdentity(project);
    await fn({ directory, project, identity });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function context(projectRoot, cwd, project = { policyRules: [], approvalRules: [] }, provenance = "builtin") {
  return {
    projectRoot,
    cwd,
    project,
    provenance,
    bash: { trusted: true, isExecutableTrusted: async () => true },
  };
}

function call(name, input) {
  return { id: "call-1", name, input };
}

test("conservative Bash parser preserves quoted words and compound structure", () => {
  assert.deepEqual(parseConservativeBash("git status && rg 'two words' src | head -n 5"), {
    commands: [["git", "status"], ["rg", "two words", "src"], ["head", "-n", "5"]],
    operators: ["&&", "|"],
  });
  assert.deepEqual(tokenizeSingleCommand("git status --short"), ["git", "status", "--short"]);
  assert.equal(tokenizeSingleCommand("git status && pwd"), undefined);
});

test("conservative Bash parser rejects syntax that can hide execution or writes", () => {
  for (const command of [
    "echo $HOME",
    "echo $(whoami)",
    "echo `whoami`",
    "echo hi > out",
    "cat < input",
    "FOO=bar git status",
    "git status &",
    "(git status)",
    "git status # comment",
    "git status;",
    "git 'unterminated",
  ]) {
    assert.equal(parseConservativeBash(command), undefined, command);
  }
  assert.deepEqual(parseConservativeBash("printf '%s' '$HOME'"), {
    commands: [["printf", "%s", "$HOME"]],
    operators: [],
  });
});

test("Bash classifier approves only project-local read-only commands", async () => {
  await withProject(async ({ directory, project, identity }) => {
    const resolve = (value) => resolveProjectPath(identity.root, project, value);
    for (const command of [
      "pwd",
      "rg TODO src | head -n 5",
      "grep -R TODO src",
      "find src -maxdepth 2 -type f -print",
      "cat src/file.ts",
    ]) {
      assert.equal((await classifyBash(command, resolve, async () => true)).safe, true, command);
    }
    for (const command of [
      `cat ${path.join(directory, "secret.txt").replaceAll("\\", "/")}`,
      "cat ~/secret",
      "find . -delete",
      "find . -exec sh -c pwd ;",
      "rg --pre cat TODO src",
      "rg --hostname-bin hostname TODO src",
      "grep -f ../patterns src/file",
      "grep -f../patterns src/file",
      "grep --exclude-from=../patterns TODO src/file",
      "rg --ignore-file=../ignore TODO src",
      "find * -type f",
      "find . -newer ../reference",
      "cat src/*",
      "wc --files0-from=../list",
      "file -Cm demo.magic",
      "git status --short",
      "git show HEAD",
      "git branch pwned",
      "git diff --output=patch.txt",
      "git status > status.txt",
      "date -s tomorrow",
      "hostname changed",
      "bash -c 'git status'",
      "sed -n 1p src/file",
    ]) {
      assert.equal((await classifyBash(command, resolve, async () => true)).safe, false, command);
    }
  });
});

test("project Approval Rules are authoritative before Policy Rules and defaults", async () => {
  await withProject(async ({ project, identity }) => {
    const matcher = { tool: "custom", input: { kind: "exact", value: { action: "run" } } };
    const projectConfig = {
      approvalRules: [{ id: "allow-custom", matcher }],
      policyRules: [{ id: "deny-custom", matcher, route: "deny" }],
    };
    const decision = await evaluatePolicy(call("custom", { action: "run" }), context(identity.root, project, projectConfig, "extension"));
    assert.deepEqual(decision, {
      route: "approve",
      source: "approval_rule",
      reason: "matched an authoritative project Approval Rule",
      ruleId: "allow-custom",
    });
  });
});

test("ordered Policy Rules run before built-in policy", async () => {
  await withProject(async ({ project, identity }) => {
    const projectConfig = {
      approvalRules: [],
      policyRules: [
        {
          id: "review-readme",
          matcher: { tool: "read", input: { kind: "fields", fields: { path: { kind: "pathGlob", pattern: "README.md" } } } },
          route: "ask_user",
        },
      ],
    };
    const decision = await evaluatePolicy(call("read", { path: "README.md" }), context(identity.root, project, projectConfig));
    assert.equal(decision.route, "ask_user");
    assert.equal(decision.ruleId, "review-readme");
  });
});

test("built-in policy approves project reads and regular writes but reviews boundaries", async () => {
  await withProject(async ({ directory, project, identity }) => {
    const cases = [
      [call("read", { path: "README.md" }), "builtin", "approve"],
      [call("read", {}), "builtin", "auto_review"],
      [call("grep", { pattern: "x" }), "builtin", "approve"],
      [call("write", { path: "src/new.ts", content: "" }), "builtin", "approve"],
      [call("write", { content: "" }), "builtin", "auto_review"],
      [call("edit", { path: ".git/config" }), "builtin", "auto_review"],
      [call("write", { path: ".pi/extensions/a.ts", content: "" }), "builtin", "auto_review"],
      [call("write", { path: "nested/AGENTS.md", content: "" }), "builtin", "auto_review"],
      [call("read", { path: path.join(directory, "outside") }), "builtin", "auto_review"],
      [call("read", { path: "README.md" }), "extension", "auto_review"],
      [call("custom", { value: 1 }), "extension", "auto_review"],
    ];
    for (const [toolCall, provenance, expected] of cases) {
      const decision = await evaluatePolicy(toolCall, context(identity.root, project, undefined, provenance));
      assert.equal(decision.route, expected, `${toolCall.name}:${JSON.stringify(toolCall.input)}:${provenance}`);
    }
  });
});

test("built-in Bash policy requires a trusted execution environment and conservative classifier", async () => {
  await withProject(async ({ project, identity }) => {
    assert.equal((await evaluatePolicy(call("bash", { command: "rg TODO src" }), context(identity.root, project))).route, "approve");
    assert.equal((await evaluatePolicy(call("bash", { command: "git status" }), context(identity.root, project))).route, "auto_review");
    const untrusted = context(identity.root, project);
    untrusted.bash = { trusted: false, reason: "BASH_ENV is set", isExecutableTrusted: async () => false };
    assert.equal((await evaluatePolicy(call("bash", { command: "rg TODO src" }), untrusted)).route, "auto_review");
  });
});
