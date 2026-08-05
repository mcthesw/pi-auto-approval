import assert from "node:assert/strict";
import { test } from "node:test";
import { ReviewContextError } from "../src/review/context.ts";
import { MAX_REVIEW_BATCH_CALLS, TurnReviewBatchCoordinator } from "../src/review/turn-batch.ts";

const config = { version: 2, globalRules: [], projects: { "/project": { rules: [] } } };
const project = { root: "/project", key: "/project" };
const call = (id, name = "custom") => ({ call: { id, name, input: { value: id } } });

function input(current, siblings, run, activeConfig = config) {
  return {
    current,
    siblings,
    config: activeConfig,
    project,
    cwd: "/project",
    messages: [{ role: "user", content: "do the requested task" }],
    run,
  };
}

function allowAll(calls) {
  return {
    decisions: new Map(calls.map((item) => [item.toolCall.id, {
      decision: "allow",
      reason: `reviewed ${item.toolCall.id}`,
    }])),
  };
}

test("TurnReviewBatchCoordinator reviews Review-Eligible siblings once in source order", async () => {
  const coordinator = new TurnReviewBatchCoordinator();
  const calls = [call("one"), call("read", "read"), call("two")];
  const allowRead = {
    ...config,
    globalRules: [{ id: "allow-read", action: "allow", matcher: { tool: "read", input: { kind: "any" } } }],
  };
  const batches = [];
  const run = async (batch) => {
    batches.push(batch.calls.map((item) => item.toolCall.id));
    return allowAll(batch.calls);
  };
  const one = await coordinator.review(input(calls[0], calls, run, allowRead));
  const two = await coordinator.review(input(calls[2], calls, run, allowRead));
  assert.equal(one.reason, "reviewed one");
  assert.equal(two.reason, "reviewed two");
  assert.deepEqual(batches, [["one", "two"]]);
});

test("TurnReviewBatchCoordinator splits source-ordered batches at the call limit", async () => {
  const coordinator = new TurnReviewBatchCoordinator();
  const calls = Array.from({ length: MAX_REVIEW_BATCH_CALLS + 1 }, (_, index) => call(`call-${index}`));
  const batches = [];
  const run = async (batch) => {
    batches.push(batch.calls.map((item) => item.toolCall.id));
    return allowAll(batch.calls);
  };
  await coordinator.review(input(calls[0], calls, run));
  await coordinator.review(input(calls.at(-1), calls, run));
  assert.equal(batches.length, 2);
  assert.deepEqual(batches[0], calls.slice(0, MAX_REVIEW_BATCH_CALLS).map((item) => item.call.id));
  assert.deepEqual(batches[1], [calls.at(-1).call.id]);
});

test("TurnReviewBatchCoordinator splits batches at the UTF-8 byte limit", async () => {
  const coordinator = new TurnReviewBatchCoordinator();
  const calls = Array.from({ length: 5 }, (_, index) => ({
    call: { id: `unicode-${index}`, name: "custom", input: { content: "中".repeat(20_000) } },
  }));
  const batches = [];
  const run = async (batch) => {
    batches.push(batch.calls.map((item) => item.toolCall.id));
    return allowAll(batch.calls);
  };
  await coordinator.review(input(calls[0], calls, run));
  await coordinator.review(input(calls.at(-1), calls, run));
  assert.deepEqual(batches, [
    calls.slice(0, 4).map((item) => item.call.id),
    [calls.at(-1).call.id],
  ]);
});

test("TurnReviewBatchCoordinator rejects an oversized current call without blocking reviewable siblings", async () => {
  const coordinator = new TurnReviewBatchCoordinator();
  const oversized = { call: { id: "large", name: "custom", input: { content: "x".repeat(70_000) } } };
  const normal = call("normal");
  const run = async (batch) => allowAll(batch.calls);
  await assert.rejects(coordinator.review(input(oversized, [oversized, normal], run)), ReviewContextError);
  assert.equal((await coordinator.review(input(normal, [oversized, normal], run))).decision, "allow");
});

test("TurnReviewBatchCoordinator forgets settled turn results", async () => {
  const coordinator = new TurnReviewBatchCoordinator();
  const current = call("one");
  let runs = 0;
  const run = async (batch) => {
    runs += 1;
    return allowAll(batch.calls);
  };
  await coordinator.review(input(current, [current], run));
  await coordinator.review(input(current, [current], run));
  coordinator.clear(["one"]);
  await coordinator.review(input(current, [current], run));
  assert.equal(runs, 2);
});
