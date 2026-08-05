import type { ReviewerConfig } from "../domain.ts";
import type { AutomatedReviewer } from "../review/reviewer.ts";
import { buildAdvisorPrompt, ADVISOR_SYSTEM_PROMPT, type AdvisorRequest } from "./prompt.ts";
import { AdvisorResponseError, parseAdvisorResponseDetailed, type RuleSuggestion } from "./schema.ts";

export type AdvisorSuggestion = RuleSuggestion & {
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
    if (!request.records.length) return [];
    const projectRules = request.config.projects[request.projectKey]?.rules ?? [];
    const parse = (response: string): RuleSuggestion[] => {
      const parsed = parseAdvisorResponseDetailed(response, {
        records: request.records,
        tools: request.tools.map((tool) => ({ name: tool.name, ...(tool.source ? { source: tool.source } : {}) })),
        projectRules,
        globalRules: request.config.globalRules,
      });
      if (parsed.hadProposals && parsed.suggestions.length === 0) {
        const summary = parsed.rejectionReasons.join("; ").slice(0, 2_000);
        throw new AdvisorResponseError(`Rule Advisor proposals were all invalid${summary ? `: ${summary}` : ""}`);
      }
      return parsed.suggestions;
    };
    const proposals = await this.reviewer.completeStructured(
      config,
      request.projectRoot,
      ADVISOR_SYSTEM_PROMPT,
      buildAdvisorPrompt(request),
      "Rule Advisor",
      parse,
      signal,
    );
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
