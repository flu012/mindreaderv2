/**
 * Entity Details Synthesis
 *
 * Merges new facts with existing entity details into a coherent
 * markdown document via LLM. Also generates a brief summary (max 200 chars).
 */

import { callLLM } from "./llm.js";
import { MAX_SUMMARY_LENGTH, MAX_DETAILS_LENGTH } from "./constants.js";

/**
 * Synthesize updated details by merging new facts with existing details.
 *
 * @param {object} opts
 * @param {string} opts.entityName - Entity name
 * @param {string} opts.existingDetails - Current details markdown (may be empty)
 * @param {string} opts.existingSummary - Current summary
 * @param {string} opts.newFacts - New information to merge
 * @param {string} opts.category - Entity category
 * @param {string[]} opts.tags - Entity tags
 * @param {object} opts.config - Server config (for LLM access)
 * @returns {Promise<{details: string, summary: string}>}
 */
export async function synthesizeDetails({ entityName, existingDetails, existingSummary, newFacts, category, tags, config }) {
  const tagStr = (tags || []).join(", ");

  const prompt = `You are updating the knowledge base entry for "${entityName}" [${category || "other"}]${tagStr ? ` (tags: ${tagStr})` : ""}.

EXISTING DETAILS:
${existingDetails || "(empty — first entry)"}

NEW INFORMATION:
${newFacts}

Instructions:
1. Merge the new information into the existing details to create a comprehensive, updated markdown document.
2. Keep all existing facts that are still relevant. Remove duplicates.
3. If new information contradicts existing details, keep the newer version and note the change.
4. Use clear markdown formatting: headers, bullet points, dates where relevant.
5. Keep it factual and concise — no filler text.
6. Also generate a brief summary (max 200 chars) that identifies the entity in one sentence.

Return JSON:
{
  "details": "Full updated markdown details (comprehensive, up to 10KB)",
  "summary": "Brief one-sentence summary (max 200 chars)"
}`;

  try {
    const result = await callLLM({ prompt, config, jsonMode: true, timeoutMs: 15000 });
    return {
      details: (typeof result.details === "string" ? result.details : "").slice(0, MAX_DETAILS_LENGTH),
      summary: (typeof result.summary === "string" ? result.summary : "").slice(0, MAX_SUMMARY_LENGTH),
    };
  } catch (err) {
    // On LLM failure, append raw facts to details
    const fallbackDetails = existingDetails
      ? `${existingDetails}\n\n---\n\n${newFacts}`
      : newFacts;
    return {
      details: fallbackDetails.slice(0, MAX_DETAILS_LENGTH),
      summary: existingSummary || entityName,
    };
  }
}
