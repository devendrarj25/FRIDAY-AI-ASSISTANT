/**
 * The retrieval ways wired to FRIDAY's real stores, for the Brain check panel.
 */

import { memory } from "./memory-engine";
import { vectorIndex, type VectorHit } from "../brain/vector-index";
import { casesFrom, evaluateWays, type RetrievalWay, type WayResult } from "./retrieval-ab";

const ids = (hits: VectorHit[]) =>
  hits.map((hit) => hit.id).filter((id): id is string => Boolean(id));

export function realWays(judgeModel = ""): RetrievalWay[] {
  return [
    {
      id: "words",
      label: "word index",
      rank: async (query) => memory.retrieve(query, 5).map((hit) => hit.item.id),
    },
    {
      id: "hashed",
      label: "hashed vectors",
      rank: async (query) => {
        const hits = await vectorIndex.queryHits(query, 5, "none");
        return hits.length ? ids(hits) : null;
      },
    },
    {
      id: "embedding",
      label: "hashed vectors + embedding model",
      rank: async (query) => {
        const hits = await vectorIndex.queryHits(query, 5, "embedding");
        return hits.length ? ids(hits) : null;
      },
    },
    {
      id: "judge",
      label: judgeModel ? `hashed vectors + judge ${judgeModel}` : "hashed vectors + rerank judge",
      rank: async (query) => {
        const chosen = judgeModel || vectorIndex.rerankModelProvider();
        if (!chosen) return null;
        const hits = await vectorIndex.queryHits(query, 5, "judge", chosen);
        return hits.length ? ids(hits) : null;
      },
    },
  ];
}

export async function runRetrievalAb(
  limit = 30,
  judgeModel = "",
): Promise<{ cases: number; results: WayResult[] }> {
  const items = memory
    .getSnapshot()
    .items.filter(
      (item) => item.tier !== "archived" && !item.supersededAt && item.text.length > 40,
    );
  const cases = casesFrom(items, limit);
  return { cases: cases.length, results: await evaluateWays(cases, realWays(judgeModel)) };
}
