import path from "node:path";
import type { FrictionHistory, FrictionRecord, ReviewDecision, UserConfirmationChoice } from "../domain.ts";
import { isJsonValue } from "../matchers.ts";
import { LockedAtomicJsonStore } from "../storage/locked-atomic-json-store.ts";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PROJECT_RECORDS = 50;
const REVIEW_DECISIONS = new Set<ReviewDecision>(["approve", "deny", "ask_user"]);
const USER_CHOICES = new Set<UserConfirmationChoice>(["approve_once", "always", "deny", "cancelled"]);

function fail(at: string, message: string): never {
  throw new Error(`${at}: ${message}`);
}

function plainRecord(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(at, "expected an object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(at, "expected a plain JSON object");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], at: string): void {
  const names = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !names.has(key));
  if (unknown) fail(`${at}.${unknown}`, "unknown property");
}

function nonEmptyString(value: unknown, at: string): string {
  if (typeof value !== "string" || !value.trim()) fail(at, "expected a non-empty string");
  return value;
}

function parseRecord(value: unknown, at: string): FrictionRecord {
  const input = plainRecord(value, at);
  exactKeys(input, ["id", "timestamp", "tool", "input", "reviewDecision", "userChoice"], at);
  const timestamp = nonEmptyString(input.timestamp, `${at}.timestamp`);
  if (!Number.isFinite(Date.parse(timestamp))) fail(`${at}.timestamp`, "expected an ISO timestamp");
  const tool = plainRecord(input.tool, `${at}.tool`);
  exactKeys(tool, ["name", "source"], `${at}.tool`);
  let source: FrictionRecord["tool"]["source"];
  if (tool.source !== undefined) {
    const identity = plainRecord(tool.source, `${at}.tool.source`);
    exactKeys(identity, ["source", "path"], `${at}.tool.source`);
    source = {
      source: nonEmptyString(identity.source, `${at}.tool.source.source`),
      path: nonEmptyString(identity.path, `${at}.tool.source.path`),
    };
  }
  if (!isJsonValue(input.input)) fail(`${at}.input`, "expected JSON data");
  if (input.reviewDecision !== undefined && !REVIEW_DECISIONS.has(input.reviewDecision as ReviewDecision)) {
    fail(`${at}.reviewDecision`, "unknown decision");
  }
  if (input.userChoice !== undefined && !USER_CHOICES.has(input.userChoice as UserConfirmationChoice)) {
    fail(`${at}.userChoice`, "unknown choice");
  }
  if (input.reviewDecision === undefined && input.userChoice === undefined) fail(at, "expected reviewDecision or userChoice");
  return {
    id: nonEmptyString(input.id, `${at}.id`),
    timestamp,
    tool: { name: nonEmptyString(tool.name, `${at}.tool.name`), ...(source ? { source } : {}) },
    input: structuredClone(input.input),
    ...(input.reviewDecision ? { reviewDecision: input.reviewDecision as ReviewDecision } : {}),
    ...(input.userChoice ? { userChoice: input.userChoice as UserConfirmationChoice } : {}),
  };
}

function parseHistory(value: unknown): FrictionHistory {
  const input = plainRecord(value, "history");
  exactKeys(input, ["version", "projects"], "history");
  if (input.version !== 1) fail("history.version", "expected 1");
  const projectsInput = plainRecord(input.projects, "history.projects");
  const projects: Record<string, FrictionRecord[]> = {};
  for (const [projectKey, records] of Object.entries(projectsInput)) {
    if (!path.isAbsolute(projectKey) || path.normalize(projectKey) !== projectKey) {
      fail(`history.projects[${JSON.stringify(projectKey)}]`, "expected a normalized absolute project key");
    }
    if (!Array.isArray(records)) fail(`history.projects[${JSON.stringify(projectKey)}]`, "expected an array");
    projects[projectKey] = records.map((record, index) => parseRecord(record, `history.projects[${JSON.stringify(projectKey)}][${index}]`));
  }
  return { version: 1, projects };
}

export type FrictionReadResult =
  | { ok: true; records: FrictionRecord[] }
  | { ok: false; error: string };

export class FrictionHistoryStore {
  readonly filePath: string;
  readonly lockPath: string;
  private readonly now: () => Date;
  private readonly json: LockedAtomicJsonStore<FrictionHistory>;

  constructor(filePath: string, now: () => Date = () => new Date()) {
    this.filePath = filePath;
    this.now = now;
    this.json = new LockedAtomicJsonStore(filePath, {
      empty: () => ({ version: 1, projects: {} }),
      parse: parseHistory,
    });
    this.lockPath = this.json.lockPath;
  }

  async readProject(projectKey: string): Promise<FrictionReadResult> {
    try {
      const history = await this.json.read();
      return { ok: true, records: this.retain(history.projects[projectKey] ?? []) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async append(projectKey: string, record: FrictionRecord): Promise<void> {
    await this.json.update((history) => {
      for (const [key, records] of Object.entries(history.projects)) {
        const retained = this.retain(records);
        if (retained.length) history.projects[key] = retained;
        else delete history.projects[key];
      }
      history.projects[projectKey] = this.retain([...(history.projects[projectKey] ?? []), parseRecord(record, "record")]);
    });
  }

  private retain(records: FrictionRecord[]): FrictionRecord[] {
    const cutoff = this.now().getTime() - RETENTION_MS;
    return records
      .filter((record) => Date.parse(record.timestamp) >= cutoff)
      .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
      .slice(-MAX_PROJECT_RECORDS);
  }
}

export function frictionHistoryFile(agentDir: string): string {
  return path.join(agentDir, "auto-approval-friction.json");
}
