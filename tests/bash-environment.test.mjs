import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { inspectBashEnvironment } from "../src/adapters/bash-environment.ts";
import { resolveProjectIdentity } from "../src/project.ts";

const ENV_KEYS = [
  "BASH_ENV", "ENV", "GIT_CONFIG_COUNT", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_SYSTEM", "GIT_DIR", "GIT_EXTERNAL_DIFF", "GIT_PAGER", "GIT_WORK_TREE",
  "GREP_OPTIONS", "LESSCLOSE", "LESSOPEN", "PAGER", "RIPGREP_CONFIG_PATH",
];

async function isolatedEnvironment(fn) {
  const saved = Object.fromEntries([...ENV_KEYS, "PATH"].map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withGuard(fn) {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "pi-auto-bash-project-"));
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-auto-bash-agent-"));
  try {
    await fn({ projectRoot, project: await resolveProjectIdentity(projectRoot), agentDir });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
}

test("Bash environment guard rejects startup hooks and project-local PATH entries", { concurrency: false }, async () => {
  await isolatedEnvironment(async () => withGuard(async ({ projectRoot, project, agentDir }) => {
    process.env.BASH_ENV = path.join(projectRoot, "hook.sh");
    const hook = await inspectBashEnvironment({}, projectRoot, agentDir, project);
    assert.equal(hook.trusted, false);
    assert.match(hook.reason, /BASH_ENV/);

    delete process.env.BASH_ENV;
    process.env.PATH = `${projectRoot}${path.delimiter}${process.env.PATH ?? ""}`;
    const localPath = await inspectBashEnvironment({}, projectRoot, agentDir, project);
    assert.equal(localPath.trusted, false);
    assert.match(localPath.reason, /project-local/);
  }));
});

test("Bash environment guard rejects custom shell configuration", { concurrency: false }, async () => {
  await isolatedEnvironment(async () => withGuard(async ({ projectRoot, project, agentDir }) => {
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ shellPath: "/custom/bash" }), "utf8");
    const guard = await inspectBashEnvironment({}, projectRoot, agentDir, project);
    assert.equal(guard.trusted, false);
    assert.match(guard.reason, /shellPath/);
  }));
});

test("Bash environment guard rejects project-local executable resolution", { concurrency: false }, async () => {
  await isolatedEnvironment(async () => withGuard(async ({ projectRoot, project, agentDir }) => {
    const pi = {
      exec: async () => ({ code: 0, stdout: `${path.join(projectRoot, "bin", "git")}\n`, stderr: "", killed: false }),
    };
    const guard = await inspectBashEnvironment(pi, projectRoot, agentDir, project);
    assert.equal(guard.trusted, true);
    assert.equal(await guard.isExecutableTrusted("git"), false);
  }));
});
