import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

const DANGEROUS_BASH_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\brm\s+-rf\b/i, label: "rm -rf" },
  { pattern: /\bsudo\b/i, label: "sudo" },
  { pattern: /\bmkfs(\.|\b)/i, label: "mkfs" },
  { pattern: /\bdd\b/i, label: "dd" },
  { pattern: /\bshutdown\b/i, label: "shutdown" },
  { pattern: /\breboot\b/i, label: "reboot" },
  { pattern: /\bpoweroff\b/i, label: "poweroff" },
  { pattern: /:\(\)\s*\{/i, label: "fork bomb" },
];

function isProtectedPath(targetPath: string, cwd: string): boolean {
  const resolved = path.resolve(cwd, targetPath);
  const lower = resolved.toLowerCase();

  if (/(^|\/)\.ssh(\/|$)/.test(lower)) return true;
  if (/(^|\/)\.git-credentials$/.test(lower)) return true;
  if (/(^|\/)auth\.json$/.test(lower)) return true;
  if (/(^|\/)id_(rsa|ed25519)(\.pub)?$/.test(lower)) return true;
  if (/(^|\/)\.env(\..+)?$/.test(lower)) return true;

  return false;
}

async function confirmOrBlock(
  ctx: ExtensionContext,
  title: string,
  message: string,
  nonInteractiveReason: string,
): Promise<{ block: true; reason: string } | undefined> {
  if (!ctx.hasUI) {
    return { block: true, reason: nonInteractiveReason };
  }

  const ok = await ctx.ui.confirm(title, message);
  if (!ok) {
    return { block: true, reason: "Blocked by safety-guard extension" };
  }

  return undefined;
}

export default function safetyGuard(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("bash", event)) {
      const command = event.input.command ?? "";
      const match = DANGEROUS_BASH_PATTERNS.find((entry) => entry.pattern.test(command));
      if (!match) return;

      return await confirmOrBlock(
        ctx,
        "Dangerous bash command",
        `Detected '${match.label}'. Execute anyway?`,
        `Blocked dangerous bash command (${match.label}) in non-interactive mode`,
      );
    }

    if (isToolCallEventType("write", event)) {
      if (!isProtectedPath(event.input.path, ctx.cwd)) return;

      return await confirmOrBlock(
        ctx,
        "Protected file write",
        `Write to protected path '${event.input.path}'?`,
        `Blocked write to protected path '${event.input.path}' in non-interactive mode`,
      );
    }

    if (isToolCallEventType("edit", event)) {
      if (!isProtectedPath(event.input.path, ctx.cwd)) return;

      return await confirmOrBlock(
        ctx,
        "Protected file edit",
        `Edit protected path '${event.input.path}'?`,
        `Blocked edit to protected path '${event.input.path}' in non-interactive mode`,
      );
    }
  });
}
