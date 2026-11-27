"""Long utterances are cut at their silences and joined again with no word lost; one-word clips reach the decode."""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "kernel"))

import stt  # noqa: E402

RATE = stt.RATE


def _name(number: int) -> str:
    """A distinct, word-like token (a transcript of counting numbers would compress like a loop)."""
    digest = hashlib.sha256(str(number).encode()).digest()
    return "".join("bcdfghklmnprstvz"[b % 16] + "aeiou"[b // 16 % 5] for b in digest[:4])


def _script(seconds: float, *, pauses: bool) -> list[dict]:
    """Words of 0.3 s. With ``pauses`` a sentence of 8-13 words ends in a 0.7 s silence; without, speech never rests."""
    words: list[dict] = []
    clock, number, sentence = 0.5, 0, 0
    while clock < seconds - 1.0:
        length = 8 + (sentence * 5) % 6
        for _ in range(length):
            if clock + 0.3 > seconds - 0.5:
                return words
            words.append({"text": _name(number), "start": round(clock, 3), "end": round(clock + 0.3, 3)})
            clock += 0.3 + (0.08 if pauses else 0.02)
            number += 1
        clock += 0.7 if pauses else 0.0
        sentence += 1
    return words


def _audio(words: list[dict], seconds: float) -> np.ndarray:
    clip = np.zeros(int(seconds * RATE), dtype=np.float32)
    for word in words:
        a, b = int(word["start"] * RATE), int(word["end"] * RATE)
        clip[a:b] = 0.3 * np.sin(2 * np.pi * 220 * np.arange(b - a) / RATE)
    return clip


class FakeModel:
    """Hears exactly what is in each piece it is handed (the nth call is the nth planned piece). A word cut by the
    piece's edge comes back shortened, as a real decoder does."""

    def __init__(self, words: list[dict], pieces: list[dict]) -> None:
        self.words, self.pieces, self.calls = words, pieces, []

    def transcribe(self, clip, **kwargs):
        piece = self.pieces[len(self.calls)]
        self.calls.append(kwargs)
        assert abs(len(clip) / RATE - (piece["end"] - piece["start"])) < 0.01
        heard = []
        for word in self.words:
            inside = min(word["end"], piece["end"]) - max(word["start"], piece["start"])
            if inside / (word["end"] - word["start"]) < 0.5:
                continue
            whole = inside >= (word["end"] - word["start"]) - 1e-6
            text = word["text"] if whole else word["text"][:3]
            heard.append(
                SimpleNamespace(
                    word=f" {text}",
                    start=max(word["start"], piece["start"]) - piece["start"],
                    end=min(word["end"], piece["end"]) - piece["start"],
                )
            )
        segments = [
            SimpleNamespace(
                text=" ".join(w.word.strip() for w in heard[i : i + 10]),
                start=heard[i].start,
                end=heard[min(i + 9, len(heard) - 1)].end,
                words=heard[i : i + 10],
                no_speech_prob=0.02,
                avg_logprob=-0.2,
            )
            for i in range(0, len(heard), 10)
        ]
        seconds = len(clip) / RATE
        info = SimpleNamespace(
            language="en", language_probability=0.97, duration=seconds, duration_after_vad=seconds * 0.8
        )
        return iter(segments), info


def _read(words: list[dict], seconds: float, hint: str = "the hint"):
    clip = _audio(words, seconds)
    pieces = stt.plan_chunks(clip)
    model = FakeModel(words, pieces)
    partials: list[str] = []
    result = stt._consume_longform(model, clip, {"language": None, "vad_filter": True}, hint, partials.append)
    return clip, pieces, model, result, partials


def test_ninety_seconds_split_at_silences_and_lose_no_word() -> None:
    words = _script(90.0, pauses=True)
    clip, pieces, model, result, partials = _read(words, 90.0)
    assert len({w["text"] for w in words}) == len(words) and len(pieces) >= 4
    assert all(p["end"] - p["start"] <= stt.LONGFORM_CHUNK_S + 1e-6 for p in pieces)
    assert [p["cut"] for p in pieces[:-1]] == ["silence"] * (len(pieces) - 1)
    for earlier, later in zip(pieces, pieces[1:], strict=False):
        assert later["start"] == pytest.approx(earlier["end"] - stt.LONGFORM_OVERLAP_S, abs=1e-3)
        mid = int(earlier["end"] * RATE)
        assert float(np.abs(clip[mid - 800 : mid + 800]).max()) == 0.0  # the cut lies inside a pause
    assert result["text"].split() == [w["text"] for w in words]  # 0 dropped, 0 repeated
    assert result["chunks"] == len(pieces) and result["durationMs"] == 90_000
    assert partials[-1] == result["text"]
    assert " ".join(r["text"] for r in result["segments"]) == result["text"]


def test_speech_with_no_pause_is_cut_hard_and_still_loses_no_word() -> None:
    words = _script(70.0, pauses=False)
    clip, pieces, model, result, _ = _read(words, 70.0)
    assert [p["cut"] for p in pieces[:-1]] == ["hard"] * (len(pieces) - 1)
    assert all(p["end"] - p["start"] <= stt.LONGFORM_CHUNK_S + 1e-6 for p in pieces)
    assert result["text"].split() == [w["text"] for w in words]


def test_each_piece_is_prompted_with_the_last_200_characters_already_said() -> None:
    words = _script(90.0, pauses=True)
    _, pieces, model, result, _ = _read(words, 90.0)
    assert model.calls[0]["initial_prompt"] == "the hint"
    said = result["text"]
    for call in model.calls[1:]:
        carried = call["initial_prompt"]
        assert 0 < len(carried) <= 200 and carried != "the hint"
        assert said.startswith(said[: said.find(carried)] or said)  # whole words
        assert carried in said
    assert all(call["word_timestamps"] is True for call in model.calls)


def test_a_repeated_phrase_at_the_seam_is_kept_once_and_the_rest_is_untouched() -> None:
    words = _script(60.0, pauses=True)
    # The model hears the overlap twice, with word times a little off, as a real one does.
    clip = _audio(words, 60.0)
    pieces = stt.plan_chunks(clip)
    model = FakeModel(words, pieces)
    original = model.transcribe

    def jittered(piece_clip, **kwargs):
        segments, info = original(piece_clip, **kwargs)
        rows = list(segments)
        for row in rows:
            for w in row.words:
                w.start += 0.12
                w.end += 0.12
        return iter(rows), info

    model.transcribe = jittered  # type: ignore[method-assign]
    result = stt._consume_longform(model, clip, {"language": None}, "", None)
    assert result["text"].split() == [w["text"] for w in words]


def test_a_noise_sign_off_in_a_quiet_piece_is_not_kept() -> None:
    clip = np.zeros(40 * RATE, dtype=np.float32)
    pieces = stt.plan_chunks(clip)

    class Hallucinating:
        def transcribe(self, piece_clip, **kwargs):
            seg = SimpleNamespace(text="Thanks for watching", start=0.0, end=1.0, words=[], no_speech_prob=0.9,
                                  avg_logprob=-1.4)  # fmt: skip
            return iter([seg]), SimpleNamespace(language="en", duration=len(piece_clip) / RATE, duration_after_vad=0.0)

    result = stt._consume_longform(Hallucinating(), clip, {"language": None}, "", None)
    assert len(pieces) == 2 and result["text"] == ""


def test_planning_edge_cases() -> None:
    assert stt.plan_chunks(np.zeros(0, dtype=np.float32)) == []
    short = stt.plan_chunks(np.zeros(10 * RATE, dtype=np.float32))
    assert short == [{"start": 0.0, "end": 10.0, "cut": "end"}]
    assert stt.is_longform(30.5) and not stt.is_longform(30.0)
    with pytest.raises(ValueError):
        stt.plan_chunks(np.zeros(60 * RATE, dtype=np.float32), max_s=3.0)


def test_a_long_clip_goes_through_the_chunked_path_and_a_short_one_does_not(monkeypatch) -> None:
    seen: list[str] = []
    monkeypatch.setattr(stt.hindi_ear, "tries_ear", lambda *a: False)
    monkeypatch.setattr(stt, "get_model", lambda *a, **k: object())
    reply = {"text": "ok then", "language": "en", "durationMs": 1000, "segments": [], "noSpeechProb": 0.0,
             "avgLogprob": -0.2, "policyCode": "", "vadMs": 900, "noSpeechNote": ""}  # fmt: skip
    monkeypatch.setattr(stt, "_consume_longform", lambda *a, **k: seen.append("long") or reply)
    monkeypatch.setattr(stt, "_consume_whisper", lambda *a, **k: seen.append("short") or reply)
    stt._transcribe_prepared("x.wav", np.zeros(45 * RATE, dtype=np.float32), "base", "en", "", None, "en")
    stt._transcribe_prepared("x.wav", np.zeros(20 * RATE, dtype=np.float32), "base", "en", "", None, "en")
    assert seen[0] == "long" and "long" not in seen[1:]


# ---- One word -------------------------------------------------------------------------------------------------------


class OneWordModel:
    def __init__(self, text: str, voiced: float, logprob: float = -0.3) -> None:
        self.text, self.voiced, self.logprob, self.calls = text, voiced, logprob, []

    def transcribe(self, clip, **kwargs):
        self.calls.append(kwargs)
        seg = SimpleNamespace(text=self.text, start=0.0, end=len(clip) / RATE, words=[], no_speech_prob=0.05,
                              avg_logprob=self.logprob)  # fmt: skip
        info = SimpleNamespace(language="hi", language_probability=0.9, duration=len(clip) / RATE,
                               duration_after_vad=self.voiced)  # fmt: skip
        return iter([seg]), info


def _say(monkeypatch, model: OneWordModel, seconds: float, language: str = "hi") -> dict:
    monkeypatch.setattr(stt.hindi_ear, "tries_ear", lambda *a: False)
    monkeypatch.setattr(stt, "get_model", lambda *a, **k: model)
    clip = np.full(int(seconds * RATE), 0.05, dtype=np.float32)
    return stt._transcribe_prepared("x.wav", clip, "base", language, "a long prompt", None, language)


def test_the_voice_filter_lets_a_120_ms_word_through() -> None:
    assert stt.VAD_PARAMETERS["min_speech_duration_ms"] == 120


@pytest.mark.parametrize(
    ("heard", "seconds", "voiced", "expect"),
    [
        ("haan", 0.25, 0.22, "haan"),
        ("Ruko.", 0.4, 0.3, "Ruko."),
        ("stop", 0.55, 0.45, "stop"),
        ("han", 0.3, 0.2, "haan"),
    ],
)
def test_a_short_command_word_reaches_the_decode_and_is_kept(monkeypatch, heard, seconds, voiced, expect) -> None:
    model = OneWordModel(heard, voiced, logprob=-1.8)  # a doubtful score does not matter for a command word
    result = _say(monkeypatch, model, seconds)
    assert result["text"] == expect
    first = model.calls[0]  # the first decode is the one the voice filter and the prompt rule govern
    assert first["vad_parameters"]["min_speech_duration_ms"] <= 120
    assert "initial_prompt" not in first  # a prompt on a one-word clip is what the model repeats back


def test_a_short_clip_keeps_a_language_the_owner_locked(monkeypatch) -> None:
    model = OneWordModel("nein", 0.3, logprob=-0.2)
    assert _say(monkeypatch, model, 0.4, language="de")["text"] == "nein"
    assert model.calls[0]["language"] == "de" and "initial_prompt" not in model.calls[0]


def test_a_short_clip_that_is_not_a_command_needs_confidence(monkeypatch) -> None:
    assert _say(monkeypatch, OneWordModel("banana", 0.3, logprob=-1.8), 0.4)["text"] == ""
    assert _say(monkeypatch, OneWordModel("chrome", 0.3, logprob=-0.2), 0.4)["text"] == "chrome"


def test_under_120_ms_of_voice_is_never_a_word(monkeypatch) -> None:
    assert _say(monkeypatch, OneWordModel("haan", 0.08), 0.4)["text"] == ""
