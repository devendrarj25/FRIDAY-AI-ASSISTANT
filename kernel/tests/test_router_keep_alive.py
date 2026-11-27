"""ollama_keep_alive reads the shared plan in config/chat-tiers.json; the env var still wins."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import router  # noqa: E402

ENV = "FRIDAY_OLLAMA_KEEP_ALIVE"


def _plan(tmp_path: Path, monkeypatch, keep_alive) -> None:
    path = tmp_path / "chat-tiers.json"
    path.write_text(json.dumps({"ollamaSettings": {"keep_alive": keep_alive}}), encoding="utf-8")
    monkeypatch.setattr(router, "_CHAT_TIERS_PATH", path)


def test_plan_value_is_read(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv(ENV, raising=False)
    _plan(tmp_path, monkeypatch, "45m")
    assert router.ollama_keep_alive() == "45m"


def test_shipped_plan_says_30m(monkeypatch) -> None:
    monkeypatch.delenv(ENV, raising=False)
    assert router.ollama_keep_alive() == "30m"


def test_env_wins_over_plan(monkeypatch, tmp_path) -> None:
    _plan(tmp_path, monkeypatch, "45m")
    monkeypatch.setenv(ENV, "5m")
    assert router.ollama_keep_alive() == "5m"
    monkeypatch.setenv(ENV, "0")
    assert router.ollama_keep_alive() == 0
    monkeypatch.setenv(ENV, "-1")
    assert router.ollama_keep_alive() == -1


def test_plan_int_form_is_kept(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv(ENV, raising=False)
    _plan(tmp_path, monkeypatch, 0)
    assert router.ollama_keep_alive() == 0


def test_unreadable_plan_falls_back_to_20m(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv(ENV, raising=False)
    monkeypatch.setattr(router, "_CHAT_TIERS_PATH", tmp_path / "missing.json")
    assert router.ollama_keep_alive() == "20m"


def test_bad_plan_value_falls_back_to_20m(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv(ENV, raising=False)
    _plan(tmp_path, monkeypatch, ["x"])
    assert router.ollama_keep_alive() == "20m"


def test_hostile_env_values_never_raise_and_fall_back_to_the_plan(monkeypatch, tmp_path) -> None:
    _plan(tmp_path, monkeypatch, "45m")
    for bad in ("--5", "٣", "²", "5 m", "1e3", "5m;x", "+5", "5.5"):
        monkeypatch.setenv(ENV, bad)
        assert router.ollama_keep_alive() == "45m", bad
    monkeypatch.setenv(ENV, "٣")
    monkeypatch.setattr(router, "_CHAT_TIERS_PATH", tmp_path / "missing.json")
    assert router.ollama_keep_alive() == "20m"


def test_duration_forms_are_kept(monkeypatch, tmp_path) -> None:
    _plan(tmp_path, monkeypatch, "45m")
    for ok in ("500ms", "30s", "2h", "90"):
        monkeypatch.setenv(ENV, ok)
        assert router.ollama_keep_alive() == (90 if ok == "90" else ok)
