import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { getAgentDir, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { AutoApprovalConfigStore, autoApprovalConfigFile } from "./src/config/store.ts";
import { decideToolCall } from "./src/decision.ts";
import type { ToolCall } from "./src/domain.ts";
import { resolveProjectIdentity, type ProjectIdentity } from "./src/project.ts";
import { AutomatedReviewer, PiReviewSessionFactory } from "./src/review/reviewer.ts";
import type { ReviewToolMetadata } from "./src/review/context.ts";
import { TurnReviewBatchCoordinator, type TurnReviewCall } from "./src/review/turn-batch.ts";
import { runWithAsyncLoader } from "./src/ui/async-loader.ts";
import { openAutoApprovalSettings } from "./src/ui/settings.ts";
import { toolSourceIdentity } from "./src/tool-identity.ts";
import { FrictionHistoryStore, frictionHistoryFile } from "./src/friction/store.ts";
import { RuleAdvisor } from "./src/advisor/advisor.ts";
import type { AdvisorToolMetadata } from "./src/advisor/prompt.ts";
import { formatModelUsage, type ModelUsage } from "./src/model-usage.ts";
import { boundedSingleLine } from "./src/ui/text.ts";

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

function assistantTurnCalls(entries: readonly unknown[], current: ToolCall, tools: readonly ToolInfo[]): TurnReviewCall[] {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (typeof entry !== "object" || entry === null) continue;
    const message = (entry as { type?: unknown; message?: unknown }).type === "message"
      ? (entry as { message?: unknown }).message
      : undefined;
    if (typeof message !== "object" || message === null || (message as { role?: unknown }).role !== "assistant") continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) break;
    const calls = content.flatMap((part): TurnReviewCall[] => {
      if (typeof part !== "object" || part === null || (part as { type?: unknown }).type !== "toolCall") return [];
      const item = part as { id?: unknown; name?: unknown; arguments?: unknown };
      if (typeof item.id !== "string" || typeof item.name !== "string") return [];
      const call = item.id === current.id ? current : { id: item.id, name: item.name, input: item.arguments };
      const tool = tools.find((candidate) => candidate.name === call.name);
      return [{ call, toolSource: toolSourceIdentity(tool), tool: reviewMetadata(tool) }];
    });
    return calls.some((item) => item.call.id === current.id) ? calls : [{ call: current }];
  }
  return [{ call: current }];
}

function reviewSummary(
  result: { decisions: ReadonlyMap<string, { decision: "allow" | "ask" | "deny" }> },
  usage?: string,
): {
  text: string;
  level: "info" | "warning" | "error";
} {
  const counts = { allow: 0, ask: 0, deny: 0 };
  result.decisions.forEach((decision) => { counts[decision.decision] += 1; });
  const total = counts.allow + counts.ask + counts.deny;
  return {
    text: `Automated Review · ${total} Tool Call${total === 1 ? "" : "s"}: ${counts.allow} Allow · ${counts.ask} Ask · ${counts.deny} Deny${usage ? ` · ${usage}` : ""}`,
    level: counts.deny ? "error" : counts.ask ? "warning" : "info",
  };
}

function reviewFailureSummary(status: "cancelled" | "failed", error: unknown, usage?: string): string {
  const detail = status === "cancelled"
    ? "Automated Review cancelled"
    : `Automated Review failed: ${boundedSingleLine(error instanceof Error ? error.message : String(error))}`;
  return `${detail}${usage ? ` · ${usage}` : ""}`;
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
    const reviewBatches = new TurnReviewBatchCoordinator();

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
      const tools = pi.getAllTools();
      const tool = tools.find((candidate) => candidate.name === call.name);
      const activeReviewer = await initializeReviewer();
      const entries = await ctx.sessionManager.buildContextEntries();
      const messages = entries.flatMap(sessionEntryToContextMessages);
      return await decideToolCall(ctx, call, {
        store,
        reviewer: activeReviewer,
        reviewerUnavailableReason: reviewerInitializationError,
        project,
        toolSource: toolSourceIdentity(tool),
        messages,
        tool: reviewMetadata(tool),
        review: async (config, request, signal) => {
          if (!activeReviewer || !config.reviewer) throw new Error("Automated Review is not configured");
          return reviewBatches.review({
            current: { call: request.toolCall, toolSource: toolSourceIdentity(tool), tool: reviewMetadata(tool) },
            siblings: assistantTurnCalls(entries, request.toolCall, tools),
            config,
            project,
            cwd: ctx.cwd,
            messages,
            run: async (batch) => {
              let usage: ModelUsage | undefined;
              const usageDisplay = config.usageDisplay;
              const outcome = await runWithAsyncLoader(
                ctx,
                `Automated Review: ${batch.calls.length} Tool Call${batch.calls.length === 1 ? "" : "s"}…`,
                (batchSignal) => activeReviewer.reviewBatch(
                  config.reviewer!,
                  batch,
                  batchSignal,
                  (value) => { usage = value; },
                ),
              );
              const usageText = formatModelUsage(usage, usageDisplay);
              if (outcome.status === "cancelled") {
                if (ctx.hasUI) ctx.ui.notify(reviewFailureSummary("cancelled", undefined, usageText), "warning");
                throw new DOMException("Automated Review was cancelled", "AbortError");
              }
              if (outcome.status === "failed") {
                if (ctx.hasUI) ctx.ui.notify(reviewFailureSummary("failed", outcome.error, usageText), "error");
                throw outcome.error;
              }
              if (ctx.hasUI) {
                const summary = reviewSummary(outcome.value, usageText);
                ctx.ui.notify(summary.text, summary.level);
              }
              return outcome.value;
            },
          });
        },
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

    pi.on("turn_end", async (event) => {
      if (event.message.role !== "assistant") return;
      const ids = event.message.content
        .filter((part) => part.type === "toolCall")
        .map((part) => part.id);
      reviewBatches.clear(ids);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      reviewBatches.clearAll();
      ctx.ui.setStatus(STATUS_KEY, undefined);
    });
  };
}

export default createAutoApprovalExtension();
