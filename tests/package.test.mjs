import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("Git installs form an isolated pnpm workspace", async () => {
  const workspace = await readFile(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");
  assert.match(workspace, /^#.*\npackages: \[\]\n/m);
  assert.match(workspace, /'@google\/genai': false/);
  assert.match(workspace, /protobufjs: false/);
});
