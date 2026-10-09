"""FRIDAY · local speech-to-text (faster-whisper).

On-device transcriber so the desktop app never depends on Chromium's online
Web Speech service. electron/stt.cjs prefers a persistent worker:

    python kernel/stt.py --serve

JSON lines on stdin, one JSON object per line on stdout. WhisperModel is
loaded once per worker and reused for every utterance. `--audio` one-shot
mode remains for probes and tests.

Nothing is faked: when the model or the dependency is missing it says so
instead of returning empty text. The model cache lives under the selected
FRIDAY root (cache/stt). One request is still one utterance file. Partial
text is emitted on this same worker as whisper segments arrive. English
Moonshine streaming runs inside this worker only when that MIT model is
already on disk and the owner preference is English. Hindi and Hinglish
stay on faster-whisper.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

# Small is the best quality/latency trade-off on a normal Windows laptop and
# handles Hindi + Indian English well. int8 keeps it CPU-friendly.
DEFAULT_MODEL = os.environ.get("FRIDAY_STT_MODEL", "small")
DEFAULT_HINT = (
    "Hinglish mixed Hindi and English in one sentence. "
    "Examples: Chrome open karo; GitHub ka latest status check karo; ye file analyze karo. "
    "Preserve filenames, paths, code identifiers, application names, project names, "
    "commands, FRIDAY, and technical English terms. "
    "Do not translate those into Hindi or replace them with similar everyday words."
)

_model = None
_model_name: str | None = None
_load_count = 0
_whisper_cls = None
_whisper_error: str | None = None


def resolve_language(raw: str) -> str | None:
    """Lock Whisper only when the owner asked for a non English/Hindi language.

    hi / en / hi-IN / en-IN stay auto-detect so mixed Hinglish is not forced
    into one script.
    """
    value = (raw or "").strip().lower().replace("_", "-")
    if not value or value in {"auto", "mixed"}:
        return None
    if value.startswith("hi") or value.startswith("en"):
        return None
    iso = value[:2]
    return iso if len(iso) == 2 and iso.isalpha() else None


def select_model(ram_gb: float, gpu: bool, battery: bool, auto: bool, requested: str = "small") -> str:
    """Same thresholds as applySttTier in src/lib/friday/voice-session.ts.

    Auto tiering changes the model only when it is requested and RAM was
    measured. Otherwise the caller's model (small, unless set) stays.
    """
    name = (requested or "small").strip() or "small"
    if not auto or not (ram_gb > 0):
        return name
    tier = "small"
    if ram_gb < 4:
        tier = "tiny"
    elif ram_gb < 8:
        tier = "base"
    elif gpu and ram_gb >= 16:
        tier = "large-v3"
    elif ram_gb >= 16:
        tier = "medium"
    if battery and tier in {"medium", "large-v3"}:
        tier = "small"
    return tier


def owner_model(size: str, requested: str) -> str:
    """An owner-chosen size wins. Auto tiering stays for the auto setting."""
    locked = (size or "").strip().lower()
    known = {"tiny", "base", "small", "medium", "large-v3"}
    if locked in known:
        return select_model(0.0, False, False, False, locked)
    return resolve_model_name(requested)


def model_load_kwargs(name: str, model_path: str | None = None) -> dict:
    """The worker opens a local folder. It does not download weights."""
    target = (model_path or "").strip() or (name or DEFAULT_MODEL)
    return {
        "target": target,
        "device": "auto",
        "compute_type": "int8",
        "download_root": cache_dir(),
        "local_files_only": True,
    }


def resolve_model_name(requested: str) -> str:
    auto = os.environ.get("FRIDAY_STT_TIER", "").strip().lower() == "auto"
    try:
        ram = float(os.environ.get("FRIDAY_RAM_GB", "") or 0)
    except ValueError:
        ram = 0.0
    gpu = os.environ.get("FRIDAY_GPU", "").strip().lower() in {"1", "true", "yes", "on"}
    battery = os.environ.get("FRIDAY_ON_BATTERY", "").strip().lower() in {"1", "true", "yes", "on"}
    return select_model(ram, gpu, battery, auto, requested or DEFAULT_MODEL)


def plan_partials(duration_s: float, window_s: float = 2.0, hop_s: float = 1.0) -> list[dict]:
    """Chunk plan for this same worker. Not a second speech engine."""
    if duration_s <= 0 or window_s <= 0 or hop_s <= 0:
        return []
    if duration_s <= window_s:
        return [{"start": 0.0, "end": round(float(duration_s), 3), "final": True}]
    out: list[dict] = []
    start = 0.0
    while start < duration_s - 1e-6:
        end = min(duration_s, start + window_s)
        out.append({"start": round(start, 3), "end": round(end, 3), "final": end >= duration_s - 1e-6})
        if end >= duration_s - 1e-6:
            break
        start += hop_s
    return out


def cache_dir() -> str:
    root = os.environ.get("FRIDAY_ROOT")
    base = Path(root) / "cache" / "stt" if root else Path.home() / ".friday" / "cache" / "stt"
    base.mkdir(parents=True, exist_ok=True)
    return str(base)


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _import_whisper():
    global _whisper_cls, _whisper_error
    if _whisper_cls is not None:
        return _whisper_cls
    if _whisper_error:
        return None
    try:
        from faster_whisper import WhisperModel  # type: ignore

        _whisper_cls = WhisperModel
        return _whisper_cls
    except Exception as exc:  # noqa: BLE001 — surfaced to the UI verbatim
        _whisper_error = f"faster-whisper is not installed ({exc})."
        return None


def get_model(name: str, model_path: str | None = None):
    """Load WhisperModel once per worker. `local_files_only` blocks a silent download."""
    global _model, _model_name, _load_count
    cls = _import_whisper()
    if cls is None:
        raise RuntimeError(_whisper_error or "faster-whisper is not installed.")
    spec = model_load_kwargs(name, model_path or os.environ.get("FRIDAY_STT_MODEL_PATH"))
    wanted = spec["target"]
    if _model is not None and _model_name == wanted:
        return _model
    _model = cls(
        wanted,
        device=spec["device"],
        compute_type=spec["compute_type"],
        download_root=spec["download_root"],
        local_files_only=spec["local_files_only"],
    )
    _model_name = wanted
    _load_count += 1
    return _model


def wants_english_stream(language: str, speech_pref: str) -> bool:
    """Moonshine English weights only. Hindi, Hinglish, and auto stay on whisper."""
    raw = (speech_pref or "").strip().lower().replace("_", "-")
    if not raw:
        raw = (language or "").strip().lower().replace("_", "-")
    if not raw or raw in {"auto", "mixed"} or raw.startswith("hi"):
        return False
    return raw.startswith("en")


def moonshine_model_dir() -> str | None:
    """English streaming weights already on disk. This does not download."""
    root = os.environ.get("FRIDAY_ROOT", "").strip()
    base = Path(root) if root else Path.home() / ".friday"
    folder = base / "models" / "moonshine-en"
    if not folder.is_dir():
        return None
    parents: dict[Path, int] = {}
    try:
        for path in folder.rglob("*"):
            if not path.is_file():
                continue
            if path.suffix.lower() not in {".onnx", ".ort"}:
                continue
            if path.stat().st_size < 100_000:
                continue
            parents[path.parent] = parents.get(path.parent, 0) + 1
    except OSError:
        return None
    if not parents:
        return None
    return str(max(parents, key=parents.get))


def prepare_audio(audio_path: str) -> tuple[str, object | None, str | None]:
    """Denoise when pyrnnoise imports. The original file is used otherwise."""
    try:
        import numpy as np  # type: ignore
        import soundfile as sf  # type: ignore
        import voice_runtime
        from faster_whisper.audio import decode_audio  # type: ignore
    except Exception:
        return audio_path, None, None
    try:
        decoded = decode_audio(audio_path, sampling_rate=16000)
    except Exception:
        return audio_path, None, None
    original = np.asarray(decoded, dtype=np.float32).reshape(-1)
    cleaned = np.asarray(voice_runtime.denoise_pcm(original, 16000), dtype=np.float32).reshape(-1)
    if cleaned.size == 0:
        return audio_path, original, None
    if cleaned.shape == original.shape and np.allclose(cleaned, original):
        return audio_path, original, None
    dest = str(Path(audio_path).with_suffix(".denoise.wav"))
    try:
        sf.write(dest, cleaned, 16000)
    except Exception:
        return audio_path, original, None
    return dest, cleaned, dest


def transcribe_moonshine(samples, model_dir: str, on_partial) -> str | None:
    """English stream inside this worker. None sends the file to faster-whisper."""
    try:
        import numpy as np  # type: ignore
        from moonshine_voice import ModelArch, Transcriber  # type: ignore
    except Exception:
        return None
    audio = np.asarray(samples, dtype=np.float32).reshape(-1)
    if audio.size < 1600:
        return None
    if audio.size > 16000 * 30:
        audio = audio[: 16000 * 30]
    try:
        transcriber = Transcriber(model_dir, model_arch=ModelArch.TINY_STREAMING)
        stream = transcriber.create_stream(update_interval=0.5)
        stream.start()
        step = 16000
        for start in range(0, audio.size, step):
            stream.add_audio(audio[start : start + step].tolist(), 16000)
        result = stream.stop()
        lines = getattr(result, "lines", None) or []
        text = " ".join(
            (getattr(line, "text", "") or "").strip() for line in lines if (getattr(line, "text", "") or "").strip()
        ).strip()
    except Exception:
        return None
    if text and on_partial:
        on_partial(text)
    return text or None


def transcribe_file(
    audio: str,
    model_name: str,
    language: str,
    initial_prompt: str,
    on_partial=None,
    speech_pref: str = "",
    owner_size: str = "",
    model_path: str = "",
) -> dict:
    prepared, samples, cleanup = prepare_audio(audio)
    try:
        return _transcribe_prepared(
            prepared,
            samples,
            model_name,
            language,
            initial_prompt,
            on_partial,
            speech_pref,
            owner_size,
            model_path,
        )
    finally:
        if cleanup and os.path.exists(cleanup):
            try:
                os.remove(cleanup)
            except OSError:
                pass


def _transcribe_prepared(
    audio: str,
    samples,
    model_name: str,
    language: str,
    initial_prompt: str,
    on_partial,
    speech_pref: str,
    owner_size: str = "",
    model_path: str = "",
) -> dict:
    engine = "faster-whisper"
    moon_text = None
    if wants_english_stream(language, speech_pref) and samples is not None:
        moon_dir = moonshine_model_dir()
        if moon_dir:
            moon_text = transcribe_moonshine(samples, moon_dir, on_partial)
            if moon_text:
                engine = "moonshine-en"
    turn_probability = None
    if samples is not None:
        try:
            import voice_runtime

            scored = voice_runtime.score_turn(samples, 16000)
            if isinstance(scored.get("probability"), (int, float)):
                turn_probability = float(scored["probability"])
        except Exception:
            turn_probability = None
    if moon_text:
        return {
            "ok": True,
            "text": moon_text,
            "language": "en",
            "durationMs": 0,
            "model": "moonshine-tiny-streaming",
            "noSpeechProb": 0.0,
            "loadCount": _load_count,
            "engine": engine,
            "turnProbability": turn_probability,
        }
    model = get_model(owner_model(owner_size, model_name), model_path or None)
    lang = resolve_language(language)
    hint = (initial_prompt or "").strip()
    if lang is None and not hint:
        hint = DEFAULT_HINT
    kwargs: dict = {
        "language": lang,
        "vad_filter": True,
        "beam_size": 1,
        "condition_on_previous_text": False,
    }
    if hint:
        kwargs["initial_prompt"] = hint[:800]
    segments, info = model.transcribe(audio, **kwargs)
    parts: list[str] = []
    no_speech: list[float] = []
    partials = 0
    for seg in segments:
        text = (getattr(seg, "text", "") or "").strip()
        if text:
            parts.append(text)
            partials += 1
            if on_partial and partials <= 12:
                on_partial(" ".join(parts))
        prob = getattr(seg, "no_speech_prob", None)
        if isinstance(prob, (int, float)):
            no_speech.append(float(prob))
    text = " ".join(parts).strip()
    avg_ns = sum(no_speech) / len(no_speech) if no_speech else 0.0
    if avg_ns >= 0.7:
        text = ""
    return {
        "ok": True,
        "text": text,
        "language": getattr(info, "language", lang or ""),
        "durationMs": int(float(getattr(info, "duration", 0.0)) * 1000),
        "model": _model_name or model_name,
        "noSpeechProb": round(avg_ns, 4),
        "loadCount": _load_count,
        "engine": engine,
        "turnProbability": turn_probability,
    }


def status_payload() -> dict:
    cls = _import_whisper()
    return {
        "ok": True,
        "available": cls is not None,
        "dependency": "ready" if cls is not None else "missing",
        "modelLoaded": _model is not None,
        "model": _model_name or DEFAULT_MODEL,
        "cache": cache_dir(),
        "loadCount": _load_count,
        "inference": "verified" if _model is not None else "unverified",
        "error": None if cls is not None else _whisper_error,
    }


def handle_request(req: dict) -> dict:
    op = str(req.get("op") or "")
    if op in {"status", "probe"}:
        return status_payload()
    if op == "load":
        import time

        started = time.time()
        try:
            get_model(str(req.get("model") or DEFAULT_MODEL), str(req.get("model_path") or "") or None)
            return {
                "ok": True,
                "model": _model_name,
                "cache": cache_dir(),
                "elapsedMs": int((time.time() - started) * 1000),
                "loadCount": _load_count,
                "inference": "verified",
            }
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "reason": "model-load-failed", "error": str(exc)[-600:], "loadCount": _load_count}
    if op == "partial-plan":
        try:
            duration = float(req.get("duration") or 0)
        except (TypeError, ValueError):
            duration = 0.0
        return {"ok": True, "windows": plan_partials(duration), "engine": "faster-whisper"}
    if op == "transcribe":
        audio = str(req.get("audio") or "")
        if not audio or not os.path.exists(audio):
            return {"ok": False, "reason": "no-audio", "error": "No audio file was supplied."}
        rid = req.get("id")

        def on_partial(text: str) -> None:
            if rid is None or not text:
                return
            emit({"id": rid, "stream": True, "text": text, "engine": "faster-whisper"})

        try:
            return transcribe_file(
                audio,
                str(req.get("model") or DEFAULT_MODEL),
                str(req.get("language") or ""),
                str(req.get("initial_prompt") or req.get("initialPrompt") or ""),
                on_partial if rid is not None else None,
                str(req.get("speech_pref") or req.get("speechPref") or ""),
                str(req.get("sttSize") or req.get("stt_size") or ""),
                str(req.get("model_path") or ""),
            )
        except Exception as exc:  # noqa: BLE001
            reason = "missing-dependency" if _whisper_cls is None else "transcribe-failed"
            return {"ok": False, "reason": reason, "error": str(exc)[-600:], "loadCount": _load_count}
    if op == "shutdown":
        return {"ok": True, "op": "shutdown", "loadCount": _load_count}
    return {"ok": False, "reason": "unknown-op", "error": f"unknown op {op!r}"}


def serve() -> int:
    """Persistent worker: one process, one WhisperModel, many utterances."""
    try:
        sys.stdin.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001,S110 — a console that cannot be reconfigured still reads lines
        pass
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as exc:  # noqa: BLE001
            emit({"ok": False, "reason": "bad-request", "error": str(exc)[-200:]})
            continue
        if not isinstance(req, dict):
            emit({"ok": False, "reason": "bad-request", "error": "request must be an object"})
            continue
        rid = req.get("id")
        result = handle_request(req)
        if rid is not None:
            result = {"id": rid, **result}
        emit(result)
        if str(req.get("op") or "") == "shutdown":
            return 0
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio")
    ap.add_argument("--language", default="")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--initial-prompt", default="", dest="initial_prompt")
    ap.add_argument("--probe", action="store_true")
    ap.add_argument("--load-probe", dest="load_probe", action="store_true")
    ap.add_argument("--serve", action="store_true")
    args = ap.parse_args()

    if args.serve:
        return serve()

    if _import_whisper() is None:
        emit({"ok": False, "reason": "missing-dependency", "error": _whisper_error})
        return 0

    if args.probe:
        payload = status_payload()
        payload["available"] = True
        emit(payload)
        return 0

    if args.load_probe:
        import time

        started = time.time()
        try:
            get_model(args.model)
            emit(
                {
                    "ok": True,
                    "model": args.model,
                    "cache": cache_dir(),
                    "elapsedMs": int((time.time() - started) * 1000),
                    "loadCount": _load_count,
                }
            )
        except Exception as exc:  # noqa: BLE001
            emit({"ok": False, "reason": "model-load-failed", "error": str(exc)[-600:]})
        return 0

    if not args.audio or not os.path.exists(args.audio):
        emit({"ok": False, "reason": "no-audio", "error": "No audio file was supplied."})
        return 0

    try:
        emit(transcribe_file(args.audio, args.model, args.language, args.initial_prompt))
    except Exception as exc:  # noqa: BLE001
        emit({"ok": False, "reason": "transcribe-failed", "error": str(exc)[-600:]})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
