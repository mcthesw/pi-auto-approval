import { matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { UsageDisplay } from "../domain.ts";

export type SettingsMenuAction = "rules" | "suggestions" | "reviewer";

type SettingsMenuTheme = {
  fg: (color: "accent" | "muted" | "dim", text: string) => string;
  bold: (text: string) => string;
};

type SettingsMenuOptions = {
  usageDisplay: UsageDisplay;
  onUsageDisplayChange: (value: UsageDisplay) => Promise<boolean>;
};

const USAGE_DISPLAY_OPTIONS: readonly UsageDisplay[] = ["detailed", "brief", "off"];
const USAGE_LABELS: Record<UsageDisplay, string> = {
  detailed: "Detailed",
  brief: "Brief",
  off: "Off",
};

export class SettingsMenuComponent implements Component {
  private selectedIndex = 0;
  private usageDisplay: UsageDisplay;
  private changingUsage = false;
  private readonly theme: SettingsMenuTheme;
  private readonly options: SettingsMenuOptions;
  private readonly done: (action?: SettingsMenuAction) => void;

  constructor(
    theme: SettingsMenuTheme,
    options: SettingsMenuOptions,
    done: (action?: SettingsMenuAction) => void,
  ) {
    this.theme = theme;
    this.options = options;
    this.done = done;
    this.usageDisplay = options.usageDisplay;
  }

  render(width: number): string[] {
    const rows: Array<{ label: string; value?: string }> = [
      { label: "Rules" },
      { label: "Suggestions" },
      { label: "Reviewer" },
      { label: "Usage display", value: `← ${USAGE_LABELS[this.usageDisplay]} →` },
    ];
    const labelWidth = Math.max(...rows.map((row) => row.label.length));
    const lines = [this.theme.fg("accent", this.theme.bold("Pi Auto Approval")), ""];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      const active = index === this.selectedIndex;
      const prefix = active ? this.theme.fg("accent", "→ ") : "  ";
      const label = active ? this.theme.fg("accent", row.label.padEnd(labelWidth)) : row.label.padEnd(labelWidth);
      const value = row.value ? (active ? this.theme.fg("accent", row.value) : this.theme.fg("muted", row.value)) : "";
      lines.push(truncateToWidth(`${prefix}${label}${value ? `  ${value}` : ""}`, width));
    }
    lines.push("");
    lines.push(truncateToWidth(this.theme.fg("dim", "  ↑/↓ navigate · ←/→ change Usage display · Enter open · Esc back"), width));
    return lines;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, "up")) {
      this.selectedIndex = (this.selectedIndex + 3) % 4;
      return;
    }
    if (matchesKey(data, "down")) {
      this.selectedIndex = (this.selectedIndex + 1) % 4;
      return;
    }
    if (this.selectedIndex === 3 && matchesKey(data, "left")) {
      void this.changeUsage(-1);
      return;
    }
    if (this.selectedIndex === 3 && matchesKey(data, "right")) {
      void this.changeUsage(1);
      return;
    }
    if (matchesKey(data, "enter")) {
      const action = ["rules", "suggestions", "reviewer"][this.selectedIndex] as SettingsMenuAction | undefined;
      if (action) this.done(action);
      return;
    }
    if (matchesKey(data, "escape")) this.done();
  }

  private async changeUsage(delta: number): Promise<void> {
    if (this.changingUsage) return;
    const currentIndex = USAGE_DISPLAY_OPTIONS.indexOf(this.usageDisplay);
    const nextIndex = (currentIndex + delta + USAGE_DISPLAY_OPTIONS.length) % USAGE_DISPLAY_OPTIONS.length;
    const previous = this.usageDisplay;
    const next = USAGE_DISPLAY_OPTIONS[nextIndex]!;
    this.usageDisplay = next;
    this.changingUsage = true;
    try {
      if (!await this.options.onUsageDisplayChange(next)) this.usageDisplay = previous;
    } finally {
      this.changingUsage = false;
    }
  }
}
