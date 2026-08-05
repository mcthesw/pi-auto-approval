import { Input, Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { singleLine } from "../ui/text.ts";

export type ConfirmationResult =
  | { kind: "allow_once" }
  | { kind: "allow_with_rule" }
  | { kind: "deny"; feedback?: string }
  | { kind: "view_call" }
  | { kind: "cancelled" };

type Theme = ExtensionContext["ui"]["theme"];

type ConfirmationComponentOptions = {
  title: string;
  reason: string;
  callSummary: string;
};

function boundedText(text: string, width: number, maxLines: number): string[] {
  const normalized = singleLine(text);
  const wrapped = wrapTextWithAnsi(normalized, width);
  const lines = wrapped.slice(0, maxLines);
  if (wrapped.length > maxLines && lines.length) {
    lines[lines.length - 1] = truncateToWidth(`${lines[lines.length - 1]}…`, width);
  }
  return lines.map((line) => truncateToWidth(line, width));
}

export class ApprovalConfirmationComponent implements Component, Focusable {
  private selected = 0;
  private readonly feedbackInput = new Input();
  private _focused = false;
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
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.syncFocus();
  }

  private syncFocus(): void {
    this.feedbackInput.focused = this._focused && this.selected === 2;
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
    if ((this.selected !== 2 && data.toLowerCase() === "v") || data === "V") {
      this.done({ kind: "view_call" });
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
      else if (this.selected === 1) this.done({ kind: "allow_with_rule" });
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
    const lines = [
      this.theme.bold(truncateToWidth(singleLine(this.options.title), safeWidth)),
      this.theme.fg("muted", truncateToWidth("Reason", safeWidth)),
      ...boundedText(this.options.reason, safeWidth, 2).map((value) => this.theme.fg("muted", value)),
      this.theme.fg("muted", truncateToWidth("Tool Call", safeWidth)),
      ...boundedText(this.options.callSummary, safeWidth, 2).map((value) => this.theme.fg("muted", value)),
      "",
      line(0, "Allow once"),
      line(1, "Allow with Rule"),
      line(2, "Deny"),
    ];
    if (this.selected === 2) {
      const nestedWidth = Math.max(1, safeWidth - 4);
      lines.push(this.theme.fg("dim", truncateToWidth("    Optional feedback for the Main Agent", safeWidth)));
      lines.push(...this.feedbackInput.render(nestedWidth).map((value) => truncateToWidth(`    ${value}`, safeWidth)));
    }
    lines.push(
      "",
      this.theme.fg("dim", truncateToWidth("↑/↓ choose • Enter confirm", safeWidth)),
      this.theme.fg("dim", truncateToWidth("V full call • Esc cancel", safeWidth)),
    );
    return lines;
  }

  invalidate(): void {
    this.feedbackInput.invalidate();
  }
}
