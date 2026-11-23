/**
 * FRIDAY · the held-out speech evaluation set: its manifest, its guarantees and its scorer.
 *
 * Pure rules, no file, audio, model, network or clock. A manifest lists recordings by id and SHA-256; the
 * audio and the reference sentences stay outside the repository (public sets are fetched by the person
 * who runs the check, the owner's own recordings never leave his PC). The manifest is strict: a field it
 * does not know (an inline audio blob, a private sentence) is a problem, a licence must be a reuse
 * licence that fits the kind of source, consent is recorded, and the test split is held apart from the
 * training data by the same audio, the same sentence, the same speaker (public sets) and by a freeze lock
 * over the test items. Scoring reuses `transcript-scorer.ts` and refuses to print a number for a
 * transcript the manifest does not list, a reference it did not hash, a test set that is not frozen, or an
 * empty split. A small group is shown but is never marked as a claim.
 *
 * The SHA-256 function is injected (`node:crypto` in the script and the tests), so this file stays free of
 * any Node import.
 */
import {
  scoreEngine,
  type GroupScore,
  type ScoredSample,
  type SpeechLang,
} from "./transcript-scorer";

export type Sha256 = (text: string) => string;
export type EvalSplit = "train" | "dev" | "test";
export type SourceKind = "public-dataset" | "own-recording" | "synthetic";

export const EVAL_LANGUAGES: readonly SpeechLang[] = ["hi", "en", "hinglish"];
export const EVAL_SPLITS: readonly EvalSplit[] = ["test", "dev", "train"];
/** The rooms and set-ups a result is split by. */
export const EVAL_CONDITIONS = [
  "quiet",
  "noisy",
  "far-field",
  "tv-background",
  "headset",
  "phone-speaker",
] as const;
/** Fewer items than this in a group and its numbers are shown but are not a claim. */
export const MIN_ITEMS_FOR_CLAIM = 30;

/** Reuse licences by source kind. A non-commercial or share-alike licence is not on the list. */
export const LICENCES_BY_KIND: Readonly<Record<SourceKind, readonly string[]>> = {
  "public-dataset": ["CC0-1.0", "CC-BY-4.0", "MIT", "Apache-2.0"],
  "own-recording": ["owner-private"],
  synthetic: ["synthetic-own"],
};
const CONSENT_BY_KIND: Readonly<Record<SourceKind, readonly string[]>> = {
  "public-dataset": ["public-licence"],
  "own-recording": ["owner-self", "speaker-written"],
  synthetic: ["synthetic"],
};

export type EvalSource = {
  id: string;
  name: string;
  kind: SourceKind;
  licence: string;
  licenceUrl?: string;
  licenceCheckedOn: string;
  access: "open" | "gated" | "local-only";
  origin: string;
  languages: SpeechLang[];
  uses: Array<"evaluate" | "train">;
  consent: { basis: string; recordedOn?: string };
  note?: string;
};

export type EvalItem = {
  id: string;
  source: string;
  language: SpeechLang;
  split: EvalSplit;
  condition: string;
  speaker: string;
  room: string;
  /** SHA-256 of the audio file, which is kept outside the repository. */
  sha256: string;
  /** SHA-256 of the NFC reference sentence (UTF-8), which is kept outside the repository. */
  referenceSha256: string;
  durationMs: number;
};

export type EvalManifest = {
  schema: 1;
  id: string;
  title: string;
  createdOn: string;
  sources: EvalSource[];
  items: EvalItem[];
  testLock: { sha256: string; items: number; frozenOn: string } | null;
};

const MANIFEST_KEYS = ["schema", "id", "title", "createdOn", "sources", "items", "testLock"];
const SOURCE_KEYS = [
  "id",
  "name",
  "kind",
  "licence",
  "licenceUrl",
  "licenceCheckedOn",
  "access",
  "origin",
  "languages",
  "uses",
  "consent",
  "note",
];
const CONSENT_KEYS = ["basis", "recordedOn"];
const ITEM_KEYS = [
  "id",
  "source",
  "language",
  "split",
  "condition",
  "speaker",
  "room",
  "sha256",
  "referenceSha256",
  "durationMs",
];
const LOCK_KEYS = ["sha256", "items", "frozenOn"];

const HEX64 = /^[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PSEUDONYM = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
const IDENT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isStr = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);

function unknownKeys(value: Obj, allowed: readonly string[], label: string, out: string[]) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) out.push(`${label}: unknown field "${key}"`);
  }
}

/** The SHA-256 over the test items (id, audio, reference, language, source, condition), in id order. */
export function testSetLock(manifest: EvalManifest, sha256: Sha256): string {
  const lines = manifest.items
    .filter((item) => item.split === "test")
    .map((i) => [i.id, i.sha256, i.referenceSha256, i.language, i.source, i.condition].join("\t"))
    .sort();
  return sha256(lines.join("\n"));
}

function checkSource(raw: unknown, index: number, out: string[]): EvalSource | null {
  if (!isObj(raw)) {
    out.push(`source #${index}: must be an object`);
    return null;
  }
  const id = isStr(raw["id"]) ? raw["id"] : `#${index}`;
  const label = `source ${id}`;
  const before = out.length;
  unknownKeys(raw, SOURCE_KEYS, label, out);
  if (!isStr(raw["id"]) || !IDENT.test(raw["id"]))
    out.push(`${label}: id must be a short plain id`);
  if (!isStr(raw["name"])) out.push(`${label}: name is empty`);
  if (!oneOf(Object.keys(LICENCES_BY_KIND) as SourceKind[], raw["kind"])) {
    out.push(
      `${label}: kind "${String(raw["kind"])}" is not public-dataset, own-recording or synthetic`,
    );
  }
  const everyLicence = Object.values(LICENCES_BY_KIND).flat();
  if (!isStr(raw["licence"]) || !everyLicence.includes(raw["licence"])) {
    out.push(`${label}: licence "${String(raw["licence"])}" is not allowed (reuse licences only)`);
  } else if (
    typeof raw["kind"] === "string" &&
    raw["kind"] in LICENCES_BY_KIND &&
    !LICENCES_BY_KIND[raw["kind"] as SourceKind].includes(raw["licence"])
  ) {
    out.push(`${label}: licence "${raw["licence"]}" does not fit kind ${String(raw["kind"])}`);
  }
  if (
    raw["licenceUrl"] !== undefined &&
    !(isStr(raw["licenceUrl"]) && raw["licenceUrl"].startsWith("https://"))
  ) {
    out.push(`${label}: licenceUrl must be an https link`);
  }
  if (!isStr(raw["licenceCheckedOn"]) || !DATE.test(raw["licenceCheckedOn"])) {
    out.push(`${label}: licenceCheckedOn must be a date YYYY-MM-DD`);
  }
  if (!oneOf(["open", "gated", "local-only"] as const, raw["access"])) {
    out.push(`${label}: access must be open, gated or local-only`);
  }
  if (!isStr(raw["origin"])) out.push(`${label}: origin is empty`);
  if (
    !Array.isArray(raw["languages"]) ||
    !raw["languages"].length ||
    !raw["languages"].every((l) => oneOf(EVAL_LANGUAGES, l))
  ) {
    out.push(`${label}: languages must list hi, en or hinglish`);
  }
  if (
    !Array.isArray(raw["uses"]) ||
    !raw["uses"].length ||
    !raw["uses"].every((u) => oneOf(["evaluate", "train"] as const, u))
  ) {
    out.push(`${label}: uses must list evaluate and/or train`);
  }
  const consent = raw["consent"];
  if (!isObj(consent)) {
    out.push(`${label}: consent is missing`);
  } else {
    unknownKeys(consent, CONSENT_KEYS, `${label} consent`, out);
    const allowed = CONSENT_BY_KIND[raw["kind"] as SourceKind];
    if (allowed && !(isStr(consent["basis"]) && allowed.includes(consent["basis"]))) {
      out.push(
        `${label}: consent basis "${String(consent["basis"])}" does not fit kind ${String(raw["kind"])}`,
      );
    }
    if (
      raw["kind"] === "own-recording" &&
      !(isStr(consent["recordedOn"]) && DATE.test(consent["recordedOn"]))
    ) {
      out.push(`${label}: consent needs recordedOn (a date YYYY-MM-DD)`);
    }
  }
  return out.length === before ? (raw as unknown as EvalSource) : null;
}

function checkItem(raw: unknown, index: number, out: string[]): EvalItem | null {
  if (!isObj(raw)) {
    out.push(`item #${index}: must be an object`);
    return null;
  }
  const id = isStr(raw["id"]) ? raw["id"] : `#${index}`;
  const label = `item ${id}`;
  const before = out.length;
  unknownKeys(raw, ITEM_KEYS, label, out);
  if (!isStr(raw["id"]) || !IDENT.test(raw["id"]))
    out.push(`${label}: id must be a short plain id`);
  if (!isStr(raw["source"])) out.push(`${label}: source is empty`);
  if (!oneOf(EVAL_LANGUAGES, raw["language"]))
    out.push(`${label}: language "${String(raw["language"])}" is not hi, en or hinglish`);
  if (!oneOf(EVAL_SPLITS, raw["split"]))
    out.push(`${label}: split "${String(raw["split"])}" is not train, dev or test`);
  if (!oneOf(EVAL_CONDITIONS, raw["condition"])) {
    out.push(
      `${label}: condition "${String(raw["condition"])}" is not one of ${EVAL_CONDITIONS.join(", ")}`,
    );
  }
  for (const key of ["speaker", "room"] as const) {
    if (!(isStr(raw[key]) && PSEUDONYM.test(raw[key] as string))) {
      out.push(
        `${label}: ${key} must be a plain pseudonym (letters, digits, . _ -), never a name or address`,
      );
    }
  }
  for (const key of ["sha256", "referenceSha256"] as const) {
    if (!(isStr(raw[key]) && HEX64.test(raw[key] as string))) {
      out.push(`${label}: ${key} must be 64 lowercase hex characters`);
    }
  }
  const ms = raw["durationMs"];
  if (!(typeof ms === "number" && Number.isInteger(ms) && ms > 0 && ms <= 3_600_000)) {
    out.push(`${label}: durationMs must be a whole number of milliseconds`);
  }
  return out.length === before ? (raw as unknown as EvalItem) : null;
}

/**
 * Check a manifest. `problems` is empty only when the shape, licences, consent, use, held-out guarantees and
 * (when the test set is frozen) the lock are all right.
 */
export function validateManifest(
  raw: unknown,
  sha256: Sha256,
): { ok: boolean; problems: string[]; manifest?: EvalManifest } {
  const problems: string[] = [];
  if (!isObj(raw)) return { ok: false, problems: ["manifest: must be an object"] };
  unknownKeys(raw, MANIFEST_KEYS, "manifest", problems);
  if (raw["schema"] !== 1) problems.push("manifest: schema must be 1");
  if (!isStr(raw["id"])) problems.push("manifest: id is empty");
  if (!isStr(raw["title"])) problems.push("manifest: title is empty");
  if (!isStr(raw["createdOn"]) || !DATE.test(raw["createdOn"]))
    problems.push("manifest: createdOn must be a date YYYY-MM-DD");
  if (!Array.isArray(raw["sources"])) problems.push("manifest: sources must be a list");
  if (!Array.isArray(raw["items"])) problems.push("manifest: items must be a list");
  if (!Array.isArray(raw["sources"]) || !Array.isArray(raw["items"]))
    return { ok: false, problems };

  const sources = new Map<string, EvalSource>();
  raw["sources"].forEach((entry, index) => {
    const source = checkSource(entry, index, problems);
    if (!source) return;
    if (sources.has(source.id)) problems.push(`duplicate source id "${source.id}"`);
    sources.set(source.id, source);
  });

  const items: EvalItem[] = [];
  const ids = new Set<string>();
  raw["items"].forEach((entry, index) => {
    const rawId = isObj(entry) && isStr(entry["id"]) ? entry["id"] : null;
    const repeated = rawId !== null && ids.has(rawId);
    if (repeated) problems.push(`duplicate item id "${rawId}"`);
    if (rawId !== null) ids.add(rawId);
    const item = checkItem(entry, index, problems);
    if (!item || repeated) return;
    const source = sources.get(item.source);
    if (!source) {
      problems.push(`item ${item.id}: unknown source "${item.source}"`);
    } else {
      if (!source.languages.includes(item.language)) {
        problems.push(
          `item ${item.id}: language "${item.language}" is not listed for source ${source.id}`,
        );
      }
      const use = item.split === "train" ? "train" : "evaluate";
      if (!source.uses.includes(use)) {
        problems.push(
          `item ${item.id}: split ${item.split} is not allowed for source ${source.id} (uses: ${source.uses.join(", ")})`,
        );
      }
    }
    items.push(item);
  });

  // owner-self consent covers the owner alone
  for (const source of sources.values()) {
    if (source.consent.basis !== "owner-self") continue;
    const speakers = new Set(items.filter((i) => i.source === source.id).map((i) => i.speaker));
    if (speakers.size > 1) {
      problems.push(
        `source ${source.id}: consent owner-self covers one speaker, found ${speakers.size}`,
      );
    }
  }

  // held-out guarantees
  const byAudio = new Map<string, EvalItem>();
  const byReference = new Map<string, EvalItem>();
  for (const item of items) {
    const sameAudio = byAudio.get(item.sha256);
    if (sameAudio) problems.push(`same audio sha256 in items ${sameAudio.id} and ${item.id}`);
    else byAudio.set(item.sha256, item);
    const sameReference = byReference.get(item.referenceSha256);
    if (sameReference && sameReference.split !== item.split) {
      problems.push(
        `same reference in items ${sameReference.id} and ${item.id} across splits ${sameReference.split} and ${item.split}`,
      );
    } else if (!sameReference) byReference.set(item.referenceSha256, item);
  }
  const speakerSplits = new Map<string, Set<EvalSplit>>();
  for (const item of items) {
    const source = sources.get(item.source);
    if (!source || source.consent.basis === "owner-self") continue;
    const key = `${item.source}\t${item.speaker}`;
    const set = speakerSplits.get(key) ?? new Set<EvalSplit>();
    set.add(item.split);
    speakerSplits.set(key, set);
  }
  for (const [key, set] of speakerSplits) {
    if (set.size < 2) continue;
    const [sourceId, speaker] = key.split("\t");
    const names = EVAL_SPLITS.filter((s) => set.has(s));
    problems.push(`speaker ${speaker} of source ${sourceId} is in splits ${names.join(" and ")}`);
  }

  const lock = raw["testLock"];
  let testLock: EvalManifest["testLock"] = null;
  if (lock !== null && lock !== undefined) {
    if (!isObj(lock)) {
      problems.push("manifest: testLock must be an object or null");
    } else {
      unknownKeys(lock, LOCK_KEYS, "testLock", problems);
      if (
        !(isStr(lock["sha256"]) && HEX64.test(lock["sha256"])) ||
        typeof lock["items"] !== "number" ||
        !isStr(lock["frozenOn"]) ||
        !DATE.test(lock["frozenOn"])
      ) {
        problems.push("manifest: testLock needs sha256, items and frozenOn");
      } else {
        testLock = { sha256: lock["sha256"], items: lock["items"], frozenOn: lock["frozenOn"] };
      }
    }
  }

  if (problems.length) return { ok: false, problems };
  const manifest: EvalManifest = {
    schema: 1,
    id: raw["id"] as string,
    title: raw["title"] as string,
    createdOn: raw["createdOn"] as string,
    sources: [...sources.values()],
    items,
    testLock,
  };
  if (testLock) {
    const tests = items.filter((i) => i.split === "test").length;
    if (testLock.items !== tests || testLock.sha256 !== testSetLock(manifest, sha256)) {
      return {
        ok: false,
        problems: [
          `test set changed after it was frozen on ${testLock.frozenOn} (lock covers ${testLock.items} items, manifest has ${tests})`,
        ],
      };
    }
  }
  return { ok: true, problems: [], manifest };
}

export type ManifestSummary = {
  splits: Record<EvalSplit, { items: number; speakers: number; rooms: number; hours: number }>;
  byLanguage: Record<SpeechLang, Record<EvalSplit, number>>;
  byCondition: Record<string, number>;
  frozen: boolean;
};

/** How big each split is, by language and condition. Counts only; nothing here is a score. */
export function manifestSummary(manifest: EvalManifest): ManifestSummary {
  const zero = (): Record<EvalSplit, number> => ({ train: 0, dev: 0, test: 0 });
  const summary: ManifestSummary = {
    splits: {
      train: { items: 0, speakers: 0, rooms: 0, hours: 0 },
      dev: { items: 0, speakers: 0, rooms: 0, hours: 0 },
      test: { items: 0, speakers: 0, rooms: 0, hours: 0 },
    },
    byLanguage: { hi: zero(), en: zero(), hinglish: zero() },
    byCondition: {},
    frozen: manifest.testLock !== null,
  };
  for (const split of EVAL_SPLITS) {
    const rows = manifest.items.filter((i) => i.split === split);
    summary.splits[split] = {
      items: rows.length,
      speakers: new Set(rows.map((i) => `${i.source}:${i.speaker}`)).size,
      rooms: new Set(rows.map((i) => `${i.source}:${i.room}`)).size,
      hours: rows.reduce((sum, i) => sum + i.durationMs, 0) / 3_600_000,
    };
  }
  for (const item of manifest.items) {
    summary.byLanguage[item.language][item.split] += 1;
    summary.byCondition[item.condition] = (summary.byCondition[item.condition] ?? 0) + 1;
  }
  return summary;
}

export type ClaimedGroup = GroupScore & { claimable: boolean };
export type HeldOutReport = {
  manifestId: string;
  split: "test" | "dev";
  engine: string;
  lock: string | null;
  items: number;
  /** Items with no transcript: scored as everything missed. */
  missing: string[];
  overall: ClaimedGroup;
  byLanguage: Partial<Record<SpeechLang, ClaimedGroup>>;
  byCondition: Record<string, ClaimedGroup>;
  byLanguageCondition: Record<string, ClaimedGroup>;
  verdicts: Partial<Record<SpeechLang, "within" | "uncertain" | "over" | "insufficient">>;
  method: string;
  notes: string[];
};

export type HeldOutResult =
  { status: "scored"; report: HeldOutReport } | { status: "refused"; reasons: string[] };

const METHOD =
  "Corpus WER and CER (total edits over total reference words or letters) from transcript-scorer.ts; the 95% range resamples items with a seeded generator, so one speaker with many items makes it optimistic; the same normaliser as kernel/stt_bench.py.";

const has = (record: Record<string, string>, key: string) => Object.hasOwn(record, key);

/**
 * Score transcripts against the manifest, or refuse. Nothing is reported for a transcript the manifest does
 * not list, a reference whose hash differs from the manifest, a test split that is not frozen, an invalid
 * manifest, or a split with no items.
 */
export function scoreHeldOut(input: {
  manifest: unknown;
  references: Record<string, string>;
  hypotheses: Record<string, string>;
  sha256: Sha256;
  split?: "test" | "dev";
  engine?: string;
  minItems?: number;
}): HeldOutResult {
  const split = input.split ?? "test";
  if (split !== "test" && split !== "dev") {
    return {
      status: "refused",
      reasons: [`split ${String(split)} is never scored (only test and dev)`],
    };
  }
  const checked = validateManifest(input.manifest, input.sha256);
  if (!checked.manifest) {
    return { status: "refused", reasons: ["manifest is not valid", ...checked.problems] };
  }
  const manifest = checked.manifest;
  const scope = manifest.items.filter((i) => i.split === split);
  if (!scope.length) {
    return {
      status: "refused",
      reasons: [`no items in split ${split}: nothing to score, no number to report`],
    };
  }
  if (split === "test" && !manifest.testLock) {
    return {
      status: "refused",
      reasons: ["the test set is not frozen: freeze it before reporting a test number"],
    };
  }

  const reasons: string[] = [];
  const known = new Map(manifest.items.map((i) => [i.id, i]));
  for (const id of Object.keys(input.hypotheses)) {
    const entry = known.get(id);
    if (!entry) reasons.push(`no manifest entry for ${id}`);
    else if (entry.split !== split) reasons.push(`${id} is in split ${entry.split}, not ${split}`);
  }
  for (const item of scope) {
    if (!has(input.references, item.id)) {
      reasons.push(`no reference for ${item.id}`);
    } else if (
      input.sha256((input.references[item.id] ?? "").normalize("NFC")) !== item.referenceSha256
    ) {
      reasons.push(`reference of ${item.id} does not match the manifest hash`);
    }
  }
  if (reasons.length) return { status: "refused", reasons };

  const samples: ScoredSample[] = scope.map((item) => ({
    id: item.id,
    lang: item.language,
    reference: (input.references[item.id] ?? "").normalize("NFC"),
    hypothesis: has(input.hypotheses, item.id) ? (input.hypotheses[item.id] ?? "") : "",
  }));
  const conditionOf = new Map(scope.map((i) => [i.id, i.condition]));
  const minItems = input.minItems ?? MIN_ITEMS_FOR_CLAIM;
  const claim = (score: GroupScore): ClaimedGroup => ({
    ...score,
    claimable: score.samples >= minItems,
  });

  const whole = scoreEngine(samples);
  const byCondition: Record<string, ClaimedGroup> = {};
  const byLanguageCondition: Record<string, ClaimedGroup> = {};
  for (const condition of EVAL_CONDITIONS) {
    const rows = samples.filter((s) => conditionOf.get(s.id) === condition);
    if (!rows.length) continue;
    byCondition[condition] = claim(scoreEngine(rows).overall);
    for (const lang of EVAL_LANGUAGES) {
      const part = rows.filter((s) => s.lang === lang);
      if (part.length)
        byLanguageCondition[`${lang}/${condition}`] = claim(scoreEngine(part).overall);
    }
  }
  const byLanguage: HeldOutReport["byLanguage"] = {};
  const verdicts: HeldOutReport["verdicts"] = {};
  for (const lang of EVAL_LANGUAGES) {
    const group = whole.byLang[lang];
    if (!group) continue;
    byLanguage[lang] = claim(group);
    verdicts[lang] =
      group.samples >= minItems ? (whole.verdicts[lang] ?? "insufficient") : "insufficient";
  }

  const missing = scope.filter((i) => !has(input.hypotheses, i.id)).map((i) => i.id);
  const report: HeldOutReport = {
    manifestId: manifest.id,
    split,
    engine: input.engine ?? "unnamed",
    lock: split === "test" ? (manifest.testLock?.sha256 ?? null) : null,
    items: scope.length,
    missing,
    overall: claim(whole.overall),
    byLanguage,
    byCondition,
    byLanguageCondition,
    verdicts,
    method: METHOD,
    notes: [],
  };
  const groups = [
    report.overall,
    ...Object.values(byLanguage),
    ...Object.values(byCondition),
    ...Object.values(byLanguageCondition),
  ];
  const small = groups.filter((g) => !g.claimable).length;
  if (small) {
    report.notes.push(
      `${small} group(s) have fewer than ${minItems} items: the numbers are shown, they are not a claim`,
    );
  }
  if (missing.length) {
    report.notes.push(
      `${missing.length} item(s) had no transcript and were scored as every word missed`,
    );
  }
  return { status: "scored", report };
}
