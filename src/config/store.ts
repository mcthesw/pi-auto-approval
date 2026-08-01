import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import type { AutoApprovalConfig } from "../domain.ts";
import { defaultAutoApprovalConfig } from "../domain.ts";
import { ConfigValidationError, parseAutoApprovalConfig } from "./schema.ts";

export type ConfigReadResult =
  | { ok: true; config: AutoApprovalConfig }
  | { ok: false; error: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function acquireLock(filePath: string, lockPath: string): Promise<() => Promise<void>> {
  await mkdir(path.dirname(filePath), { recursive: true });
  return lockfile.lock(filePath, {
    lockfilePath: lockPath,
    realpath: false,
    stale: 30_000,
    update: 5_000,
    retries: { retries: 100, factor: 1, minTimeout: 50, maxTimeout: 50 },
  });
}

async function readValidated(filePath: string): Promise<AutoApprovalConfig> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultAutoApprovalConfig();
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new ConfigValidationError(`Invalid JSON: ${errorMessage(error)}`);
  }
  return parseAutoApprovalConfig(parsed);
}

async function writeAtomically(filePath: string, config: AutoApprovalConfig): Promise<void> {
  const validated = parseAutoApprovalConfig(config);
  const directory = path.dirname(filePath);
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true });
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filePath);
    try {
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      if (!(["EINVAL", "EISDIR", "EPERM"] as unknown[]).includes((error as NodeJS.ErrnoException).code)) throw error;
    }
  } finally {
    try {
      await unlink(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export class AutoApprovalConfigStore {
  readonly filePath: string;
  readonly lockPath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
  }

  async read(): Promise<ConfigReadResult> {
    try {
      return { ok: true, config: await readValidated(this.filePath) };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  async update(mutator: (config: AutoApprovalConfig) => void | AutoApprovalConfig): Promise<AutoApprovalConfig> {
    const release = await acquireLock(this.filePath, this.lockPath);
    try {
      const current = await readValidated(this.filePath);
      const draft = structuredClone(current);
      const replacement = mutator(draft);
      const next = replacement ?? draft;
      await writeAtomically(this.filePath, next);
      return parseAutoApprovalConfig(next);
    } finally {
      await release();
    }
  }

  /** Replace an invalid file only after an explicit user repair action. */
  async replace(config: AutoApprovalConfig): Promise<void> {
    const release = await acquireLock(this.filePath, this.lockPath);
    try {
      await writeAtomically(this.filePath, config);
    } finally {
      await release();
    }
  }
}

export function autoApprovalConfigFile(agentDir: string): string {
  return path.join(agentDir, "auto-approval.json");
}
