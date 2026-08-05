import { Key, matchesKey, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RuleScope } from "../matchers.ts";
import { singleLine } from "./text.ts";

type Theme = ExtensionContext["ui"]["theme"];

export type RuleReviewItem = {
  summary: string;
  selected: boolean;
  scope: RuleScope;
  suffix?: string;
  warning?: boolean;
};

export type RuleReviewResult =
  | { kind: "edit"; index: number; selected: boolean[] }
  | { kind: "save"; selected: boolean[] }
  | { kind: "cancelled"; selected: boolean[] };

type RuleReviewOptions = {
  title: string;
  subtitle: string;
  visibleRows?: number;
};

export class RuleReviewComponent implements Component {
  private cursor = 0;
  private readonly selected: boolean[];
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly items: readonly RuleReviewItem[];
  private readonly done: (result: RuleReviewResult) => void;
  private readonly options: RuleReviewOptions;

  constructor(
    tui: TUI,
    theme: Theme,
    items: readonly RuleReviewItem[],
    done: (result: RuleReviewResult) => void,
    options: RuleReviewOptions,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.items = items;
    this.done = done;
    this.options = options;
    this.selected = items.map((item) => item.selected);
  }

  private move(delta: number): void {
    this.cursor = (this.cursor + delta + this.items.length) % this.items.length;
  }

  private finish(kind: "save" | "cancelled"): void {
    this.done({ kind, selected: [...this.selected] });
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.finish("cancelled");
      return;
    }
    if (matchesKey(data, Key.up)) this.move(-1);
    else if (matchesKey(data, Key.down)) this.move(1);
    else if (matchesKey(data, Key.space)) this.selected[this.cursor] = !this.selected[this.cursor];
    else if (matchesKey(data, Key.enter) || data.toLowerCase() === "s") {
      this.finish("save");
      return;
    } else if (data.toLowerCase() === "e") {
      this.done({ kind: "edit", index: this.cursor, selected: [...this.selected] });
      return;
    } else return;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const visibleRows = this.options.visibleRows ?? 8;
    const start = Math.max(0, Math.min(this.cursor - Math.floor(visibleRows / 2), this.items.length - visibleRows));
    const end = Math.min(this.items.length, start + visibleRows);
    const lines = [
      this.theme.bold(truncateToWidth(singleLine(this.options.title), safeWidth)),
      this.theme.fg("muted", truncateToWidth(singleLine(this.options.subtitle), safeWidth)),
      "",
    ];
    for (let index = start; index < end; index += 1) {
      const item = this.items[index]!;
      const cursor = index === this.cursor ? this.theme.fg("accent", "❯") : " ";
      const checked = this.selected[index] ? this.theme.fg("success", "[x]") : "[ ]";
      const scope = item.scope === "global"
        ? this.theme.fg("warning", "GLOBAL")
        : this.theme.fg("dim", "Project");
      const warning = item.warning ? this.theme.fg("warning", " · warning") : "";
      const suffix = item.suffix ? this.theme.fg("dim", ` · ${singleLine(item.suffix)}`) : "";
      lines.push(truncateToWidth(`${cursor} ${checked} ${singleLine(item.summary)} · ${scope}${suffix}${warning}`, safeWidth));
    }
    if (this.items.length > visibleRows) {
      lines.push(this.theme.fg("dim", truncateToWidth(`${start + 1}-${end} of ${this.items.length}`, safeWidth)));
    }
    lines.push("", this.theme.fg("dim", truncateToWidth(
      "↑/↓ move • Space select • E view/edit • Enter save • Esc back",
      safeWidth,
    )));
    return lines;
  }

  invalidate(): void {}
}
