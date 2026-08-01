import path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createExtensionRuntime,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { ReviewerConfig } from "../domain.ts";
import { prepareReviewContext, type ReviewRequest } from "./context.ts";
import { buildReviewPrompt, REVIEW_SYSTEM_PROMPT } from "./prompt.ts";
import { parseReviewResponse, type ReviewResult } from "./schema.ts";

const DEFAULT_REVIEW_TIMEOUT_MS = 60_000;

export class ReviewUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewUnavailableError";
  }
}

class InertReviewResourceLoader implements ResourceLoader {
  private readonly extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };

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
    return REVIEW_SYSTEM_PROMPT;
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
  abort(): Promise<void>;
  dispose(): void;
};

export type ReviewerModelOption = { provider: string; modelId: string; label: string };

export type ReviewSessionFactory = {
  create(config: ReviewerConfig, cwd: string): Promise<ReviewSession>;
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
    const models = await this.runtime.getAvailable();
    return models.map((model) => ({
      provider: model.provider,
      modelId: model.id,
      label: `${model.name} (${model.provider}/${model.id})`,
    }));
  }

  async availability(config: ReviewerConfig): Promise<string | undefined> {
    const model = this.runtime.getModel(config.provider, config.modelId);
    if (!model) return `Reviewer model not found: ${config.provider}/${config.modelId}`;
    const available = await this.runtime.getAvailable();
    if (!available.some((candidate) => modelMatches(candidate, config))) {
      return `Reviewer model has no configured authentication: ${config.provider}/${config.modelId}`;
    }
    return undefined;
  }

  async create(config: ReviewerConfig, cwd: string): Promise<ReviewSession> {
    const unavailable = await this.availability(config);
    if (unavailable) throw new ReviewUnavailableError(unavailable);
    const model = this.runtime.getModel(config.provider, config.modelId);
    if (!model) throw new ReviewUnavailableError(`Reviewer model not found: ${config.provider}/${config.modelId}`);
    const resourceLoader = new InertReviewResourceLoader();
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd,
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

function assistantText(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (typeof message !== "object" || message === null || (message as Record<string, unknown>).role !== "assistant") continue;
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((part) => typeof part === "object" && part !== null && (part as Record<string, unknown>).type === "text")
      .map((part) => (part as Record<string, unknown>).text)
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    if (text.trim()) return text;
  }
  return undefined;
}

function abortError(): Error {
  const error = new Error("Automated Review was cancelled");
  error.name = "AbortError";
  return error;
}

function createSessionWithAbort(
  pending: Promise<ReviewSession>,
  signal: AbortSignal,
): Promise<ReviewSession> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(abortError());
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

  async review(config: ReviewerConfig, request: ReviewRequest, signal?: AbortSignal): Promise<ReviewResult> {
    if (signal?.aborted) throw abortError();
    const context = prepareReviewContext(request);
    const controller = new AbortController();
    let session: ReviewSession | undefined;
    let timedOut = false;
    let cancelled = false;
    const onCallerAbort = () => {
      cancelled = true;
      controller.abort();
    };
    const onReviewAbort = () => {
      if (session) void session.abort().catch(() => {});
    };
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    controller.signal.addEventListener("abort", onReviewAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      session = await createSessionWithAbort(this.sessions.create(config, request.cwd), controller.signal);
      await session.prompt(buildReviewPrompt(context), { expandPromptTemplates: false });
      if (cancelled) throw abortError();
      if (timedOut) throw new ReviewUnavailableError(`Automated Review timed out after ${this.timeoutMs} ms`);
      const response = assistantText(session.messages);
      if (!response) throw new ReviewUnavailableError("Reviewer returned no assistant text");
      return parseReviewResponse(response);
    } catch (error) {
      if (cancelled || signal?.aborted) throw abortError();
      if (timedOut) throw new ReviewUnavailableError(`Automated Review timed out after ${this.timeoutMs} ms`);
      if (error instanceof ReviewUnavailableError) throw error;
      throw new ReviewUnavailableError(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onCallerAbort);
      controller.signal.removeEventListener("abort", onReviewAbort);
      session?.dispose();
    }
  }
}
