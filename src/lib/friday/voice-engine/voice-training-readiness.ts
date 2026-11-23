/**
 * FRIDAY · training readiness, levels 1 to 3, judged from evidence.
 *
 * Pure: the spec (`config/voice/training-readiness.json`), the owner's manifest and the owner's training
 * records go in, a report of PASS, PARTIAL or UNVERIFIED per level comes out. Nothing here trains, loads or
 * ships a model, reads a recording or opens the network. A level with no evidence is UNVERIFIED, never
 * failed and never passed; a level can only pass when every check passes, the previous level passed and
 * its tooling exists. The numbers in a release record are only trusted when they come from a claimable
 * group of the frozen test set (`voice-eval-set.ts`), and a check that cannot be made says so.
 */
import {
  EVAL_LANGUAGES,
  manifestSummary,
  validateManifest,
  type EvalManifest,
  type Sha256,
} from "./voice-eval-set";

export type CheckStatus = "pass" | "fail" | "unverified";
export type Check = { id: string; status: CheckStatus; detail: string };
export type LevelStatus = "PASS" | "PARTIAL" | "UNVERIFIED";

export type ReadinessSpec = {
  schema: number;
  about?: string;
  thresholds: {
    minTestItemsPerLanguage: number;
    minTestRooms: number;
    minTestConditions: number;
    minTrainHours: number;
    adapterTolerance: number;
  };
  baseModelLicences: string[];
  levels: Array<{
    level: number;
    id: string;
    title: string;
    needs: string;
    tooling: string[];
    notBuilt: string[];
  }>;
};

export type LevelReport = {
  level: number;
  id: string;
  title: string;
  status: LevelStatus;
  needs: string;
  checks: Check[];
  notBuilt: string[];
};

export type ReadinessReport = {
  levels: LevelReport[];
  /** "recorded" only means the owner's records name an active release; nothing is shipped in this repository. */
  trainedModel: "none" | "recorded";
  summary: string;
};

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const HEX64 = /^[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const METHODS = ["lora", "adapter", "full-finetune"];

/** A hash of the sorted, de-duplicated training item ids: a run may pin the exact training set with it. */
export function trainSetSha256(ids: readonly string[], sha256: Sha256): string {
  return sha256([...new Set(ids)].sort().join("\n"));
}

const pass = (id: string, detail: string): Check => ({ id, status: "pass", detail });
const fail = (id: string, detail: string): Check => ({ id, status: "fail", detail });
const unverified = (id: string, detail: string): Check => ({ id, status: "unverified", detail });

/** Pass when `problems` is empty, fail with them otherwise. */
function verdict(id: string, problems: string[], ok: string): Check {
  return problems.length ? fail(id, problems.join("; ")) : pass(id, ok);
}

type Evidence = {
  manifest: EvalManifest | null;
  manifestProblems: string[];
  hasItems: boolean;
  runs: Obj[];
  releases: Obj[];
  sha256: Sha256;
};

function level1(spec: ReadinessSpec, ev: Evidence): Check[] {
  const t = spec.thresholds;
  const none = (id: string) => unverified(id, "no manifest with items was given");
  if (!ev.hasItems) {
    return ["manifest-valid", "own-train-hours", "test-frozen", "test-coverage"].map(none);
  }
  const checks: Check[] = [
    ev.manifest
      ? pass("manifest-valid", "schema, licences, consent and held-out guarantees hold")
      : fail("manifest-valid", ev.manifestProblems.slice(0, 5).join("; ")),
  ];
  const m = ev.manifest;
  if (!m) {
    return [
      ...checks,
      ...["own-train-hours", "test-frozen", "test-coverage"].map((id) =>
        unverified(id, "the manifest is not valid"),
      ),
    ];
  }
  const ownIds = new Set(m.sources.filter((s) => s.kind === "own-recording").map((s) => s.id));
  const hours =
    m.items
      .filter((i) => i.split === "train" && ownIds.has(i.source))
      .reduce((sum, i) => sum + i.durationMs, 0) / 3_600_000;
  checks.push(
    hours >= t.minTrainHours
      ? pass("own-train-hours", `${hours.toFixed(2)} h of the owner's consented training audio`)
      : fail(
          "own-train-hours",
          `${hours.toFixed(2)} h of the owner's consented training audio, needs ${t.minTrainHours} h`,
        ),
  );
  checks.push(
    m.testLock
      ? pass("test-frozen", `frozen on ${m.testLock.frozenOn}`)
      : fail("test-frozen", "the test set is not frozen (node scripts/voice-eval.cjs freeze)"),
  );
  const summary = manifestSummary(m);
  const problems: string[] = [];
  for (const lang of EVAL_LANGUAGES) {
    const n = summary.byLanguage[lang].test;
    if (n < t.minTestItemsPerLanguage)
      problems.push(`${lang} has ${n} test items, needs ${t.minTestItemsPerLanguage}`);
  }
  const test = m.items.filter((i) => i.split === "test");
  const rooms = new Set(test.map((i) => `${i.source}:${i.room}`)).size;
  const conditions = new Set(test.map((i) => i.condition)).size;
  if (rooms < t.minTestRooms)
    problems.push(`${rooms} rooms in the test set, needs ${t.minTestRooms}`);
  if (conditions < t.minTestConditions)
    problems.push(`${conditions} conditions in the test set, needs ${t.minTestConditions}`);
  checks.push(
    verdict("test-coverage", problems, "enough test items per language, rooms and conditions"),
  );
  return checks;
}

function level2(spec: ReadinessSpec, ev: Evidence): Check[] {
  const ids = [
    "run-recorded",
    "base-model-licence",
    "offline-attested",
    "consented-train-data",
    "no-test-leak",
    "test-set-unchanged",
    "artifact-hashed",
  ];
  if (!ev.runs.length) return ids.map((id) => unverified(id, "no training run was recorded"));
  const m = ev.manifest;
  const bad = (id: string, pick: (run: Obj, rid: string) => string[]): Check => {
    const problems = ev.runs.flatMap((run, index) => pick(run, text(run["id"]) || `#${index}`));
    return verdict(id, problems, `${ev.runs.length} run(s) checked`);
  };
  const needManifest = (
    id: string,
    pick: (run: Obj, rid: string, manifest: EvalManifest) => string[],
  ): Check =>
    m
      ? bad(id, (run, rid) => pick(run, rid, m))
      : unverified(id, "no valid manifest to check the run against");
  return [
    pass("run-recorded", `${ev.runs.length} run(s) recorded`),
    bad("base-model-licence", (run, rid) => {
      const base = isObj(run["baseModel"]) ? run["baseModel"] : {};
      const out: string[] = [];
      if (!text(base["id"]) || !text(base["revision"]))
        out.push(`${rid}: base model id and revision are required`);
      if (!spec.baseModelLicences.includes(text(base["licence"]))) {
        out.push(
          `${rid}: base model licence "${text(base["licence"])}" is not one of ${spec.baseModelLicences.join(", ")}`,
        );
      }
      return out;
    }),
    bad("offline-attested", (run, rid) =>
      run["offline"] === true && run["networkUsed"] === false
        ? []
        : [`${rid}: not recorded as offline with no network`],
    ),
    needManifest("consented-train-data", (run, rid, manifest) => {
      const out: string[] = [];
      const sources = list(run["dataSources"]).map(text);
      const trainIds = list(run["trainItemIds"]).map(text);
      if (!sources.length) out.push(`${rid}: no data source listed`);
      if (!trainIds.length) out.push(`${rid}: no training items listed`);
      for (const id of sources) {
        const source = manifest.sources.find((s) => s.id === id);
        if (!source) out.push(`${rid}: source ${id} is not in the manifest`);
        else if (!source.uses.includes("train"))
          out.push(`${rid}: source ${id} is not cleared for training`);
      }
      for (const id of trainIds) {
        const item = manifest.items.find((i) => i.id === id);
        if (!item) out.push(`${rid}: item ${id} is not in the manifest`);
        else if (item.split === "train" && !sources.includes(item.source)) {
          out.push(`${rid}: item ${id} is from source ${item.source}, which the run did not list`);
        }
      }
      if (
        run["trainSetSha256"] !== undefined &&
        run["trainSetSha256"] !== trainSetSha256(trainIds, ev.sha256)
      ) {
        out.push(`${rid}: trainSetSha256 does not match the listed items`);
      }
      return out;
    }),
    needManifest("no-test-leak", (run, rid, manifest) => {
      const held = list(run["trainItemIds"])
        .map(text)
        .filter((id) => manifest.items.some((i) => i.id === id && i.split !== "train"));
      return held.length
        ? [`${rid}: dev or test items among the training items: ${held.join(", ")}`]
        : [];
    }),
    needManifest("test-set-unchanged", (run, rid, manifest) => {
      if (!manifest.testLock) return [`${rid}: the test set is not frozen`];
      return run["testLockSha256"] === manifest.testLock.sha256
        ? []
        : [`${rid}: the test set changed since this run`];
    }),
    bad("artifact-hashed", (run, rid) => {
      const artifact = isObj(run["artifact"]) ? run["artifact"] : {};
      const out: string[] = [];
      if (!HEX64.test(text(artifact["sha256"])))
        out.push(`${rid}: artifact.sha256 must be 64 lowercase hex`);
      if (!METHODS.includes(text(run["method"])))
        out.push(`${rid}: method must be ${METHODS.join(", ")}`);
      return out;
    }),
  ];
}

type Report = {
  split: string;
  lock: string;
  overall: number | null;
  claimOverall: boolean;
  langs: Map<string, { wer: number; claim: boolean }>;
};

function readReport(value: unknown): Report | null {
  if (!isObj(value)) return null;
  const overall = isObj(value["overall"]) ? value["overall"] : {};
  const langs = new Map<string, { wer: number; claim: boolean }>();
  if (isObj(value["byLanguage"])) {
    for (const [lang, group] of Object.entries(value["byLanguage"])) {
      if (isObj(group) && typeof group["corpusWer"] === "number") {
        langs.set(lang, { wer: group["corpusWer"], claim: group["claimable"] === true });
      }
    }
  }
  return {
    split: text(value["split"]),
    lock: text(value["lock"]),
    overall: typeof overall["corpusWer"] === "number" ? overall["corpusWer"] : null,
    claimOverall: overall["claimable"] === true,
    langs,
  };
}

function level3(spec: ReadinessSpec, ev: Evidence): Check[] {
  const ids = [
    "release-recorded",
    "evaluated-on-frozen-test",
    "not-worse-than-base",
    "versioned",
    "rollback-ready",
  ];
  if (!ev.releases.length) return ids.map((id) => unverified(id, "no release was recorded"));
  const m = ev.manifest;
  const named = ev.releases.map((r, index) => ({ r, name: text(r["version"]) || `#${index}` }));
  const candidates = named.filter(({ r }) => text(r["status"]) !== "retired");
  const evaluation = (r: Obj) => (isObj(r["evaluation"]) ? r["evaluation"] : {});

  const frozen: Check = !m?.testLock
    ? unverified("evaluated-on-frozen-test", "no frozen test set in a valid manifest")
    : verdict(
        "evaluated-on-frozen-test",
        candidates.flatMap(({ r, name }) =>
          (["base", "adapter"] as const).flatMap((side) => {
            const rep = readReport(evaluation(r)[side]);
            if (!rep) return [`${name}: no ${side} report`];
            if (rep.split !== "test" || rep.lock !== m.testLock!.sha256) {
              return [`${name}: the ${side} report is not from the current frozen test set`];
            }
            return [];
          }),
        ),
        "base and adapter were scored on the current frozen test set",
      );

  const compare = verdict(
    "not-worse-than-base",
    candidates.flatMap(({ r, name }) => {
      const base = readReport(evaluation(r)["base"]);
      const adapter = readReport(evaluation(r)["adapter"]);
      if (!base || !adapter || base.overall === null || adapter.overall === null)
        return [`${name}: both reports need an overall WER`];
      const out: string[] = [];
      if (!base.claimOverall || !adapter.claimOverall)
        out.push(`${name}: the overall group is too small to be a claim`);
      if (adapter.overall > base.overall)
        out.push(
          `${name}: overall WER ${adapter.overall.toFixed(3)} is worse than the base ${base.overall.toFixed(3)}`,
        );
      for (const [lang, a] of adapter.langs) {
        const b = base.langs.get(lang);
        if (!b) continue;
        if (!a.claim || !b.claim) out.push(`${name}: ${lang} is too small to be a claim`);
        else if (a.wer > b.wer + spec.thresholds.adapterTolerance) {
          out.push(
            `${name}: ${lang} WER ${a.wer.toFixed(3)} is worse than the base ${b.wer.toFixed(3)} by more than ${spec.thresholds.adapterTolerance}`,
          );
        }
      }
      return out;
    }),
    "no release is worse than the base model overall or in a language beyond the tolerance",
  );

  const versions = new Set<string>();
  const runIds = new Set(ev.runs.map((run) => text(run["id"])));
  const versionProblems: string[] = [];
  for (const { r, name } of named) {
    if (!text(r["version"])) versionProblems.push(`${name}: version is empty`);
    else if (versions.has(name)) versionProblems.push(`${name}: version is used twice`);
    versions.add(name);
    if (!runIds.has(text(r["run"])))
      versionProblems.push(`${name}: run "${text(r["run"])}" is not recorded`);
    if (!HEX64.test(text(r["artifactSha256"])))
      versionProblems.push(`${name}: artifactSha256 must be 64 lowercase hex`);
  }
  for (const { r, name } of named) {
    if (
      r["previous"] !== null &&
      r["previous"] !== undefined &&
      (!versions.has(text(r["previous"])) || text(r["previous"]) === name)
    ) {
      versionProblems.push(
        `${name}: previous "${text(r["previous"])}" is not another recorded version`,
      );
    }
  }
  const active = named.filter(({ r }) => text(r["status"]) === "active");
  if (active.length > 1)
    versionProblems.push(`only one active release is allowed, found ${active.length}`);

  let rollback: Check;
  if (!active.length) rollback = unverified("rollback-ready", "no release is active yet");
  else if (active.length > 1) rollback = fail("rollback-ready", "more than one active release");
  else {
    const a = active[0]!;
    rollback = DATE.test(text(a.r["rollbackTestedOn"]))
      ? pass(
          "rollback-ready",
          `${a.name} can go back to ${text(a.r["previous"]) || "the base model"}, tried on ${text(a.r["rollbackTestedOn"])}`,
        )
      : fail(
          "rollback-ready",
          `${a.name}: rollbackTestedOn (a date) is missing: the way back was never tried`,
        );
  }
  return [
    pass("release-recorded", `${ev.releases.length} release(s) recorded`),
    frozen,
    compare,
    verdict(
      "versioned",
      versionProblems,
      "versions are unique, tied to a run and a hashed artifact, with one active",
    ),
    rollback,
  ];
}

type Input = {
  spec: ReadinessSpec;
  sha256: Sha256;
  exists: (path: string) => boolean;
  manifest?: unknown;
  records?: unknown;
};

/** Judge the three levels. Never throws on input of the wrong shape. */
export function assessReadiness(input: Input): ReadinessReport {
  const { spec, sha256, exists } = input;
  const rawManifest = input.manifest;
  const checked = rawManifest === undefined ? null : validateManifest(rawManifest, sha256);
  const records = isObj(input.records) ? input.records : {};
  const hasItems =
    isObj(rawManifest) && Array.isArray(rawManifest["items"]) && rawManifest["items"].length > 0;
  const ev: Evidence = {
    manifest: checked?.manifest ?? null,
    manifestProblems: checked?.problems ?? [],
    hasItems,
    runs: list(records["runs"]).filter(isObj),
    releases: list(records["releases"]).filter(isObj),
    sha256,
  };

  const levels: LevelReport[] = [];
  for (const def of spec.levels) {
    const missing = def.tooling.filter((file) => !exists(file));
    const tooling: Check = missing.length
      ? fail("tooling", `missing: ${missing.join(", ")}`)
      : pass("tooling", `${def.tooling.length} file(s) present`);
    const evidence =
      def.level === 1 ? level1(spec, ev) : def.level === 2 ? level2(spec, ev) : level3(spec, ev);
    const checks = [tooling, ...evidence];
    const previous = levels[levels.length - 1];
    if (previous) {
      checks.push(
        previous.status === "PASS"
          ? pass("previous-level", `level ${previous.level} passed`)
          : previous.status === "UNVERIFIED"
            ? unverified("previous-level", `level ${previous.level} is UNVERIFIED`)
            : fail("previous-level", `level ${previous.level} is ${previous.status}`),
      );
    }
    const status: LevelStatus = evidence.every((c) => c.status === "unverified")
      ? "UNVERIFIED"
      : checks.every((c) => c.status === "pass")
        ? "PASS"
        : "PARTIAL";
    levels.push({
      level: def.level,
      id: def.id,
      title: def.title,
      status,
      needs: def.needs,
      checks,
      notBuilt: def.notBuilt,
    });
  }

  const recorded = ev.releases.some((r) => text(r["status"]) === "active");
  const line = levels.map((l) => `level ${l.level} ${l.status}`).join(", ");
  return {
    levels,
    trainedModel: recorded ? "recorded" : "none",
    summary: `No trained model ships with FRIDAY. ${line}. A level is PASS only on the owner's own evidence; UNVERIFIED means none was given.`,
  };
}
