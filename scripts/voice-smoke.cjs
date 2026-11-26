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
 * @param {{python: string, fridayRoot: string, kernelDir?: string, run?: Function, log?: Function}} options
 * @returns {{ok: boolean, problems: string[], notes: string[]}}
 */
function voiceSmoke({ python, fridayRoot, kernelDir = KERNEL, run = capture, log = console.log }) {
  const problems = [];
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
    let said = null;
    try {
      said = JSON.parse(
        String(spoken.stdout || "")
          .trim()
          .split(/\r?\n/)
          .pop() || "null",
      );
    } catch {
      said = null;
    }
    const size = fs.existsSync(wav) ? fs.statSync(wav).size : 0;
    if (said && said.ok && size > 1000) {
      log(`offline voice (Supertonic) spoke a test line (${size} bytes)`);
    } else {
      const why = (said && said.reason) || "no audio came out";
      log(`offline voice (Supertonic) did not speak: ${why}`);
      problems.push(`the offline voice (Supertonic) did not speak (${String(why).slice(0, 120)})`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { ok: problems.length === 0, problems, notes };
}

module.exports = { voiceSmoke, problemsIn, notesIn };

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
