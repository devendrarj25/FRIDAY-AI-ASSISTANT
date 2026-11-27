#!/usr/bin/env node
/**
 * FRIDAY - offline, one-time Hinglish lexicon and WER fixture proposal builder.
 *
 * Reads datasets the owner fetched outside the repository and writes a PROPOSAL for him to review. It never
 * edits config/hinglish-lexicon.json, never reaches the network, and refuses an --out folder inside the repo.
 *
 *   node scripts/build-hinglish-lexicon.cjs --dakshina <dir with hi/lexicons/*.tsv> --out <dir>
 *       [--asr <dir with hinglish_clean.jsonl / hinglish_noisy.jsonl>] [--min-count 3] [--per-stratum 50]
 *
 * The Dakshina lexicon is share-alike: it feeds only the spelling proposal, never an eval manifest. The WER
 * fixture accepts only the Apache-2.0 speech source and carries hashes, never audio or reference text.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DAKSHINA_LICENCE = "CC-BY-SA-4.0 (share-alike, review before merge)";
const ASR_LICENCE = "Apache-2.0";
const ALLOWED_FIXTURE_LICENCES = [ASR_LICENCE];

const ENGLISH_STOP =
  `the of and to a in is it you that he was for on are with as i his they be at one have this
from or had by hot but some what there we can out other were all your when up use word how said an each she which
do their time if will way about many then them would write like so these her long make thing see him two has look
more day could go come did my sound no most number who over know water than call first people may down side been now
find any new work part take get place made live where after back little only round man year came show every good me
give our under name very through just form much great think say help low line before turn cause same mean differ move
right boy old too does tell sentence set three want air well also play small end put home read hand port large spell add
even land here must big high such follow act why ask men change went light kind off need house picture try us again
animal point mother world near build self earth father head stand own page should country found answer school grow study
still learn plant cover food sun four between state keep eye never last let thought city tree cross farm hard start might
story saw far sea draw left late run while press close night real life few north open seem together next white children
begin got walk example ease paper group always music those both mark often letter until mile river car feet care second
book carry took science eat room friend began idea fish mountain stop once base hear horse cut sure watch color face wood
main enough plain girl usual young ready above ever red list though feel talk bird soon body dog family direct pose leave
song measure door product black short numeral class wind question happen complete ship area half rock order fire south
problem piece told knew pass since top whole king space heard best hour better true during hundred five remember step
early hold west ground interest reach fast verb sing listen six table travel less morning ten simple several vowel toward
war lay against pattern slow center love person money serve appear road map rain rule govern pull cold notice voice unit
power town fine certain fly fall lead cry dark machine note wait plan figure star box noun field rest correct able pound
done beauty drive stood contain front teach week final gave green oh quick develop ocean warm free minute strong special
mind behind clear tail produce fact street inch multiply nothing course stay wheel full force blue object decide surface
deep moon island foot system busy test record boat common gold possible plane stead dry wonder laugh thousand ago ran check
game shape equate hot miss brought heat snow tire bring yes distant fill east paint language among`
    .split(/\s+/)
    .filter(Boolean);
const ENGLISH_STOP_SET = new Set(ENGLISH_STOP.slice(0, 200));

const norm = (s) => String(s).normalize("NFC").trim().toLowerCase();
const sha256 = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

/** Dakshina lexicon lines: native word, Latin romanization, attestation count (tab separated). */
function parseDakshinaLexicon(tsvText) {
  const rows = [];
  for (const line of String(tsvText).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    if (cols.length < 2) continue;
    const native = String(cols[0]).normalize("NFC").trim();
    const latin = norm(cols[1]);
    const count = cols[2] === undefined ? 1 : Number.parseInt(cols[2], 10);
    if (!native || !latin || !Number.isFinite(count) || count < 0) continue;
    rows.push({ native, latin, count });
  }
  return rows;
}

function spellingsOf(pair) {
  return String(pair[0]).split("|").map(norm).filter(Boolean);
}

/**
 * Propose spelling variants for words the lexicon already knows. A Latin spelling joins an existing pair only
 * when it is seen at least minCount times for one native word; a spelling that is a common English word, a
 * loanword, or points at several native words goes to ambiguousCandidates and never to the sure words.
 */
function proposeSpellings(rows, existingJson, options = {}) {
  const minCount = Number.isInteger(options.minCount) ? options.minCount : 3;
  const sure = [...(existingJson.sureHindi || []), ...(existingJson.sureHindiAdded || [])];
  const known = new Set();
  for (const group of [sure, existingJson.ambiguous || []]) {
    for (const pair of group) for (const s of spellingsOf(pair)) known.add(s);
  }
  const english = new Set(ENGLISH_STOP_SET);
  for (const pair of existingJson.loanwords || []) english.add(norm(pair[0]));

  // spelling -> native -> summed count
  const bySpelling = new Map();
  for (const row of rows) {
    const latin = norm(row.latin);
    const natives = bySpelling.get(latin) || new Map();
    natives.set(row.native, (natives.get(row.native) || 0) + row.count);
    bySpelling.set(latin, natives);
  }
  const existingByNative = new Map();
  for (const pair of sure) existingByNative.set(String(pair[1]).normalize("NFC"), pair);

  const added = new Map(); // native -> spellings to add
  const candidates = [];
  const skipped = [];
  for (const [latin, natives] of [...bySpelling].sort((a, b) => a[0].localeCompare(b[0]))) {
    const strong = [...natives].filter(([, c]) => c >= minCount).sort((a, b) => b[1] - a[1]);
    if (!strong.length) {
      skipped.push({ word: latin, why: "low-count" });
      continue;
    }
    const top = strong[0][0];
    if (english.has(latin) || strong.length > 1) {
      candidates.push([latin, top]);
      continue;
    }
    if (!existingByNative.has(top)) continue;
    if (known.has(latin)) {
      skipped.push({ word: latin, why: "already-known" });
      continue;
    }
    added.set(top, [...(added.get(top) || []), latin]);
  }
  const sureHindiAdded = [...added].map(([native, extra]) => {
    const pair = existingByNative.get(native);
    return [[...spellingsOf(pair), ...extra].join("|"), native];
  });
  return { sureHindiAdded, ambiguousCandidates: candidates, skipped };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STRATUM_CONDITION = { hinglish_clean: "quiet", hinglish_noisy: "noisy" };

/**
 * An EvalManifest-shaped fixture from noisy-hinglish-asr rows ({id, text, stratum, speaker?, audioSha256?,
 * durationMs?}). Items hold hashes only: no sentence text and no audio path. Only the Apache-2.0 source is accepted.
 */
function buildWerFixture(rows, options = {}) {
  const perStratum = Number.isInteger(options.perStratum) ? options.perStratum : 50;
  const seed = Number.isInteger(options.seed) ? options.seed : 1;
  const licence = options.licence === undefined ? ASR_LICENCE : options.licence;
  if (!ALLOWED_FIXTURE_LICENCES.includes(licence)) {
    throw new Error(`WER fixture refuses licence "${licence}": only ${ASR_LICENCE} may feed it`);
  }
  const date = options.createdOn || "1970-01-01";
  const rand = mulberry32(seed);
  const items = [];
  for (const stratum of Object.keys(STRATUM_CONDITION)) {
    const pool = rows
      .filter((r) => r.stratum === stratum && String(r.text || "").trim() && r.id !== undefined)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    for (const r of pool.slice(0, perStratum)) {
      const id = `${stratum}-${String(r.id).replace(/[^A-Za-z0-9_.-]/g, "_")}`.slice(0, 79);
      const ms = Math.round(Number(r.durationMs));
      items.push({
        id,
        source: "noisy-hinglish-asr",
        language: "hinglish",
        split: "dev",
        condition: STRATUM_CONDITION[stratum],
        speaker: "anon",
        room: "unknown",
        sha256: /^[0-9a-f]{64}$/.test(r.audioSha256 || "") ? r.audioSha256 : sha256(`asr-id:${id}`),
        referenceSha256: sha256(String(r.text).normalize("NFC").trim()),
        durationMs: ms > 0 && ms <= 3_600_000 ? ms : 1000,
      });
    }
  }
  items.sort((a, b) => a.id.localeCompare(b.id));
  return {
    schema: 1,
    id: "hinglish-wer-proposal",
    title: "Hinglish WER fixture proposal (hashes only)",
    createdOn: date,
    sources: [
      {
        id: "noisy-hinglish-asr",
        name: "noisy-hinglish-asr (hinglish_clean, hinglish_noisy)",
        kind: "public-dataset",
        licence: ASR_LICENCE,
        licenceUrl: "https://huggingface.co/datasets/addyo07/noisy-hinglish-asr",
        licenceCheckedOn: date,
        access: "open",
        origin: "https://huggingface.co/datasets/addyo07/noisy-hinglish-asr",
        languages: ["hinglish"],
        uses: ["evaluate"],
        consent: { basis: "public-licence" },
        note: "Audio hash is the dataset clip hash when the export has one, otherwise a hash of the row id; duration is 1000 when the export has none.",
      },
    ],
    items,
    testLock: null,
  };
}

function readDakshinaDir(dir) {
  const lex = path.join(dir, "hi", "lexicons");
  const files = fs.existsSync(lex) ? fs.readdirSync(lex).filter((f) => f.endsWith(".tsv")) : [];
  if (!files.length) throw new Error(`no hi/lexicons/*.tsv under ${dir}`);
  return files
    .sort()
    .flatMap((f) => parseDakshinaLexicon(fs.readFileSync(path.join(lex, f), "utf8")));
}

function readAsrDir(dir) {
  const rows = [];
  for (const stratum of Object.keys(STRATUM_CONDITION)) {
    const file = path.join(dir, `${stratum}.jsonl`);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      rows.push({
        id: o.unit_id ?? o.id,
        text: o.transcription ?? o.text,
        stratum,
        ...(o.clip_sha256 ? { audioSha256: o.clip_sha256 } : {}),
        ...(o.duration_s ? { durationMs: Number(o.duration_s) * 1000 } : {}),
      });
    }
  }
  return rows;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    out[a.slice(2)] = argv[i + 1];
    i++;
  }
  return out;
}

const USAGE = `usage: node scripts/build-hinglish-lexicon.cjs --dakshina <dir> --out <dir> [--asr <dir>] [--min-count 3] [--per-stratum 50]
  --dakshina  folder holding hi/lexicons/*.tsv (spelling proposal only, share-alike data)
  --asr       folder holding hinglish_clean.jsonl and hinglish_noisy.jsonl (Apache-2.0 WER fixture)
  --out       a folder OUTSIDE the repository; the proposal is written there, nothing else is touched`;

function insideRepo(target) {
  const rel = path.relative(ROOT, path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function main(argv, io = { log: console.log, error: console.error }) {
  const args = parseArgs(argv);
  if (!args.dakshina && !args.asr) {
    io.error(USAGE);
    return 2;
  }
  if (!args.out || insideRepo(args.out)) {
    io.error(`--out must be a folder outside the repository\n${USAGE}`);
    return 2;
  }
  for (const key of ["dakshina", "asr"]) {
    if (args[key] && !fs.existsSync(args[key])) {
      io.error(`--${key} path is missing: ${args[key]}`);
      return 2;
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(args.out, { recursive: true });
  if (args.dakshina) {
    const existing = JSON.parse(
      fs.readFileSync(path.join(ROOT, "config", "hinglish-lexicon.json"), "utf8"),
    );
    const minCount = args["min-count"] ? Number.parseInt(args["min-count"], 10) : 3;
    const proposal = proposeSpellings(readDakshinaDir(args.dakshina), existing, { minCount });
    const body = {
      licence: DAKSHINA_LICENCE,
      basedOnVersion: existing.version,
      minCount,
      ...proposal,
    };
    fs.writeFileSync(
      path.join(args.out, "spelling-proposal.json"),
      `${JSON.stringify(body, null, 2)}\n`,
    );
    io.log(
      `spelling proposal: ${proposal.sureHindiAdded.length} merged pairs, ${proposal.ambiguousCandidates.length} candidates`,
    );
  }
  if (args.asr) {
    const perStratum = args["per-stratum"] ? Number.parseInt(args["per-stratum"], 10) : 50;
    const fixture = buildWerFixture(readAsrDir(args.asr), {
      perStratum,
      seed: 1,
      createdOn: today,
    });
    fs.writeFileSync(
      path.join(args.out, "wer-fixture.json"),
      `${JSON.stringify(fixture, null, 2)}\n`,
    );
    io.log(`wer fixture: ${fixture.items.length} items`);
  }
  return 0;
}

module.exports = { parseDakshinaLexicon, proposeSpellings, buildWerFixture, main, USAGE };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
