"""FRIDAY's Hindi ear: a Hindi speech recogniser that runs on this PC with no torch.

The weights are the Hindi IndicConformer model exported to ONNX (MIT), the int8 file only, run by FRIDAY's own NeMo
runner (``nemo_ear.py``: numpy and onnxruntime, nothing else). If that runner cannot open the folder, the
``onnx-asr`` package, when it is installed, still can; both read the same files and give the same line. They are
downloaded on demand by the Install Manager into ``<FRIDAY root>/models/hindi-ear`` at a pinned revision and SHA-256
(``electron/voice-pins.cjs``); this module never downloads.

It is used only when the owner picks Hindi. English stays on Moonshine or faster-whisper, and Hinglish and
auto stay on faster-whisper, which also answers whenever this ear is missing, fails, or hears nothing in
Devanagari, so a missing file or a bad run can never lose an utterance. A folder neither runner can open is
remembered (by its model file's time and size) and reported in ``error()``, so it is tried once, not on every
interim; every load first asks the worker's memory admission (``admit_hook``). Text stays as heard; nothing is
transliterated. When the optional punctuation model (``hindi_punct.py``) is installed, marks are added to a line the
ear wrote without any; the words themselves are never changed.

The owner's own words (names, project terms) bias the ear while it decodes: ``with_hotwords(words)`` scopes them around
a read, and the ear then gets a ``context_graph`` of those words and their Roman and Devanagari spellings
(``hotword_bias``). Only FRIDAY's own runner takes them; the confidence and noise gates judge the biased reading by its
acoustic scores, and with no words, or none that made it into the line, the reading is the plain greedy one.
"""

from __future__ import annotations

import os
import re
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import hindi_punct
import hinglish_lexicon

MODEL_DIR = "hindi-ear"
MODEL_FILE = "model.int8.onnx"
REQUIRED = (MODEL_FILE, "vocab.txt", "config.json")
MODEL_TYPE = "nemo-conformer-ctc"
# The pinned file is 137,677,313 bytes; anything far smaller is a partial download.
MIN_MODEL_BYTES = 100_000_000
SAMPLE_RATE = 16000
MIN_SECONDS = 0.2
MAX_SECONDS = 60
_DEVANAGARI = re.compile(r"[ऀ-ॿ]")
_model = None
_model_dir = ""
_timed = None  # (model, its timed reader)
_owner_words: tuple[str, ...] = ()  # the owner's words for the read in progress (see ``with_hotwords``)
_bias = None  # (model, words, graph): the bias graph of the last word list, built once per model and list
# Rough resident sizes for the worker's memory admission (``stt.admit``): the int8 ear and the punctuation model.
LOAD_MB = 450.0
PUNCT_LOAD_MB = 350.0
# The worker's admission check before a load: ``(kind, est_mb) -> bool``. Alone (tests, tools) every load is admitted.


def admit_all(_kind: str, _mb: float) -> bool:
    """The admission of a module run alone (tests, tools): every load may open. The worker sets ``admit_hook``."""
    return True


admit_hook: Callable[[str, float], bool] = admit_all
# A folder neither runner could open, keyed by folder, model file mtime and size: tried once, not on every interim.
_broken: dict[tuple[str, int, int], str] = {}
_last_skip = ""  # why the last read did not run: "", "low-memory" (refused) or "broken"


class EarSkipped(RuntimeError):
    """The ear did not open: ``kind`` is ``low-memory`` (the worker refused the load) or ``broken``."""

    def __init__(self, kind: str) -> None:
        super().__init__(kind)
        self.kind = kind


def model_dir() -> Path | None:
    """The folder with the three files on disk, or None. This does not download or open the model."""
    root = os.environ.get("FRIDAY_ROOT", "").strip()
    folder = (Path(root) if root else Path.home() / ".friday") / "models" / MODEL_DIR
    try:
        for name in REQUIRED:
            if not (folder / name).is_file():
                return None
        if (folder / MODEL_FILE).stat().st_size < MIN_MODEL_BYTES:
            return None
    except OSError:
        return None
    return folder


def _folder_key(folder: Path) -> tuple[str, int, int]:
    try:
        stat = (folder / MODEL_FILE).stat()
    except OSError:
        return (str(folder), 0, 0)
    return (str(folder), stat.st_mtime_ns, stat.st_size)


def ready() -> bool:
    """The files are on disk and this worker has not found them unreadable."""
    folder = model_dir()
    return folder is not None and _folder_key(folder) not in _broken


def error() -> str | None:
    """Why the ear on disk cannot open (no folder names), or None."""
    folder = model_dir()
    return None if folder is None else _broken.get(_folder_key(folder))


def last_skip() -> str:
    """Why the last read did not run: "" (it ran, or there was nothing to read), "low-memory" or "broken"."""
    return _last_skip


def _error_text(exc: BaseException) -> str:
    try:
        from voice_runtime import _safe_error

        return _safe_error(exc)
    except Exception:  # noqa: BLE001 - without the scrubber only the class name leaves
        return type(exc).__name__


def wants_hindi(language: str, speech_pref: str) -> bool:
    """Only when Hindi is chosen. Hinglish, auto and English are not Hindi-only speech."""
    raw = (speech_pref or "").strip().lower().replace("_", "-") or (language or "").strip().lower().replace("_", "-")
    if raw == "hi-latn" or raw.startswith("hi-latn-"):  # Roman-letter Hindi (any region) is the Hinglish (Roman) mode
        return False
    return raw == "hi" or raw.startswith("hi-")


def listen_mode(language: str, speech_pref: str) -> str:
    """How the owner chose to be heard: ``hi``, ``roman`` (Hinglish in Roman letters), ``en``, ``auto`` or ``other``.

    No choice at all (the warm-up and the live preview send none) is ``auto``.
    """
    raw = (speech_pref or "").strip().lower().replace("_", "-") or (language or "").strip().lower().replace("_", "-")
    if not raw or raw in {"auto", "mixed"}:
        return "auto"
    if raw == "hi-latn" or raw.startswith("hi-latn-") or raw == "hinglish-roman":
        return "roman"
    if raw == "hi" or raw.startswith("hi-"):
        return "hi"
    if raw == "en" or raw.startswith("en-"):
        return "en"
    return "other"


def tries_ear(language: str, speech_pref: str) -> bool:
    """Hindi chosen, or no language chosen (auto): the ear listens first, and its own confidence decides whether it
    keeps the line. English, Roman Hinglish and every other language never reach it."""
    return listen_mode(language, speech_pref) in {"hi", "auto"}


# Mean token log-probability of the ear's own reading below which it is not trusted. Measured on synthetic speech
# (Supertonic F2, 22 sentences, clean and with noise): Hindi sentences read -0.00 to -0.26 (code-mixed Devanagari
# -0.27), English read -0.13 to -1.2 (mostly below -0.35, transliterated into Devanagari words that mean nothing).
# Hindi chosen is more lenient, since the owner asked for Hindi and the ear is far the better Hindi reader; auto is
# stricter, since English is likely. Real microphones are noisier than this clean set: unverified on the owner's PC.
EAR_MIN_LOGPROB = {"hi": -0.40, "auto": -0.33}


def confident(mode: str, mean_logprob: float | None) -> bool:
    """True when the ear's line stands. No score (an old runtime, or none measured) is today's behaviour: it stands."""
    if mean_logprob is None or mode not in EAR_MIN_LOGPROB:
        return True
    return float(mean_logprob) >= EAR_MIN_LOGPROB[mode]


_last_confidence: float | None = None


def last_confidence() -> float | None:
    """The mean token log-probability of the most recent reading, or None when it was not measured."""
    return _last_confidence


# ---- The English gate (auto only) ---------------------------------------------------------------------------------
# The ear writes English speech as Devanagari spellings ("व्हाट टाइम इज द"), often with a score inside its own floor:
# on 8 synthetic English clips it kept 4 such lines in auto. Before a line is kept, its own words are read: Hindi
# grammar words keep it, English function words spelled in Devanagari send it to the English lane, and only a line
# the words cannot tell asks the clip itself (whisper's language guess on the first seconds, from a model already
# resident) and then the turn before it. No threshold of the ear is lowered; the gate only refuses more.
ENGLISH_GATE = {
    "sureLogprob": -0.15,  # an ear this sure, with no English function word, keeps its line with no model run
    "strongMin": 2,  # this many English function words and no Hindi word: English
    "shareMin": 0.6,  # or one function word and this share of English words (function, loan, folded): English
    "foldMinConsonants": 3,  # a consonant fold shorter than this is never evidence (कल folds like "call")
    "cueSeconds": 2.0,  # the clip's opening the language guess hears
    "cueMin": 0.5,  # the guess must give a language at least this
    "cueRatio": 3.0,  # and this many times the other language
}
# English words that are not Hindi words, as the ear spells them (gate keys: nukta dropped, ॉ read as ो).
ENGLISH_FUNCTION_WORDS = (
    "द दि इज व्हाट वाट व्हॉट हाउ आर यू योर युअर माय माइ मी टू टु फॉर ऑफ ऑन एट एन एंड ऐंड प्लीज विद विथ दिस दैट देट "
    "इट कैन विल डू डज फ्रॉम अप वी देयर व्हेयर व्हेन व्हाई हू"
).split()
# English words the owner may say inside Hindi too: evidence only beside a function word.
ENGLISH_WEAK_WORDS = "सेवन थर्टी ट्वेंटी फाइव सिक्स नाइन टेन टुमारो टुडे डाउन सेट टर्न रीड कॉल सेंड मॉम लास्ट".split()
ENGLISH_FOLD_WORDS = (
    "seven thirty twenty forty fifty tomorrow morning evening little last weather volume minute second number "
    "message chrome music remind reminder alarm calendar timer battery"
).split()
# Common Hindi words the shared lexicon does not list in Devanagari.
HINDI_GRAMMAR_WORDS = "है में ने पर हो कर दो लो ना एक हम वह उस उन थोड़ी".split()

_DEVA_FOLD = dict.fromkeys("कख", "k") | dict.fromkeys("गघ", "g") | dict.fromkeys("चछ", "c") | dict.fromkeys("जझ", "j")
_DEVA_FOLD |= dict.fromkeys("टठतथ", "t") | dict.fromkeys("डढदध", "d") | dict.fromkeys("णनं", "n")
_DEVA_FOLD |= {"प": "p", "फ": "f", "ब": "b", "भ": "b", "म": "m", "र": "r", "ल": "l", "व": "v"}
_DEVA_FOLD |= dict.fromkeys("शषस", "s")
_ROMAN_PAIRS = (("ph", "f"), ("th", "t"), ("ck", "k"), ("chr", "kr"), ("ch", "c"), ("sh", "s"), ("qu", "kv"))


def _gate_key(word: str) -> str:
    return hinglish_lexicon.lexicon_key(word).replace("ॉ", "ो").replace("ॅ", "े")


def _collapse(letters: str) -> str:
    return "".join(ch for i, ch in enumerate(letters) if i == 0 or letters[i - 1] != ch)


def deva_fold(word: str) -> str:
    """The consonant outline of a Devanagari word in Roman letters (वॉल्यम -> vlm); vowels, य and ह say nothing."""
    return _collapse("".join(_DEVA_FOLD.get(ch, "") for ch in _gate_key(word)))


def roman_fold(word: str) -> str:
    """The same outline of an English spelling (volume -> vlm, Jarvis -> jrvs, cancel -> knsl)."""
    text = word.lower()
    for pair, sound in _ROMAN_PAIRS:
        text = text.replace(pair, sound)
    text = re.sub(r"c(?=[eiy])", "s", text).replace("c", "k").replace("q", "k").replace("x", "ks")
    text = text.replace("w", "v").replace("z", "j")
    return _collapse(re.sub(r"[^bcdfgjklmnprstv]", "", text))


def _keys(words) -> frozenset[str]:
    return frozenset(_gate_key(s) for w in words for s in str(w).split("|") if s)


_HINDI_KEYS = _keys(hinglish_lexicon._SURE.values()) | _keys(HINDI_GRAMMAR_WORDS)
_STRONG_KEYS = _keys(ENGLISH_FUNCTION_WORDS) - _HINDI_KEYS
_WEAK_KEYS = (_keys(hinglish_lexicon._LOAN) | _keys(ENGLISH_WEAK_WORDS)) - _HINDI_KEYS - _STRONG_KEYS
_LOAN_LATIN = sorted(set(hinglish_lexicon._LOAN.values()) | set(ENGLISH_FOLD_WORDS))


def _folds(words) -> frozenset[str]:
    floor = int(ENGLISH_GATE["foldMinConsonants"])
    return frozenset(f for f in (roman_fold(w) for w in words) if len(f) >= floor)


_FOLD_KEYS = _folds(_LOAN_LATIN)


def english_gate(text: str | None, confidence: float | None, hotwords: Sequence[str] = ()) -> dict:
    """Whether the ear's line is Hindi to keep, English spelled in Devanagari, or a line its words cannot tell.

    ``{"verdict": "keep" | "english" | "listen", "why", "hindi", "strong", "weak", "words"}``; only ``listen`` asks
    for the clip's own cue (``settle_gate``). The owner's English hotwords count as English words by their fold."""
    cores = [c for c in (hinglish_lexicon._core(p) for p in str(text or "").split()) if c]
    counts = {"hindi": 0, "strong": 0, "weak": 0, "words": len(cores)}

    def verdict(kind: str, why: str) -> dict:
        return {"verdict": kind, "why": why, **counts}

    if not cores:
        return verdict("keep", "no-words")
    if any("a" <= ch.lower() <= "z" for c in cores for ch in c):
        return verdict("keep", "mixed-script")  # the ear wrote Latin letters itself: Hinglish, kept as written
    sure_hindi = set(hinglish_lexicon._SURE)
    folds = _FOLD_KEYS | _folds(w for w in hotwords if w.isascii() and w.lower() not in sure_hindi)
    for core in cores:
        key = _gate_key(core)
        if key in _HINDI_KEYS:
            counts["hindi"] += 1
        elif key in _STRONG_KEYS:
            counts["strong"] += 1
        elif key in _WEAK_KEYS or deva_fold(core) in folds:
            counts["weak"] += 1
    hindi, strong, words = counts["hindi"], counts["strong"], counts["words"]
    if hindi and hindi >= strong:
        return verdict("keep", "hindi-words")
    share = (strong + counts["weak"]) / words
    if not hindi and (strong >= ENGLISH_GATE["strongMin"] or (strong and share >= ENGLISH_GATE["shareMin"])):
        return verdict("english", "english-words")
    if not strong and confidence is not None and confidence >= ENGLISH_GATE["sureLogprob"]:
        return verdict("keep", "sure-ear")
    return verdict("listen", "unclear")


def settle_gate(gate: Mapping[str, Any], cue: Mapping[str, float] | None, prior: str) -> dict:
    """The final verdict of a ``listen`` line: the clip's own language guess (``{"en": p, "hi": p}``) when it is
    clear, then the turn before it (English after English), else the ear's line stands as before this gate."""
    if gate.get("verdict") != "listen":
        return dict(gate)
    en, hi = float((cue or {}).get("en") or 0.0), float((cue or {}).get("hi") or 0.0)
    least, ratio = ENGLISH_GATE["cueMin"], ENGLISH_GATE["cueRatio"]
    if en >= least and en >= ratio * hi:
        return {**gate, "verdict": "english", "why": "cue-en"}
    if hi >= least and hi >= ratio * en:
        return {**gate, "verdict": "keep", "why": "cue-hi"}
    if prior == "en":
        return {**gate, "verdict": "english", "why": "prior-en"}
    return {**gate, "verdict": "keep", "why": "ear-kept"}


def _load(folder: Path):
    """The open ear for ``folder``. Raises ``EarSkipped`` when the worker refuses the memory or the folder already
    failed to open in this worker (a re-download changes the file and is tried again)."""
    global _model, _model_dir, _last_skip
    if _model is not None and _model_dir == str(folder):
        return _model
    key = _folder_key(folder)
    if key in _broken:
        _last_skip = "broken"
        raise EarSkipped("broken")
    if not admit_hook("hindi-ear", LOAD_MB):
        _last_skip = "low-memory"
        raise EarSkipped("low-memory")
    try:
        try:
            import nemo_ear

            model = nemo_ear.NemoEar.load(folder, kind=nemo_ear.kind_of(MODEL_TYPE), quantization="int8")
        except Exception:  # noqa: BLE001 — the own runner could not open the folder: the pip package may still
            import onnx_asr  # type: ignore

            model = onnx_asr.load_model(MODEL_TYPE, path=str(folder), quantization="int8")
    except Exception as exc:  # noqa: BLE001 — neither runner opens it: remembered, so faster-whisper answers at once
        _broken[key] = _error_text(exc)
        _last_skip = "broken"
        raise EarSkipped("broken") from exc
    _model, _model_dir = model, str(folder)
    return _model


def _punctuate(text: str) -> str:
    """Marks from the optional punctuation model, when it is open or the worker admits opening it."""
    opened = getattr(hindi_punct, "_runtime", None) is not None
    if hindi_punct.ready() and not opened and not admit_hook("punct", PUNCT_LOAD_MB):
        return text
    return hindi_punct.apply(text)


@contextmanager
def with_hotwords(words: Sequence[str] | None) -> Iterator[None]:
    """Bias every read inside the block toward the owner's words; the previous words come back on exit."""
    global _owner_words
    before = _owner_words
    _owner_words = tuple(str(w) for w in (words or ()) if str(w).strip())
    try:
        yield
    finally:
        _owner_words = before


def hotword_bias(
    words: Sequence[str], vocab: Mapping[str, int], *, boost: float | None = None, word_mark: str = "\u2581"
):
    """The bias graph of ``words`` (with Roman and Devanagari spellings) over ``vocab`` (piece to id), or None."""
    import nemo_ear

    return nemo_ear.hotword_bias(words, vocab, boost=boost, word_mark=word_mark)


def _bias_for(model) -> dict:
    """``{"hotwords": graph}`` for the owner's words when this model takes them (FRIDAY's runner), else nothing."""
    global _bias
    build = getattr(model, "hotword_bias", None)
    if not _owner_words or not callable(build):
        return {}
    if _bias is None or _bias[0] is not model or _bias[1] != _owner_words:
        _bias = (model, _owner_words, build(list(_owner_words)))
    return {"hotwords": _bias[2]} if _bias[2] else {}


def loaded() -> bool:
    """True while the ear holds its model in memory."""
    return _model is not None


def unload() -> bool:
    """Drop the model and its timed reader so the memory returns; True when one was open. It loads again on demand."""
    global _model, _model_dir, _timed, _bias
    was_open = _model is not None
    _model, _model_dir, _timed, _bias = None, "", None, None
    return was_open


# A word ends this long after its last token at the latest, or where the next word starts, whichever is first.
LAST_TOKEN_S = 0.35
MIN_WORD_S = 0.05


def _word_rows(pieces: list[tuple[str, float]], duration: float) -> list[dict]:
    """``(text, start)`` per word to rows with an end: a word ends at the next one's start or a short time after it."""
    rows: list[dict] = []
    for index, (text, start) in enumerate(pieces):
        later = pieces[index + 1][1] if index + 1 < len(pieces) else duration
        end = min(later, start + LAST_TOKEN_S)
        end = max(end, start + MIN_WORD_S)
        rows.append({"text": text, "start": round(start, 3), "end": round(end, 3)})
    return rows


def group_words(tokens, timestamps, duration: float, text: str = "") -> list[dict]:
    """Words with times from the ear's tokens: ``[{"text", "start", "end"}]`` in seconds.

    The runtime (onnx-asr) marks the first token of a word with a leading space (or the SentencePiece ``▁``) and gives
    each token the time of its first frame. Without usable token times the words of ``text`` are spread over the clip
    by letter count, which keeps the order but not the real timing.
    """
    duration = max(0.0, float(duration or 0.0))
    if tokens and timestamps and len(tokens) == len(timestamps):
        pieces: list[tuple[str, float]] = []
        for token, stamp in zip(tokens, timestamps, strict=True):
            raw = str(token)
            starts_word = raw[:1] in {" ", "\u2581"} or not pieces
            body = raw.replace("\u2581", " ").strip()
            if not body:
                continue
            if starts_word:
                pieces.append((body, float(stamp)))
            else:
                pieces[-1] = (pieces[-1][0] + body, pieces[-1][1])
        if pieces:
            return _word_rows(pieces, max(duration, pieces[-1][1] + MIN_WORD_S))
    spoken = str(text or "").split()
    if not spoken or duration <= 0:
        return []
    total = sum(len(word) for word in spoken)
    at = 0.0
    rows = []
    for word in spoken:
        end = at + duration * len(word) / total
        rows.append({"text": word, "start": round(at, 3), "end": round(end, 3)})
        at = end
    rows[-1]["end"] = round(duration, 3)
    return rows


def _read_timed(model, audio):
    """``(text, mean token logprob or None, words)``; words are timed from the tokens when the runtime gives them."""
    global _timed
    timed = None
    if getattr(model, "with_timestamps", None) is not None:
        if _timed is None or _timed[0] is not model:
            _timed = (model, model.with_timestamps())
        timed = _timed[1]
    seconds = len(audio) / SAMPLE_RATE
    if timed is not None:
        heard = timed.recognize(audio, sample_rate=SAMPLE_RATE, **_bias_for(model))
        scores = [float(v) for v in (getattr(heard, "logprobs", None) or [])]
        mean = sum(scores) / len(scores) if scores else None
        text = str(getattr(heard, "text", "") or "").strip()
        words = group_words(getattr(heard, "tokens", None), getattr(heard, "timestamps", None), seconds, text)
        return text, mean, words
    text = str(model.recognize(audio, sample_rate=SAMPLE_RATE, **_bias_for(model)) or "").strip()
    return text, None, group_words(None, None, seconds, text)


def _read(model, audio):
    """``(text, mean token logprob or None)``. The timed reader is the same decode and also reports the scores."""
    global _timed
    timed = None
    if getattr(model, "with_timestamps", None) is not None:
        if _timed is None or _timed[0] is not model:
            _timed = (model, model.with_timestamps())
        timed = _timed[1]
    if timed is not None:
        heard = timed.recognize(audio, sample_rate=SAMPLE_RATE, **_bias_for(model))
        scores = [float(v) for v in (getattr(heard, "logprobs", None) or [])]
        mean = sum(scores) / len(scores) if scores else None
        return str(getattr(heard, "text", "") or "").strip(), mean
    return str(model.recognize(audio, sample_rate=SAMPLE_RATE, **_bias_for(model)) or "").strip(), None


BLANK_PIECE = "<blk>"
WORD_MARK = "\u2581"  # the SentencePiece word-start mark; onnx-asr swaps it for a space in its vocabulary


def _ctc_engine(model):
    """``(asr, pieces, frame_s)`` of the CTC head behind an onnx-asr model, or None when it does not expose one.
    (FRIDAY's own runner answers ``ctc_head`` and ``log_probs`` itself and never comes through here.)

    onnx-asr keeps the engine at ``adapter.asr``. A CTC model runs ``preprocessor -> _encode`` and ``_encode`` returns
    the per-frame log probabilities (the ``logprobs`` output of the exported graph). These are private names of the
    package, so every one is checked; any miss means "not exposed" and the caller keeps today's text-only reading.
    """
    asr: Any = getattr(model, "asr", None)
    vocab = getattr(asr, "_vocab", None)
    steps = (getattr(asr, "_preprocessor", None), getattr(asr, "_encode", None))
    if not isinstance(vocab, dict) or not vocab or not all(callable(step) for step in steps):
        return None
    try:
        frame_s = float(asr.window_step) * float(asr._subsampling_factor)
        pieces = [""] * (max(int(i) for i in vocab) + 1)
        for index, token in vocab.items():
            pieces[int(index)] = str(token).replace(" ", WORD_MARK)
    except (AttributeError, TypeError, ValueError):
        return None
    if frame_s <= 0 or BLANK_PIECE not in pieces:
        return None
    return asr, pieces, frame_s


def ctc_head() -> tuple[list[str], float] | None:
    """``(pieces, frame_s)`` of the loaded ear's CTC head (piece per id, blank is ``<blk>``; seconds per frame), or
    None: the ear is not on disk, cannot load, or its runtime does not expose the head."""
    folder = model_dir()
    if folder is None:
        return None
    try:
        model: Any = _load(folder)
        if hasattr(model, "ctc_head"):
            return model.ctc_head()
        found = _ctc_engine(model)
    except Exception:  # noqa: BLE001 — a model that will not load has no head to read
        return None
    return None if found is None else (found[1], found[2])


def log_probs(samples):
    """The ear's CTC output for 16 kHz mono float samples: ``(log_probs [T, V], pieces, frame_s)``, or None.

    ``log_probs`` is the per-frame log probability (rows sum to one in probability); ``pieces[i]`` is the piece of id
    ``i`` (a word start carries the ``\u2581`` mark, the blank is ``<blk>``); ``frame_s`` is the seconds one frame
    covers. None when the model is not on disk, its runtime does not expose the head, the clip is too short, the
    run fails, or the output is not log probabilities. It never raises and never changes the transcribe paths.
    """
    folder = model_dir()
    if folder is None:
        return None
    try:
        import numpy as np  # type: ignore

        audio = np.asarray(samples, dtype=np.float32).reshape(-1)
        if audio.size < int(SAMPLE_RATE * MIN_SECONDS):
            return None
        audio = audio[: SAMPLE_RATE * MAX_SECONDS]
        model: Any = _load(folder)
        if hasattr(model, "log_probs"):
            return model.log_probs(audio)
        found = _ctc_engine(model)
        if found is None:
            return None
        asr, pieces, frame_s = found
        features, lens = asr._preprocessor(audio[None, :], np.asarray([audio.size], dtype=np.int64))
        head, head_lens = asr._encode(features, lens)
        head = np.asarray(head, dtype=np.float32)
        frames = int(np.asarray(head_lens).reshape(-1)[0])
        rows = head[0, : max(0, min(frames, head.shape[1]))]
        if rows.ndim != 2 or rows.shape[0] == 0 or rows.shape[1] > len(pieces) or not np.isfinite(rows).all():
            return None
        if float(rows.max()) > 1e-3:  # logits, not log probabilities: biasing them would be wrong
            return None
        return rows, pieces, frame_s
    except Exception:  # noqa: BLE001 — any failure here means the text-only reading answers instead
        return None


def transcribe(samples) -> str | None:
    """Hindi text for 16 kHz mono float samples, or None to let faster-whisper answer."""
    global _last_confidence, _last_skip
    _last_confidence, _last_skip = None, ""
    folder = model_dir()
    if folder is None:
        return None
    try:
        import numpy as np  # type: ignore

        audio = np.asarray(samples, dtype=np.float32).reshape(-1)
        if audio.size < int(SAMPLE_RATE * MIN_SECONDS):
            return None
        audio = audio[: SAMPLE_RATE * MAX_SECONDS]
        text, _last_confidence = _read(_load(folder), audio)
    except Exception:  # noqa: BLE001 — any failure here means faster-whisper hears it instead
        _last_confidence = None
        return None
    # A Hindi recogniser that wrote no Devanagari heard nothing it understands.
    return _punctuate(text) if _DEVANAGARI.search(text) else None


def transcribe_words(samples) -> dict | None:
    """One live reading: ``{"text", "words", "confidence"}`` with word times in seconds, or None to let whisper answer.

    The same ear, the same gates and the same score as ``transcribe`` (so a partial and its final agree on who hears
    it), but the words carry times and no punctuation model runs: this is a guess made while the owner still speaks.
    """
    global _last_confidence, _last_skip
    _last_confidence, _last_skip = None, ""
    folder = model_dir()
    if folder is None:
        return None
    try:
        import numpy as np  # type: ignore

        audio = np.asarray(samples, dtype=np.float32).reshape(-1)
        if audio.size < int(SAMPLE_RATE * MIN_SECONDS):
            return None
        audio = audio[: SAMPLE_RATE * MAX_SECONDS]
        text, _last_confidence, words = _read_timed(_load(folder), audio)
    except Exception:  # noqa: BLE001 — any failure here means faster-whisper hears it instead
        _last_confidence = None
        return None
    if not _DEVANAGARI.search(text) or not words:
        return None
    return {"text": " ".join(w["text"] for w in words), "words": words, "confidence": _last_confidence}
