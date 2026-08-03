import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";

type Theme = ExtensionContext["ui"]["theme"];

export type AsyncLoaderResult<T> =
  | { status: "completed"; value: T }
  | { status: "cancelled" }
  | { status: "failed"; error: unknown };

class ReviewStatusWidget implements Component {
  private frame = 0;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly message: string;

  constructor(tui: TUI, theme: Theme, message: string) {
    this.tui = tui;
    this.theme = theme;
    this.message = message;
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % 8;
      this.tui.requestRender();
    }, 100);
  }

  render(width: number): string[] {
    const spinner = "⠋⠙⠹⠸⠼⠴⠦⠧"[this.frame]!;
    return [truncateToWidth(`${this.theme.fg("accent", spinner)} ${this.theme.fg("muted", this.message)}`, width)];
  }

  invalidate(): void {}

  dispose(): void {
    clearInterval(this.timer);
  }
}

export async function runWithAsyncLoader<T>(
  ctx: ExtensionContext,
  message: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<AsyncLoaderResult<T>> {
  const signal = ctx.signal ?? new AbortController().signal;
  if (ctx.mode === "tui") {
    ctx.ui.setWidget("auto-approval-review", (tui, theme) => new ReviewStatusWidget(tui, theme, message));
  }
  try {
    return { status: "completed", value: await operation(signal) };
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      return { status: "cancelled" };
    }
    return { status: "failed", error };
  } finally {
    if (ctx.mode === "tui") ctx.ui.setWidget("auto-approval-review", undefined);
  }
}
