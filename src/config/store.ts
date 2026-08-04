import path from "node:path";
import type { AutoApprovalConfig } from "../domain.ts";
import { defaultAutoApprovalConfig } from "../domain.ts";
import { LockedAtomicJsonStore } from "../storage/locked-atomic-json-store.ts";
import { ConfigValidationError, parseAutoApprovalConfig } from "./schema.ts";

export type ConfigReadResult =
  | { ok: true; config: AutoApprovalConfig }
  | { ok: false; error: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AutoApprovalConfigStore {
  readonly filePath: string;
  readonly lockPath: string;
  private readonly json: LockedAtomicJsonStore<AutoApprovalConfig>;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.json = new LockedAtomicJsonStore(filePath, {
      empty: defaultAutoApprovalConfig,
      parse: parseAutoApprovalConfig,
      invalidJsonError: (message) => new ConfigValidationError(message),
    });
    this.lockPath = this.json.lockPath;
  }

  async read(): Promise<ConfigReadResult> {
    try {
      return { ok: true, config: await this.json.read() };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  async update(mutator: (config: AutoApprovalConfig) => void | AutoApprovalConfig): Promise<AutoApprovalConfig> {
    return await this.json.update(mutator);
  }

  /** Replace an invalid file only after an explicit user repair action. */
  async replace(config: AutoApprovalConfig): Promise<void> {
    await this.json.replace(config);
  }
}

export function autoApprovalConfigFile(agentDir: string): string {
  return path.join(agentDir, "auto-approval.json");
}
