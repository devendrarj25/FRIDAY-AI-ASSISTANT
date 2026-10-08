/**
 * FRIDAY · real voice-runtime verification.
 *
 * First run used to mark "voice ready" as soon as the pip commands finished.
 * A finished install is not a working engine: the wheel may be for the wrong
 * interpreter, the model may fail to load, edge-tts may not resolve a voice.
 * This module runs the REAL probes through the shared Python resolver so the
 * first-run screen (and Voice Diagnostics) reports the truth:
 *
 *   · python -c "import faster_whisper"   — the dependency is importable
 *   · kernel/stt.py --load-probe          — the model really loads
 *   · python -c "import edge_tts"         — the dependency is importable
 *   · edge_tts --list-voices              — a real voice is really available
 */
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const paths = require("./friday-paths.cjs");
const { resolvePython } = require("./python.cjs");

const STT_SCRIPT = path.join(__dirname, "..", "kernel", "stt.py");
const RUNTIME_SCRIPT = path.join(__dirname, "..", "kernel", "voice_runtime.py");

function sttScript() {
  if (fs.existsSync(STT_SCRIPT)) return STT_SCRIPT;
  const packaged = path.join(process.resourcesPath || "", "kernel", "stt.py");
  return fs.existsSync(packaged) ? packaged : STT_SCRIPT;
}

function runtimeScript() {
  if (fs.existsSync(RUNTIME_SCRIPT)) return RUNTIME_SCRIPT;
  const packaged = path.join(process.resourcesPath || "", "kernel", "voice_runtime.py");
  return fs.existsSync(packaged) ? packaged : RUNTIME_SCRIPT;
}

function run(exe, args, timeout = 120000, env) {
  return new Promise((resolve) => {
    execFile(
      exe,
      args,
      {
        timeout,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          FRIDAY_ROOT: paths.root() || process.env.FRIDAY_ROOT || "",
          ...(env || {}),
        },
      },
      (error, stdout, stderr) =>
        resolve({
          ok: !error,
          stdout: stdout || "",
          stderr: stderr || String(error?.message || ""),
        }),
    );
  });
}

const tail = (text, fallback) => (String(text || "").trim() || fallback).slice(-400);

/**
 * @returns {Promise<{ok:boolean, python:string|null, checks:Array<{id:string,label:string,ok:boolean,detail:string}>}>}
 */
async function verifyVoiceRuntime({ loadModel = true } = {}) {
  const checks = [];
  const found = await resolvePython();
  if (!found) {
    return {
      ok: false,
      python: null,
      checks: [
        {
          id: "python",
          label: "Python runtime",
          ok: false,
          detail: "no supported Python interpreter was found",
        },
      ],
    };
  }
  const exe = found.exe;
  const prefix = found.prefix || [];
  checks.push({
    id: "python",
    label: "Python runtime",
    ok: true,
    detail: `${found.executable} (${found.version})`,
  });

  const whisperImport = await run(
    exe,
    [...prefix, "-c", "import faster_whisper;print(faster_whisper.__version__)"],
    60000,
  );
  checks.push({
    id: "stt-import",
    label: "import faster_whisper",
    ok: whisperImport.ok,
    detail: whisperImport.ok
      ? `faster-whisper ${whisperImport.stdout.trim()}`
      : tail(whisperImport.stderr, "faster_whisper could not be imported"),
  });

  if (whisperImport.ok && loadModel) {
    const weights = require("./voice-weights.cjs");
    const prepared = await weights.ensureSttWeights("base", paths.root() || "", {
      exists: (file) => fs.existsSync(file),
      downloadModel: require("./model-download.cjs").downloadModel,
    });
    if (!prepared.ok) {
      checks.push({
        id: "stt-model",
        label: "speech model loads",
        ok: false,
        detail: prepared.error || "speech weights are not on disk",
      });
    } else {
      const load = await run(exe, [...prefix, sttScript(), "--load-probe"], 600000, {
        ...process.env,
        FRIDAY_STT_MODEL_PATH: prepared.dir,
      });
      let parsed = null;
      try {
        const text = load.stdout.trim();
        parsed = JSON.parse(text.slice(text.lastIndexOf("{")));
      } catch {
        parsed = null;
      }
      checks.push({
        id: "stt-model",
        label: "speech model loads",
        ok: Boolean(parsed?.ok),
        detail: parsed?.ok
          ? `model "${parsed.model}" loaded in ${parsed.elapsedMs}ms`
          : tail(parsed?.error || load.stderr, "the speech model could not be loaded"),
      });
    }
  } else if (loadModel) {
    checks.push({
      id: "stt-model",
      label: "speech model loads",
      ok: false,
      detail: "skipped — faster_whisper is not importable",
    });
  }

  const ttsImport = await run(
    exe,
    [...prefix, "-c", "import edge_tts;print(edge_tts.__version__)"],
    60000,
  );
  checks.push({
    id: "tts-import",
    label: "import edge_tts",
    ok: ttsImport.ok,
    detail: ttsImport.ok
      ? `edge-tts ${ttsImport.stdout.trim()}`
      : tail(ttsImport.stderr, "edge_tts could not be imported"),
  });

  if (ttsImport.ok) {
    const voices = await run(exe, [...prefix, "-m", "edge_tts", "--list-voices"], 90000);
    const names = (voices.stdout.match(/\b[a-z]{2}-[A-Z]{2}-\w+Neural\b/g) || []).filter(Boolean);
    checks.push({
      id: "tts-voice",
      label: "a neural voice is available",
      ok: names.length > 0,
      detail: names.length
        ? `${names.length} voices · e.g. ${names.slice(0, 2).join(", ")}`
        : tail(voices.stderr, "edge-tts returned no voices"),
    });
  } else {
    checks.push({
      id: "tts-voice",
      label: "a neural voice is available",
      ok: false,
      detail: "skipped — edge_tts is not importable",
    });
  }

  const local = await run(exe, [...prefix, runtimeScript(), "--check"], 60000);
  const stages = local.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(PASS|FAIL)\s+\S+/.test(line));
  if (!stages.length) {
    checks.push({
      id: "voice-check",
      label: "voice self-check",
      ok: false,
      required: false,
      detail: tail(local.stderr, "voice runtime did not print a stage"),
    });
  } else {
    for (const line of stages) {
      const ok = line.startsWith("PASS");
      const rest = line.slice(5).trim();
      const id = rest.split(/\s+/)[0] || "stage";
      checks.push({
        id,
        label: rest,
        ok,
        required: false,
        detail: line,
      });
    }
  }

  const requiredOk = checks.filter((check) => check.required !== false).every((check) => check.ok);
  return {
    ok: requiredOk,
    python: found.executable,
    checks,
    localReady: checks.some((check) => check.id === "local-tts" && check.ok),
  };
}

module.exports = { verifyVoiceRuntime };
