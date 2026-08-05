import { Key, matchesKey, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Theme = ExtensionContext["ui"]["theme"];

export type AdvisorListItem = {
  summary: string;
  stats: { calls: number; userConfirmations: number; automatedReviews: number };
  selected: boolean;
  scope: "project" | "global";
  replaces: number;
  warning?: boolean;
};

export type AdvisorListResult =
  | { kind: "detail"; index: number; selected: boolean[] }
  | { kind: "continue"; selected: boolean[] }
  | { kind: "cancelled"; selected: boolean[] };

export class AdvisorCandidateListComponent implements Component {
  private cursor = 0;
  private readonly selected: boolean[];
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly items: AdvisorListItem[];
  private readonly done: (result: AdvisorListResult) => void;

  constructor(tui: TUI, theme: Theme, items: AdvisorListItem[], done: (result: AdvisorListResult) => void) {
    this.tui = tui;
    this.theme = theme;
    this.items = items;
    this.selected = items.map((item) => item.selected);
    this.done = done;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.done({ kind: "cancelled", selected: this.selected });
      return;
    }
    if (matchesKey(data, Key.up)) this.cursor = (this.cursor - 1 + this.items.length) % this.items.length;
    else if (matchesKey(data, Key.down)) this.cursor = (this.cursor + 1) % this.items.length;
    else if (matchesKey(data, Key.space)) this.selected[this.cursor] = !this.selected[this.cursor];
    else if (matchesKey(data, Key.enter)) {
      this.done({ kind: "detail", index: this.cursor, selected: this.selected });
      return;
    } else if (data.toLowerCase() === "s") {
      this.done({ kind: "continue", selected: this.selected });
      return;
    } else return;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const lines = [
      this.theme.bold(truncateToWidth("Rule Suggestions", width)),
      this.theme.fg("muted", truncateToWidth("Nothing is selected by default. Review each Rule before saving.", width)),
      "",
    ];
    this.items.forEach((item, index) => {
      const cursor = index === this.cursor ? this.theme.fg("accent", "❯") : " ";
      const checked = this.selected[index] ? this.theme.fg("success", "[x]") : "[ ]";
      const warning = item.warning ? this.theme.fg("warning", " · counterevidence") : "";
      const optimization = item.replaces ? this.theme.fg("accent", ` · replaces ${item.replaces}`) : "";
      const scope = item.scope === "global" ? this.theme.fg("warning", " · GLOBAL") : this.theme.fg("dim", " · project");
      lines.push(truncateToWidth(`${cursor} ${checked} ${item.summary}${scope}${optimization}${warning}`, width));
      lines.push(this.theme.fg("dim", truncateToWidth(
        `      Calls ${item.stats.calls} · User confirmations ${item.stats.userConfirmations} · AI reviews ${item.stats.automatedReviews}`,
        width,
      )));
    });
    lines.push(
      "",
      this.theme.fg("dim", truncateToWidth("counterevidence = cited ask/deny/cancel outcomes", width)),
      this.theme.fg("dim", truncateToWidth("↑/↓ move • Space select • Enter details/edit • S review selected • Esc cancel", width)),
    );
    return lines;
  }

  invalidate(): void {}
}
