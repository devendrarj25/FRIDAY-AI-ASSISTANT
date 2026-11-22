# ruff: noqa: S311 - seeded test data, not a secret
"""Deterministic property tests for the kernel voice and speech path.

No hypothesis package is installed, so each property runs over a seeded generator (the seed is a constant: the
same cases run on every machine and every day). Covered: the sentence and script cuts, the echo canceller on
hostile frames, the speech worker's option building and request handling, the TTS worker's request validation, the
ear mode rules, and the ephemeral (speculative draft) chat turn.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import random
import re
import subprocess
import sys
from pathlib import Path

import pytest

KERNEL = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(KERNEL))

import echo_canceller  # noqa: E402
import hindi_ear  # noqa: E402
import language_segmenter as seg  # noqa: E402
import stt  # noqa: E402
import voice_runtime  # noqa: E402
import whisper_ears  # noqa: E402

SEED = 20261122
CASES = 400


def squeeze(text: str) -> str:
    """Everything but the whitespace: what a cut must never lose or invent."""
    return re.sub(r"\s+", "", text)


# ---------------------------------------------------------------------------------------------------------------
# language_segmenter
# ---------------------------------------------------------------------------------------------------------------

ATOMS = [
    "Dr.", "Mr.", "Rs.", "3.5", "a.m.", "p.m.", "U.S.A.", "e.g.", "https://example.com/a.b", "www.x.in",
    "।", "॥", "?", "!", "\n", "\n\n", "नमस्ते", "hello", "I.", "J.", "1.", "10.", "etc.", "world.", "फिर",
    "...", "…", "\t", " ", " ", "😀", "ä", "(", ")", '"', "'", ".", "Dr", "No.", "vs.", "डॉ.",
]  # fmt: skip


def random_text(rng: random.Random) -> str:
    return "".join(rng.choice(ATOMS) + rng.choice(["", " ", "  "]) for _ in range(rng.randint(0, 14)))


def test_split_sentences_never_loses_or_invents_a_character():
    rng = random.Random(SEED)
    for _ in range(CASES * 5):
        text = random_text(rng)
        assert squeeze("".join(seg.split_sentences(text))) == squeeze(text), repr(text)


def test_split_sentences_is_idempotent_apart_from_blank_pieces():
    rng = random.Random(SEED + 1)
    for _ in range(CASES * 5):
        text = random_text(rng)
        once = [p for p in seg.split_sentences(text) if p.strip()]
        again = [q for p in once for q in seg.split_sentences(p) if q.strip()]
        assert again == once, repr(text)


@pytest.mark.parametrize("abbreviation", ["Dr.", "Mr.", "Mrs.", "Ms.", "Prof.", "Rs.", "डॉ.", "प्रो."])
def test_an_abbreviation_never_ends_a_sentence(abbreviation):
    for name in ["Singh", "शर्मा", "Kumar", "5000"]:
        for tail in ["Then go.", "फिर जाओ।", "Ok"]:
            text = f"Please ask {abbreviation} {name} about it. {tail}"
            pieces = seg.split_sentences(text)
            assert f"{abbreviation} {name} about it." in pieces[0], pieces


def test_decimals_and_urls_are_never_cut():
    rng = random.Random(SEED + 3)
    for _ in range(CASES):
        number = f"{rng.randint(0, 999)}.{rng.randint(0, 99)}"
        url = f"https://example.com/{rng.randint(0, 99)}.html?q={number}"
        text = f"The value is {number} and the page is {url} now. Next sentence here."
        pieces = seg.split_sentences(text)
        assert len(pieces) == 2, pieces
        assert number in pieces[0] and url in pieces[0], pieces


def test_segment_keeps_every_character_in_order_and_stays_bounded():
    rng = random.Random(SEED + 4)
    for _ in range(CASES * 3):
        text = random_text(rng)
        spans = seg.segment(text)
        assert squeeze("".join(s.text for s in spans)) == squeeze(text), repr(text)
        assert len(spans) <= seg.MAX_SPANS
        assert all(s.text.strip() and s.lang in ("hi", "en") for s in spans)
        assert all(a.lang != b.lang for a, b in zip(spans, spans[1:], strict=False)), repr(text)


def test_script_policy_is_stable_on_its_own_output():
    rng = random.Random(SEED + 5)
    for _ in range(CASES * 3):
        text = random_text(rng)
        first = seg.script_policy(text)
        assert seg.script_policy(first["text"]) == first, repr(text)
        assert first["lang"] in ("hi", "en", "mixed")
        assert all(s["text"].strip() for s in first["segments"])


def test_devanagari_stays_hindi_and_latin_stays_english_in_the_policy():
    policy = seg.script_policy("मुझे report भेजो और open Chrome करो")
    kinds = {w["text"]: w["kind"] for s in policy["segments"] for w in s["words"]}
    assert kinds["मुझे"] == "hi" and kinds["Chrome"] == "en"
    assert "नमस्ते" in seg.script_policy("नमस्ते")["text"]  # nothing is transliterated


# ---------------------------------------------------------------------------------------------------------------
# echo_canceller
# ---------------------------------------------------------------------------------------------------------------

np, _aec, _missing = echo_canceller._load()
LIBRARY = np is not None and not _missing
needs_aec = pytest.mark.skipif(not LIBRARY, reason="numpy or pyaec is not installed here")


def frame(rng: random.Random, n: int, kind: int):
    gen = np.random.default_rng(rng.randrange(1 << 30))
    if kind == 0:
        return gen.integers(-32768, 32768, n, dtype=np.int16)
    if kind == 1:
        return np.full(n, 32767, np.int16)
    if kind == 2:
        return np.full(n, -32768, np.int16)
    if kind == 3:
        return np.zeros(n, np.int16)
    return (np.sin(np.arange(n) * 0.3) * 20000).astype(np.int16)


@needs_aec
def test_the_canceller_never_raises_and_keeps_the_length_on_hostile_frames():
    rng = random.Random(SEED + 6)
    canceller = echo_canceller.EchoCanceller()
    assert canceller.ready
    for index in range(CASES):
        n = rng.choice([0, 1, 2, 159, 160, 161, 320, 480, 1000, 4000])
        mic = frame(rng, n, rng.randrange(5))
        ref_n = rng.choice([n, n, 0, 1, n + 7, 3000, 50000])
        ref = frame(rng, ref_n, rng.randrange(5)) if rng.random() < 0.9 else None
        form = rng.choice(["array", "bytes", "bytearray", "memoryview"])
        mic_in = {
            "array": mic,
            "bytes": mic.tobytes(),
            "bytearray": bytearray(mic.tobytes()),
            "memoryview": memoryview(mic.tobytes()),
        }[form]
        ref_in = ref if ref is None or rng.random() < 0.5 else ref.tobytes()
        out = canceller.process(mic_in, ref_in)
        assert len(out) == len(mic_in)
        if form == "array":
            assert out.dtype == np.int16
        else:
            assert isinstance(out, bytes | bytearray | memoryview)
        if index % 100 == 0:
            canceller.reset()
    assert canceller.ready, canceller.status()  # hostile frames never turn the canceller off


@needs_aec
def test_an_empty_reference_is_silence_and_never_counts_as_a_failure():
    """Playback that has just ended sends an empty reference: three of them in a row turned the canceller off."""
    canceller = echo_canceller.EchoCanceller()
    mic = np.full(480, 1000, np.int16)
    for empty in (b"", np.zeros(0, np.int16), bytearray(), memoryview(b"")):
        for _ in range(echo_canceller.MAX_ERRORS + 1):
            assert np.array_equal(canceller.process(mic, empty), mic)
    assert canceller.ready, canceller.status()


@needs_aec
def test_without_a_reference_the_microphone_passes_through_untouched():
    rng = random.Random(SEED + 7)
    canceller = echo_canceller.EchoCanceller()
    for _ in range(60):
        mic = frame(rng, rng.choice([160, 480, 2560]), rng.randrange(5))
        assert np.array_equal(canceller.process(mic, None), mic)
        assert canceller.process(mic.tobytes()) == mic.tobytes()
    assert canceller.status()["cancelledFrames"] == 0


@needs_aec
@pytest.mark.parametrize(
    "junk",
    [None, "abc", 123, [1, 2, 3], b"abc", {}, (1, 2)],
)
def test_a_frame_that_is_not_pcm_comes_back_unchanged(junk):
    canceller = echo_canceller.EchoCanceller()
    assert canceller.process(junk, junk) is junk


def test_an_unready_canceller_is_a_passthrough(monkeypatch):
    monkeypatch.setattr(echo_canceller, "_load", lambda: (None, None, "pyaec is not installed"))
    canceller = echo_canceller.EchoCanceller()
    assert not canceller.ready
    frame_bytes = bytes(range(64))
    assert canceller.process(frame_bytes, frame_bytes) is frame_bytes


# ---------------------------------------------------------------------------------------------------------------
# stt.py: option building, ear modes, provisional passes
# ---------------------------------------------------------------------------------------------------------------

HOSTILE_WORDS = [None, "", "  ", ",", " , ;\n", 0, 5, True, [], {}, ["", " "], ["a", None, 3], "x" * 5000, "नाम, name"]


def test_hotwords_are_sent_only_when_there_is_a_real_word(monkeypatch):
    monkeypatch.delenv("FRIDAY_STT_WORD_TIMESTAMPS", raising=False)
    rng = random.Random(SEED + 8)
    for _ in range(CASES):
        raw = rng.choice(HOSTILE_WORDS)
        options = stt.decode_options({"hotwords": raw}, language_locked=False)
        cleaned = stt.clean_hotwords(raw)
        assert len(cleaned) <= stt.MAX_HOTWORDS_CHARS
        assert cleaned == cleaned.strip(" ,")
        assert ",," not in cleaned and ", ," not in cleaned
        if cleaned:
            assert options == {"hotwords": cleaned}
        else:
            assert "hotwords" not in options
        assert stt.clean_hotwords(cleaned) == cleaned  # a second pass changes nothing


def test_the_other_options_follow_a_strict_true_and_an_unlocked_language(monkeypatch):
    monkeypatch.delenv("FRIDAY_STT_WORD_TIMESTAMPS", raising=False)
    for flag in [True, False, None, 1, "true", "yes", [True]]:
        for locked in (True, False):
            options = stt.decode_options({"multilingual": flag, "word_timestamps": flag}, locked)
            assert ("multilingual" in options) is (flag is True and not locked)
            assert ("word_timestamps" in options) is (flag is True)
            # the silence threshold is only ever sent together with word timings
            assert ("hallucination_silence_threshold" in options) is ("word_timestamps" in options)
    assert stt.decode_options(None, False) == {}


@pytest.mark.parametrize("variant", ["hi-Latn", "HI-LATN", " hi_Latn ", "hi-latn", "hi_LATN"])
def test_hindi_in_roman_letters_never_reaches_the_devanagari_ear(variant):
    for language, pref in [(variant, ""), ("", variant), ("en", variant)]:
        assert hindi_ear.wants_hindi(language, pref) is False
        assert whisper_ears.wants_roman_hinglish(language, pref) is True


@pytest.mark.parametrize("tag", ["hi-Latn-IN", "hi-latn-x", "HI_LATN_IN", "hi-Latn-u-nu-latn"])
def test_a_hi_latn_tag_with_a_region_is_still_roman_mode(tag):
    # BCP 47 puts the script before the region: the Devanagari ear must not take any hi-Latn tag.
    assert hindi_ear.wants_hindi(tag, "") is False
    assert hindi_ear.wants_hindi("", tag) is False
    assert whisper_ears.wants_roman_hinglish(tag, "") is True


def test_the_two_ears_never_both_claim_the_same_request():
    rng = random.Random(SEED + 9)
    parts = [
        "hi",
        "hi-IN",
        "hi-Latn",
        "hi_Latn",
        "hi-Latn-IN",
        "hinglish-roman",
        "hinglish",
        "en",
        "en-IN",
        "auto",
        "",
        " ",
        "mixed",
        "HI",
    ]
    for _ in range(CASES):
        language, pref = rng.choice(parts), rng.choice(parts)
        assert not (hindi_ear.wants_hindi(language, pref) and whisper_ears.wants_roman_hinglish(language, pref)), (
            language,
            pref,
        )


def test_the_ear_mode_rules_never_raise_on_hostile_values():
    for value in ["\x00", "😀" * 50, "हिन्दी", "hi-" * 1000, "-", "_", "HI-LATN\n"]:
        for call in (hindi_ear.wants_hindi, whisper_ears.wants_roman_hinglish):
            assert isinstance(call(value, ""), bool)
            assert isinstance(call("", value), bool)


def test_the_language_lock_is_never_anything_but_two_letters_and_never_hindi_or_english():
    rng = random.Random(SEED + 14)
    pool = [
        "hi",
        "hi-Latn",
        "hi_IN",
        "en",
        "en-IN",
        "EN",
        "auto",
        "mixed",
        "",
        " ",
        "fr",
        "DE",
        "ja-JP",
        "x",
        "123",
        "\x00a",
        "हि",
        "😀😀",
    ]
    for _ in range(CASES):
        raw = rng.choice(pool) + rng.choice(["", "-IN", "_US", " ", "\n"])
        locked = stt.resolve_language(raw)
        assert locked is None or (len(locked) == 2 and locked.isalpha() and locked == locked.lower()), raw
        if raw.strip().lower().startswith(("hi", "en")):
            assert locked is None, raw  # Hinglish and mixed speech are never forced into one language


def test_the_no_speech_policy_is_consistent_for_any_text_and_evidence():
    rng = random.Random(SEED + 15)
    texts = [
        "",
        "  ",
        "thank you",
        "Thank you.",
        "मुझे रिपोर्ट भेजो",
        "open Chrome करो",
        "ha ha ha",
        "1.5kg 1.5kg 1.5kg",
        "ありがとう",
        "😀",
        "x" * 5000,
    ]
    numbers = [None, 0.0, 0.3, 0.69, 0.7, 0.95, 1.0, -1.0, float("nan"), float("inf"), -5.0]
    for _ in range(CASES):
        text = rng.choice(texts)
        kept, _note, code = stt.apply_no_speech_policy(
            text, rng.choice(numbers[1:]), rng.choice(numbers), rng.choice(numbers)
        )
        assert code == "" or code in voice_runtime.DROP_CODES
        if code:
            assert kept == ""  # a dropped utterance carries one code and no text
        else:
            assert kept == text.strip() and kept  # a kept one is the text as heard, never empty
    # Clear, confident speech in either script is never dropped.
    for spoken in ("मुझे रिपोर्ट भेजो", "open Chrome करो", "thank you"):
        assert stt.apply_no_speech_policy(spoken, 0.0, -0.2, 6.0) == (spoken, "", "")


class Stub:
    """Records what a provisional pass is allowed to touch."""

    def __init__(self, monkeypatch):
        self.recorded: list = []
        self.counters_before = json.dumps(stt.counters_payload(), sort_keys=True)
        monkeypatch.setattr(stt, "prepare_audio", lambda path: (path, None, None, {"facts": 1}))
        monkeypatch.setattr(stt, "load_audio_array", lambda path: (_ for _ in ()).throw(OSError("no file")))
        monkeypatch.setattr(stt, "_record_hearing", lambda *a, **k: self.recorded.append(a))

        def prepared(*args, **kwargs):
            stt.note_outcome("")
            stt.note_outcome("no-speech")
            return {"ok": True, "text": "hello", "audio": {"durationMs": 1200}}

        monkeypatch.setattr(stt, "_transcribe_prepared", prepared)


def test_a_provisional_pass_is_never_counted_or_recorded(monkeypatch):
    stub = Stub(monkeypatch)
    result = stt.transcribe_file("a.wav", "small", "", "", provisional=True)
    assert result["ok"] is True
    assert stub.recorded == []
    assert json.dumps(stt.counters_payload(), sort_keys=True) == stub.counters_before
    assert stt._provisional_pass is False  # the flag never leaks into the next utterance
    stt.transcribe_file("a.wav", "small", "", "")
    assert len(stub.recorded) == 1
    assert json.dumps(stt.counters_payload(), sort_keys=True) != stub.counters_before


def test_a_failing_provisional_pass_still_clears_the_flag(monkeypatch):
    Stub(monkeypatch)

    def boom(*args, **kwargs):
        raise RuntimeError("model fell over")

    monkeypatch.setattr(stt, "_transcribe_prepared", boom)
    with pytest.raises(RuntimeError):
        stt.transcribe_file("a.wav", "small", "", "", provisional=True)
    assert stt._provisional_pass is False


def test_flush_is_provisional_by_name_and_only_a_strict_true_flags_transcribe(monkeypatch, tmp_path):
    audio = tmp_path / "a.wav"
    audio.write_bytes(b"RIFF")
    seen: list[bool] = []

    def fake(*args, **kwargs):
        seen.append(kwargs.get("provisional") is True)
        return {"ok": True, "text": "hi", "audio": {"durationMs": 500}}

    monkeypatch.setattr(stt, "transcribe_file", fake)
    flush = stt.handle_request({"op": "flush", "audio": str(audio), "utteranceId": "u" * 200})
    assert flush["final"] is False and len(flush["utteranceId"]) == 64
    stt.handle_request({"op": "transcribe", "audio": str(audio), "provisional": True})
    for loose in ["true", 1, "yes", [True]]:
        reply = stt.handle_request({"op": "transcribe", "audio": str(audio), "provisional": loose})
        assert "final" not in reply
    assert seen == [True, True, False, False, False, False]


def test_handle_request_survives_hostile_payloads():
    rng = random.Random(SEED + 10)
    values = [
        None,
        True,
        False,
        0,
        -1,
        -1e308,
        "",
        "x" * 20000,
        "हिन्दी",
        "😀",
        "a\x00b",
        [],
        {},
        [1, "a", None],
        "../../etc/passwd",
    ]
    ops = ["status", "probe", "partial-plan", "transcribe", "flush", "shutdown", "bogus", None, "", 5, [], "TRANSCRIBE"]
    keys = ["id", "duration", "audio", "language", "hotwords", "utteranceId", "model", "initial_prompt", "provisional"]
    for _ in range(CASES):
        req = {"op": rng.choice(ops)}
        for key in keys:
            if rng.random() < 0.5:
                req[key] = rng.choice(values)
        reply = stt.handle_request(req)
        assert isinstance(reply, dict)
        json.dumps(reply, allow_nan=False)


@pytest.mark.parametrize("duration", [float("inf"), float("nan"), 1e12, 10**30, "inf", "1e999", 200_000.0])
def test_partial_plan_is_bounded_for_any_duration(duration):
    """One hostile duration must not grow a list until the worker is out of memory."""
    code = (
        "import sys, json, resource\n"
        "resource.setrlimit(resource.RLIMIT_AS, (1 << 30, 1 << 30))\n"
        f"sys.path.insert(0, {str(KERNEL)!r})\n"
        "import stt\n"
        "reply = stt.handle_request({'op': 'partial-plan', 'duration': json.loads(sys.argv[1])})\n"
        "print(json.dumps({'ok': reply['ok'], 'count': len(reply['windows'])}))\n"
    )
    if sys.platform == "win32":
        pytest.skip("RLIMIT_AS is POSIX only; the bound is also asserted in-process below")
    done = subprocess.run(
        [sys.executable, "-I", "-c", code, json.dumps(duration)], capture_output=True, text=True, timeout=60
    )
    assert done.returncode == 0, done.stderr[-300:]
    reply = json.loads(done.stdout.strip().splitlines()[-1])
    assert reply["ok"] is True
    assert reply["count"] <= stt.MAX_PARTIAL_WINDOWS


def test_partial_plan_still_covers_a_normal_utterance():
    windows = stt.plan_partials(5.0)
    assert windows[0]["start"] == 0.0 and windows[-1]["final"] is True and windows[-1]["end"] == 5.0
    assert all(a["start"] < b["start"] for a, b in zip(windows, windows[1:], strict=False))
    assert stt.plan_partials(0) == [] and stt.plan_partials(-3) == []
    assert stt.plan_partials(1.5) == [{"start": 0.0, "end": 1.5, "final": True}]


def run_serve(module, monkeypatch, capsys, lines: list[str]) -> list[dict]:
    monkeypatch.setattr(sys, "stdin", io.StringIO("\n".join(lines) + "\n"))
    assert module.serve() == 0
    out = capsys.readouterr().out
    return [json.loads(line) for line in out.splitlines() if line.startswith("{")]


def test_the_stt_worker_loop_survives_a_request_that_raises(monkeypatch, capsys):
    def explode():
        raise RuntimeError("probe fell over")

    monkeypatch.setattr(stt, "status_payload", explode)
    replies = run_serve(
        stt,
        monkeypatch,
        capsys,
        [
            json.dumps({"id": 1, "op": "status"}),
            json.dumps({"id": 2, "op": "bogus"}),
            json.dumps({"id": 3, "op": "shutdown"}),
        ],
    )
    assert [r["id"] for r in replies] == [1, 2, 3]
    assert replies[0]["ok"] is False and replies[1]["reason"] == "unknown-op" and replies[2]["ok"] is True


# ---------------------------------------------------------------------------------------------------------------
# voice_runtime: speak-pcm, echo-shadow, the worker loop
# ---------------------------------------------------------------------------------------------------------------

HOSTILE = [
    None, True, 0, -5, 10**40, 1e308, float("nan"), "", "  ", "x" * 70000, "हि\ud83d", "\x00", "!!!!", "AAA=", "AAAA\n",
    [], {}, [1], {"a": 1}, "A" * 40000,
]  # fmt: skip


def b64_pcm(rng: random.Random, samples: int, kind: int) -> str:
    gen = np.random.default_rng(rng.randrange(1 << 30))
    data = [
        gen.integers(-32768, 32768, samples, dtype=np.int16),
        np.full(samples, -32768, np.int16),
        np.full(samples, 32767, np.int16),
        np.zeros(samples, np.int16),
    ][kind]
    return base64.b64encode(data.tobytes()).decode()


@pytest.mark.skipif(np is None, reason="numpy is not installed here")
def test_echo_shadow_answers_every_hostile_request_with_plain_json():
    rng = random.Random(SEED + 11)
    voice_runtime._echo_shadow = None
    for _ in range(CASES):
        n = rng.choice([1, 2, 160, 2560, 16000, 16001, 40000])
        req: dict = {}
        for key in ["mic", "ref", "reset", "seq", "id"]:
            if rng.random() < 0.8:
                if key in ("mic", "ref") and rng.random() < 0.6:
                    req[key] = b64_pcm(rng, rng.choice([n, n, n + 1, 0, 1]), rng.randrange(4))
                else:
                    req[key] = rng.choice(HOSTILE)
        reply = voice_runtime.echo_shadow_payload(req)
        assert isinstance(reply["ok"], bool)
        json.dumps(reply, allow_nan=False)
        if reply["ok"]:
            assert reply["gate"] is False and "pcm16" not in reply and "mic" not in reply
            assert -120.0 <= reply["micDb"] <= 0.5 and -120.0 <= reply["residualDb"] <= 0.5


@pytest.mark.skipif(np is None, reason="numpy is not installed here")
def test_echo_shadow_refuses_oversize_odd_and_mismatched_audio():
    rng = random.Random(SEED + 12)
    voice_runtime._echo_shadow = None
    too_long = b64_pcm(rng, voice_runtime.ECHO_SHADOW_MAX_SAMPLES + 1, 0)
    assert voice_runtime.echo_shadow_payload({"mic": too_long})["reason"] == "too-long"
    assert voice_runtime.echo_shadow_payload({"mic": base64.b64encode(b"abc").decode()})["reason"] == "bad-audio"
    assert voice_runtime.echo_shadow_payload({"mic": ""})["reason"] == "bad-audio"
    mic, ref = b64_pcm(rng, 160, 0), b64_pcm(rng, 161, 0)
    assert voice_runtime.echo_shadow_payload({"mic": mic, "ref": ref})["reason"] == "length-mismatch"


def test_speak_pcm_validates_the_text_and_never_raises(monkeypatch):
    rng = random.Random(SEED + 13)
    monkeypatch.setattr(voice_runtime, "speak_pcm16", lambda text, speed, lang, style: (b"\x01\x00" * 4, 22050))
    for _ in range(CASES):
        req = {
            key: rng.choice(HOSTILE + ["hello", "नमस्ते hello"])
            for key in ["text", "speed", "lang", "style", "seq"]
            if rng.random() < 0.8
        }
        reply = voice_runtime.speak_pcm_payload(req)
        json.dumps(reply, allow_nan=False)
        if isinstance(req.get("text"), str) and req["text"].strip():
            assert reply["ok"] is True and base64.b64decode(reply["pcm16"]) == b"\x01\x00" * 4
            seq = req.get("seq")
            assert ("seq" in reply) is (isinstance(seq, int) and not isinstance(seq, bool))
        else:
            assert reply == {"ok": False, "reason": "empty-text"}


def test_speak_pcm_clamps_a_hostile_speed_before_synthesis(monkeypatch):
    seen: list[float] = []

    class Tts:
        sample_rate = 22050

        def get_voice_style(self, name):
            return name

        def synthesize(self, text, voice_style=None, total_steps=5, speed=1.0, lang="en", silence_duration=0.12):
            seen.append(speed)
            return np.zeros(2205, np.float32), 0.1

    monkeypatch.setattr(voice_runtime, "supertonic_dir", lambda: Path("."))
    monkeypatch.setattr(voice_runtime, "_tts", Tts())
    monkeypatch.setattr(voice_runtime, "_tts_dir", str(Path(".")))
    monkeypatch.setitem(sys.modules, "supertonic", type(sys)("supertonic"))
    sys.modules["supertonic"].TTS = lambda **kwargs: Tts()  # type: ignore[attr-defined]
    for speed in [float("nan"), float("inf"), -float("inf"), 1e308, -3, 0, "nan", "1e999", True]:
        voice_runtime.speak_pcm_payload({"text": "hello there", "speed": speed})
    assert seen and all(0.7 <= value <= 2.0 for value in seen)


@pytest.mark.parametrize(
    "out",
    ["a\x00b", "{base}/file.txt/x/y.wav", "/proc/none/x.wav", "x" * 5000],
    ids=["nul-byte", "parent-is-a-file", "missing-system-folder", "name-too-long"],
)
def test_the_tts_worker_loop_survives_an_output_path_that_cannot_be_written(monkeypatch, capsys, tmp_path, out):
    (tmp_path / "file.txt").write_text("x")
    monkeypatch.setattr(voice_runtime, "speak_wav_bytes", lambda *args, **kwargs: b"RIFFxxxx")
    path = out.replace("{base}", str(tmp_path))
    replies = run_serve(
        voice_runtime,
        monkeypatch,
        capsys,
        [
            json.dumps({"id": 1, "op": "speak", "text": "hi", "out": path}),
            json.dumps({"id": 2, "op": "nothing"}),
            json.dumps({"id": 3, "op": "shutdown"}),
        ],
    )
    assert [r["id"] for r in replies] == [1, 2, 3], replies
    assert replies[0]["ok"] is False and replies[1]["reason"] == "unknown-op" and replies[2]["ok"] is True


def test_the_tts_worker_loop_answers_garbage_lines_and_keeps_going(monkeypatch, capsys):
    lines = ["not json", "[]", "5", "null", '"text"', json.dumps({"op": 5}), json.dumps({"id": 9, "op": "shutdown"})]
    replies = run_serve(voice_runtime, monkeypatch, capsys, lines)
    assert [r.get("reason") for r in replies[:5]] == ["bad-request"] * 5
    assert replies[-1] == {"id": 9, "ok": True}


# ---------------------------------------------------------------------------------------------------------------
# kernel/main.py: the ephemeral (speculative draft) chat turn
# ---------------------------------------------------------------------------------------------------------------


@pytest.fixture
def chat_env(monkeypatch, tmp_path):
    pytest.importorskip("fastapi")
    pytest.importorskip("httpx")
    import os

    os.environ.setdefault("FRIDAY_DATA_DIR", str(tmp_path / "data"))
    os.environ.setdefault("FRIDAY_WORKSPACE_ROOT", str(tmp_path))
    os.environ.setdefault("FRIDAY_BRIDGE_TOKEN", "contract-token")
    import main
    import router as router_mod

    class Env:
        rows: list = []
        broadcasts: list = []
        memory_writes: list = []
        tools_seen: list = []

    env = Env()
    env.rows, env.broadcasts, env.memory_writes, env.tools_seen = [], [], [], []
    env.main, env.router = main, router_mod

    async def stream(**kwargs):
        env.tools_seen.append(router_mod.NO_TOOLS.get())
        await asyncio.sleep(0)  # yield the loop so a parallel turn interleaves
        yield {"modelId": "local-fake", "delta": "A guess."}
        await asyncio.sleep(0)
        env.tools_seen.append(router_mod.NO_TOOLS.get())
        yield {"modelId": "local-fake", "done": True}

    async def phone_broadcast(payload, **kwargs):
        env.broadcasts.append(payload)

    async def memory_add(*args, **kwargs):
        env.memory_writes.append(args)

    monkeypatch.setattr(
        main.storage, "append_chat", lambda sid, role, text, *a, **k: env.rows.append((sid, role, text))
    )
    monkeypatch.setattr(main, "phone_broadcast", phone_broadcast)
    monkeypatch.setattr(main.memory, "add", memory_add)
    monkeypatch.setattr(main.router, "stream", stream)
    monkeypatch.setattr(main, "ACTIVE_SESSION", "before")

    async def send(payload):
        return None

    env.send = send
    return env


@pytest.mark.asyncio
@pytest.mark.parametrize("value", [1, 1.0, "True", "TRUE", "1", 2, [True], {"a": True}, -1, "true "])
async def test_no_loose_value_makes_a_turn_ephemeral(chat_env, value):
    await chat_env.main.dispatch(
        "chat.stream", {"prompt": "hello", "sessionId": "s-loose", "ephemeral": value}, chat_env.send
    )
    assert [r[1] for r in chat_env.rows] == ["user", "assistant"]
    assert set(chat_env.tools_seen) == {False}


@pytest.mark.asyncio
async def test_a_draft_beside_a_real_turn_never_leaks_its_tool_ban(chat_env):
    draft = chat_env.main.dispatch(
        "chat.stream", {"prompt": "draft", "sessionId": "s-draft", "ephemeral": True}, chat_env.send
    )
    real = chat_env.main.dispatch("chat.stream", {"prompt": "real", "sessionId": "s-real"}, chat_env.send)
    await asyncio.gather(draft, real)
    # Two turns, two reads each: the draft saw the ban twice, the real turn never did.
    assert sorted(chat_env.tools_seen) == [False, False, True, True]
    assert [r for r in chat_env.rows if r[0] == "s-draft"] == []
    assert [r[1] for r in chat_env.rows if r[0] == "s-real"] == ["user", "assistant"]
    assert chat_env.router.NO_TOOLS.get() is False


@pytest.mark.asyncio
async def test_a_phone_turn_keeps_its_tools_even_when_it_says_ephemeral(chat_env):
    chat_env.main._PHONE_COGNIZE["s-phone"] = asyncio.Queue()
    try:
        await chat_env.main.dispatch(
            "chat.stream", {"prompt": "from phone", "sessionId": "s-phone", "ephemeral": True}, chat_env.send
        )
    finally:
        chat_env.main._PHONE_COGNIZE.pop("s-phone", None)
    assert set(chat_env.tools_seen) == {False}
    assert ("s-phone", "assistant", "A guess.") in chat_env.rows


@pytest.mark.asyncio
async def test_a_cancelled_draft_still_restores_the_tools(chat_env):
    started = asyncio.Event()

    async def slow(**kwargs):
        started.set()
        await asyncio.sleep(30)
        yield {"modelId": "x", "delta": "never"}

    chat_env.main.router.stream = slow
    task = asyncio.create_task(
        chat_env.main.dispatch("chat.stream", {"prompt": "d", "sessionId": "s-c", "ephemeral": True}, chat_env.send)
    )
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert chat_env.router.NO_TOOLS.get() is False
    assert chat_env.rows == [] and chat_env.memory_writes == []
