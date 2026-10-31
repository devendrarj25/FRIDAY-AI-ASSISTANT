"""The run trace is off by default, local, and cannot carry content."""

import json
from pathlib import Path

import pytest
import run_trace


@pytest.fixture()
def folder(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("FRIDAY_RUN_TRACE_DIR", str(tmp_path))
    return tmp_path


def test_off_by_default_writes_nothing(folder: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FRIDAY_RUN_TRACE", raising=False)
    assert run_trace.record("run-1", "chat.start") is False
    assert not (folder / "run-trace.jsonl").exists()


def test_records_numbers_and_ids_but_drops_content(folder: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FRIDAY_RUN_TRACE", "1")
    assert run_trace.record(
        "run-1",
        "chat.done",
        model="openai/gpt-x",
        ms=120,
        prompt="my secret plan",
        text="answer body",
        tools=["fs.read", "my password is hunter2 !!"],
        api_key="sk-123",
    )
    row = json.loads((folder / "run-trace.jsonl").read_text(encoding="utf-8").strip())
    assert row["runId"] == "run-1" and row["event"] == "chat.done" and row["ms"] == 120
    assert row["model"] == "openai/gpt-x"
    assert row["tools"] == ["fs.read"]
    assert not {"prompt", "text", "api_key"} & set(row)
    assert "hunter2" not in json.dumps(row) and "sk-123" not in json.dumps(row)


def test_a_malformed_run_id_is_not_logged(folder: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FRIDAY_RUN_TRACE", "1")
    for bad in (None, "", "a b", "../x", "x" * 65, 5):
        assert run_trace.record(bad, "chat.start") is False
    assert not (folder / "run-trace.jsonl").exists()


def test_text_that_looks_like_content_is_redacted(folder: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FRIDAY_RUN_TRACE", "1")
    run_trace.record("run-2", "chat.error", model="has spaces and words")
    row = json.loads((folder / "run-trace.jsonl").read_text(encoding="utf-8").strip())
    assert row["model"] == "redacted"


def test_an_unwritable_folder_never_raises(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    blocker = tmp_path / "file"
    blocker.write_text("x", encoding="utf-8")
    monkeypatch.setenv("FRIDAY_RUN_TRACE", "1")
    monkeypatch.setenv("FRIDAY_RUN_TRACE_DIR", str(blocker / "sub"))
    assert run_trace.record("run-3", "chat.start") is False
