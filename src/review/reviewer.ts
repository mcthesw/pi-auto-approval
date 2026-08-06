import path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createExtensionRuntime,
  type ResourceLoader,
  type SessionStats,
} from "@earendil-works/pi-coding-agent";
import type { ReviewerConfig } from "../domain.ts";
import { modelUsageFromStats, type ModelUsageObserver } from "../model-usage.ts";
import { prepareReviewBatchContext, type ReviewBatchRequest, type ReviewRequest } from "./context.ts";
import { buildReviewBatchPrompt, REVIEW_SYSTEM_PROMPT } from "./prompt.ts";
import {
  parseReviewBatchResponse,
  structuredResponseCorrectionPrompt,
  type ReviewBatchResult,
  type ReviewResult,
} from "./schema.ts";

const DEFAULT_REVIEW_TIMEOUT_MS = 60_000;

export class ReviewUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewUnavailableError";
  }
}

class InertReviewResourceLoader implements ResourceLoader {
  private readonly extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  private readonly systemPrompt: string;

  constructor(systemPrompt: string) {
    this.systemPrompt = systemPrompt;
  }

  getExtensions() {
    return this.extensions;
  }
  getSkills() {
    return { skills: [], diagnostics: [] };
  }
  getPrompts() {
    return { prompts: [], diagnostics: [] };
  }
  getThemes() {
    return { themes: [], diagnostics: [] };
  }
  getAgentsFiles() {
    return { agentsFiles: [] };
  }
  getSystemPrompt() {
    return this.systemPrompt;
  }
  getSystemPromptSource() {
    return undefined;
  }
  getAppendSystemPrompt() {
    return [];
  }
  getAppendSystemPromptSources() {
    return [];
  }
  extendResources() {}
  async reload() {}
}

export type ReviewSession = {
  prompt(text: string, options?: { expandPromptTemplates?: boolean }): Promise<void>;
  readonly messages: readonly unknown[];
  getSessionStats?(): SessionStats;
  abort(): Promise<void>;
  dispose(): void;
};

export type ReviewerModelOption = { provider: string; modelId: string; label: string };

export type ReviewSessionFactory = {
  create(config: ReviewerConfig, cwd: string, systemPrompt?: string): Promise<ReviewSession>;
  availability(config: ReviewerConfig): Promise<string | undefined>;
  availableModels?(): Promise<ReviewerModelOption[]>;
};

function modelMatches(model: Model<any>, config: ReviewerConfig): boolean {
  return model.provider === config.provider && model.id === config.modelId;
}

export class PiReviewSessionFactory implements ReviewSessionFactory {
  private readonly runtime: ModelRuntime;
  private readonly agentDir: string;

  private constructor(runtime: ModelRuntime, agentDir: string) {
    this.runtime = runtime;
    this.agentDir = agentDir;
  }

  static async create(agentDir: string): Promise<PiReviewSessionFactory> {
    const runtime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
    });
    return new PiReviewSessionFactory(runtime, agentDir);
  }

  async availableModels(): Promise<ReviewerModelOption[]> {
    await this.runtime.refresh({ allowNetwork: false });
    const models = await this.runtime.getAvailable();
    return models.map((model) => ({
      provider: model.provider,
      modelId: model.id,
      label: `${model.name} (${model.provider}/${model.id})`,
    }));
  }

  async availability(config: ReviewerConfig): Promise<string | undefined> {
    // Reload auth.json and models.json so a long-running Pi process observes
    // explicit credential or model changes without retaining Reviewer history.
    await this.runtime.refresh({ allowNetwork: false });
    const model = this.runtime.getModel(config.provider, config.modelId);
    if (!model) return `Reviewer model not found: ${config.provider}/${config.modelId}`;
    const available = await this.runtime.getAvailable();
    if (!available.some((candidate) => modelMatches(candidate, config))) {
      return `Reviewer model has no configured authentication: ${config.provider}/${config.modelId}`;
    }
    return undefined;
  }

  async create(config: ReviewerConfig, _cwd: string, systemPrompt = REVIEW_SYSTEM_PROMPT): Promise<ReviewSession> {
    const unavailable = await this.availability(config);
    if (unavailable) throw new ReviewUnavailableError(unavailable);
    const model = this.runtime.getModel(config.provider, config.modelId);
    if (!model) throw new ReviewUnavailableError(`Reviewer model not found: ${config.provider}/${config.modelId}`);
    const resourceLoader = new InertReviewResourceLoader(systemPrompt);
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      // Pi appends the session cwd to custom system prompts. Use only the
      // filesystem root here so an untrusted project path cannot add system-level text.
      // The actual cwd is supplied separately as explicitly untrusted evidence.
      cwd: inertReviewSessionCwd(this.agentDir),
      agentDir: this.agentDir,
      modelRuntime: this.runtime,
      model,
      thinkingLevel: config.thinkingLevel,
      noTools: "all",
      resourceLoader,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
        quietStartup: true,
      }),
    });
    return session;
  }
}

export function inertReviewSessionCwd(agentDir: string): string {
  return path.parse(path.resolve(agentDir)).root;
}

type AssistantOutcome = {
  text?: string;
  stopReason?: string;
  errorMessage?: string;
};

function assistantOutcome(messages: readonly unknown[]): AssistantOutcome | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (typeof message !== "object" || message === null || (message as Record<string, unknown>).role !== "assistant") continue;
    const input = message as Record<string, unknown>;
    const content = input.content;
    const text = Array.isArray(content)
      ? content
        .filter((part) => typeof part === "object" && part !== null && (part as Record<string, unknown>).type === "text")
        .map((part) => (part as Record<string, unknown>).text)
        .filter((value): value is string => typeof value === "string")
        .join("\n")
      : undefined;
    return {
      ...(text?.trim() ? { text } : {}),
      ...(typeof input.stopReason === "string" ? { stopReason: input.stopReason } : {}),
      ...(typeof input.errorMessage === "string" ? { errorMessage: input.errorMessage } : {}),
    };
  }
  return undefined;
}

function abortError(operation = "Automated Review"): Error {
  const error = new Error(`${operation} was cancelled`);
  error.name = "AbortError";
  return error;
}

function createSessionWithAbort(
  pending: Promise<ReviewSession>,
  signal: AbortSignal,
  operation: string,
): Promise<ReviewSession> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(abortError(operation));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (session) => {
        signal.removeEventListener("abort", onAbort);
        if (settled) {
          session.dispose();
          return;
        }
        settled = true;
        resolve(session);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        if (settled) return;
        settled = true;
        reject(error);
      },
    );
  });
}

export class AutomatedReviewer {
  private readonly sessions: ReviewSessionFactory;
  private readonly timeoutMs: number;

  constructor(sessions: ReviewSessionFactory, timeoutMs = DEFAULT_REVIEW_TIMEOUT_MS) {
    this.sessions = sessions;
    this.timeoutMs = timeoutMs;
  }

  availability(config: ReviewerConfig): Promise<string | undefined> {
    return this.sessions.availability(config);
  }

  availableModels(): Promise<ReviewerModelOption[]> {
    return this.sessions.availableModels?.() ?? Promise.resolve([]);
  }

  private async inSession<T>(
    config: ReviewerConfig,
    cwd: string,
    systemPrompt: string,
    operation: string,
    run: (prompt: (text: string) => Promise<string>) => Promise<T>,
    signal?: AbortSignal,
    onUsage?: ModelUsageObserver,
  ): Promise<T> {
    if (signal?.aborted) throw abortError(operation);
    const controller = new AbortController();
    let session: ReviewSession | undefined;
    let abortPromise: Promise<void> | undefined;
    let timedOut = false;
    let cancelled = false;
    let modelRequestStarted = false;
    let usageReported = false;
    const onCallerAbort = () => {
      cancelled = true;
      controller.abort();
    };
    const abortSession = (): Promise<void> => {
      if (!session) return Promise.resolve();
      abortPromise ??= session.abort().catch(() => {});
      return abortPromise;
    };
    const onReviewAbort = () => { void abortSession(); };
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    controller.signal.addEventListener("abort", onReviewAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    const reportUsage = (): void => {
      if (!modelRequestStarted || usageReported || !onUsage || !session?.getSessionStats) return;
      usageReported = true;
      try {
        onUsage(modelUsageFromStats(session.getSessionStats()));
      } catch {
        // Usage reporting is an optional UI observer and must not affect authorization.
      }
    };

    const prompt = async (text: string): Promise<string> => {
      modelRequestStarted = true;
      await session!.prompt(text, { expandPromptTemplates: false });
      if (cancelled) throw abortError(operation);
      if (timedOut) throw new ReviewUnavailableError(`${operation} timed out after ${this.timeoutMs} ms`);
      const outcome = assistantOutcome(session!.messages);
      if (!outcome) throw new ReviewUnavailableError(`${operation} returned no assistant message`);
      if (outcome.stopReason !== "stop") {
        const detail = outcome.errorMessage ? `: ${outcome.errorMessage}` : "";
        throw new ReviewUnavailableError(`${operation} stopped with ${outcome.stopReason ?? "an unknown reason"}${detail}`);
      }
      if (!outcome.text) throw new ReviewUnavailableError(`${operation} returned no assistant text`);
      return outcome.text;
    };

    try {
      session = await createSessionWithAbort(this.sessions.create(config, cwd, systemPrompt), controller.signal, operation);
      return await run(prompt);
    } catch (error) {
      if (cancelled || signal?.aborted) throw abortError(operation);
      if (timedOut) throw new ReviewUnavailableError(`${operation} timed out after ${this.timeoutMs} ms`);
      if (error instanceof ReviewUnavailableError) throw error;
      throw new ReviewUnavailableError(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onCallerAbort);
      controller.signal.removeEventListener("abort", onReviewAbort);
      if (controller.signal.aborted) await abortSession();
      reportUsage();
      session?.dispose();
    }
  }

  async complete(
    config: ReviewerConfig,
    cwd: string,
    systemPrompt: string,
    prompt: string,
    operation: string,
    signal?: AbortSignal,
    onUsage?: ModelUsageObserver,
  ): Promise<string> {
    return this.inSession(config, cwd, systemPrompt, operation, (send) => send(prompt), signal, onUsage);
  }

  async completeStructured<T>(
    config: ReviewerConfig,
    cwd: string,
    systemPrompt: string,
    prompt: string,
    operation: string,
    parse: (response: string) => T,
    signal?: AbortSignal,
    onUsage?: ModelUsageObserver,
  ): Promise<T> {
    return this.inSession(config, cwd, systemPrompt, operation, async (send) => {
      const initial = await send(prompt);
      try {
        return parse(initial);
      } catch (error) {
        return parse(await send(structuredResponseCorrectionPrompt(error)));
      }
    }, signal, onUsage);
  }

  async reviewBatch(
    config: ReviewerConfig,
    request: ReviewBatchRequest,
    signal?: AbortSignal,
    onUsage?: ModelUsageObserver,
  ): Promise<ReviewBatchResult> {
    const context = prepareReviewBatchContext(request);
    const toolCallIds = request.calls.map((item) => item.toolCall.id);
    return this.completeStructured(
      config,
      request.cwd,
      REVIEW_SYSTEM_PROMPT,
      buildReviewBatchPrompt(context),
      "Automated Review",
      (response) => parseReviewBatchResponse(response, toolCallIds),
      signal,
      onUsage,
    );
  }

  async review(
    config: ReviewerConfig,
    request: ReviewRequest,
    signal?: AbortSignal,
    onUsage?: ModelUsageObserver,
  ): Promise<ReviewResult> {
    const result = await this.reviewBatch(config, {
      cwd: request.cwd,
      projectRoot: request.projectRoot,
      messages: request.messages,
      calls: [{ toolCall: request.toolCall, tool: request.tool }],
    }, signal, onUsage);
    const review = result.decisions.get(request.toolCall.id);
    if (!review) throw new ReviewUnavailableError("Reviewer response omitted the Tool Call decision");
    return review;
  }
}
