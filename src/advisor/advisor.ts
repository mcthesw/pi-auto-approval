import type { ReviewerConfig } from "../domain.ts";
import type { AutomatedReviewer } from "../review/reviewer.ts";
import { buildAdvisorPrompt, ADVISOR_SYSTEM_PROMPT, type AdvisorRequest } from "./prompt.ts";
import { parseAdvisorResponse, type ApprovalRuleProposal } from "./schema.ts";

export type AdvisorSuggestion = ApprovalRuleProposal & {
  stats: {
    calls: number;
    userConfirmations: number;
    automatedReviews: number;
  };
};

export class RuleAdvisor {
  private readonly reviewer: AutomatedReviewer;

  constructor(reviewer: AutomatedReviewer) {
    this.reviewer = reviewer;
  }

  async suggest(config: ReviewerConfig, request: AdvisorRequest, signal?: AbortSignal): Promise<AdvisorSuggestion[]> {
    const projectApprovalRules = request.config.projects[request.projectKey]?.approvalRules ?? [];
    const response = await this.reviewer.complete(
      config,
      request.projectRoot,
      ADVISOR_SYSTEM_PROMPT,
      buildAdvisorPrompt(request),
      "Rule Advisor",
      signal,
    );
    const proposals = parseAdvisorResponse(response, {
      records: request.records,
      tools: request.tools.map((tool) => ({ name: tool.name, ...(tool.source ? { source: tool.source } : {}) })),
      projectApprovalRules,
      globalMatchers: request.config.globalApprovalRules.map((rule) => rule.matcher),
    });
    const records = new Map(request.records.map((record) => [record.id, record]));
    return proposals
      .map((proposal) => {
        const supporting = proposal.supportingRecordIds.flatMap((id) => {
          const record = records.get(id);
          return record ? [record] : [];
        });
        return {
          ...proposal,
          stats: {
            calls: supporting.length,
            userConfirmations: supporting.filter((record) => record.userChoice !== undefined).length,
            automatedReviews: supporting.filter((record) => record.reviewDecision !== undefined).length,
          },
        };
      })
      .sort((left, right) =>
        right.stats.calls - left.stats.calls
        || right.stats.userConfirmations - left.stats.userConfirmations);
  }
}
