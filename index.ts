import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { getAgentDir, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { AutoApprovalConfigStore, autoApprovalConfigFile } from "./src/config/store.ts";
import { decideToolCall } from "./src/decision.ts";
import type { ToolCall } from "./src/domain.ts";
import { resolveProjectIdentity, type ProjectIdentity } from "./src/project.ts";
import { inspectBashEnvironment } from "./src/adapters/bash-environment.ts";
import { AutomatedReviewer, PiReviewSessionFactory } from "./src/review/reviewer.ts";
import type { ReviewToolMetadata } from "./src/review/context.ts";
import { openAutoApprovalSettings } from "./src/ui/settings.ts";
import type { ToolProvenance } from "./src/policy/engine.ts";

const STATUS_KEY = "auto-approval";

function toolProvenance(tool: ToolInfo | undefined): ToolProvenance {
  const source = (tool?.sourceInfo as { source?: string } | undefined)?.source;
  if (source === "builtin") return "builtin";
  if (source === "sdk") return "sdk";
  if (source) return "extension";
  return "unknown";
}

function reviewMetadata(tool: ToolInfo | undefined): ReviewToolMetadata | undefined {
  if (!tool) return undefined;
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    sourceInfo: tool.sourceInfo,
  };
}

async function projectIdentity(pi: ExtensionAPI, cwd: string): Promise<ProjectIdentity> {
  return resolveProjectIdentity(cwd, async (directory) => {
    const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: directory, timeout: 5_000 });
    return result.code === 0 ? result.stdout.trim() || undefined : undefined;
  });
}

export type AutoApprovalRuntimeOptions = {
  agentDir?: string;
  createReviewer?: () => Promise<AutomatedReviewer>;
};

export function createAutoApprovalExtension(options: AutoApprovalRuntimeOptions = {}) {
  return function autoApproval(pi: ExtensionAPI): void {
    const agentDir = options.agentDir ?? getAgentDir();
    const store = new AutoApprovalConfigStore(autoApprovalConfigFile(agentDir));
    let reviewer: AutomatedReviewer | undefined;
    let reviewerInitializationError: string | undefined;

    const initializeReviewer = async (): Promise<AutomatedReviewer | undefined> => {
      if (reviewer) return reviewer;
      try {
        reviewer = options.createReviewer
          ? await options.createReviewer()
          : new AutomatedReviewer(await PiReviewSessionFactory.create(agentDir));
      reviewerInitializationError = undefined;
      return reviewer;
    } catch (error) {
      reviewerInitializationError = error instanceof Error ? error.message : String(error);
      return undefined;
    }
  };

  pi.registerCommand("auto-approval", {
    description: "Configure the Reviewer model, Policy Rules, and project Approval Rules",
    handler: async (_args, ctx) => {
      const activeReviewer = await initializeReviewer();
      const project = await projectIdentity(pi, ctx.cwd);
      await openAutoApprovalSettings(ctx, {
        store,
        projectKey: project.key,
        reviewer: activeReviewer,
        reviewerUnavailableReason: reviewerInitializationError,
      });
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const activeReviewer = await initializeReviewer();
    const loaded = await store.read();
    if (!loaded.ok) {
      if (ctx.hasUI) ctx.ui.notify(`Pi Auto Approval is fail-closed: ${loaded.error}`, "error");
      ctx.ui.setStatus(STATUS_KEY, "auto-approval: invalid config");
      return;
    }
    if (!loaded.config.reviewer) {
      if (ctx.hasUI) ctx.ui.notify("Pi Auto Approval needs an explicit Reviewer model. Run /auto-approval.", "warning");
      ctx.ui.setStatus(STATUS_KEY, "auto-approval: reviewer not configured");
      return;
    }
    const unavailable = activeReviewer
      ? await activeReviewer.availability(loaded.config.reviewer)
      : reviewerInitializationError ?? "Reviewer runtime unavailable";
    if (unavailable) {
      if (ctx.hasUI) ctx.ui.notify(`Pi Auto Approval will ask before residual calls: ${unavailable}`, "warning");
      ctx.ui.setStatus(STATUS_KEY, "auto-approval: reviewer unavailable");
    } else {
      ctx.ui.setStatus(STATUS_KEY, "auto-approval: ready");
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    const call: ToolCall = { id: event.toolCallId, name: event.toolName, input: event.input };
    try {
      const project = await projectIdentity(pi, ctx.cwd);
      const tool = pi.getAllTools().find((candidate) => candidate.name === call.name);
      const provenance = toolProvenance(tool);
      const activeReviewer = await initializeReviewer();
      const bash = call.name === "bash"
        ? await inspectBashEnvironment(pi, ctx.cwd, agentDir, project)
        : undefined;
      const messages = ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);
      return await decideToolCall(ctx, call, {
        store,
        reviewer: activeReviewer,
        reviewerUnavailableReason: reviewerInitializationError,
        project,
        provenance,
        bash,
        messages,
        tool: reviewMetadata(tool),
      });
    } catch (error) {
      const reason = `Pi Auto Approval failed closed: ${error instanceof Error ? error.message : String(error)}`;
      if (ctx.signal?.aborted) return { block: true, reason };
      if (ctx.hasUI && await ctx.ui.confirm("Auto Approval failed", `${reason}\nApprove this Tool Call once?`)) return undefined;
      return { block: true, reason };
    }
  });

    pi.on("session_shutdown", async (_event, ctx) => {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    });
  };
}

export default createAutoApprovalExtension();
