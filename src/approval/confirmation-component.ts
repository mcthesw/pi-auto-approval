import { Input, Key, matchesKey, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ConfirmationResult =
  | { kind: "allow_once" }
  | { kind: "always" }
  | { kind: "deny"; feedback?: string }
  | { kind: "cancelled" };

type Theme = ExtensionContext["ui"]["theme"];

type ConfirmationComponentOptions = {
  title: string;
  detail: string;
  matcherSummaries: readonly string[];
};

const MAX_MATCHER_PREVIEW_LINES = 3;

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

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
      if (this.selected === 0) this.done({ kind: "allow_once" });
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
    const safeWidth = Math.max(1, width);
    const line = (index: number, label: string) => {
      const marker = this.selected === index ? this.theme.fg("accent", "❯") : " ";
      const text = this.selected === index ? this.theme.fg("accent", label) : label;
      return truncateToWidth(`${marker} ${text}`, safeWidth);
    };
    const matcherLines = this.options.matcherSummaries
      .slice(0, MAX_MATCHER_PREVIEW_LINES)
      .map((summary) => this.theme.fg("muted", truncateToWidth(`    ${singleLine(summary)}`, safeWidth)));
    if (this.options.matcherSummaries.length > MAX_MATCHER_PREVIEW_LINES) {
      matcherLines.push(this.theme.fg("muted", truncateToWidth(
        `    … ${this.options.matcherSummaries.length - MAX_MATCHER_PREVIEW_LINES} more Rules`,
        safeWidth,
      )));
    }
    const nestedWidth = Math.max(1, safeWidth - 4);
    const feedbackLines = this.feedbackInput.render(nestedWidth)
      .map((value) => truncateToWidth(`    ${value}`, safeWidth));
    const lines = [
      this.theme.bold(truncateToWidth(singleLine(this.options.title), safeWidth)),
      this.theme.fg("muted", truncateToWidth(singleLine(this.options.detail), safeWidth)),
      "",
      line(0, "Allow once"),
      line(1, "Always allow with Rule"),
      ...matcherLines,
      line(2, "Deny (optional feedback):"),
      ...feedbackLines,
    ];
    lines.push("", this.theme.fg("dim", truncateToWidth("↑/↓ choose • Enter confirm • Esc cancel", safeWidth)));
    return lines;
  }

  invalidate(): void {
    this.feedbackInput.invalidate();
  }
}
