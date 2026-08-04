import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createFrictionRecord } from "../src/friction/summary.ts";
import { FrictionHistoryStore } from "../src/friction/store.ts";

async function withStore(fn) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-auto-friction-"));
  try {
    const project = path.join(directory, "project");
    const now = new Date("2026-08-08T00:00:00.000Z");
    const store = new FrictionHistoryStore(path.join(directory, "history.json"), () => now);
    await fn({ directory, project, now, store });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function friction(index, now) {
  return createFrictionRecord({
    call: {
      id: `call-${index}`,
      name: "custom",
      input: { text: "x".repeat(300), items: Array.from({ length: 12 }, (_, value) => value) },
    },
    reviewDecision: "approve",
    now,
  });
}

test("Friction Records summarize long JSON values before persistence", () => {
  const record = friction(1, new Date("2026-08-08T00:00:00.000Z"));
  assert.ok(record);
  assert.equal(record.input.text.$truncated.reason, "string");
  assert.equal(record.input.text.$truncated.length, 300);
  assert.equal(record.input.items.length, 11);
  assert.equal(record.input.items.at(-1).$truncated.reason, "array");
  assert.ok(Buffer.byteLength(JSON.stringify(record), "utf8") <= 4 * 1024);

  const tooWide = createFrictionRecord({
    call: { id: "wide", name: "custom", input: Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`field-${index}`, index])) },
    reviewDecision: "approve",
  });
  assert.equal(tooWide, undefined);
});

test("Friction History keeps only the latest seven days and fifty project records", async () => {
  await withStore(async ({ project, now, store }) => {
    const expired = friction(-1, new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000));
    const staleProject = path.join(path.dirname(project), "stale-project");
    const records = [expired];
    for (let index = 0; index < 51; index += 1) {
      records.push(friction(index, new Date(now.getTime() - (51 - index) * 1000)));
    }
    await writeFile(store.filePath, JSON.stringify({ version: 1, projects: { [project]: records, [staleProject]: [expired] } }), "utf8");
    await store.append(project, friction(52, now));
    const result = await store.readProject(project);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.records.length, 50);
      assert.equal(result.records.at(-1).timestamp, now.toISOString());
      assert.ok(result.records.every((record) => Date.parse(record.timestamp) >= now.getTime() - 7 * 24 * 60 * 60 * 1000));
    }
    const persisted = JSON.parse(await readFile(store.filePath, "utf8"));
    assert.equal(persisted.projects[staleProject], undefined);
  });
});

test("Friction History serializes concurrent appends", async () => {
  await withStore(async ({ project, now, store }) => {
    await Promise.all(Array.from({ length: 12 }, (_, index) => store.append(project, friction(index, now))));
    const result = await store.readProject(project);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.records.length, 12);
  });
});

test("invalid Friction History is reported without replacement", async () => {
  await withStore(async ({ project, store }) => {
    await writeFile(store.filePath, "{broken", "utf8");
    const result = await store.readProject(project);
    assert.equal(result.ok, false);
    await assert.rejects(store.append(project, friction(1, new Date())), /Invalid JSON/);
  });
});
