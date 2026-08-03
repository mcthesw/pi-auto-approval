import assert from "node:assert/strict";
import { test } from "node:test";
import { runWithAsyncLoader } from "../src/ui/async-loader.ts";

test("TUI async loader shows an animated review widget without replacing the editor", async () => {
  const widgets = [];
  let customCalled = false;
  const ctx = {
    mode: "tui",
    signal: new AbortController().signal,
    ui: {
      custom: async () => { customCalled = true; },
      setWidget: (key, content) => widgets.push({ key, content }),
    },
  };
  const result = await runWithAsyncLoader(ctx, "Reviewing todowrite…", async () => "done");
  assert.deepEqual(result, { status: "completed", value: "done" });
  assert.equal(customCalled, false);
  assert.equal(widgets[0].key, "auto-approval-review");
  assert.equal(typeof widgets[0].content, "function");
  const widget = widgets[0].content(
    { requestRender: () => {} },
    { fg: (_color, text) => text },
  );
  assert.match(widget.render(80)[0], /Reviewing todowrite/);
  widget.dispose();
  assert.deepEqual(widgets.at(-1), { key: "auto-approval-review", content: undefined });
});

test("async loader reports cancellation from Pi's active abort signal", async () => {
  const controller = new AbortController();
  const pending = runWithAsyncLoader(
    { mode: "tui", signal: controller.signal, ui: { setWidget: () => {} } },
    "Reviewing…",
    async (signal) => await new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
      setTimeout(resolve, 1_000);
    }),
  );
  controller.abort();
  assert.deepEqual(await pending, { status: "cancelled" });
});
