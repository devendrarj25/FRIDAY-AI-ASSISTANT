"""FRIDAY's default voice (the ``friday`` recipe) is the voice of every kernel path, no path picks a real person or a
character, and the mixed-script reading check (50 lines, CER per stratum against a pinned baseline) holds.

Everything but the last test uses stand-ins and runs anywhere. The last one speaks the lines with the real voice and
reads them back with the local ears: it runs when the three model folders are named in the environment
(``FRIDAY_TTS_MODEL_DIR``, ``FRIDAY_STT_DIR``, ``FRIDAY_HINDI_EAR_DIR``) and prints which are missing when they are not.
"""

from __future__ import annotations

import json
import os
import re
import sys
import types
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import friday_voice  # noqa: E402
import tts_eval  # noqa: E402
import tts_frontend  # noqa: E402
import voice_persona  # noqa: E402
import voice_runtime  # noqa: E402

PRESETS = ("F1", "F2", "F3", "F4", "F5", "M1", "M2")
RATE = 8000
FIXTURE = json.loads(tts_eval.READING_FIXTURE.read_text(encoding="utf-8"))
LINES = FIXTURE["lines"]
RECIPES = json.loads(voice_persona.RECIPE_FILE.read_text(encoding="utf-8"))

# Names of real people and of characters or other assistants a voice must never be made after.
BORROWED_NAMES = re.compile(
    r"jarvis|siri|alexa|cortana|samantha|scarlett|johansson|bettany|tony stark|iron ?man|morgan freeman|"
    r"amitabh|bachchan|lata|mangeshkar|shah ?rukh|deepika|priyanka|sridevi|darth|vader|optimus|"
    r"clone|cloned|impersonat|celebrity|lookalike|sound-?alike",
    re.IGNORECASE,
)


class StandIn:
    """Shaped like ``friday_voice.FridayVoice``: each preset is one number, so a blend can be read back."""

    sample_rate = RATE
    _indexer = None

    def __init__(self):
        self.styles: list[friday_voice.Style] = []

    def style(self, name):
        key = str(name).upper()
        if key not in PRESETS:
            raise KeyError(name)
        k = float(PRESETS.index(key) + 1)
        return friday_voice.Style(np.full((1, 2, 3), k, dtype=np.float32), np.full((1, 2, 3), 10 * k, dtype=np.float32))

    def synth(self, text, lang, style, *, steps=5, speed=1.0, seed=None):
        self.styles.append(style)
        body = 0.5 * np.sin(np.linspace(0, 200 * np.pi, RATE * max(1, len(text)) // 40)).astype(np.float32)
        pad = np.zeros(RATE // 4, dtype=np.float32)
        return np.concatenate([pad, body, pad])

    def warm_up(self):
        return 0.0


class PipTTS:
    """Stand-in for the ``supertonic`` package: the fallback voice when FRIDAY Voice cannot speak."""

    sample_rate = 22050
    asked: list[str] = []

    def __init__(self, *args, **kwargs):
        pass

    def get_voice_style(self, name):
        PipTTS.asked.append(name)
        return name

    def synthesize(self, text, voice_style=None, total_steps=5, speed=1.0, lang="en", silence_duration=0.12):
        return np.full(2205, 0.2, dtype=np.float32), 0.1


@pytest.fixture
def engine(monkeypatch, tmp_path):
    voice_runtime.reset_speech_state()
    voice_runtime.reset_cancelled()
    PipTTS.asked = []
    pkg = types.ModuleType("supertonic")
    pkg.TTS = PipTTS  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "supertonic", pkg)
    monkeypatch.setattr(voice_runtime, "supertonic_dir", lambda: tmp_path)
    monkeypatch.setattr(voice_runtime, "_tts", None)
    monkeypatch.setattr(voice_runtime, "_tts_dir", "")
    stand_in = StandIn()
    monkeypatch.setattr(friday_voice, "open_voice", lambda model_dir, *, threads=None: stand_in)
    yield stand_in
    voice_runtime.reset_speech_state()
    voice_runtime.reset_cancelled()


def _default_style() -> np.ndarray:
    """The blend of the shipped default recipe, from the stand-in presets (F2 0.7, F1 0.15, F4 0.15)."""
    base = RECIPES["recipes"]["friday"]["base"]
    return sum(w * (PRESETS.index(n) + 1) for n, w in base.items()) * np.ones((1, 2, 3), dtype=np.float32)


# ---------------------------------------------------------------- the recipe and the voice list


def test_the_default_recipe_is_friday_with_the_agreed_blend_speed_and_a_warm_chain():
    assert RECIPES["default"] == "friday" == voice_persona.DEFAULT_ID
    recipe = RECIPES["recipes"]["friday"]
    assert recipe["base"] == {"F2": 0.7, "F1": 0.15, "F4": 0.15}
    assert recipe["speed_scale"] == 0.97
    kinds = {section["type"] for section in recipe["fx"]["eq"]}
    assert "highshelf" in kinds and recipe["fx"].get("compressor") and recipe["fx"].get("deesser")
    assert list(RECIPES["recipes"])[0] == "friday"  # first in the picker order too


def test_every_recipe_is_a_blend_of_female_presets_only_and_plain_data():
    for rid, recipe in RECIPES["recipes"].items():
        assert set(recipe["base"]) <= {"F1", "F2", "F3", "F4", "F5"}, rid
        assert sum(recipe["base"].values()) == pytest.approx(1.0), rid
        # Data only: no reference recording, speaker file or cloning switch can ride along in a recipe.
        assert set(recipe) <= {"label", "description", "base", "steps", "speed_scale", "fx", "measured"}, rid


def test_no_voice_name_description_or_key_borrows_a_person_or_a_character():
    text = json.dumps(RECIPES, ensure_ascii=False)
    found = BORROWED_NAMES.findall(text)
    assert not found, found
    for rid, recipe in RECIPES["recipes"].items():
        assert rid == "friday" or rid.startswith("friday-"), rid
        assert recipe["label"].startswith("FRIDAY"), rid


@pytest.mark.parametrize(
    "asked", ["", "friday", "FRIDAY", "  Friday ", "../../etc/passwd", "no-such-voice", "scarlett", None, 7]
)
def test_any_style_that_is_not_a_known_id_is_the_default_voice(asked):
    assert voice_runtime.persona_name(asked) == "friday"
    assert voice_persona.cache_key(asked) == voice_persona.cache_key("friday")


def test_a_male_preset_is_only_ever_picked_by_name_and_every_fallback_is_female():
    # An owner may ask for M1 or M2 on purpose; nothing in the runtime or the recipes falls back to one.
    assert voice_runtime.persona_name("M1") == "M1" and voice_runtime.persona_name("m2") == "M2"
    assert voice_runtime.SUPERTONIC_VOICE.startswith("F")
    assert voice_runtime.voice_style_name("") == voice_runtime.SUPERTONIC_VOICE
    assert voice_runtime.voice_style_name("not a style") == voice_runtime.SUPERTONIC_VOICE


# ---------------------------------------------------------------- every kernel path speaks the default voice

LINES_BY_PATH = {
    "reply": "Your meeting starts at ten thirty tomorrow.",
    "hindi reply": "आपकी बैठक कल सुबह शुरू होगी।",
    "ack": "Haan.",
    "error line": "Sorry, I could not do that.",
    "read aloud": "Aapka message bhej diya hai.",
}


@pytest.mark.parametrize("path", list(LINES_BY_PATH))
@pytest.mark.parametrize("asked", [None, "", "friday", "FRIDAY", "junk/../style"])
def test_every_spoken_line_without_an_owner_choice_gets_the_friday_blend(engine, path, asked):
    request: dict = {"text": LINES_BY_PATH[path]}
    if asked is not None:
        request["style"] = asked
    body = voice_runtime.speak_pcm_payload(request)
    assert body["ok"] is True, body
    assert engine.styles, "the engine was never asked"
    assert all(np.allclose(style.ttl, _default_style()) for style in engine.styles)


def test_a_preview_of_a_variant_changes_only_that_sample_and_the_default_is_untouched(engine):
    voice_runtime.speak_pcm_payload({"text": "Namaste.", "style": "friday-bright"})
    bright = engine.styles[-1].ttl
    voice_runtime.speak_pcm_payload({"text": "Namaste."})
    assert not np.allclose(bright, engine.styles[-1].ttl)
    assert np.allclose(engine.styles[-1].ttl, _default_style())


def test_the_warm_up_and_the_wav_path_use_the_default_voice_too(engine):
    assert voice_runtime.warm_up_payload({})["voiceId"] == "friday"
    assert all(np.allclose(style.ttl, _default_style()) for style in engine.styles)
    engine.styles.clear()
    voice_runtime.speak_wav_bytes("Hello there.")
    assert engine.styles and all(np.allclose(style.ttl, _default_style()) for style in engine.styles)


def test_when_friday_voice_cannot_speak_the_fallback_is_the_dominant_female_preset_of_the_default(engine, monkeypatch):
    monkeypatch.setattr(friday_voice, "open_voice", lambda model_dir, *, threads=None: None)
    voice_runtime.reset_speech_state()
    body = voice_runtime.speak_pcm_payload({"text": "Hello there."})
    assert body["ok"] is True and PipTTS.asked, body
    base = RECIPES["recipes"]["friday"]["base"]
    assert set(PipTTS.asked) == {max(base, key=lambda name: base[name])} == {"F2"}


# ---------------------------------------------------------------- the fixture


def test_the_fixture_has_fifty_lines_in_eight_strata_with_valid_shapes():
    assert len(LINES) == 50
    assert FIXTURE["strata"] == list(tts_eval.READING_STRATA)
    counts = {name: sum(1 for line in LINES if line["stratum"] == name) for name in tts_eval.READING_STRATA}
    assert all(count >= 6 for count in counts.values()), counts
    assert sum(counts.values()) == 50
    assert len({line["id"] for line in LINES}) == 50
    assert {line["kind"] for line in LINES} <= set(tts_eval.KINDS)
    # The same file loads through the tool's own reader.
    assert [row["id"] for row in tts_eval.reading_lines()] == [line["id"] for line in LINES]


def test_the_scripts_of_each_line_match_its_kind():
    deva, latin = re.compile("[ऀ-ॿ]"), re.compile("[A-Za-z]")
    for line in LINES:
        has_deva, has_latin = bool(deva.search(line["text"])), bool(latin.search(line["text"]))
        kind = line["kind"]
        assert has_deva == (kind in ("hi", "hing-deva")), line["id"]
        if kind in ("en", "hing-roman"):
            assert has_latin and not has_deva, line["id"]
        if line["stratum"] == "mixed-script":
            assert has_deva and has_latin, line["id"]
        if line["stratum"] == "hinglish-roman":
            assert kind == "hing-roman", line["id"]
    covered = {line["stratum"] for line in LINES if deva.search(line["text"])}
    assert {"hindi", "mixed-script", "numbers", "times", "dates", "rupees", "units"} <= covered


def test_a_line_with_a_digit_names_its_numbers_and_its_spoken_form_has_none():
    for line in LINES:
        digits = re.search(r"\d", line["text"])
        assert not re.search(r"\d", line["spoken"]), line["id"]
        if digits:
            assert line.get("numbers"), line["id"]
            assert all(n["lang"] in ("hi", "en") and re.search(r"\d", n["text"]) for n in line["numbers"]), line["id"]
        else:
            assert "numbers" not in line and line["spoken"] == line["text"], line["id"]
    covered = {line["stratum"] for line in LINES if line.get("numbers")}
    assert covered == {"numbers", "times", "dates", "rupees", "units"}


def _kernel_text(line) -> str:
    clauses = tts_frontend.prepare(line["text"], tts_eval.READING_HINT[line["kind"]])
    return " ".join(clause.text for clause in clauses)


def _kernel_number_lang(line) -> str:
    """The language the kernel front end read the line's number in: ``hi``, ``en`` or ``none`` (not found)."""
    spoken = _kernel_text(line)
    token = line["numbers"][0]["text"]
    if tts_frontend.expand_numbers(token, "hi").strip() in spoken:
        return "hi"
    if tts_frontend.expand_numbers(token, "en").strip() in spoken:
        return "en"
    return "none"


# The language comes from the neighbouring word (``script-policy.ts`` spanTreatments, pinned in the vitest of the same
# fixture) and the kernel follows it: the word after the number, else the word before it. The fixture still lists
# t33, t39 and t45 as ``kernelReads`` gaps (the kernel used to read the clause language); they are fixed here. The one
# line where the kernel differs on purpose is t21: it knows ``nayi`` is Hindi (the renderer's lexicon does not yet),
# so it says the number in Hindi.
KERNEL_READS_BETTER = {"t21": "hi"}
FIXED_GAPS = ("t33", "t39", "t45")


def test_the_kernel_reads_each_number_in_the_language_the_policy_names_except_the_declared_gaps():
    gaps = {}
    for line in LINES:
        if not line.get("numbers"):
            continue
        found = _kernel_number_lang(line)
        if found != line["numbers"][0]["lang"]:
            gaps[line["id"]] = found
    assert gaps == KERNEL_READS_BETTER, gaps
    by_id = {line["id"]: line for line in LINES}
    for line_id in FIXED_GAPS:  # the pins of the first measurement, flipped to what the policy says
        assert by_id[line_id].get("kernelReads"), line_id
        assert _kernel_number_lang(by_id[line_id]) == by_id[line_id]["numbers"][0]["lang"], line_id


def test_the_kernel_says_each_plain_hindi_or_english_numeric_line_as_its_spoken_form():
    words = re.compile(r"[\s.,।!?]+")
    for line in LINES:
        if not line.get("numbers") or line["kind"] not in ("hi", "en"):
            continue
        said = _kernel_text(line)
        # the units (km, GB) are words too
        assert words.sub(" ", said).strip() == words.sub(" ", line["spoken"]).strip(), line["id"]


def test_a_roman_hinglish_line_keeps_its_english_words_and_reads_the_number_by_its_neighbour():
    said = {line["id"]: _kernel_text(line) for line in LINES if line["kind"] == "hing-roman"}
    # t39: Rs. keeps its rupees
    assert "seven hundred fifty rupees" in said["t39"] and "balance" in said["t39"], said["t39"]
    assert "three April" in said["t33"], said["t33"]  # t33: the next word is English
    assert "thirty two degree" in said["t45"] and "temperature" in said["t45"], said["t45"]  # t45
    assert "बारह नई emails" in said["t21"], said["t21"]  # t21: nayi is Hindi, so the number and the clause are
    assert "alarm" in said["t08"].lower() and "alarm" in said["t27"].lower() and "set" in said["t27"].split(), said
    for text in said.values():
        assert not re.search("अलर्म|सेत|तेंपेरतुरे", text), text


# ---------------------------------------------------------------- the scoring and the baseline (no models)


def _clip(n=1):
    return np.zeros(1600 * n, dtype=np.float32)


def test_the_reading_score_is_per_stratum_and_a_perfect_ear_scores_zero():
    lines = [line for line in LINES if line["stratum"] in ("hindi", "dates", "units")]
    heard = {line["text"]: line["spoken"] for line in lines}
    scores = tts_eval.reading_scores(lines, [_clip() for _ in lines], lambda _a, _k, text: heard[text])
    assert set(scores) == {"hindi", "dates", "units", "all"}
    assert all(row["cer"] == pytest.approx(0.0, abs=0.02) for row in scores.values()), scores
    assert scores["all"]["n"] == len(lines) and scores["all"]["failed"] == 0


def test_an_ear_that_writes_digits_is_read_as_words_in_the_lines_number_language():
    hindi = next(line for line in LINES if line["stratum"] == "rupees" and line["kind"] == "hi")
    english = next(line for line in LINES if line["stratum"] == "units" and line["kind"] == "en")
    assert tts_eval._digits_as_words("खाते में 5200 रुपये", hindi) == "खाते में पाँच हज़ार दो सौ रुपये"
    assert tts_eval._digits_as_words("at 20% now", english).startswith("at twenty percent")


def test_an_ear_that_fails_on_a_clip_counts_it_as_wrong_and_unread_and_never_crashes():
    lines = [line for line in LINES if line["stratum"] == "hindi"][:2]

    def broken(_audio, _kind, _text):
        raise RuntimeError("no model")

    scores = tts_eval.reading_scores(lines, [_clip(), _clip()], broken)
    assert scores["hindi"]["cer"] == 1.0 and scores["hindi"]["failed"] == 2


def test_the_regression_check_fails_only_beyond_the_margin_and_never_for_an_improvement():
    base = {"hindi": {"cer": 0.01}, "numbers": {"cer": 0.06}, "all": {"cer": 0.10}}
    same = {"hindi": {"cer": 0.03}, "numbers": {"cer": 0.05}, "all": {"cer": 0.12}}
    assert tts_eval.reading_regressions(same, base, 0.06) == []
    worse = {"hindi": {"cer": 0.09}, "numbers": {"cer": 0.30}, "all": {"cer": 0.2}}
    found = tts_eval.reading_regressions(worse, base, 0.06)
    assert [line.split(":")[0] for line in found] == ["numbers", "all", "hindi"]  # worst first
    assert tts_eval.reading_regressions({"numbers": {"cer": 0.0}}, base, 0.06) == []
    assert tts_eval.reading_regressions({}, base, 0.06) == []  # a stratum missing from this run is not compared


def test_the_pinned_baseline_covers_every_stratum_with_numbers_that_a_run_can_be_judged_by():
    pinned = json.loads(tts_eval.READING_BASELINE.read_text(encoding="utf-8"))
    assert pinned["recipe"] == "friday" and pinned["margin"] == tts_eval.READING_MARGIN
    assert set(pinned["strata"]) == {*tts_eval.READING_STRATA, "all"}
    sizes = {name: sum(1 for line in LINES if line["stratum"] == name) for name in tts_eval.READING_STRATA}
    for name, row in pinned["strata"].items():
        assert 0.0 <= row["cer"] <= 1.0 and 0.0 <= row["wer"] <= 1.0, name
        assert row["n"] == (50 if name == "all" else sizes[name]), name


def test_the_reading_report_speaks_every_line_and_routes_the_ears_by_kind():
    asked: list[str] = []
    rendered: list[str] = []

    def render(_voice, text, _kind):
        rendered.append(text)
        return np.zeros(RATE, dtype=np.float32), RATE

    def english(_a, kind, _t):
        asked.append(f"en:{kind}")
        return ""

    def hindi(_a, kind, _t):
        asked.append(f"hi:{kind}")
        return ""

    report = tts_eval.reading_report(None, tts_eval.ears_listener(english, hindi), render=render)
    assert rendered == [line["text"] for line in LINES] and report["lines"] == 50
    assert {a for a in asked if a.startswith("hi:")} == {"hi:hi", "hi:hing-deva"}
    assert {a for a in asked if a.startswith("en:")} == {"en:en", "en:hing-roman"}
    assert len(report["heard"]) == 50 and report["strata"]["all"]["n"] == 50


def test_the_reading_render_is_the_runtime_render_with_the_default_style(engine):
    audio, rate = tts_eval.reading_render(engine, "Haan.", "hing-roman")
    assert rate == RATE and audio.size > 0
    assert all(np.allclose(style.ttl, _default_style()) for style in engine.styles)


# ---------------------------------------------------------------- the real voice and the real ears

_DIRS = {name: os.environ.get(name, "") for name in ("FRIDAY_TTS_MODEL_DIR", "FRIDAY_STT_DIR", "FRIDAY_HINDI_EAR_DIR")}


def test_the_default_voice_read_back_by_the_local_ears_is_not_worse_than_the_pinned_baseline(capsys):
    missing = [name for name, folder in _DIRS.items() if not folder or not Path(folder).is_dir()]
    if missing:
        with capsys.disabled():
            print("\nreading round trip not run: model folders not set or not found: " + ", ".join(missing))
        return
    voice = friday_voice.open_voice(_DIRS["FRIDAY_TTS_MODEL_DIR"])
    assert voice is not None, "the voice folder does not open"
    listen = tts_eval.ears_listener(
        tts_eval.whisper_listener(_DIRS["FRIDAY_STT_DIR"]), tts_eval.hindi_ear_listener(_DIRS["FRIDAY_HINDI_EAR_DIR"])
    )
    report = tts_eval.reading_report(voice, listen)
    pinned = json.loads(tts_eval.READING_BASELINE.read_text(encoding="utf-8"))
    with capsys.disabled():
        print(f"\nreading CER per stratum (load {os.getloadavg()[0]:.1f} on {os.cpu_count()} cores)")
        for name, row in report["strata"].items():
            was = pinned["strata"].get(name, {}).get("cer", float("nan"))
            print(f"  {name:15s} CER {row['cer']:.3f} (pinned {was:.3f}), WER {row['wer']:.3f}, lines {int(row['n'])}")
    assert report["strata"]["all"]["failed"] == 0
    assert tts_eval.reading_regressions(report["strata"], pinned["strata"], float(pinned["margin"])) == []
