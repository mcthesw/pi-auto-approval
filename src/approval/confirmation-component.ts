import { Input, Key, matchesKey, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ConfirmationResult =
  | { kind: "approve_once" }
  | { kind: "always" }
  | { kind: "deny"; feedback?: string }
  | { kind: "cancelled" };

type Theme = ExtensionContext["ui"]["theme"];

type ConfirmationComponentOptions = {
  title: string;
  detail: string;
  matcherSummary: string;
};

export class ApprovalConfirmationComponent implements Component {
  private selected = 0;
  private readonly feedbackInput = new Input();
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly done: (result: ConfirmationResult) => void;
  private readonly options: ConfirmationComponentOptions;

  constructor(
    tui: TUI,
    theme: Theme,
    done: (result: ConfirmationResult) => void,
    options: ConfirmationComponentOptions,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.options = options;
    this.syncFocus();
  }

  private syncFocus(): void {
    this.feedbackInput.focused = this.selected === 2;
  }

  private move(delta: number): void {
    this.selected = (this.selected + delta + 3) % 3;
    this.syncFocus();
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.done({ kind: "cancelled" });
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.move(-1);
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, Key.tab)) {
      this.move(1);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (this.selected === 0) this.done({ kind: "approve_once" });
      else if (this.selected === 1) this.done({ kind: "always" });
      else {
        const feedback = this.feedbackInput.getValue().trim();
        this.done({ kind: "deny", ...(feedback ? { feedback } : {}) });
      }
      return;
    }

    if (this.selected === 2) this.feedbackInput.handleInput(data);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const line = (index: number, label: string) => {
      const marker = this.selected === index ? this.theme.fg("accent", "❯") : " ";
      const text = this.selected === index ? this.theme.fg("accent", label) : label;
      return truncateToWidth(`${marker} ${text}`, width);
    };
    const nestedWidth = Math.max(8, width - 4);
    const lines = [
      this.theme.bold(truncateToWidth(this.options.title, width)),
      this.theme.fg("muted", truncateToWidth(this.options.detail, width)),
      "",
      line(0, "Approve once"),
      line(1, "Always approve with rule"),
      this.theme.fg("muted", truncateToWidth(`    ${this.options.matcherSummary}`, width)),
      line(2, "Deny (optional feedback):"),
      ...this.feedbackInput.render(nestedWidth).map((value) => `    ${value}`),
    ];
    lines.push("", this.theme.fg("dim", truncateToWidth("↑/↓ choose • Enter confirm • Esc cancel", width)));
    return lines;
  }

  invalidate(): void {
    this.feedbackInput.invalidate();
  }
}
