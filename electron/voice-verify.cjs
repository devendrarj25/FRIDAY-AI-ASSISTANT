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

const OPTIONAL_INSTALL = {
  "local-tts": "supertonic-3",
  "vad-silero": "silero-vad",
  "smart-turn": "smart-turn",
};

function parseJsonLine(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text.slice(text.lastIndexOf("{")));
  } catch {
    return null;
  }
}

async function speechSelfTest() {
  const found = await resolvePython();
  if (!found) {
    return {
      ok: true,
      skipped: true,
      detail: "skipped: no Python interpreter for the speech self-test",
      av: null,
    };
  }
  const runResult = await run(
    found.exe,
    [...(found.prefix || []), sttScript(), "--self-test"],
    600000,
  );
  const parsed = parseJsonLine(runResult.stdout);
  if (!parsed) {
    return {
      ok: false,
      skipped: false,
      detail: tail(runResult.stderr, "speech self-test did not return JSON"),
      av: null,
    };
  }
  if (parsed.skipped) {
    return {
      ok: true,
      skipped: true,
      detail: `skipped: ${parsed.reason || "speech model is not installed"} · audio path verified`,
      engine: parsed.engine || "",
      model: parsed.model || "",
      loadMs: parsed.loadMs || 0,
      transcribeMs: parsed.transcribeMs || 0,
      av: parsed.av || null,
    };
  }
  if (!parsed.ok) {
    return {
      ok: false,
      skipped: false,
      detail: parsed.error || parsed.reason || "transcription failed",
      engine: parsed.engine || "",
      model: parsed.model || "",
      loadMs: parsed.loadMs || 0,
      transcribeMs: parsed.transcribeMs || 0,
      av: parsed.av || null,
    };
  }
  return {
    ok: true,
    skipped: false,
    detail: `${parsed.engine} · ${parsed.model} · load ${parsed.loadMs}ms · transcribe ${parsed.transcribeMs}ms`,
    engine: parsed.engine || "",
    model: parsed.model || "",
    loadMs: parsed.loadMs || 0,
    transcribeMs: parsed.transcribeMs || 0,
    av: parsed.av || null,
  };
}

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
    .filter((line) => /^(PASS|FAIL|OPTIONAL)\s+\S+/.test(line));
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
      const optional = line.startsWith("OPTIONAL");
      const ok = line.startsWith("PASS");
      const rest = line.slice(line.indexOf(" ") + 1).trim();
      const id = rest.split(/\s+/)[0] || "stage";
      checks.push({
        id,
        label: optional ? `${rest} optional - not installed` : rest,
        ok,
        optional,
        installId: OPTIONAL_INSTALL[id] || "",
        required: false,
        detail: line,
      });
    }
  }

  const speech = await speechSelfTest();
  checks.push({
    id: "stt-transcribe",
    label: "speech transcription",
    ok: speech.ok,
    required: !speech.skipped,
    detail: speech.detail,
  });
  if (speech.av && speech.av.installed && !speech.av.ok) {
    checks.push({
      id: "av-pin",
      label: "PyAV range",
      ok: false,
      required: true,
      detail: `${speech.av.reason}. ${speech.av.fix}`,
    });
  } else if (speech.av) {
    checks.push({
      id: "av-pin",
      label: "PyAV range",
      ok: true,
      required: false,
      detail: speech.av.installed
        ? `av ${speech.av.version} is inside ${speech.av.requirement}`
        : speech.av.reason,
    });
  }

  const requiredOk = checks.filter((check) => check.required !== false).every((check) => check.ok);
  return {
    ok: requiredOk,
    python: found.executable,
    checks,
    localReady: checks.some((check) => check.id === "local-tts" && check.ok),
  };
}

module.exports = { verifyVoiceRuntime, speechSelfTest };
