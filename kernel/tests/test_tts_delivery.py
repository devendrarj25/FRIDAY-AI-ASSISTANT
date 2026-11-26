"""Delivery tags: parsing, stripping, clamps, the engine allow-list and the injection guards.

No model file and no clock: text goes in, pieces and numbers come out.
"""

from __future__ import annotations

import math
import random
import sys
import unicodedata
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import friday_voice  # noqa: E402
import tts_delivery as td  # noqa: E402
import voice_fx  # noqa: E402

screen = td.strip
ON = {name: {"enabled": True} for name in td.ENGINE_TAG_NAMES}


def only(text: str, **kw) -> td.Piece:
    pieces = td.parse(text, **kw)
    assert len(pieces) == 1, pieces
    return pieces[0]


# ---- the vocabulary ----------------------------------------------------------------------------------------------


def test_vocabulary_is_exactly_the_ten_tags():
    assert sorted(td.TAGS) == sorted(
        ["warm", "soft", "excited", "calm", "pause", "breath", "sigh", "laugh-soft", "slow", "fast"]
    )


def test_every_table_number_is_inside_its_limit():
    for spec in td.TAGS.values():
        assert spec.kind in td.KINDS
        assert td.SPEED_LIMITS[0] <= spec.speed <= td.SPEED_LIMITS[1]
        assert td.GAIN_LIMITS_DB[0] <= spec.gain_db <= td.GAIN_LIMITS_DB[1]
        assert td.PAUSE_SCALE_LIMITS[0] <= spec.pause_mul <= td.PAUSE_SCALE_LIMITS[1]
        for key, db in spec.fx:
            assert td._FX_KEY.match(key) and abs(db) <= td.FX_LIMIT_DB
            assert key.split(":")[0] in voice_fx.EQ_TYPES
        if spec.min_steps is not None:
            assert td.STEPS_LIMITS[0] <= spec.min_steps <= td.STEPS_LIMITS[1]
        if spec.engine:
            assert spec.engine in td.ENGINE_TAG_NAMES


def test_engine_names_come_only_from_the_table():
    assert td.ENGINE_TAG_NAMES == ("breath", "laugh", "sigh")
    assert set(td.ENGINE_TAG_STATUS) == set(td.ENGINE_TAG_NAMES)
    assert set(td.ENGINE_FALLBACK) == set(td.ENGINE_TAG_NAMES)


def test_status_table_never_enables_a_tag_that_was_spoken_aloud():
    for name, entry in td.ENGINE_TAG_STATUS.items():
        spoken = entry.get("spoken", {})
        if entry["enabled"]:
            assert spoken and not any(spoken.values()), name
        assert td.engine_enabled(name) is entry["enabled"]


def test_measured_status_rows_are_complete_and_inside_the_limits():
    assert td.ENGINE_TAG_MEASURED_ON == "2026-11-26"
    for name, entry in td.ENGINE_TAG_STATUS.items():
        assert set(entry["spoken"]) == {"en", "hi", "na"}, name
        for lang in ("en", "hi", "na"):
            low, high = entry["alone_active_s"][lang]
            assert 0 < low <= high < 1.0, (name, lang)
            low, high = entry["alone_rms_db"][lang]
            assert -60 < low <= high < 0, (name, lang)
        assert entry["note"]


def test_a_tag_read_aloud_in_any_language_is_never_on_by_default():
    for entry in td.ENGINE_TAG_STATUS.values():
        if any(entry["spoken"].values()):
            assert entry["enabled"] is False
    assert not any(td.engine_enabled(name) for name in td.ENGINE_TAG_NAMES)


def test_speed_constants_match_the_speech_graphs():
    assert td.ENGINE_SPEED_RANGE == friday_voice.SPEED_RANGE
    assert td.STEPS_LIMITS == friday_voice.STEP_RANGE


def test_angle_marks_cover_every_character_the_engine_cleanup_folds_to_an_angle():
    folded = {chr(c) for c in range(0x10000) if unicodedata.normalize("NFKD", chr(c)) in ("<", ">")}
    assert folded <= set(td._ANGLE_MARKS)


# ---- parse: moods ------------------------------------------------------------------------------------------------


def test_plain_text_is_one_neutral_piece():
    piece = only("Hello there, how are you?")
    assert piece.text == "Hello there, how are you?"
    assert (piece.speed_mul, piece.gain_db, piece.fx_delta, piece.tags_applied) == (1.0, 0.0, {}, ())
    assert piece.engine_tags == () and piece.pause_ms_before == 0 and piece.pause_ms_after == 0


@pytest.mark.parametrize("value", ["", None, "   ", "\n\n"])
def test_empty_input_gives_no_pieces(value):
    assert td.parse(value) == []  # type: ignore[arg-type]


def test_warm_sets_speed_fx_and_steps():
    piece = only("[warm] Good evening.")
    assert piece.text == "Good evening."
    assert piece.speed_mul == pytest.approx(0.97)
    assert piece.fx_delta == pytest.approx({"lowshelf:200": 1.5, "peak:3500": 1.0})
    assert piece.min_steps == 5 and piece.tags_applied == ("warm",)


def test_soft_sets_gain_and_air():
    piece = only("[soft] Good night.")
    assert piece.speed_mul == pytest.approx(0.92) and piece.gain_db == pytest.approx(-3.0)
    assert piece.fx_delta == pytest.approx({"highshelf:6000": -2.0})


def test_excited_and_calm_scale_the_pauses():
    excited = only("[excited] We did it!")
    calm = only("[calm] Take your time.")
    assert (excited.speed_mul, excited.gain_db, excited.pause_mul) == pytest.approx((1.08, 1.0, 0.8))
    assert (calm.speed_mul, calm.gain_db, calm.pause_mul) == pytest.approx((0.93, 0.0, 1.2))


def test_slow_and_fast_change_only_speed():
    assert only("[slow] Listen carefully.").speed_mul == pytest.approx(0.88)
    fast = only("[fast] Quick note.")
    assert fast.speed_mul == pytest.approx(1.12) and fast.gain_db == 0.0 and fast.fx_delta == {}


def test_mood_and_pace_stack_and_clamp():
    piece = only("[warm][fast] Right away.")
    assert piece.speed_mul == pytest.approx(0.97 * 1.12)
    assert piece.tags_applied == ("warm", "fast")
    assert only("[excited][fast] Go go go.").speed_mul == pytest.approx(1.2)  # 1.08 * 1.12 = 1.21, clamped


def test_a_later_mood_replaces_the_earlier_one():
    first, second = td.parse("[warm] one [soft] two")
    assert (first.text, first.tags_applied) == ("one", ("warm",))
    assert (second.text, second.tags_applied) == ("two", ("soft",))
    assert second.gain_db == pytest.approx(-3.0) and "lowshelf:200" not in second.fx_delta


def test_a_sentence_end_clears_the_mood():
    styled, plain = td.parse("[warm] Hello there. Nothing special now.")
    assert styled.text == "Hello there." and styled.tags_applied == ("warm",)
    assert plain.text == "Nothing special now." and plain.tags_applied == () and plain.speed_mul == 1.0


def test_a_mood_runs_through_commas_inside_one_sentence():
    piece = only("[calm] Well, honestly, it is fine.")
    assert piece.text == "Well, honestly, it is fine." and piece.tags_applied == ("calm",)


def test_newline_and_danda_end_a_sentence():
    assert [p.tags_applied for p in td.parse("[warm] one\ntwo")] == [("warm",), ()]
    assert [p.tags_applied for p in td.parse("[warm] नमस्ते। शुक्रिया")] == [("warm",), ()]


def test_a_decimal_point_does_not_end_the_sentence():
    piece = only("[warm] It is 3.5 degrees out.")
    assert piece.text == "It is 3.5 degrees out." and piece.tags_applied == ("warm",)


def test_neutral_sentences_stay_in_one_piece():
    assert only("First one. Second one! Third?").text == "First one. Second one! Third?"


def test_a_tag_glued_to_the_next_word_still_works():
    piece = only("[warm]Hello again.")
    assert piece.text == "Hello again." and piece.tags_applied == ("warm",)


def test_hindi_and_hinglish_words_pass_through_unchanged():
    assert only("[warm] मैं यहाँ हूँ, बताइए।").text == "मैं यहाँ हूँ, बताइए।"
    assert only("[soft] Haan boss, kal subah ten baje hai.").text == "Haan boss, kal subah ten baje hai."


# ---- parse: strength ---------------------------------------------------------------------------------------------


def test_strength_scales_every_delta():
    half = only("[warm:0.5] Hello.")
    assert half.speed_mul == pytest.approx(0.985)
    assert half.fx_delta == pytest.approx({"lowshelf:200": 0.75, "peak:3500": 0.5})
    assert only("[soft:0.5] Hello.").gain_db == pytest.approx(-1.5)


def test_strength_zero_is_neutral_and_too_big_is_clamped():
    zero = only("[excited:0] Hello.")
    assert (zero.speed_mul, zero.gain_db, zero.pause_mul) == (1.0, 0.0, 1.0)
    assert only("[soft:9] Hello.").gain_db == pytest.approx(-4.5)  # strength 1.5


@pytest.mark.parametrize("value", ["abc", "-1", "1e3", "1,5", "", "0.5.5"])
def test_a_bad_strength_drops_the_tag_and_speaks_nothing_of_it(value):
    piece = only(f"[warm:{value}] Hello.")
    assert piece.text == "Hello." and piece.tags_applied == () and piece.speed_mul == 1.0


# ---- parse: pauses -----------------------------------------------------------------------------------------------


def test_pause_defaults_to_250_ms_after_the_text_before_it():
    first, second = td.parse("Wait a moment. [pause] Now go.")
    assert first.text == "Wait a moment." and first.pause_ms_after == 250 and "pause" in first.tags_applied
    assert second.text == "Now go." and second.pause_ms_before == 0


@pytest.mark.parametrize(
    ("tag", "ms"),
    [("[pause:400]", 400), ("[pause:300ms]", 300), ("[pause:0.5s]", 500), ("[pause:5]", 80), ("[pause:99999]", 1200)],
)
def test_pause_values_are_read_and_clamped(tag, ms):
    assert td.parse(f"Okay {tag} next")[0].pause_ms_after == ms


@pytest.mark.parametrize("value", ["abc", "-5", "1e3", ""])
def test_a_bad_pause_value_is_dropped(value):
    pieces = td.parse(f"Okay [pause:{value}] next")
    assert [p.pause_ms_after for p in pieces] == [0, 0]
    assert all("pause" not in p.text for p in pieces)


def test_a_pause_first_waits_before_the_first_words():
    piece = only("[pause:600] Hello.")
    assert piece.pause_ms_before == 600 and piece.text == "Hello."


def test_a_lone_pause_is_an_empty_piece():
    piece = only("[pause:300]")
    assert piece.text == "" and piece.pause_ms_before == 300


def test_pauses_add_up_to_a_cap():
    assert td.parse("Hi [pause:1000] [pause:1000]")[0].pause_ms_after == 2000
    assert td.parse("Hi [pause:1200]")[0].pause_ms_after == 1200


# ---- parse: engine tags ------------------------------------------------------------------------------------------


def test_engine_tags_become_their_own_empty_pieces():
    pieces = td.parse("Hmm [sigh] okay.")
    assert [(p.text, p.engine_tags) for p in pieces] == [("Hmm", ()), ("", ("sigh",)), ("okay.", ())]


def test_laugh_soft_asks_for_the_laugh_tag_at_minus_four_db():
    piece = td.parse("[laugh-soft] fine")[0]
    assert piece.engine_tags == ("laugh",) and piece.gain_db == pytest.approx(-4.0)
    assert piece.tags_applied == ("laugh-soft",)


def test_bare_laugh_is_not_a_tag():
    piece = only("so [laugh] funny")
    assert piece.text == "so funny" and piece.engine_tags == () and piece.tags_applied == ()


def test_an_engine_piece_keeps_the_mood_gain():
    pieces = td.parse("[soft] ok [breath] more")
    assert pieces[1].engine_tags == ("breath",) and pieces[1].gain_db == pytest.approx(-3.0)


# ---- parse: density and unknown tags ------------------------------------------------------------------------------


def test_a_third_tag_in_one_sentence_is_ignored():
    pieces = td.parse("[warm] [soft] [pause:900] Hello.")
    assert pieces[0].tags_applied == ("soft",) and pieces[0].pause_ms_after == 0 and pieces[0].pause_ms_before == 0
    assert "pause" not in pieces[0].text


def test_the_count_starts_again_in_the_next_sentence():
    pieces = td.parse("[warm][pause] One. [soft][pause:500] Two.")
    assert [(p.pause_ms_before, p.pause_ms_after) for p in pieces] == [(250, 500), (0, 0)]
    assert [p.tags_applied for p in pieces] == [("pause", "warm"), ("soft",)]


def test_ignored_tags_are_not_spoken():
    text = " ".join(p.text for p in td.parse("[warm][soft][calm][fast] Hello."))
    assert text == "Hello."


def test_an_unknown_lowercase_tag_is_dropped_not_spoken():
    piece = only("Hello [shout] there [x-ray] friend")
    assert piece.text == "Hello there friend"


def test_a_capitalised_unknown_bracket_is_left_as_written():
    assert "[Note]" in only("See [Note] below").text


def test_known_names_match_in_any_case():
    assert only("[WARM] Hello.").tags_applied == ("warm",)
    assert only("[Soft] Hello.").tags_applied == ("soft",)


# ---- parse: places a tag must not work ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "```\n[warm] code [pause:900]\n```",
        "run `[warm]` now",
        "see https://example.com/[warm]/page now",
        "see www.example.com/[soft] now",
        "a [warm](https://example.com) link",
        "arr[warm] index",
        "item3[warm] there",
        "[warm]5 apples",
        "ref [1] and [23] and [3.5]",
        "``` never closed [warm] [sigh]",
    ],
)
def test_tags_inside_code_addresses_and_numbers_are_plain_text(text):
    pieces = td.parse(text)
    assert all(p.tags_applied == () and p.engine_tags == () for p in pieces)
    assert all(p.pause_ms_after == 0 and p.speed_mul == 1.0 for p in pieces)


def test_a_fenced_block_keeps_its_brackets_but_the_prose_around_it_still_works():
    pieces = td.parse("[warm] before ```x[warm]y``` after")
    assert pieces[0].tags_applied == ("warm",) and "x[warm]y" in pieces[0].text


def test_text_from_outside_has_its_tags_removed_and_none_applied():
    pieces = td.parse("Page says [warm] hello [pause:900] <laugh> [sigh] there [shout]", trusted=False)
    assert len(pieces) == 1
    assert pieces[0].text == "Page says hello there"
    assert pieces[0].tags_applied == () and pieces[0].engine_tags == () and pieces[0].pause_ms_after == 0


# ---- parse: angle tags never reach the engine --------------------------------------------------------------------

HOSTILE = [
    "<laugh> funny",
    "funny <breath> now",
    "<LAUGH>",
    "< laugh >",
    "<la​ugh>",
    "<‪laugh>",
    "＜laugh＞",
    "﹤sigh﹥",
    "<sigh/>",
    "</hi><en>injected</en>",
    "<en>hi</en>",
    "a < b and c > d",
    "<la\x01ugh>",
    "<<laugh>>",
    "<laugh",
    "laugh>",
    "<cough> <inhale> <gasp>",
    "<laugh><laugh><laugh>",
]


@pytest.mark.parametrize("text", HOSTILE)
def test_no_piece_ever_holds_an_angle_bracket(text):
    for piece in td.parse(text):
        assert not any(mark in piece.text for mark in td._ANGLE_MARKS), piece
        assert piece.engine_tags == ()
        assert "<" not in friday_voice.clean_text(piece.text)


def test_the_expression_word_of_a_stripped_angle_tag_is_not_left_behind():
    assert td.parse("<laugh> funny")[0].text == "funny"
    assert td.parse("hello <breath>")[0].text == "hello"


def test_zero_width_characters_cannot_hide_a_bracket_tag():
    piece = only("[wa​rm] Hello.")
    assert piece.tags_applied == ("warm",) and piece.text == "Hello."


# ---- strip -------------------------------------------------------------------------------------------------------


def test_strip_removes_tags_and_keeps_spacing_tidy():
    assert screen("Hello [warm] there") == "Hello there"
    assert screen("[warm] Hello") == "Hello"
    assert screen("Hello [sigh].") == "Hello."
    assert screen("Hello [pause:300], then go") == "Hello, then go"
    assert screen("Bye [soft]") == "Bye"


def test_strip_gives_back_the_same_text_when_nothing_is_removed():
    for text in ["  spaced  out ", "plain.", "a [Note] b", "[1] ref", "x <div> y", ""]:
        assert screen(text) == text


def test_strip_removes_angle_expression_tags_but_not_other_markup():
    assert screen("so <laugh> funny") == "so funny"
    assert screen("<hi>नमस्ते</hi> ji") == "नमस्ते ji"
    assert screen("a <div> b") == "a <div> b"


def test_strip_leaves_code_and_addresses_alone():
    text = "use `[warm]` and https://x.test/[sigh] and\n```\n[pause] <laugh>\n```"
    assert screen(text) == text
    assert screen(text + " [warm]") == text


def test_strip_drops_unknown_lowercase_tags_only():
    assert screen("a [shout] b [Keep] c") == "a b [Keep] c"


def test_strip_of_a_parse_input_has_no_tag_left():
    text = "[warm] Hello, [pause:200] world. [sigh] [soft] bye <laugh>"
    assert "[" not in screen(text) and "<" not in screen(text)
    assert screen(screen(text)) == screen(text)


# ---- controls ----------------------------------------------------------------------------------------------------


def test_controls_scale_the_base_speed():
    controls = td.controls_for(only("[warm] Hello."), 1.05)
    assert controls.speed == pytest.approx(1.05 * 0.97, abs=1e-3)
    assert controls.steps == 5 and controls.text == "Hello."


def test_total_multiplier_is_clamped_to_point_eight_and_one_point_two():
    assert td.controls_for(td.Piece("x", speed_mul=5.0), 1.0).speed == pytest.approx(1.2)
    assert td.controls_for(td.Piece("x", speed_mul=0.01), 1.0).speed == pytest.approx(0.8)


def test_final_speed_stays_inside_what_the_graphs_accept():
    assert td.controls_for(td.Piece("x", speed_mul=0.8), 0.7).speed == pytest.approx(0.7)
    assert td.controls_for(td.Piece("x", speed_mul=1.2), 2.0).speed == pytest.approx(2.0)
    assert td.controls_for(td.Piece("x"), 99).speed == pytest.approx(2.0)


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), None, "fast", -1])
def test_a_bad_base_speed_falls_back_to_normal(bad):
    speed = td.controls_for(td.Piece("x"), bad).speed  # type: ignore[arg-type]
    assert math.isfinite(speed) and 0.7 <= speed <= 2.0


def test_gain_fx_and_pause_numbers_are_clamped():
    piece = td.Piece(
        "x",
        gain_db=40.0,
        fx_delta={"lowshelf:200": 30.0, "peak:3500": -30.0, "evil": 1.0, "peak:1000": float("nan")},
        pause_ms_before=-5,
        pause_ms_after=10**9,
        pause_mul=50.0,
    )
    c = td.controls_for(piece)
    assert c.gain_db == 3.0
    assert c.fx_delta == {"lowshelf:200": 4.0, "peak:3500": -4.0, "peak:1000": 0.0}
    assert (c.pause_before_ms, c.pause_after_ms, c.pause_mul) == (0, 2400, 1.6)
    assert td.controls_for(td.Piece("x", gain_db=-40.0)).gain_db == -9.0


def test_steps_outside_the_range_are_ignored():
    assert td.controls_for(td.Piece("x", min_steps=99)).steps is None
    assert td.controls_for(td.Piece("x", min_steps=5)).steps == 5


def test_a_disabled_breath_becomes_a_short_quiet_noise():
    c = td.controls_for(td.parse("a [breath] b")[1])
    assert c.text == "" and c.engine_tag == "" and c.noise_ms == 180 and c.noise_db == -26.0


def test_a_disabled_sigh_becomes_a_pause_and_a_disabled_laugh_becomes_nothing():
    sigh = td.controls_for(td.parse("a [sigh] b")[1])
    laugh = td.controls_for(td.parse("a [laugh-soft] b")[1])
    assert (sigh.text, sigh.noise_ms, sigh.pause_after_ms) == ("", 0, 300)
    assert (laugh.text, laugh.noise_ms, laugh.pause_after_ms) == ("", 0, 0)


def test_an_enabled_engine_tag_reaches_the_engine_only_through_the_table():
    c = td.controls_for(td.parse("a [breath] b")[1], engine_status=ON)
    assert c.text == "<breath>" and c.engine_tag == "breath" and c.noise_ms == 0
    assert td.controls_for(td.parse("a [laugh-soft] b")[1], engine_status=ON).text == "<laugh>"


def test_a_forged_piece_cannot_name_an_engine_tag_outside_the_table():
    forged = td.Piece("", engine_tags=("cough", "../../etc/passwd", "breath><evil"))
    c = td.controls_for(forged, engine_status={"cough": {"enabled": True}, "breath><evil": {"enabled": True}})
    assert c.text == "" and c.engine_tag == ""


def test_a_forged_piece_text_cannot_carry_an_angle_tag_into_controls():
    c = td.controls_for(td.Piece("<laugh> hello ＜sigh＞"), engine_status=ON)
    assert "<" not in c.text and ">" not in c.text and c.engine_tag == ""


def test_only_an_explicit_true_enables_a_tag():
    for flag in (1, "yes", "true", None):
        assert td.engine_enabled("breath", {"breath": {"enabled": flag}}) is False
    assert td.engine_enabled("breath", {}) is False
    assert td.engine_enabled("nonsense", {"nonsense": {"enabled": True}}) is False


def test_merge_fx_adds_and_clamps_and_drops_bad_keys():
    merged = td.merge_fx([{"peak:3500": 3.0, "bad": 9}, {"peak:3500": 3.0}, {"lowshelf:200": -1.0}])
    assert merged == {"peak:3500": 4.0, "lowshelf:200": -1.0}


def test_default_controls_for_text_without_tags_are_neutral():
    c = td.controls_for(only("Just words."), 1.0)
    assert (c.text, c.speed, c.steps, c.gain_db, c.fx_delta) == ("Just words.", 1.0, None, 0.0, {})
    assert (c.pause_before_ms, c.pause_after_ms, c.pause_mul, c.noise_ms) == (0, 0, 1.0, 0)


# ---- fallback noise ----------------------------------------------------------------------------------------------


def test_fallback_noise_has_the_asked_length_and_level():
    noise = td.fallback_noise(44100, 180.0, -26.0, seed=1)
    assert noise.dtype == np.float32 and noise.size == int(44100 * 0.18)
    rms_db = 20 * np.log10(np.sqrt(np.mean(noise.astype(np.float64) ** 2)))
    assert rms_db == pytest.approx(-26.0, abs=0.2)
    assert float(np.max(np.abs(noise))) < 0.5


def test_fallback_noise_is_repeatable_and_the_seed_changes_it():
    a, b, c = (td.fallback_noise(seed=s) for s in (3, 3, 4))
    assert np.array_equal(a, b) and not np.array_equal(a, c)


def test_fallback_noise_fades_in_and_out_and_is_airy_not_a_rumble():
    noise = td.fallback_noise(44100, 200.0, -26.0, seed=2).astype(np.float64)
    assert abs(noise[0]) < 0.02 * np.max(np.abs(noise)) and abs(noise[-1]) < 0.02 * np.max(np.abs(noise))
    power = np.abs(np.fft.rfft(noise)) ** 2
    freq = np.fft.rfftfreq(noise.size, 1 / 44100)
    assert power[freq < 100].sum() < 0.02 * power.sum()
    assert power[freq > 12000].sum() < 0.05 * power.sum()


@pytest.mark.parametrize(
    "args", [(0, 180, -26), (44100, 0, -26), (44100, float("nan"), -26), (44100, 180, float("inf")), ("x", 180, -26)]
)
def test_fallback_noise_never_raises_and_stays_finite(args):
    noise = td.fallback_noise(*args)
    assert np.all(np.isfinite(noise)) and float(np.max(np.abs(noise), initial=0.0)) < 1.0


# ---- the whole path, fuzzed with a fixed seed ---------------------------------------------------------------------


def test_random_tag_soup_always_obeys_every_limit():
    rng = random.Random(20261126)  # noqa: S311 - a fixed-seed test generator
    bits = [
        "[warm]", "[soft:0.5]", "[excited:9]", "[calm:x]", "[pause]", "[pause:9999]", "[pause:-1]", "[breath]",
        "[sigh]", "[laugh-soft]", "[slow]", "[fast:1.5]", "[nope]", "<laugh>", "<breath>", "＜sigh＞", "`", "```",
        "https://a.b/[warm]", "word", "नमस्ते", ".", "!", "।", "\n", " ", "​", "<", ">", "[", "]", "3.5", "[1]",
    ]  # fmt: skip
    for _ in range(400):
        text = "".join(rng.choice(bits) + rng.choice(["", " "]) for _ in range(rng.randint(1, 14)))
        for trusted in (True, False):
            for piece in td.parse(text, trusted=trusted):
                assert not any(mark in piece.text for mark in td._ANGLE_MARKS)
                assert td.SPEED_LIMITS[0] <= piece.speed_mul <= td.SPEED_LIMITS[1]
                assert td.GAIN_LIMITS_DB[0] <= piece.gain_db <= td.GAIN_LIMITS_DB[1]
                assert all(abs(v) <= td.FX_LIMIT_DB for v in piece.fx_delta.values())
                assert (
                    0 <= piece.pause_ms_before <= td.PAUSE_TOTAL_MS and 0 <= piece.pause_ms_after <= td.PAUSE_TOTAL_MS
                )
                assert set(piece.engine_tags) <= set(td.ENGINE_TAG_NAMES)
                if not trusted:
                    assert piece.tags_applied == () and piece.engine_tags == ()
                control = td.controls_for(piece, 1.0)
                assert control.text == "" or "<" not in control.text
                assert 0.7 <= control.speed <= 2.0
        assert isinstance(screen(text), str)
