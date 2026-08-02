import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CancellableLoader } from "@earendil-works/pi-tui";

export type AsyncLoaderResult<T> =
  | { status: "completed"; value: T }
  | { status: "cancelled" }
  | { status: "failed"; error: unknown };

export async function runWithAsyncLoader<T>(
  ctx: ExtensionContext,
  message: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<AsyncLoaderResult<T>> {
  if (ctx.mode !== "tui") {
    try {
      return { status: "completed", value: await operation(ctx.signal ?? new AbortController().signal) };
    } catch (error) {
      if (ctx.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        return { status: "cancelled" };
      }
      return { status: "failed", error };
    }
  }

  const result = await ctx.ui.custom<AsyncLoaderResult<T>>(
    (tui, theme, _keybindings, done) => {
      const loader = new CancellableLoader(
        tui,
        (text) => theme.fg("accent", text),
        (text) => theme.fg("muted", text),
        `${message} (Esc to cancel)`,
      );
      let settled = false;
      const finish = (value: AsyncLoaderResult<T>) => {
        if (settled) return;
        settled = true;
        done(value);
      };
      loader.onAbort = () => finish({ status: "cancelled" });
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, loader.signal]) : loader.signal;
      operation(signal).then(
        (value) => finish({ status: "completed", value }),
        (error) => finish(
          signal.aborted || (error instanceof Error && error.name === "AbortError")
            ? { status: "cancelled" }
            : { status: "failed", error },
        ),
      );
      return loader;
    },
  );
  return result ?? { status: "cancelled" };
}
