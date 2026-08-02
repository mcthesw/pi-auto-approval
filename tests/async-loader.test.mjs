import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { runWithAsyncLoader } from "../src/ui/async-loader.ts";

initTheme("dark", false);

const theme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

test("TUI async loader renders a compact cancellable status line", async () => {
  let customOptions;
  let rendered = [];
  const ctx = {
    mode: "tui",
    ui: {
      custom: async (factory, options) => {
        customOptions = options;
        return await new Promise((resolve) => {
          let component;
          const done = (value) => {
            component.dispose();
            resolve(value);
          };
          component = factory({ requestRender: () => {} }, theme, {}, done);
          rendered = component.render(80);
          setImmediate(() => {
            component.abortController.abort();
            component.onAbort?.();
          });
        });
      },
    },
  };
  const result = await runWithAsyncLoader(ctx, "Reviewing todowrite…", async (signal) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 1_000);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("cancelled", "AbortError"));
      }, { once: true });
    });
    return "unexpected";
  });
  assert.equal(result.status, "cancelled");
  assert.equal(customOptions, undefined);
  assert.equal(rendered.length, 2);
  assert.match(rendered.join("\n"), /Reviewing todowrite.*Esc to cancel/);
});
