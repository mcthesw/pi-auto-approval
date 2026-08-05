import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Theme = ExtensionContext["ui"]["theme"];

export class ReadOnlyViewer implements Component {
  private offset = 0;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly done: () => void;
  private readonly title: string;
  private readonly content: string;
  private readonly visibleRows: number;

  constructor(
    tui: TUI,
    theme: Theme,
    done: () => void,
    title: string,
    content: string,
    visibleRows = 14,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.title = title;
    this.content = content;
    this.visibleRows = visibleRows;
  }

  private contentLines(width: number): string[] {
    return this.content.split("\n").flatMap((line) => wrapTextWithAnsi(line || " ", width));
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
      this.done();
      return;
    }
    if (matchesKey(data, Key.up)) this.offset = Math.max(0, this.offset - 1);
    else if (matchesKey(data, Key.down)) this.offset += 1;
    else if (matchesKey(data, Key.home)) this.offset = 0;
    else if (matchesKey(data, Key.end)) this.offset = Number.MAX_SAFE_INTEGER;
    else return;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const content = this.contentLines(safeWidth);
    const maxOffset = Math.max(0, content.length - this.visibleRows);
    this.offset = Math.min(this.offset, maxOffset);
    const end = Math.min(content.length, this.offset + this.visibleRows);
    return [
      this.theme.bold(truncateToWidth(this.title, safeWidth)),
      "",
      ...content.slice(this.offset, end).map((line) => truncateToWidth(line, safeWidth)),
      ...(content.length > this.visibleRows
        ? [this.theme.fg("dim", truncateToWidth(`${this.offset + 1}-${end} of ${content.length}`, safeWidth))]
        : []),
      "",
      this.theme.fg("dim", truncateToWidth("↑/↓ scroll • Home/End jump • Enter/Esc back", safeWidth)),
    ];
  }

  invalidate(): void {}
}
