import { Key, matchesKey, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RuleScope } from "../matchers.ts";
import { singleLine } from "./text.ts";

type Theme = ExtensionContext["ui"]["theme"];

export type RuleListItem = { summary: string; scope: RuleScope };
export type RuleListResult =
  | { kind: "add" }
  | { kind: "edit" | "delete"; index: number }
  | { kind: "cancelled" };

const VISIBLE_ROWS = 10;

export class RuleListComponent implements Component {
  private cursor = 0;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly items: readonly RuleListItem[];
  private readonly done: (result: RuleListResult) => void;

  constructor(
    tui: TUI,
    theme: Theme,
    items: readonly RuleListItem[],
    done: (result: RuleListResult) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.items = items;
    this.done = done;
  }

  private move(delta: number): void {
    const count = this.items.length + 1;
    this.cursor = (this.cursor + delta + count) % count;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.done({ kind: "cancelled" });
      return;
    }
    if (matchesKey(data, Key.up)) this.move(-1);
    else if (matchesKey(data, Key.down)) this.move(1);
    else if (matchesKey(data, Key.enter)) {
      this.done(this.cursor === 0 ? { kind: "add" } : { kind: "edit", index: this.cursor - 1 });
      return;
    } else if (data.toLowerCase() === "d" && this.cursor > 0) {
      this.done({ kind: "delete", index: this.cursor - 1 });
      return;
    } else return;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const rows = [{ summary: "+ Add Rule", scope: "project" as const }, ...this.items];
    const start = Math.max(0, Math.min(this.cursor - Math.floor(VISIBLE_ROWS / 2), rows.length - VISIBLE_ROWS));
    const end = Math.min(rows.length, start + VISIBLE_ROWS);
    const lines = [this.theme.bold(truncateToWidth("Rules", safeWidth)), ""];
    for (let index = start; index < end; index += 1) {
      const row = rows[index]!;
      const active = index === this.cursor;
      const marker = active ? this.theme.fg("accent", "❯") : " ";
      const text = index > 0 && row.scope === "global"
        ? this.theme.fg("warning", singleLine(row.summary))
        : active ? this.theme.fg("accent", singleLine(row.summary)) : singleLine(row.summary);
      lines.push(truncateToWidth(`${marker} ${text}`, safeWidth));
    }
    if (rows.length > VISIBLE_ROWS) {
      lines.push(this.theme.fg("dim", truncateToWidth(`${start + 1}-${end} of ${rows.length}`, safeWidth)));
    }
    lines.push("", this.theme.fg("dim", truncateToWidth("↑/↓ move • Enter add/edit • D delete • Esc back", safeWidth)));
    return lines;
  }

  invalidate(): void {}
}
