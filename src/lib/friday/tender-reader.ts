/**
 * FRIDAY · tender / RFP reader
 *
 * Extracts only spans that actually appear in the document text. Missing
 * sections stay missing. Ambiguous wording is flagged instead of guessed.
 * Model routing reuses planPipeline with needsReasoning, and private:true so
 * a cloud model is not chosen just because it is expensive.
 */

import { planPipeline } from "./brain/orchestrator";
import { extractTender, formatTenderExtract, type TenderExtract } from "./owner-work-logic";

export function readTender(text: string): TenderExtract {
  return extractTender(text);
}

export function describeTender(text: string): string {
  return formatTenderExtract(extractTender(text));
}

/**
 * How FRIDAY would actually pick models for this document. The extract itself
 * does not call a model — it is grounded in the text. A connected model is
 * only needed when the owner wants a reasoning pass over the quoted clauses.
 */
export function tenderModelPlan(
  prompt = "extract eligibility, deadlines and submission requirements from this tender",
) {
  return planPipeline({
    prompt,
    kind: "tender",
    needsReasoning: true,
    private: true,
  });
}
