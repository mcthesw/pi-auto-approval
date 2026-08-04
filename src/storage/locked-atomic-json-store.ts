import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";

export type JsonCodec<T> = {
  empty: () => T;
  parse: (value: unknown) => T;
  invalidJsonError?: (message: string) => Error;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!(["EINVAL", "EISDIR", "EPERM"] as unknown[]).includes((error as NodeJS.ErrnoException).code)) throw error;
  }
}

export class LockedAtomicJsonStore<T> {
  readonly filePath: string;
  readonly lockPath: string;
  private readonly codec: JsonCodec<T>;

  constructor(filePath: string, codec: JsonCodec<T>) {
    this.filePath = filePath;
    this.codec = codec;
    this.lockPath = `${filePath}.lock`;
  }

  async read(): Promise<T> {
    let source: string;
    try {
      source = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return this.codec.empty();
      throw error;
    }

    try {
      return this.codec.parse(JSON.parse(source));
    } catch (error) {
      if (error instanceof SyntaxError) {
        const message = `Invalid JSON: ${errorMessage(error)}`;
        throw this.codec.invalidJsonError?.(message) ?? new Error(message);
      }
      throw error;
    }
  }

  async update(mutator: (draft: T) => void | T): Promise<T> {
    const release = await this.acquireLock();
    try {
      const current = await this.read();
      const draft = structuredClone(current);
      const replacement = mutator(draft);
      const next = replacement ?? draft;
      return await this.write(next);
    } finally {
      await release();
    }
  }

  async replace(value: T): Promise<void> {
    const release = await this.acquireLock();
    try {
      await this.write(value);
    } finally {
      await release();
    }
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    return lockfile.lock(this.filePath, {
      lockfilePath: this.lockPath,
      realpath: false,
      stale: 30_000,
      update: 5_000,
      retries: { retries: 100, factor: 1, minTimeout: 50, maxTimeout: 50 },
    });
  }

  private async write(value: T): Promise<T> {
    const validated = this.codec.parse(value);
    const directory = path.dirname(this.filePath);
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true });
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.filePath);
      await syncDirectory(directory);
      return validated;
    } finally {
      try {
        await unlink(temporary);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
    }
  }
}
