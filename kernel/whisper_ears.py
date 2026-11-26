"""Two optional faster-whisper ears that download on demand and are never bundled.

* The Hinglish ear: a Whisper-base fine-tune (Apache-2.0, 78 MB, CTranslate2 int8) that writes Hindi speech in
  Roman letters. It must be decoded with ``language="en"`` (with ``"hi"`` it falls back to Devanagari). Roman
  Hinglish conflicts with the default script policy (Hindi stays in Devanagari), so it is used ONLY when the owner
  picks the explicit ``hi-Latn`` listening mode. No other setting, language or fallback ever reaches it.
* The Hindi fallback: Collabora's Whisper-small Hindi fine-tune (CC-BY-4.0, credit shown on the Models page). It
  stands in for generic faster-whisper small only when Hindi is chosen, the Hindi ear is missing, and these
  weights are installed.
* The Trelis mixed-script ear (``hinglish-ear-trelis``): a Whisper large-v3 fine-tune (Apache-2.0, int8 CTranslate2,
  GPU class) that writes Hindi words in Devanagari and English words in Latin letters. It needs a decoder prompt that
  the library cannot build by itself (see ``MarkerDecoder``). It is a candidate, never a default: it is used only when
  the request names it (``hinglishEar: "trelis"``), the pinned files are on disk at the pinned sizes, and the PC has
  a GPU with at least 4 GB of video memory (or the owner forces it). Anything else, and any failure, leaves the engine
  of today to answer.

The weights sit in ``<FRIDAY root>/models/<id>`` at the revision and SHA-256 pinned in ``electron/voice-pins.cjs``;
this module only looks at the disk and never downloads. Whatever is missing, broken or silent falls back to the
engine that works today.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import threading
from collections.abc import Callable
from pathlib import Path

import language_segmenter
from la2_partials import roman_hindi, script_of

HINGLISH_ID = "hinglish-ear"
HINDI_FALLBACK_ID = "hindi-fallback-ear"
# What a faster-whisper folder needs to open (every one is pinned by revision, size and SHA-256).
REQUIRED = ("model.bin", "config.json", "tokenizer.json", "vocabulary.json", "preprocessor_config.json")
# The pinned model files are 76,396,677 and 483,546,977 bytes; anything far smaller is a partial download.
MIN_BYTES = {HINGLISH_ID: 70_000_000, HINDI_FALLBACK_ID: 450_000_000}
# `hi-Latn` is the BCP 47 tag for Hindi written in Roman letters; `hinglish-roman` is the plain-words alias.
ROMAN_MODES = frozenset({"hi-latn", "hinglish-roman"})

_failed: set[str] = set()


def _norm(value: str) -> str:
    return (value or "").strip().lower().replace("_", "-")


def model_dir(ear_id: str) -> Path | None:
    """The folder with every pinned file on disk, or None. This does not download or open the model."""
    root = os.environ.get("FRIDAY_ROOT", "").strip()
    folder = (Path(root) if root else Path.home() / ".friday") / "models" / ear_id
    try:
        for name in REQUIRED:
            if not (folder / name).is_file():
                return None
        if (folder / "model.bin").stat().st_size < MIN_BYTES[ear_id]:
            return None
    except OSError:
        return None
    return folder


def hinglish_ready() -> bool:
    return model_dir(HINGLISH_ID) is not None


def hindi_fallback_ready() -> bool:
    return model_dir(HINDI_FALLBACK_ID) is not None


def wants_roman_hinglish(language: str, speech_pref: str) -> bool:
    """True only for the explicit Hinglish (Roman) mode. Hindi, English, Hinglish in Devanagari and auto are not."""
    raw = _norm(speech_pref) or _norm(language)
    return raw in ROMAN_MODES or raw.startswith("hi-latn-")  # a region or variant subtag keeps the Roman mode


def mark_failed(ear_id: str) -> None:
    """A broken ear is not tried again in this worker, so one bad file cannot slow every utterance."""
    _failed.add(ear_id)


def reset_failures() -> None:
    _failed.clear()


def choose(language: str, speech_pref: str, hindi_ear_ready: bool, hindi_chosen: bool) -> dict | None:
    """The faster-whisper folder to listen with instead of the generic model, or None for the engine of today.

    ``hindi_chosen`` is the Hindi-only test of the Hindi ear (never true in the Roman mode).
    """
    if wants_roman_hinglish(language, speech_pref):
        folder = None if HINGLISH_ID in _failed else model_dir(HINGLISH_ID)
        if folder is not None:
            # Decode as "en": the fine-tune writes Roman Hinglish for English-tagged decoding only.
            return {"id": HINGLISH_ID, "path": str(folder), "decode": "en", "report": "hi", "engine": "hinglish-ear"}
        return None
    if hindi_chosen and not hindi_ear_ready:
        folder = None if HINDI_FALLBACK_ID in _failed else model_dir(HINDI_FALLBACK_ID)
        if folder is not None:
            return {
                "id": HINDI_FALLBACK_ID,
                "path": str(folder),
                "decode": "hi",
                "report": "hi",
                "engine": "hindi-fallback-ear",
            }
    return None


def roman_hindi_segment(text: str) -> bool:
    """True when one phrase is Hindi written in Roman letters: no Devanagari, at least two Latin words, at least two of
    them common Hindi (the lexicon of ``language_segmenter``) and those are half or more of the Latin words.

    A live pass uses this to send only such a phrase to the Hindi ear (Devanagari for Hindi words, Latin for English
    words). Hindi and English mixed inside one phrase ("mujhe ek meeting schedule karni hai") is not split: the ear
    would need a word boundary that the audio does not give cleanly (see FRIDAY_VOICE_ENGINE.md).
    """
    body = text or ""
    if re.search("[\u0900-\u097f]", body):
        return False
    latin = re.findall("[A-Za-z]+", body)
    if len(latin) < 2:
        return False
    hits = round(language_segmenter.roman_hindi_ratio(body) * len(latin))
    return hits >= 2 and hits * 2 >= len(latin)


# ---- the Trelis mixed-script ear -----------------------------------------------------------------------------------

TRELIS_ID = "hinglish-ear-trelis"
TRELIS_SUBDIR = "int8"  # the model folder is the pinned repository's int8/ subfolder
# The pinned files and their exact sizes (electron/voice-pins.cjs, "nikh360pro/capsbro-hinglish-ct2"; a test keeps the
# two lists equal). Every one must be on disk at exactly this size: a partial or swapped file is not the model.
TRELIS_FILES = {
    "config.json": 2634,
    "model.bin": 1556723863,
    "preprocessor_config.json": 357,
    "tokenizer.json": 2480617,
    "vocabulary.json": 1120001,
}
# The decoder prompt is [<|startoftranscript|>, <|hi|>, MARKER, <|transcribe|>, <|notimestamps|>]. The marker
# <|mixedcode|> sits after the language and before the task. tokenizer.json stops at id 51865 and cannot encode it, so
# it is written as this literal id; vocabulary.json holds it at this index (checked before the ear opens).
TRELIS_MARKER_ID = 51866
TRELIS_MARKER_TOKEN = "<|mixedcode|>"  # noqa: S105 — a vocabulary entry, not a secret
TRELIS_DECODE = "hi"  # "en" gives the same quality; Hindi is the tag the evaluation used
TRELIS_COMPUTE_GPU = "int8_float16"  # untested on a GPU here; the CPU path is int8 (the worker's own choice)
TRELIS_MIN_VRAM_GB = 4.0
TRELIS_OPTIONS = frozenset({"trelis", "hinglish-ear-trelis"})
_TRUTHY = frozenset({"1", "true", "yes", "on"})

_marker_checked: dict[str, bool] = {}
_decode_lock = threading.RLock()
_active_hf: object | None = None  # the one tokenizer a marker decode is building right now
_marker_cls: type | None = None
_vram_cache: list[float | None] = []


def _marker_in_vocabulary(folder: Path) -> bool:
    """True when vocabulary.json holds the marker token at the literal id (read once per folder and size)."""
    path = folder / "vocabulary.json"
    try:
        key = f"{path}:{path.stat().st_size}:{path.stat().st_mtime_ns}"
    except OSError:
        return False
    if key not in _marker_checked:
        try:
            words = json.loads(path.read_text(encoding="utf-8"))
            ok = (
                isinstance(words, list)
                and len(words) > TRELIS_MARKER_ID
                and words[TRELIS_MARKER_ID] == TRELIS_MARKER_TOKEN
            )
        except (OSError, ValueError):
            ok = False
        _marker_checked[key] = ok
    return _marker_checked[key]


def trelis_dir() -> Path | None:
    """The int8 folder with every pinned file at its pinned size and the marker in its vocabulary, or None."""
    root = os.environ.get("FRIDAY_ROOT", "").strip()
    folder = (Path(root) if root else Path.home() / ".friday") / "models" / TRELIS_ID / TRELIS_SUBDIR
    try:
        for name, size in TRELIS_FILES.items():
            if not (folder / name).is_file() or (folder / name).stat().st_size != size:
                return None
    except OSError:
        return None
    return folder if _marker_in_vocabulary(folder) else None


def trelis_ready() -> bool:
    return trelis_dir() is not None


def wants_trelis(extras: dict | None) -> bool:
    """True only when the request names this ear. No language, mode or setting selects it by itself."""
    return _norm(str((extras or {}).get("hinglish_ear") or "")) in TRELIS_OPTIONS


def _forced(extras: dict | None) -> bool:
    env = os.environ.get("FRIDAY_HINGLISH_EAR_FORCE", "").strip().lower() in _TRUTHY
    return env or (extras or {}).get("hinglish_ear_force") is True


def gpu_vram_gb() -> float | None:
    """Total video memory of the first NVIDIA card in GB (FRIDAY_GPU_VRAM_GB wins; else one short nvidia-smi query,
    asked once). None when it cannot be told."""
    raw = os.environ.get("FRIDAY_GPU_VRAM_GB", "").strip()
    if raw:
        try:
            return float(raw)
        except ValueError:
            return None
    if not _vram_cache:
        value: float | None = None
        try:
            out = subprocess.run(  # noqa: S603 — a fixed argument list, no shell
                ["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"],  # noqa: S607
                capture_output=True,
                text=True,
                timeout=4,
                check=False,
            )
            first = (out.stdout or "").strip().splitlines()[:1]
            value = float(first[0]) / 1024.0 if first else None
        except (OSError, ValueError, subprocess.SubprocessError):
            value = None
        _vram_cache.append(value)
    return _vram_cache[0]


def trelis_verdict(
    extras: dict | None, cuda_ready: bool | Callable[[], bool], vram_gb: float | None = None
) -> tuple[dict | None, str]:
    """(the ear to listen with or None, why not). The reason is "" when the ear was not asked for. ``cuda_ready`` may
    be a function: it is asked only when the ear was named and the hardware matters."""
    if not wants_trelis(extras):
        return None, ""
    if TRELIS_ID in _failed:
        return None, "failed-before"
    folder = trelis_dir()
    if folder is None:
        return None, "not-installed"
    if not _forced(extras):
        if not (cuda_ready() if callable(cuda_ready) else cuda_ready):
            return None, "no-gpu"
        vram = vram_gb if vram_gb is not None else gpu_vram_gb()
        if vram is None:
            return None, "vram-unknown"
        if vram < TRELIS_MIN_VRAM_GB:
            return None, "vram-too-small"
    return {
        "id": TRELIS_ID,
        "path": str(folder),
        "decode": TRELIS_DECODE,
        "report": "hi",
        "engine": "hinglish-ear-trelis",
        "compute_type": TRELIS_COMPUTE_GPU,
        "marker": True,
    }, ""


def is_trelis_path(path: str | None) -> bool:
    """True when ``path`` is the Trelis folder (a live pass must not decode with it: it has no marker prompt)."""
    parts = Path(str(path or "")).parts
    return len(parts) >= 2 and parts[-1] == TRELIS_SUBDIR and parts[-2] == TRELIS_ID


def _marker_tokenizer_class() -> type:
    """A faster-whisper Tokenizer whose start sequence carries the marker, for the one tokenizer being built."""
    global _marker_cls
    if _marker_cls is None:
        from faster_whisper.tokenizer import Tokenizer

        class MarkerTokenizer(Tokenizer):
            def __init__(self, tokenizer, *args, **kwargs):
                super().__init__(tokenizer, *args, **kwargs)
                self._marked = tokenizer is _active_hf  # read later, when the lazy decode asks for the sequence

            @property
            def sot_sequence(self) -> list[int]:
                base = list(super().sot_sequence)
                if not self._marked:
                    return base
                if len(base) != 3:  # [sot, language, task]: anything else is not a multilingual large-v3
                    raise RuntimeError("the Trelis ear needs a multilingual tokenizer")
                return [base[0], base[1], TRELIS_MARKER_ID, base[2]]

        _marker_cls = MarkerTokenizer
    return _marker_cls


class MarkerDecoder:
    """A faster-whisper model that decodes with the Trelis prompt. Every other model is untouched: the library's
    ``Tokenizer`` is swapped only while this model's ``transcribe`` builds its own tokenizer (it does so before it
    returns, and the swap is put back afterwards, even on an error), and the swapped class adds the marker only to the
    tokenizer of this model."""

    def __init__(self, model, language: str = TRELIS_DECODE):
        self._model = model
        self._language = language
        if getattr(model, "hf_tokenizer", None) is None:
            raise RuntimeError("the Trelis ear needs the model's own tokenizer")

    def __getattr__(self, name: str):
        return getattr(self._model, name)

    def transcribe(self, audio, **kwargs):
        import faster_whisper.transcribe as ft

        global _active_hf
        options = dict(kwargs)
        if options.get("language") not in {"hi", "en"}:
            options["language"] = self._language
        options["without_timestamps"] = True  # the prompt ends with <|notimestamps|>
        for key in ("initial_prompt", "hotwords", "multilingual"):  # the verified contract has no prompt text
            options.pop(key, None)
        with _decode_lock:
            original = ft.Tokenizer
            _active_hf = self._model.hf_tokenizer
            ft.Tokenizer = _marker_tokenizer_class()
            try:
                return self._model.transcribe(audio, **options)
            finally:
                ft.Tokenizer = original
                _active_hf = None


def decoder_for(model, alt: dict | None):
    """The model to decode with: wrapped for the Trelis ear, the same object for every other engine."""
    if alt is not None and alt.get("id") == TRELIS_ID:
        return MarkerDecoder(model, str(alt.get("decode") or TRELIS_DECODE))
    return model


def script_violation(text: str, speech_pref: str = "") -> bool:
    """True when the reading breaks the script policy: Hindi in Roman letters (Hindi stays in Devanagari, English in
    Latin) unless the owner chose the Roman Hinglish mode."""
    return not wants_roman_hinglish("", speech_pref) and roman_hindi(text)


def result_facts(alt: dict | None, text: str, skipped: str = "") -> dict:
    """Extra result fields: the marker and the script of the Trelis reading, or why the ear that was asked for did not
    run. Empty for every other engine."""
    if alt is not None and alt.get("id") == TRELIS_ID:
        return {"marker": True, "script": script_of(text)}
    return {"hinglishEarSkipped": skipped} if skipped else {}


def request_options(req: dict) -> dict:
    """The Trelis options of a worker request, only the ones that are set (so a request without them is unchanged)."""
    out: dict = {}
    named = req.get("hinglishEar") or req.get("hinglish_ear")
    if isinstance(named, str) and named.strip():
        out["hinglish_ear"] = named.strip()
    if (req.get("hinglishEarForce") or req.get("hinglish_ear_force")) is True:
        out["hinglish_ear_force"] = True
    return out
