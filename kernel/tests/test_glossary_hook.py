"""Learned glossary in the ears (hotwords, prompt hint) and the kernel calls the app uses (temp data root)."""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

_root = Path(tempfile.mkdtemp(prefix="friday-glossary-"))
os.environ.setdefault("FRIDAY_DATA_DIR", str(_root / "data"))
os.environ.setdefault("FRIDAY_WORKSPACE_ROOT", str(_root))
os.environ.setdefault("FRIDAY_BRIDGE_TOKEN", "contract-token")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import glossary_learn  # noqa: E402
import main  # noqa: E402
import stt  # noqa: E402


def _noop_send(_msg):
    return None


async def call(method: str, params: dict):
    return await main.dispatch(method, params, _noop_send)


@pytest.fixture
def root(tmp_path, monkeypatch):
    monkeypatch.setenv("FRIDAY_ROOT", str(tmp_path))
    return tmp_path


def learn(words: str, corrected: str, root_dir) -> list[str]:
    rows = [{"source": "owner", "corrected": True, "heard": words, "text": corrected}]
    return glossary_learn.learn_from_corrections(rows, True, root=root_dir)


def test_learned_terms_follow_owner_words_in_hotwords(root):
    learn("pro jet", "Zorblax Quillon", root)
    opts = stt.decode_options({"hotwords": ["Devendra"]}, False)
    words = opts["hotwords"].split(", ")
    assert words[0] == "Devendra"
    assert "Zorblax" in words


def test_setting_default_is_on_and_off_hides_learned(root):
    learn("pro jet", "Zorblax", root)
    assert "Zorblax" in stt.decode_options({}, False).get("hotwords", "")
    assert "hotwords" not in stt.decode_options({"learnGlossary": False}, False)


def test_hotword_cap_still_200_and_owner_words_survive(root):
    learn("a b c d e f", " ".join(f"Learnedterm{i:02d}" for i in range(40)), root)
    owner = ["OwnerWordOne", "OwnerWordTwo"]
    hot = stt.decode_options({"hotwords": owner}, False)["hotwords"]
    assert len(hot) <= stt.MAX_HOTWORDS_CHARS
    assert hot.startswith("OwnerWordOne, OwnerWordTwo")


def test_owner_duplicate_of_learned_term_is_not_repeated(root):
    learn("pro jet", "Zorblax", root)
    hot = stt.decode_options({"hotwords": ["zorblax"]}, False)["hotwords"].split(", ")
    assert [w.lower() for w in hot].count("zorblax") == 1


def test_prompt_hint_is_appended_to_initial_prompt(root):
    learn("pro jet", "Zorblax", root)
    out = stt.with_glossary_hint("Namaste.", {})
    assert out.startswith("Namaste.") and "Zorblax" in out
    assert stt.with_glossary_hint("", {}) == glossary_learn.prompt_hint(True)
    assert stt.with_glossary_hint("Namaste.", {"learnGlossary": False}) == "Namaste."


def test_nothing_learned_leaves_prompt_untouched(root):
    assert stt.with_glossary_hint("Namaste.", {}) == "Namaste."


@pytest.mark.asyncio
async def test_glossary_learn_list_and_forget_calls(root):
    rows = [{"source": "owner", "corrected": True, "heard": "pro jet", "text": "Zorblax"}]
    res = await call("glossary.learn", {"rows": rows, "on": True})
    assert "Zorblax" in res["terms"]
    assert "Zorblax" in (await call("glossary.list", {"on": True}))["terms"]
    assert (await call("glossary.list", {"on": False}))["terms"] == []
    assert (await call("glossary.forget", {"term": "Zorblax"}))["removed"] == 1
    assert (await call("glossary.list", {"on": True}))["terms"] == []


@pytest.mark.asyncio
async def test_glossary_forget_all_and_learn_off(root):
    learn("pro jet", "Zorblax Quillon", root)
    assert (await call("glossary.forget", {"all": True}))["removed"] >= 2
    off = await call(
        "glossary.learn", {"rows": [{"source": "owner", "corrected": True, "heard": "a", "text": "Foo"}], "on": False}
    )
    assert off["terms"] == []


@pytest.mark.asyncio
async def test_privacy_classify_call(root):
    out = await call("privacy.classify", {"text": "hello there"})
    assert out["level"] == "public"
    assert (await call("privacy.classify", {"text": ""}))["level"] == "public"
    assert (await call("privacy.classify", {}))["level"] == "public"
