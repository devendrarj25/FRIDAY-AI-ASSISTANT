/**
 * The Models page shows the same source and date the classifier uses.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  PROVIDER_KNOWLEDGE_VIEW,
  knowledgeAgeLabel,
  providerKnowledgeLine,
} from "../../src/lib/friday/knowledge-age";

const require_ = createRequire(import.meta.url);
const access = require_("../../electron/model-access.cjs");

describe("model knowledge age", () => {
  it("matches every official source date in model-access", () => {
    const rows = access.knowledgeCatalogue(Date.parse("2026-10-01T00:00:00Z"));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const view = PROVIDER_KNOWLEDGE_VIEW[row.id];
      expect(view, row.id).toBeTruthy();
      expect(view?.source).toBe(row.source);
      expect(view ? Date.parse(view.checkedAt) : 0).toBe(row.checkedAt);
    }
  });

  it("says unknown when the date or source is missing", () => {
    const now = Date.parse("2026-10-08T00:00:00Z");
    expect(knowledgeAgeLabel(null, now)).toBe("age unknown");
    expect(knowledgeAgeLabel(Date.parse("2026-10-09T00:00:00Z"), now)).toBe("age unknown");
    expect(knowledgeAgeLabel(Date.parse("2026-10-07T00:00:00Z"), now)).toBe("1 day old");
    expect(providerKnowledgeLine(undefined, now)).toBe("Source unknown · age unknown");
    expect(providerKnowledgeLine(PROVIDER_KNOWLEDGE_VIEW["groq"], now)).toContain(
      "console.groq.com/docs/models",
    );
    expect(providerKnowledgeLine(PROVIDER_KNOWLEDGE_VIEW["groq"], now)).toContain("2026-10-07");
  });
});
