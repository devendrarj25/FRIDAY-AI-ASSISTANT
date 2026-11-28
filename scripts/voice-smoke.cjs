#!/usr/bin/env node
/**
 * Run the voice files for real, not only look for them.
 *
 *   node scripts/voice-smoke.cjs        what Doctor runs
 *
 * The voice files are checked by size and digest when they download, but a file that is on disk can still
 * fail to load (a broken onnxruntime wheel, a half-written model, a changed package API). So the voice
 * runtime is run: it scores a window with the silero file through onnxruntime, checks the noise suppressor
 * and the end-of-turn file, and Supertonic speaks one short line to a temporary WAV.
 *
 * After the English line the same voice also speaks a Hindi line (Devanagari) and a Hinglish line, and when the Hindi
 * ear is on disk it decodes the Hindi clip back to text. Those rows only WARN (`warnings`, a "voice warn:" line): a
 * language row never fails the run. FRIDAY_VOICE_SMOKE_LANGS=0 turns them off for a slow PC.
 *
 * `npm run setup` (scripts/setup-python.cjs) and Doctor use the same code; each gets the list of problems.
 * Windows only: the models are staged there. FRIDAY_VOICE_SMOKE=1 forces it on another system.
 */
"use strict";
// Colour that means something (ok green, FAIL red, a note yellow) on a real console; plain text everywhere else.
if (require.main === module) require("./live-console.cjs").installColorConsole();

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const KERNEL = path.resolve(__dirname, "..", "kernel");

/** The extra speak lines after the English one: Hindi in Devanagari, then Hinglish (Roman Hindi with English words). */
const LANGUAGE_LINES = [
  { id: "hindi", label: "Hindi", text: "नमस्ते, यह फ्राइडे की आवाज़ की जाँच है।", lang: "hi" },
  { id: "hinglish", label: "Hinglish", text: "Namaste, main FRIDAY bol rahi hoon.", lang: "hi" },
];
const DEVANAGARI = /[\u0900-\u097F]/;
/** The files the Hindi ear needs (kernel/hindi_ear.py REQUIRED); the decode round trip runs only when all are on disk. */
const HINDI_EAR_FILES = ["model.int8.onnx", "vocab.txt", "config.json"];

/** Language rows run unless FRIDAY_VOICE_SMOKE_LANGS=0 (or the caller says `langs: false`). */
function languageRowsOn(env = process.env) {
  return String(env.FRIDAY_VOICE_SMOKE_LANGS ?? "") !== "0";
}

/** The last JSON line of a worker's output, or null. */
function lastJson(text) {
  try {
    return JSON.parse(
      String(text || "")
        .trim()
        .split(/\r?\n/)
        .pop() || "null",
    );
  } catch {
    return null;
  }
}

function capture(exe, args, opts = {}) {
  return spawnSync(exe, args, { encoding: "utf8", shell: false, timeout: 120000, ...opts });
}

/** The OPTIONAL rows of `voice_runtime.py --check`: parts FRIDAY runs well without (an energy VAD, a timer, no speaker model). */
const OPTIONAL_ROW = /^OPTIONAL\s+/;

/**
 * Lines of `voice_runtime.py --check` that mean a real problem right after setup fetched the files.
 * Every FAIL is one (but a disk reading, which can be unmeasurable on a locked-down PC), and so is the offline voice
 * (Supertonic) reported as not installed: it was just downloaded and the voice cannot speak offline without it.
 * Every other OPTIONAL row (silero, Smart Turn, the speaker model, the echo canceller) is only a note: the energy VAD
 * and the silence timer are the fallbacks.
 */
function problemsIn(lines) {
  const problems = [];
  for (const line of lines) {
    const noVoice = /^OPTIONAL\s+local-tts\b/.test(line);
    if ((/^FAIL\s/.test(line) && !/^FAIL\s+disk/.test(line)) || noVoice) {
      problems.push(`voice runtime: ${line.replace(/^(FAIL|OPTIONAL)\s+/, "")}`);
    }
  }
  return problems;
}

/** The OPTIONAL rows that are not a problem, as plain text. Never a failure. */
function notesIn(lines) {
  return lines
    .filter((line) => OPTIONAL_ROW.test(line) && !/^OPTIONAL\s+local-tts\b/.test(line))
    .map((line) => line.replace(OPTIONAL_ROW, ""));
}

/**
 * @param {{python: string, fridayRoot: string, kernelDir?: string, run?: Function, log?: Function, langs?: boolean, exists?: Function}} options
 * @returns {{ok: boolean, problems: string[], notes: string[], warnings?: string[]}} `warnings` is present only when a
 *   language row (Hindi or Hinglish speech, the Hindi ear round trip) did not pass; it never changes `ok`.
 */
function voiceSmoke({
  python,
  fridayRoot,
  kernelDir = KERNEL,
  run = capture,
  log = console.log,
  langs = languageRowsOn(),
  exists = fs.existsSync,
}) {
  const problems = [];
  const warnings = [];
  const script = path.join(kernelDir, "voice_runtime.py");
  const env = { ...process.env, FRIDAY_ROOT: fridayRoot, PYTHONIOENCODING: "utf-8" };
  const checked = run(python, [script, "--check"], { env, timeout: 300000 });
  const lines = String(checked.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (checked.status !== 0 || !lines.length) {
    log("voice runtime check did not run");
    problems.push("the voice runtime check did not run");
  }
  for (const line of lines) log(`voice runtime: ${line}`);
  problems.push(...problemsIn(lines));
  const notes = notesIn(lines);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-voice-"));
  try {
    const wav = path.join(dir, "check.wav");
    const spoken = run(python, [script, "--speak", "--text", "FRIDAY voice check.", "--out", wav], {
      env,
      timeout: 600000,
    });
    const said = lastJson(spoken.stdout);
    const size = fs.existsSync(wav) ? fs.statSync(wav).size : 0;
    if (said && said.ok && size > 1000) {
      log(`offline voice (Supertonic) spoke a test line (${size} bytes)`);
    } else {
      const why = (said && said.reason) || "no audio came out";
      log(`offline voice (Supertonic) did not speak: ${why}`);
      problems.push(`the offline voice (Supertonic) did not speak (${String(why).slice(0, 120)})`);
    }
    // A voice that did not speak the English line cannot speak the others: no second long wait.
    if (langs && said && said.ok && size > 1000)
      warnings.push(
        ...languageRows({ python, script, kernelDir, env, run, log, exists, dir, fridayRoot }),
      );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { ok: problems.length === 0, problems, notes, ...(warnings.length ? { warnings } : {}) };
}

/**
 * The Hindi and Hinglish speak lines and the Hindi ear round trip. Every miss is a warning string (and a log line that
 * starts with "WARN"); nothing here throws and nothing here is a problem. Returns the warnings.
 */
function languageRows({ python, script, kernelDir, env, run, log, exists, dir, fridayRoot }) {
  const warnings = [];
  const warn = (text) => {
    warnings.push(text);
    log(`WARN ${text}`);
  };
  let hindiWav = "";
  for (const row of LANGUAGE_LINES) {
    const wav = path.join(dir, `${row.id}.wav`);
    let said = null;
    try {
      const spoken = run(
        python,
        [script, "--speak", "--text", row.text, "--lang", row.lang, "--out", wav],
        {
          env,
          timeout: 600000,
        },
      );
      said = lastJson(spoken?.stdout);
    } catch {
      said = null;
    }
    const size = fs.existsSync(wav) ? fs.statSync(wav).size : 0;
    if (said && said.ok && size > 1000) {
      log(`offline voice (Supertonic) spoke a ${row.label} test line (${size} bytes)`);
      if (row.id === "hindi") hindiWav = wav;
    } else {
      const why = (said && said.reason) || "no audio came out";
      warn(
        `the offline voice did not speak the ${row.label} test line (${String(why).slice(0, 120)})`,
      );
    }
  }
  const earDir = path.join(fridayRoot, "models", "hindi-ear");
  if (!HINDI_EAR_FILES.every((name) => exists(path.join(earDir, name)))) {
    log(
      "Hindi ear decode check skipped: the Hindi ear is not installed (FRIDAY uses faster-whisper for Hindi)",
    );
    return warnings;
  }
  if (!hindiWav) {
    log("Hindi ear decode check skipped: there was no Hindi test clip to read back");
    return warnings;
  }
  try {
    const heard = run(
      python,
      [path.join(kernelDir, "stt.py"), "--audio", hindiWav, "--language", "hi"],
      {
        env,
        timeout: 300000,
      },
    );
    const text = String(lastJson(heard?.stdout)?.text || "").trim();
    if (DEVANAGARI.test(text))
      log(
        `Hindi ear decoded the Hindi test line back to Devanagari text (${text.length} characters)`,
      );
    else warn("the Hindi ear did not return Devanagari text for the Hindi test clip");
  } catch {
    warn("the Hindi ear decode check could not run");
  }
  return warnings;
}

module.exports = { voiceSmoke, problemsIn, notesIn, languageRowsOn, LANGUAGE_LINES };

if (require.main === module) {
  if (process.platform !== "win32" && process.env.FRIDAY_VOICE_SMOKE !== "1") {
    console.log("[friday] voice smoke test: skipped (the voice models are staged on Windows)");
    process.exitCode = 0;
  } else {
    let python = require("./explicit-python.cjs").explicitPython(process.env.FRIDAY_PYTHON);
    if (!python) {
      try {
        python = require("./python-runtime.cjs").resolveVenvPython() || "";
      } catch {
        python = "";
      }
    }
    if (!python) {
      console.error(
        "[friday] voice smoke test: no FRIDAY Python was found; run npm run setup:python",
      );
      process.exitCode = 1;
    } else {
      const root = require("./friday-root.cjs").workspaceRootOrDev().root;
      const result = voiceSmoke({
        python,
        fridayRoot: root,
        log: (line) => console.log(`[friday] ${line}`),
      });
      for (const note of result.notes) console.log(`[friday] voice note: ${note}`);
      for (const warning of result.warnings || []) console.log(`[friday] voice warn: ${warning}`);
      for (const problem of result.problems) console.error(`[friday] voice problem: ${problem}`);
      if (!result.ok) {
        console.error(
          "[friday] Fix it with: npm run setup:python (fetches the voice files), then npm run doctor",
        );
      }
      process.exitCode = result.ok ? 0 : 1;
    }
  }
}
