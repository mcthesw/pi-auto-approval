import { Key, matchesKey, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RuleAction } from "../domain.ts";
import type { RuleScope } from "../matchers.ts";
import { singleLine } from "./text.ts";

export type RuleMatchKind = "any" | "exact" | "fields";

type Theme = ExtensionContext["ui"]["theme"];

type EditorState = {
  action: RuleAction;
  scope: RuleScope;
  matchKind: RuleMatchKind;
};

export type RuleEditorResult =
  | ({ kind: "choose_action" | "choose_scope" | "choose_match" | "edit_matcher" | "advanced" | "save" } & EditorState)
  | { kind: "cancelled" };

type RuleEditorOptions = EditorState & {
  tool: string;
  matcherSummary: string;
  actionFixed?: boolean;
  contextLines?: readonly string[];
};

type EditorItem = {
  kind: "action" | "scope" | "match" | "matcher" | "advanced" | "save";
  label: string;
};

const ACTIONS: readonly RuleAction[] = ["allow", "ask", "deny"];
const SCOPES: readonly RuleScope[] = ["project", "global"];
const MATCH_KINDS: readonly RuleMatchKind[] = ["any", "exact", "fields"];

function cycle<T>(values: readonly T[], current: T, delta: number): T {
  const index = values.indexOf(current);
  return values[(index + delta + values.length) % values.length]!;
}

function actionLabel(action: RuleAction): string {
  return action === "allow" ? "Allow" : action === "ask" ? "Ask" : "Deny";
}

function scopeLabel(scope: RuleScope): string {
  return scope === "global" ? "Global" : "Project";
}

function matchLabel(kind: RuleMatchKind): string {
  return kind === "any" ? "All calls" : kind === "exact" ? "Exact call" : "Selected constraints";
}

export class RuleEditorComponent implements Component {
  private cursor = 0;
  private action: RuleAction;
  private scope: RuleScope;
  private matchKind: RuleMatchKind;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly done: (result: RuleEditorResult) => void;
  private readonly options: RuleEditorOptions;

  constructor(
    tui: TUI,
    theme: Theme,
    done: (result: RuleEditorResult) => void,
    options: RuleEditorOptions,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.options = options;
    this.action = options.action;
    this.scope = options.scope;
    this.matchKind = options.matchKind;
  }

  private get items(): EditorItem[] {
    return [
      ...(this.options.actionFixed ? [] : [{ kind: "action" as const, label: "Action" }]),
      { kind: "scope", label: "Scope" },
      { kind: "match", label: "Match type" },
      { kind: "matcher", label: "Matcher" },
      { kind: "advanced", label: "Advanced JSON" },
      { kind: "save", label: "Save" },
    ];
  }

  private state(): EditorState {
    return { action: this.action, scope: this.scope, matchKind: this.matchKind };
  }

  private move(delta: number): void {
    const count = this.items.length;
    this.cursor = (this.cursor + delta + count) % count;
  }

  private change(delta: number): boolean {
    const item = this.items[this.cursor];
    if (item?.kind === "action") this.action = cycle(ACTIONS, this.action, delta);
    else if (item?.kind === "scope") this.scope = cycle(SCOPES, this.scope, delta);
    else if (item?.kind === "match") this.matchKind = cycle(MATCH_KINDS, this.matchKind, delta);
    else return false;
    return true;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.done({ kind: "cancelled" });
      return;
    }
    if (matchesKey(data, Key.up)) this.move(-1);
    else if (matchesKey(data, Key.down)) this.move(1);
    else if (matchesKey(data, Key.left)) {
      if (!this.change(-1)) return;
    } else if (matchesKey(data, Key.right)) {
      if (!this.change(1)) return;
    } else if (matchesKey(data, Key.enter)) {
      const item = this.items[this.cursor];
      if (!item) return;
      const kind = item.kind === "action" ? "choose_action"
        : item.kind === "scope" ? "choose_scope"
        : item.kind === "match" ? "choose_match"
        : item.kind === "matcher" ? "edit_matcher"
        : item.kind;
      this.done({ kind, ...this.state() });
      return;
    } else return;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const value = (item: EditorItem): string => {
      if (item.kind === "action") return actionLabel(this.action);
      if (item.kind === "scope") return scopeLabel(this.scope);
      if (item.kind === "match") return matchLabel(this.matchKind);
      if (item.kind === "matcher") {
        return this.matchKind === this.options.matchKind ? singleLine(this.options.matcherSummary) : "Not configured";
      }
      return "";
    };
    const lines = [
      this.theme.bold(truncateToWidth("Rule Editor", safeWidth)),
      this.theme.fg("muted", truncateToWidth(`Tool: ${singleLine(this.options.tool)}`, safeWidth)),
      ...(this.options.actionFixed
        ? [this.theme.fg("muted", truncateToWidth(`Action: ${actionLabel(this.action)} (fixed)`, safeWidth))]
        : []),
      "",
    ];
    for (const [index, item] of this.items.entries()) {
      const active = index === this.cursor;
      const marker = active ? this.theme.fg("accent", "❯") : " ";
      const label = active ? this.theme.fg("accent", item.label) : item.label;
      const itemValue = value(item);
      const coloredValue = item.kind === "scope" && this.scope === "global"
        ? this.theme.fg("warning", itemValue)
        : this.theme.fg("muted", itemValue);
      lines.push(truncateToWidth(`${marker} ${label}${itemValue ? `  ${coloredValue}` : ""}`, safeWidth));
    }
    if (this.options.contextLines?.length) {
      lines.push("", this.theme.fg("dim", truncateToWidth("Context", safeWidth)));
      for (const context of this.options.contextLines.slice(0, 8)) {
        lines.push(this.theme.fg("dim", truncateToWidth(`  ${singleLine(context)}`, safeWidth)));
      }
    }
    lines.push("", this.theme.fg("dim", truncateToWidth(
      "↑/↓ move • ←/→ change • Enter edit/save • Esc discard",
      safeWidth,
    )));
    return lines;
  }

  invalidate(): void {}
}
