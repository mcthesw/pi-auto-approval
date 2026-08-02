import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ToolCall = {
  id: string;
  name: string;
  input: unknown;
};

export type DecisionRoute = "approve" | "deny" | "ask_user" | "auto_review";

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

export type SpecificToolMatcher = {
  tool: string;
  input: ExactInputMatcher | { kind: "fields"; fields: Record<string, FieldMatcher> };
};

export type ToolWideMatcher = {
  tool: string;
  source: ToolSourceIdentity;
  input: { kind: "any" };
};

export type ToolMatcher = SpecificToolMatcher | ToolWideMatcher;

export type ApprovalRule = {
  id: string;
  matcher: ToolMatcher;
};

export type GlobalApprovalRule = {
  id: string;
  matcher: ToolWideMatcher;
};

export type PolicyRule = {
  id: string;
  matcher: SpecificToolMatcher;
  route: DecisionRoute;
};

export type ReviewerConfig = {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
};

export type ProjectConfig = {
  policyRules: PolicyRule[];
  approvalRules: ApprovalRule[];
};

export type AutoApprovalConfig = {
  version: 1;
  reviewer?: ReviewerConfig;
  globalApprovalRules: GlobalApprovalRule[];
  projects: Record<string, ProjectConfig>;
};

export const EMPTY_PROJECT_CONFIG: Readonly<ProjectConfig> = Object.freeze({
  policyRules: [],
  approvalRules: [],
});

export function defaultAutoApprovalConfig(): AutoApprovalConfig {
  return { version: 1, globalApprovalRules: [], projects: {} };
}
