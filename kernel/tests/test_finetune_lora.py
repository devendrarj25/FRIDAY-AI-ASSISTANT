"""The adapter trainer's guards: it says why it cannot train instead of crashing, and keeps progress machine-readable.

The training itself needs torch, a base model and time, so it is not run here: the libraries are replaced by empty
stand-ins to reach the checks that come before any model is loaded.
"""

import json
import sys
import types
from pathlib import Path

import finetune_lora
import pytest


def events(capsys: pytest.CaptureFixture[str]) -> list[dict]:
    return [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.strip()]


def run(monkeypatch: pytest.MonkeyPatch, job: dict | None, tmp_path: Path) -> int:
    config = tmp_path / "job.json"
    if job is not None:
        config.write_text(json.dumps(job), encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["finetune_lora.py", "--config", str(config)])
    with pytest.raises(SystemExit) as stop:
        finetune_lora.main()
    return int(stop.value.code or 0)


def fake_libraries(monkeypatch: pytest.MonkeyPatch) -> None:
    for name, attrs in {
        "torch": {},
        "datasets": {"Dataset": object},
        "peft": {"LoraConfig": object, "get_peft_model": object, "prepare_model_for_kbit_training": object},
        "transformers": {
            "AutoModelForCausalLM": object,
            "AutoTokenizer": object,
            "DataCollatorForLanguageModeling": object,
            "Trainer": object,
            "TrainerCallback": object,
            "TrainingArguments": object,
        },
    }.items():
        module = types.ModuleType(name)
        for key, value in attrs.items():
            setattr(module, key, value)
        monkeypatch.setitem(sys.modules, name, module)


def test_load_dataset_keeps_only_complete_rows(tmp_path: Path) -> None:
    path = tmp_path / "d.jsonl"
    path.write_text(
        '{"prompt": "a", "response": "b"}\nnot json\n\n{"prompt": "", "response": "x"}\n{"prompt": "c"}\n',
        encoding="utf-8",
    )
    assert finetune_lora.load_dataset(str(path)) == [{"prompt": "a", "response": "b"}]


def test_an_unreadable_job_fails_with_a_message(monkeypatch, capsys, tmp_path) -> None:
    assert run(monkeypatch, None, tmp_path) == 1
    last = events(capsys)[-1]
    assert last["stage"] == "failed" and "training job" in last["error"]


def test_a_job_missing_its_paths_fails(monkeypatch, capsys, tmp_path) -> None:
    assert run(monkeypatch, {"base": "x"}, tmp_path) == 1
    assert "missing base / dataset / output" in events(capsys)[-1]["error"]


def test_missing_libraries_say_how_to_install(monkeypatch, capsys, tmp_path) -> None:
    for name in ("torch", "datasets", "peft", "transformers"):
        monkeypatch.setitem(sys.modules, name, None)  # an import of None raises ImportError
    job = {"base": "b", "dataset": str(tmp_path / "d.jsonl"), "output": str(tmp_path / "out")}
    assert run(monkeypatch, job, tmp_path) == 1
    out = events(capsys)
    assert out[0]["stage"] == "preparing"
    assert "Install Manager" in out[-1]["error"]


def test_too_few_examples_stop_before_any_model_is_loaded(monkeypatch, capsys, tmp_path) -> None:
    fake_libraries(monkeypatch)
    data = tmp_path / "d.jsonl"
    data.write_text("\n".join(json.dumps({"prompt": f"p{i}", "response": f"r{i}"}) for i in range(7)), encoding="utf-8")
    job = {"base": "b", "dataset": str(data), "output": str(tmp_path / "out")}
    assert run(monkeypatch, job, tmp_path) == 1
    last = events(capsys)[-1]
    assert last["stage"] == "failed" and "Only 7 verified example" in last["error"]
    assert not (tmp_path / "out").exists()
