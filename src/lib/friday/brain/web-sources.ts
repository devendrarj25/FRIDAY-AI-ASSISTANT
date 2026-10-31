/**
 * FRIDAY · how far to trust a web source, and whether a citation holds
 *
 * Research is only as good as its sources. This sorts a link into a kind of site (an official or
 * academic one, a code host, a news outlet, a community forum, a social post) and gives each kind a
 * trust figure, notes when other sites carry the same figures, and checks that a sentence which cites
 * a source says something that source's own text supports. It reads only the title, link and snippet
 * the search returned, so it never fetches anything, and "supported" means the words overlap, not that
 * the claim is true.
 */

export type SourceKind =
  "official" | "research" | "reference" | "code-host" | "news" | "community" | "social" | "unknown";

export type SourceTrust = { kind: SourceKind; trust: number; reason: string; host: string };

const NEWS =
  /(^|\.)(reuters\.com|apnews\.com|bbc\.(com|co\.uk)|thehindu\.com|indianexpress\.com|ndtv\.com|timesofindia\.indiatimes\.com|livemint\.com|economictimes\.indiatimes\.com|theguardian\.com|nytimes\.com|wsj\.com|ft\.com|bloomberg\.com)$/;
const COMMUNITY =
  /(^|\.)(stackoverflow\.com|stackexchange\.com|reddit\.com|medium\.com|substack\.com|dev\.to|quora\.com|hashnode\.dev|blogspot\.com|wordpress\.com|news\.ycombinator\.com)$/;
const SOCIAL =
  /(^|\.)(x\.com|twitter\.com|facebook\.com|instagram\.com|tiktok\.com|linkedin\.com|threads\.net|t\.me)$/;
const RESEARCH =
  /(^|\.)(arxiv\.org|doi\.org|pubmed\.ncbi\.nlm\.nih\.gov|nature\.com|science\.org|acm\.org|ieee\.org|springer\.com|sciencedirect\.com|openreview\.net|aclanthology\.org)$/;
const CODE_HOST =
  /(^|\.)(github\.com|gitlab\.com|pypi\.org|npmjs\.com|crates\.io|huggingface\.co)$/;
const REFERENCE =
  /(^|\.)(wikipedia\.org|britannica\.com|developer\.mozilla\.org|w3\.org|ietf\.org)$/;
const OFFICIAL_HOST = /^(docs|developer|developers|learn|support|help|platform)\./;
const OFFICIAL_TLD = /\.(gov|edu|mil)(\.[a-z]{2})?$|(^|\.)(gov|nic|ac)\.in$|\.ac\.[a-z]{2}$/;

export function hostOf(url: string): string {
  try {
    return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function classifyUrl(url: string): SourceTrust {
  const host = hostOf(url);
  const insecure = String(url).startsWith("http://") ? 0.05 : 0;
  const make = (kind: SourceKind, trust: number, reason: string): SourceTrust => ({
    kind,
    trust: Math.max(0, +(trust - insecure).toFixed(2)),
    reason: insecure ? `${reason}; not https` : reason,
    host,
  });
  if (!host) return { kind: "unknown", trust: 0.2, reason: "not a readable link", host };
  if (OFFICIAL_TLD.test(host))
    return make("official", 0.9, "government, university or institution domain");
  if (RESEARCH.test(host)) return make("research", 0.85, "research or publisher site");
  if (OFFICIAL_HOST.test(host)) return make("official", 0.85, "a documentation or support host");
  if (REFERENCE.test(host)) return make("reference", 0.7, "reference site");
  if (CODE_HOST.test(host)) return make("code-host", 0.7, "code or package host");
  if (NEWS.test(host)) return make("news", 0.65, "news outlet");
  if (COMMUNITY.test(host)) return make("community", 0.4, "forum or open blog; anyone can post");
  if (SOCIAL.test(host)) return make("social", 0.3, "social post; not edited");
  return make("unknown", 0.45, "site not classified");
}

const STOP = new Set(
  "the a an and or of to in on for with is are was were be been it this that as at by from not no can will has have had which who what when where how its their his her they them our your you i we also than then into over more most such per via".split(
    " ",
  ),
);

const contentTerms = (text: string): string[] =>
  Array.from(
    new Set(
      String(text || "")
        .toLowerCase()
        .match(/[a-z0-9][a-z0-9.%-]{2,}/g)
        ?.filter((word) => !STOP.has(word)) ?? [],
    ),
  );

/** Numbers and version-like tokens: the figures two sources would have to share to agree. */
const figuresOf = (text: string): string[] =>
  Array.from(new Set(String(text || "").match(/\b\d[\d,.]*\d%?|\b\d%?\b/g) ?? []));

export type SearchHit = { title: string; url: string; snippet?: string };

/** For each hit, how many OTHER sites (distinct hosts) carry at least one of the same figures. */
export function corroboration(hits: SearchHit[]): number[] {
  const figures = hits.map((hit) =>
    figuresOf(`${hit.title} ${hit.snippet ?? ""}`).filter((f) => f.length >= 2),
  );
  return hits.map((hit, i) => {
    const hosts = new Set<string>();
    hits.forEach((other, j) => {
      if (i === j || hostOf(other.url) === hostOf(hit.url)) return;
      if ((figures[j] ?? []).some((figure) => (figures[i] ?? []).includes(figure)))
        hosts.add(hostOf(other.url));
    });
    return hosts.size;
  });
}

/** The 0..1 score a search result gets: what kind of site it is, https, a useful snippet. */
export function sourceScore(hit: SearchHit): number {
  const { trust } = classifyUrl(hit.url);
  const snippet = (hit.snippet ?? "").length > 80 ? 0.08 : 0;
  return Math.min(1, +(0.2 + trust * 0.7 + snippet).toFixed(2));
}

export type CitationProblem = { sentence: string; url: string; reason: string };

const URL_IN_TEXT = /https?:\/\/[^\s)\]>"']+/g;

/**
 * Every sentence of an answer that carries a link is checked: the link must be one that was retrieved,
 * and the sentence must share enough content words with that source's title and snippet. Sentences
 * with no link are not judged here.
 */
export function checkCitations(answer: string, sources: SearchHit[]): CitationProblem[] {
  const problems: CitationProblem[] = [];
  const byUrl = new Map(sources.map((source) => [source.url.replace(/[/.,;]+$/, ""), source]));
  const sentences = String(answer || "").split(/(?<=[.!?])\s+|\n+/);
  for (const raw of sentences) {
    const urls = raw.match(URL_IN_TEXT);
    if (!urls) continue;
    const claim = raw.replace(URL_IN_TEXT, " ");
    const claimTerms = contentTerms(claim);
    if (claimTerms.length < 4) continue; // a bare link or a short label makes no claim to check
    for (const found of urls) {
      const url = found.replace(/[/.,;]+$/, "");
      const source = byUrl.get(url);
      if (!source) {
        problems.push({
          sentence: claim.trim().slice(0, 120),
          url,
          reason: "cites a link that was not retrieved",
        });
        continue;
      }
      const sourceTerms = new Set(contentTerms(`${source.title} ${source.snippet ?? ""}`));
      const shared = claimTerms.filter((term) => sourceTerms.has(term)).length;
      if (sourceTerms.size >= 6 && shared < Math.max(2, Math.ceil(claimTerms.length * 0.34))) {
        problems.push({
          sentence: claim.trim().slice(0, 120),
          url,
          reason: "says something its cited source's text does not mention",
        });
      }
    }
  }
  return problems;
}
