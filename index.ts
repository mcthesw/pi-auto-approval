import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { getAgentDir, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { AutoApprovalConfigStore, autoApprovalConfigFile } from "./src/config/store.ts";
import { decideToolCall } from "./src/decision.ts";
import type { ToolCall } from "./src/domain.ts";
import { resolveProjectIdentity, type ProjectIdentity } from "./src/project.ts";
import { AutomatedReviewer, PiReviewSessionFactory } from "./src/review/reviewer.ts";
import type { ReviewToolMetadata } from "./src/review/context.ts";
import { openAutoApprovalSettings } from "./src/ui/settings.ts";
import { toolSourceIdentity } from "./src/tool-identity.ts";
import { FrictionHistoryStore, frictionHistoryFile } from "./src/friction/store.ts";
import { RuleAdvisor } from "./src/advisor/advisor.ts";
import type { AdvisorToolMetadata } from "./src/advisor/prompt.ts";

const STATUS_KEY = "auto-approval";

function reviewMetadata(tool: ToolInfo | undefined): ReviewToolMetadata | undefined {
  if (!tool) return undefined;
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    sourceInfo: tool.sourceInfo,
  };
}

function advisorMetadata(tool: ToolInfo): AdvisorToolMetadata {
  const source = toolSourceIdentity(tool);
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    sourceInfo: tool.sourceInfo,
    ...(source ? { source } : {}),
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
    const frictionStore = new FrictionHistoryStore(frictionHistoryFile(agentDir));
    let reviewer: AutomatedReviewer | undefined;
    let reviewerInitializationError: string | undefined;
    let frictionWarningShown = false;

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
    description: "Review approval friction and configure Auto Approval",
    handler: async (_args, ctx) => {
      const activeReviewer = await initializeReviewer();
      const project = await projectIdentity(pi, ctx.cwd);
      const skills = ctx.getSystemPromptOptions().skills?.map((skill) => ({
        name: skill.name,
        description: skill.description,
      })) ?? [];
      await openAutoApprovalSettings(ctx, {
        store,
        history: frictionStore,
        projectKey: project.key,
        projectRoot: project.root,
        reviewer: activeReviewer,
        advisor: activeReviewer ? new RuleAdvisor(activeReviewer) : undefined,
        reviewerUnavailableReason: reviewerInitializationError,
        tools: pi.getAllTools().map(advisorMetadata),
        skills,
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
      const activeReviewer = await initializeReviewer();
      const messages = ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);
      return await decideToolCall(ctx, call, {
        store,
        reviewer: activeReviewer,
        reviewerUnavailableReason: reviewerInitializationError,
        project,
        toolSource: toolSourceIdentity(tool),
        messages,
        tool: reviewMetadata(tool),
        recordFriction: async (record) => {
          try {
            await frictionStore.append(project.key, record);
          } catch (error) {
            if (!frictionWarningShown && ctx.hasUI) {
              frictionWarningShown = true;
              ctx.ui.notify(
                `Rule Advisor history is unavailable: ${error instanceof Error ? error.message : String(error)}`,
                "warning",
              );
            }
          }
        },
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
