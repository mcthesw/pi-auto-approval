import { readFile } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { AutoApprovalConfigStore, autoApprovalConfigFile } from "../src/config/store.ts";
import { evaluateReviewerCases, parseReviewerEvalCases } from "../src/review/eval.ts";
import { AutomatedReviewer, PiReviewSessionFactory } from "../src/review/reviewer.ts";

const casesPath = path.resolve(import.meta.dirname, "../eval/reviewer-cases.json");

async function main(): Promise<void> {
  const agentDir = getAgentDir();
  const config = await new AutoApprovalConfigStore(autoApprovalConfigFile(agentDir)).read();
  if (!config.ok) throw new Error(`Auto Approval configuration is invalid: ${config.error}`);
  if (!config.config.reviewer) throw new Error("Configure a Reviewer model with /auto-approval before running this eval");
  const cases = parseReviewerEvalCases(JSON.parse(await readFile(casesPath, "utf8")));
  const reviewer = new AutomatedReviewer(await PiReviewSessionFactory.create(agentDir));
  const results = await evaluateReviewerCases(cases, config.config.reviewer, reviewer);
  for (const result of results) {
    const status = result.passed ? "PASS" : "FAIL";
    const actual = result.actual ?? "error";
    console.log(`${status} ${result.id}: expected ${result.expected}, got ${actual}${result.reason ? ` — ${result.reason}` : result.error ? ` — ${result.error}` : ""}`);
  }
  const failed = results.filter((result) => !result.passed);
  console.log(`\n${results.length - failed.length}/${results.length} cases passed`);
  if (failed.length) process.exitCode = 1;
}

await main();
