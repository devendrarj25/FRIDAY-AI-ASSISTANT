"""The text layer of FRIDAY's ears: decide whether what a speech engine wrote is speech or invented text.

Every gate here is a pure function of text and a few numbers the caller already has (no model, no clock, no network),
so a test feeds it numbers and reads the verdict. The gates that lived in ``stt.py`` moved here unchanged and are
re-exported from there; the rest are new:

* compression ratio (a looping decode compresses far better than speech does)
* speech fraction and voiced time from the VAD, checked before any text is trusted
* a stock-phrase table per language (the sign-offs Whisper learned from videos)
* a mean token-confidence floor for CTC and streaming transducer readings, which give no no-speech probability
* the short-clip rule: under 600 ms only a command word or a confident reading is accepted

Every threshold is a starting value that has not been measured on the owner's audio.
"""

from __future__ import annotations

import difflib
import math
import sys
import unicodedata
import zlib
from pathlib import Path

_KERNEL_DIR = str(Path(__file__).resolve().parent)
if _KERNEL_DIR not in sys.path:
    sys.path.insert(0, _KERNEL_DIR)

import voice_runtime  # noqa: E402

# ---- Stock sign-offs per language ---------------------------------------------------------------------------------

# What Whisper "hears" in room noise, a fan, a TV or silence: the sign-offs and credits of the videos it was trained
# on. Said alone, short, and with weak evidence of speech, they are noise. One row per language; "xx" is Roman-script
# Hindi. A phrase is matched whole, after case and punctuation are removed, so a real sentence that contains one is
# never touched.
NOISE_PHRASES_BY_LANGUAGE: dict[str, frozenset[str]] = {
    "en": frozenset(
        {
            "thank you",
            "thanks",
            "thank you very much",
            "thanks for watching",
            "thank you for watching",
            "thank you so much for watching",
            "thanks for watching and see you next time",
            "see you in the next video",
            "please subscribe",
            "like and subscribe",
            "subscribe",
            "dont forget to subscribe",
            "bye",
            "bye bye",
            "you",
            "okay",
            "ok",
            "subtitles by the amara org community",
        }
    ),
    "hi": frozenset(
        {
            "धन्यवाद",
            "शुक्रिया",
            "धन्यवाद दोस्तों",
            "देखने के लिए धन्यवाद",
            "वीडियो देखने के लिए धन्यवाद",
            "नमस्कार दोस्तों",
            "सब्सक्राइब",
            "सब्सक्राइब करें",
            "चैनल को सब्सक्राइब करें",
            "लाइक और सब्सक्राइब करें",
            "अगले वीडियो में मिलते हैं",
        }
    ),
    "xx": frozenset(
        {
            "dhanyavad",
            "dhanyawad",
            "shukriya",
            "subscribe karein",
            "channel ko subscribe karein",
            "video dekhne ke liye dhanyavad",
        }
    ),
}
# Every phrase in every language: the same words are noise whichever language the owner chose.
_NOISE_PHRASES = frozenset().union(*NOISE_PHRASES_BY_LANGUAGE.values())

NOISE_PHRASE_MAX_SECONDS = 2.5
NOISE_PHRASE_NO_SPEECH = 0.25
NOISE_PHRASE_LOGPROB = -0.7

# ---- New gate numbers (starting values, not measured) -------------------------------------------------------------

COMPRESSION_RATIO_MAX = 2.4  # the ratio Whisper's own decoder uses to call a transcript a repetition loop
COMPRESSION_MIN_BYTES = 32  # a shorter text compresses too poorly to say anything; the loop gate covers it
SPEECH_FRACTION_MIN = 0.3
VOICED_MS_MIN = 120
VOICED_MS_CLEAR = 600  # this much voiced audio is speech whatever share of the clip it is (a long, quiet pause)
TOKEN_CONFIDENCE_FLOOR = 0.35  # mean per-token probability under which a CTC or transducer reading is not trusted
SHORT_CLIP_MS = 600
SHORT_CLIP_CONFIDENCE = 0.6  # a reading shorter than SHORT_CLIP_MS that is not a command word needs this much
SNAP_CUTOFF = 0.8

# The words a person says alone, quickly, to an assistant that just asked or is speaking. Roman and Devanagari.
COMMAND_LEXICON: tuple[str, ...] = (
    "haan",
    "nahi",
    "ruko",
    "stop",
    "ok",
    "theek hai",
    "yes",
    "no",
    "हाँ",
    "हां",
    "नहीं",
    "रुको",
    "ठीक है",
)

# ---- Text helpers -------------------------------------------------------------------------------------------------


def bare_text(text: str) -> str:
    """Lower case, punctuation and symbols removed, spaces folded. A Devanagari vowel sign is kept (it is not a
    word character to the regex engine, so a character category test is used instead)."""
    cleaned = "".join(" " if unicodedata.category(ch)[0] in "PS" else ch for ch in (text or "").lower())
    return " ".join(cleaned.split())


def _phrases_for(language: str | None) -> frozenset[str]:
    code = (language or "").lower().split("-")[0]
    if code in NOISE_PHRASES_BY_LANGUAGE:
        return NOISE_PHRASES_BY_LANGUAGE[code] | NOISE_PHRASES_BY_LANGUAGE["en"]
    return _NOISE_PHRASES


def is_blacklisted_phrase(text: str, language: str | None = None) -> bool:
    """The whole text is one stock sign-off of ``language`` (any language when it is unknown)."""
    return bare_text((text or "").replace("'", "")) in _phrases_for(language)


def is_noise_hallucination(
    text: str,
    avg_ns: float,
    avg_logprob: float | None = None,
    duration_s: float | None = None,
    language: str | None = None,
) -> bool:
    """True for a stock sign-off that came out of noise rather than out of the owner.

    The same words from a clear, longer recording are kept: someone may really say "thank you".
    """
    if not is_blacklisted_phrase(text, language):
        return False
    return (
        avg_ns >= NOISE_PHRASE_NO_SPEECH
        or (avg_logprob is not None and avg_logprob <= NOISE_PHRASE_LOGPROB)
        or (duration_s is not None and duration_s < NOISE_PHRASE_MAX_SECONDS)
    )


# Scripts this owner does not speak. A clip heard in room noise that comes back as Japanese,
# Korean, Thai, Arabic or Cyrillic with weak evidence is the model inventing text.
_FOREIGN_SCRIPT_NAMES = ("CJK", "HIRAGANA", "KATAKANA", "HANGUL", "THAI", "ARABIC", "CYRILLIC", "HEBREW")


def is_foreign_script(text: str) -> bool:
    letters = [ch for ch in (text or "") if unicodedata.category(ch)[0] == "L"]
    if len(letters) < 3:
        return False
    foreign = sum(1 for ch in letters if any(name in unicodedata.name(ch, "") for name in _FOREIGN_SCRIPT_NAMES))
    return foreign * 2 > len(letters)


def is_repetition_loop(text: str) -> bool:
    """The same word or phrase repeated three or more times in a row ("1.5kg 1.5kg 1.5kg")."""
    words = (text or "").lower().split()
    if len(words) < 3:
        return False
    for size in (1, 2, 3):
        if len(words) < size * 3:
            continue
        for start in range(0, len(words) - size * 3 + 1):
            chunk = words[start : start + size]
            if words[start + size : start + size * 2] == chunk and words[start + size * 2 : start + size * 3] == chunk:
                return True
    return False


def compression_ratio(text: str) -> float:
    """UTF-8 bytes over deflate bytes, the measure Whisper's decoder uses. Speech reads about 1.0 to 1.7 (Devanagari up
    to about 1.5); a loop of one phrase climbs past 2.4."""
    raw = (text or "").encode("utf-8")
    if not raw:
        return 0.0
    return len(raw) / len(zlib.compress(raw))


def is_compression_loop(text: str, limit: float = COMPRESSION_RATIO_MAX) -> bool:
    raw = (text or "").strip().encode("utf-8")
    return len(raw) >= COMPRESSION_MIN_BYTES and compression_ratio(text.strip()) > limit


def is_invented_noise(
    text: str,
    avg_ns: float,
    avg_logprob: float | None = None,
    duration_s: float | None = None,
) -> bool:
    """A loop or a script the owner does not speak, said with weak evidence of speech."""
    if not (is_repetition_loop(text) or is_foreign_script(text)):
        return False
    return (
        avg_ns >= NOISE_PHRASE_NO_SPEECH
        or (avg_logprob is not None and avg_logprob <= NOISE_PHRASE_LOGPROB)
        or (duration_s is not None and duration_s < NOISE_PHRASE_MAX_SECONDS + 1.5)
    )


# ---- Evidence from the audio: VAD, token confidence ---------------------------------------------------------------


def _number(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return None if math.isnan(float(value)) else float(value)


def speech_gate(speech_fraction, voiced_ms, text: str = "") -> str:
    """Empty when the audio holds speech enough to trust a transcript, else "no-speech".

    ``speech_fraction`` (0 to 1) and ``voiced_ms`` come from a VAD the caller already ran; either one that is not
    known is skipped, so no VAD means no gate. Under 120 ms of voice is never a word. A low share of the clip is
    tolerated once 600 ms are voiced, and a command word needs no share at all (a quick "haan" in a longer clip).
    """
    voiced = _number(voiced_ms)
    if voiced is not None and voiced < VOICED_MS_MIN:
        return "no-speech"
    fraction = _number(speech_fraction)
    if fraction is None or fraction >= SPEECH_FRACTION_MIN:
        return ""
    if voiced is not None and voiced >= VOICED_MS_CLEAR:
        return ""
    return "" if lexicon_match(text) else "no-speech"


def vad_evidence(after_vad_s, duration_s) -> tuple[float | None, float | None]:
    """(speech fraction, voiced ms) from the seconds a VAD kept and the seconds the clip lasts; (None, None) when
    either is unknown, which switches the speech gate off."""
    kept, total = _number(after_vad_s), _number(duration_s)
    if kept is None or total is None or total <= 0:
        return None, None
    return max(0.0, min(1.0, kept / total)), max(0.0, kept * 1000.0)


def mean_token_confidence(probabilities) -> float | None:
    """Mean of the per-token probabilities (0 to 1); None when none are known."""
    values = [v for v in (_number(p) for p in (probabilities or [])) if v is not None]
    if not values:
        return None
    return sum(min(1.0, max(0.0, v)) for v in values) / len(values)


def logprob_to_confidence(mean_logprob) -> float | None:
    """A mean token log-probability as a 0 to 1 confidence; None when it is unknown."""
    value = _number(mean_logprob)
    return None if value is None else math.exp(min(0.0, value))


def confidence_trusted(confidence: float | None, floor: float = TOKEN_CONFIDENCE_FLOOR) -> bool:
    """A reading with no score stands (today's behaviour); one with a score stands at the floor or above."""
    return confidence is None or confidence >= floor


# ---- Short clips --------------------------------------------------------------------------------------------------


def lexicon_match(text: str) -> str:
    """The command word the text is exactly (after case and punctuation), or "" when it is none."""
    key = bare_text(text)
    for word in COMMAND_LEXICON:
        if key == bare_text(word):
            return word
    return ""


def snap_to_lexicon(text: str) -> str:
    """The command word the text is a near match of ("han" -> "haan"), or "" when none is close enough."""
    key = bare_text(text)
    if not key or len(key) > 12:
        return ""
    close = difflib.get_close_matches(key, [bare_text(w) for w in COMMAND_LEXICON], n=1, cutoff=SNAP_CUTOFF)
    if not close:
        return ""
    return next(w for w in COMMAND_LEXICON if bare_text(w) == close[0])


def is_short_clip(duration_s) -> bool:
    seconds = _number(duration_s)
    return seconds is not None and 0.0 < seconds * 1000.0 < SHORT_CLIP_MS


def short_clip_decode(duration_s, language: str | None, prompt: str) -> tuple[str | None, str]:
    """The (language, prompt) to decode a clip with: under 600 ms the language stays what the owner chose and no prompt
    is sent, because a prompt on a one-word clip is what the model repeats back. Longer clips are unchanged."""
    if not is_short_clip(duration_s):
        return language, prompt
    return language, ""


def short_clip_verdict(text: str, avg_logprob=None) -> tuple[str, str]:
    """(text, drop code) for a clip under 600 ms: a command word is kept (snapped when it was close), anything else
    needs ``SHORT_CLIP_CONFIDENCE`` and is dropped as "no-speech" without it."""
    body = (text or "").strip()
    if lexicon_match(body):
        return body, ""
    snapped = snap_to_lexicon(body)
    if snapped:
        return snapped, ""
    confidence = logprob_to_confidence(avg_logprob)
    if confidence is not None and confidence >= SHORT_CLIP_CONFIDENCE:
        return body, ""
    return "", "no-speech"


# ---- The policies stt.py calls ------------------------------------------------------------------------------------


def apply_no_speech_policy(
    text: str,
    avg_ns: float,
    avg_logprob: float | None = None,
    duration_s: float | None = None,
    *,
    speech_fraction: float | None = None,
    voiced_ms: float | None = None,
    language: str | None = None,
) -> tuple[str, str, str]:
    """Returns (text, note, drop code).

    Text that Whisper produced is kept unless BOTH the average no-speech
    probability is at the one threshold or above AND the average log-probability
    is at the low-confidence mark or below. A stock sign-off such as "thank you" that came
    from a short or doubtful recording is dropped as noise. Audio with too little voice, text that compresses like a
    loop, and a clip under 600 ms that is neither a command word nor a confident reading are dropped too. Empty
    text is dropped with the code that says why.
    """
    body = (text or "").strip()
    high = avg_ns >= voice_runtime.NO_SPEECH_THRESHOLD
    unsure = avg_logprob is not None and avg_logprob <= voice_runtime.LOW_CONFIDENCE_LOGPROB
    if body:
        if high and unsure:
            return "", f"no_speech {avg_ns:.2f} and avg_logprob {avg_logprob:.2f}", "low-confidence"
        if speech_gate(speech_fraction, voiced_ms, body):
            return "", f"too little voice ({_describe_voice(speech_fraction, voiced_ms)}): {body[:40]!r}", "no-speech"
        if is_noise_hallucination(body, avg_ns, avg_logprob, duration_s, language):
            return "", f"noise phrase {body!r}; no_speech {avg_ns:.2f}", "no-speech"
        if is_invented_noise(body, avg_ns, avg_logprob, duration_s):
            return "", f"invented text {body[:40]!r}; no_speech {avg_ns:.2f}", "no-speech"
        if is_compression_loop(body):
            return "", f"compression ratio {compression_ratio(body):.1f}: {body[:40]!r}", "no-speech"
        if is_short_clip(duration_s):
            body, code = short_clip_verdict(body, avg_logprob)
            if code:
                return "", f"short clip, not a command word, low confidence: {text.strip()[:40]!r}", code
        if high:
            return body, f"kept segment text; no_speech {avg_ns:.2f}", ""
        return body, "", ""
    if high:
        return "", f"no_speech {avg_ns:.2f}", "no-speech"
    return "", "", "empty"


def _describe_voice(speech_fraction, voiced_ms) -> str:
    fraction, voiced = _number(speech_fraction), _number(voiced_ms)
    parts = []
    if fraction is not None:
        parts.append(f"{fraction:.2f} of the clip")
    if voiced is not None:
        parts.append(f"{voiced:.0f} ms voiced")
    return ", ".join(parts)


# The segment gate of the live and stream paths: no_speech and log-probability at these marks together call a segment
# silence the model made words for.
LIVE_NOISE_NO_SPEECH = 0.6
LIVE_NOISE_LOGPROB = -1.0


def live_segment_is_noise(text: str, no_speech, logprob, language: str | None = None) -> bool:
    """A segment that is a loop, a stock sign-off from noise, or silence the model made words for."""
    if is_repetition_loop(text) or is_compression_loop(text):
        return True
    ns = float(no_speech) if isinstance(no_speech, (int, float)) else 0.0
    lp = float(logprob) if isinstance(logprob, (int, float)) else None
    if lp is not None and ns >= LIVE_NOISE_NO_SPEECH and lp <= LIVE_NOISE_LOGPROB:
        return True
    return is_noise_hallucination(text, ns, lp, None, language)


def stream_text_dropped(
    text: str,
    *,
    confidence=None,
    duration_s=None,
    speech_fraction=None,
    voiced_ms=None,
    language: str | None = None,
) -> str:
    """The reason a streaming or CTC reading is not trusted, or "" when it stands. ``confidence`` is the mean token
    log-probability the reader reported (None when it reports none). Used by the stream ears, which give no
    no-speech probability, so the token score and the audio evidence stand in for it."""
    body = (text or "").strip()
    if not body:
        return ""
    if not confidence_trusted(logprob_to_confidence(confidence)):
        return "low-confidence"
    if speech_gate(speech_fraction, voiced_ms, body):
        return "no-speech"
    if is_repetition_loop(body) or is_compression_loop(body):
        return "no-speech"
    ns = 0.0
    lp = _number(confidence)
    if is_noise_hallucination(body, ns, lp, _number(duration_s), language):
        return "no-speech"
    if is_short_clip(duration_s) and short_clip_verdict(body, confidence)[1]:
        return "no-speech"
    return ""
