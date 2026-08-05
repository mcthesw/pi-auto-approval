import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ToolCall = {
  id: string;
  name: string;
  input: unknown;
};

export type RuleAction = "allow" | "ask" | "deny";

export type ExactInputMatcher = {
  kind: "exact";
  value: JsonValue;
};

export type FieldMatcher =
  | { kind: "exact"; value: JsonValue }
  | { kind: "tokenPrefix"; tokens: string[] }
  | { kind: "pathGlob"; pattern: string };

export type ToolSourceIdentity = {
  source: string;
  path: string;
};

export type ToolMatcher = {
  tool: string;
  /** New external-tool rules use this automatically when Pi provides sourceInfo. */
  source?: ToolSourceIdentity;
  input: ExactInputMatcher | { kind: "any" } | { kind: "fields"; fields: Record<string, FieldMatcher> };
};

export type Rule = {
  id: string;
  action: RuleAction;
  matcher: ToolMatcher;
};

export type ReviewerConfig = {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
};

export type ProjectConfig = {
  rules: Rule[];
};

export type AutoApprovalConfig = {
  version: 2;
  reviewer?: ReviewerConfig;
  globalRules: Rule[];
  projects: Record<string, ProjectConfig>;
};

export type ReviewDecision = RuleAction;
export type UserConfirmationChoice = "allow_once" | "always" | "deny" | "cancelled";

export type FrictionRecord = {
  id: string;
  timestamp: string;
  tool: {
    name: string;
    source?: ToolSourceIdentity;
  };
  input: JsonValue;
  reviewDecision?: ReviewDecision;
  userChoice?: UserConfirmationChoice;
};

export type FrictionHistory = {
  version: 1;
  projects: Record<string, FrictionRecord[]>;
};

export const EMPTY_PROJECT_CONFIG: Readonly<ProjectConfig> = Object.freeze({ rules: [] });

export function defaultAutoApprovalConfig(): AutoApprovalConfig {
  return { version: 2, globalRules: [], projects: {} };
}
