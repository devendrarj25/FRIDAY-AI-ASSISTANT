"""FRIDAY's own voice recipes: data in a JSON file, resolved into a style, steps, speed and finishing chain.

No model file: the voice is a small fake that hands out styles the way ``FridayVoice.style`` does.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import friday_voice  # noqa: E402
import voice_fx  # noqa: E402
import voice_persona  # noqa: E402

NAMES = ("F1", "F2", "F3", "F4", "F5", "M1", "M2")


class FakeVoice:
    def __init__(self, missing=()):
        self.asked: list[str] = []
        self.missing = set(missing)

    def style(self, name):
        key = str(name).upper()
        if key not in NAMES or key in self.missing:
            raise KeyError(name)
        self.asked.append(key)
        k = float(NAMES.index(key) + 1)
        return friday_voice.Style(np.full((1, 2, 3), k, dtype=np.float32), np.full((1, 2, 3), 10 * k, dtype=np.float32))


def _write(tmp_path, data):
    path = tmp_path / "recipes.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


def _recipe(**over):
    base = {
        "label": "Test",
        "base": {"F2": 0.5, "F1": 0.3, "F4": 0.2},
        "steps": 5,
        "speed_scale": 0.97,
        "fx": {"highpass_hz": 80},
        "measured": {"median_hz": 210.0},
    }
    base.update(over)
    return base


def _file(tmp_path, recipes, version=3, default="friday"):
    return _write(tmp_path, {"recipe_version": version, "default": default, "recipes": recipes})


# ---- the shipped file -----------------------------------------------------------------------------------------------


def test_the_shipped_recipes_are_the_three_named_voices():
    ids = list(voice_persona.recipes())
    assert ids[0] == voice_persona.DEFAULT_ID == "friday"
    assert {"friday", "friday-bright", "friday-calm"} <= set(ids)
    assert isinstance(voice_persona.RECIPE_VERSION, int)
    assert voice_persona.RECIPE_VERSION >= 1


def test_every_shipped_recipe_is_clean_data_that_the_chain_accepts():
    for rid, recipe in voice_persona.recipes().items():
        assert recipe["label"], rid
        assert sum(recipe["base"].values()) == pytest.approx(1.0), rid
        assert set(recipe["base"]) <= set(NAMES), rid
        assert 1 <= recipe["steps"] <= friday_voice.STEP_RANGE[1], rid
        assert 0.7 <= recipe["speed_scale"] <= 1.3, rid
        assert voice_fx.normalise_spec(recipe["fx"]) == recipe["fx"], rid
        assert recipe["measured"], rid
        voice_fx.FxChain(44100, recipe["fx"])


def test_the_default_recipe_blends_female_voices_only():
    default = voice_persona.recipes()[voice_persona.DEFAULT_ID]
    assert len(default["base"]) >= 2
    assert all(name.startswith("F") for name in default["base"])


# ---- ids ----------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "want"),
    [
        ("friday", "friday"),
        ("  FRIDAY ", "friday"),
        ("friday-bright", "friday-bright"),
        ("Friday-Calm", "friday-calm"),
        ("f2", "F2"),
        ("F5", "F5"),
        ("m1", "M1"),
        ("M2", "M2"),
        ("", "friday"),
        (None, "friday"),
        (7, "friday"),
        ("M3", "friday"),
        ("F6", "friday"),
        ("../../etc/passwd", "friday"),
        ("..\\models\\x", "friday"),
        ("C:\\Windows\\win.ini", "friday"),
        ("F2/../F1", "friday"),
        ("friday\x00", "friday"),
        ("x" * 5000, "friday"),
        ("friday-bright; rm -rf", "friday"),
    ],
)
def test_resolve_id_only_ever_names_a_known_voice(text, want):
    assert voice_persona.resolve_id(text) == want


# ---- resolving ----------------------------------------------------------------------------------------------------


def test_resolve_blends_the_base_voices_with_their_weights(tmp_path):
    path = _file(tmp_path, {"friday": _recipe(), "friday-bright": _recipe(base={"F1": 1.0})})
    with_file = voice_persona.Personas(path)
    got = with_file.resolve("friday", FakeVoice())
    assert isinstance(got, voice_persona.Resolved)
    want = 0.5 * 2 + 0.3 * 1 + 0.2 * 4  # F2, F1, F4 hold 2, 1, 4 in the fake
    assert got.style.ttl.reshape(-1)[0] == pytest.approx(want)
    assert got.style.dp.reshape(-1)[0] == pytest.approx(want * 10)
    assert got.id == "friday"
    assert got.label == "Test"
    assert got.steps == 5
    assert got.speed_scale == pytest.approx(0.97)
    assert got.fx_spec == voice_fx.normalise_spec({"highpass_hz": 80})


def test_the_blend_is_made_once_per_voice_and_recipe(tmp_path):
    personas = voice_persona.Personas(_file(tmp_path, {"friday": _recipe()}))
    voice = FakeVoice()
    first = personas.resolve("friday", voice)
    asked = len(voice.asked)
    again = personas.resolve("friday", voice)
    assert again.style is first.style
    assert len(voice.asked) == asked
    other = personas.resolve("friday", FakeVoice())
    assert other.style is not first.style


def test_a_preset_is_a_plain_voice_with_no_chain(tmp_path):
    personas = voice_persona.Personas(_file(tmp_path, {"friday": _recipe()}))
    voice = FakeVoice()
    got = personas.resolve("f4", voice)
    assert got.id == "F4"
    assert got.style.ttl.reshape(-1)[0] == pytest.approx(4.0)
    assert got.speed_scale == 1.0
    assert got.steps == voice_persona.DEFAULT_STEPS
    assert got.fx_spec == voice_fx.normalise_spec({})
    assert got.label == "F4"


def test_an_unknown_id_gets_the_default_recipe(tmp_path):
    personas = voice_persona.Personas(_file(tmp_path, {"friday": _recipe(label="Default")}))
    got = personas.resolve("nonsense", FakeVoice())
    assert got.id == "friday"
    assert got.label == "Default"


def test_a_missing_base_voice_is_left_out_and_the_rest_still_blend(tmp_path):
    personas = voice_persona.Personas(_file(tmp_path, {"friday": _recipe(base={"F2": 0.5, "F4": 0.5})}))
    got = personas.resolve("friday", FakeVoice(missing=["F4"]))
    assert got.style.ttl.reshape(-1)[0] == pytest.approx(2.0)


def test_when_no_base_voice_can_be_read_a_preset_is_tried_before_giving_up(tmp_path):
    personas = voice_persona.Personas(_file(tmp_path, {"friday": _recipe(base={"F2": 1.0})}))
    got = personas.resolve("friday", FakeVoice(missing=["F2"]))
    assert got.style.ttl.reshape(-1)[0] > 0
    with pytest.raises(KeyError):
        personas.resolve("friday", FakeVoice(missing=NAMES))


# ---- the cache key ------------------------------------------------------------------------------------------------


def test_the_cache_key_changes_with_the_version_and_with_the_recipe_text(tmp_path):
    one = voice_persona.Personas(_file(tmp_path, {"friday": _recipe()}, version=1))
    two = voice_persona.Personas(_file(tmp_path, {"friday": _recipe()}, version=2))
    edited = voice_persona.Personas(_file(tmp_path, {"friday": _recipe(speed_scale=1.0)}, version=1))
    assert one.cache_key("friday") != two.cache_key("friday")
    assert one.cache_key("friday") != edited.cache_key("friday")
    assert one.cache_key("friday") == voice_persona.Personas(
        _file(tmp_path, {"friday": _recipe()}, version=1)
    ).cache_key("friday")
    assert one.cache_key("F2") == "F2"
    assert one.cache_key("garbage") == one.cache_key("friday")


def test_the_shipped_cache_key_names_the_version():
    assert f"v{voice_persona.RECIPE_VERSION}" in voice_persona.cache_key("friday")
    assert voice_persona.cache_key("F3") == "F3"


# ---- a bad file never breaks the voice ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    ["", "not json", "[]", "null", '{"recipes": 5}', '{"recipes": {}}', '{"recipe_version": "x"}'],
)
def test_a_broken_file_falls_back_to_one_working_default(tmp_path, text):
    path = tmp_path / "recipes.json"
    path.write_text(text, encoding="utf-8")
    personas = voice_persona.Personas(path)
    assert personas.default_id == "friday"
    got = personas.resolve("friday", FakeVoice())
    assert got.id == "friday"
    assert float(np.mean(got.style.ttl)) > 0


def test_a_missing_file_falls_back_too(tmp_path):
    personas = voice_persona.Personas(tmp_path / "nope.json")
    assert personas.resolve("anything", FakeVoice()).id == "friday"


def test_bad_numbers_in_a_recipe_are_clamped_and_bad_recipes_dropped(tmp_path):
    wild = _recipe(steps=999, speed_scale=50, base={"F2": 1, "F9": 3, "F1": -1, "F4": "x"}, fx="nonsense")
    data = {
        "friday": wild,
        "friday-bright": {"label": "no base"},
        "friday-calm": "not a dict",
        "../evil": _recipe(),
    }
    personas = voice_persona.Personas(_file(tmp_path, data))
    recipes = personas.recipes()
    assert set(recipes) == {"friday"}
    one = recipes["friday"]
    assert one["steps"] == friday_voice.STEP_RANGE[1]
    assert one["speed_scale"] == pytest.approx(1.3)
    assert one["base"] == {"F2": 1.0}
    assert one["fx"] == voice_fx.normalise_spec(voice_fx.DEFAULT_SPECS["warm"])


def test_a_default_that_names_no_recipe_becomes_the_first_one(tmp_path):
    personas = voice_persona.Personas(_file(tmp_path, {"friday-calm": _recipe()}, default="ghost"))
    assert personas.default_id == "friday-calm"
    assert personas.resolve("nothing", FakeVoice()).id == "friday-calm"


# ---- the sweep hook -----------------------------------------------------------------------------------------------


def test_candidate_is_a_recipe_in_the_sweeps_shape():
    row = voice_persona.candidate("friday")
    assert row is not None
    assert row["id"] == "friday"
    assert sum(row["base"].values()) == pytest.approx(1.0)
    assert row["fx"] == voice_persona.recipes()["friday"]["fx"]
    plain = voice_persona.candidate("f2")
    assert plain is not None
    assert plain["base"] == {"F2": 1.0}
    assert voice_persona.candidate("zzz") is None


def test_module_level_resolve_uses_the_shipped_file():
    got = voice_persona.resolve("friday-calm", FakeVoice())
    assert got.id == "friday-calm"
    assert got.fx_spec == voice_persona.recipes()["friday-calm"]["fx"]


def test_the_starting_chains_are_the_chains_of_the_shipped_recipes():
    shipped = voice_persona.recipes()
    for rid, name in (("friday", "warm"), ("friday-bright", "bright"), ("friday-calm", "calm")):
        assert shipped[rid]["fx"] == voice_fx.normalise_spec(voice_fx.DEFAULT_SPECS[name]), rid


def test_the_recipes_file_is_plain_data_with_its_measured_numbers():
    raw = json.loads(voice_persona.RECIPE_FILE.read_text(encoding="utf-8"))
    assert isinstance(raw["recipe_version"], int)
    assert raw["default"] == voice_persona.DEFAULT_ID
    for rid, recipe in raw["recipes"].items():
        measured = recipe["measured"]
        assert "pending" not in measured, rid
        for key in ("median_hz", "range_st", "tilt_db_oct", "rate_syl_s", "rtf", "first_clause_ms"):
            assert key in measured, (rid, key)


def test_the_numbers_recorded_for_each_recipe_satisfy_the_gates_it_was_chosen_by():
    import tts_eval

    gates = tts_eval.GATES
    for rid, recipe in voice_persona.recipes().items():
        m = recipe["measured"]
        assert gates["f0_median_hz"][0] <= m["median_hz"] <= gates["f0_median_hz"][1], rid
        assert m["range_st"] >= gates["f0_range_st"], rid
        assert m["tilt_db_oct"] > m["plain_base_tilt_db_oct"], rid
        assert m["stt_wer"] <= m["plain_base_stt_wer"] + gates["stt_margin"], rid
        assert m["stt_cer"] <= m["plain_base_stt_cer"] + gates["stt_margin"], rid
        assert m["clip_ratio"] <= gates["clip_ratio"], rid


def test_the_cache_key_ignores_the_label_and_the_notes(tmp_path):
    one = voice_persona.Personas(_file(tmp_path, {"friday": _recipe()}))
    two = voice_persona.Personas(_file(tmp_path, {"friday": _recipe(label="Renamed", measured={"median_hz": 1.0})}))
    assert one.cache_key("friday") == two.cache_key("friday")
    chain = voice_persona.Personas(_file(tmp_path, {"friday": _recipe(fx={"highpass_hz": 90})}))
    assert one.cache_key("friday") != chain.cache_key("friday")
