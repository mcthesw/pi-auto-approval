import { Key, matchesKey, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RuleScope } from "./rule-editor.ts";

type Theme = ExtensionContext["ui"]["theme"];

export type RuleAction = "Change match type" | "Edit constraints" | "Scope" | "Advanced JSON" | "Save rule" | "Cancel";
export type RuleActionResult = { action: RuleAction; scope: RuleScope };

type RuleActionComponentOptions = {
  detail: string;
  allowScope: boolean;
  scope: RuleScope;
};

export class RuleActionComponent implements Component {
  private selected = 0;
  private scope: RuleScope;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly done: (result: RuleActionResult) => void;
  private readonly options: RuleActionComponentOptions;

  constructor(
    tui: TUI,
    theme: Theme,
    done: (result: RuleActionResult) => void,
    options: RuleActionComponentOptions,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.options = options;
    this.scope = options.scope;
  }

  private get items(): Array<{ label: string; action?: RuleAction }> {
    return [
      { label: "Change match type", action: "Change match type" },
      { label: "Edit constraints", action: "Edit constraints" },
      ...(this.options.allowScope ? [{ label: "Scope" }] : []),
      { label: "Advanced JSON", action: "Advanced JSON" },
      { label: "Save rule", action: "Save rule" },
      { label: "Cancel", action: "Cancel" },
    ];
  }

  private scopeIndex(): number | undefined {
    return this.options.allowScope ? 2 : undefined;
  }

  private move(delta: number): void {
    const items = this.items;
    this.selected = (this.selected + delta + items.length) % items.length;
  }

  private toggleScope(): void {
    this.scope = this.scope === "project" ? "global" : "project";
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.done({ action: "Cancel", scope: this.scope });
      return;
    }
    if (matchesKey(data, Key.up)) this.move(-1);
    else if (matchesKey(data, Key.down)) this.move(1);
    else if ((matchesKey(data, Key.left) || matchesKey(data, Key.right)) && this.selected === this.scopeIndex()) {
      this.toggleScope();
    } else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
      if (this.selected === this.scopeIndex()) this.toggleScope();
      else {
        const action = this.items[this.selected]?.action;
        if (action) this.done({ action, scope: this.scope });
        return;
      }
    } else return;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const lines = [
      ...this.options.detail.split("\n").map((line) => truncateToWidth(line, width)),
      "",
    ];
    this.items.forEach((item, index) => {
      const selected = index === this.selected;
      const marker = selected ? this.theme.fg("accent", "❯") : " ";
      const label = selected ? this.theme.fg("accent", item.label) : item.label;
      const value = item.label === "Scope"
        ? this.theme.fg(this.scope === "global" ? "warning" : "muted", this.scope === "global" ? "Global" : "Current project")
        : "";
      lines.push(truncateToWidth(`${marker} ${label}${value ? `  ${value}` : ""}`, width));
    });
    lines.push(
      "",
      this.theme.fg("dim", truncateToWidth(
        this.options.allowScope
          ? "↑/↓ choose • ←/→ change scope • Enter confirm • Esc cancel"
          : "↑/↓ choose • Enter confirm • Esc cancel",
        width,
      )),
    );
    return lines;
  }

  invalidate(): void {}
}
