"""The load op warms the engine it just opened: the voice filter and one real encoder and decoder run."""

from __future__ import annotations

import pytest
import stt


class _Model:
    def __init__(self, fail: bool = False):
        self.calls: list[dict] = []
        self.fail = fail

    def transcribe(self, audio, **kwargs):
        if self.fail:
            raise RuntimeError("no kernel for this CPU")
        self.calls.append({"samples": len(audio), **kwargs})
        return iter([]), object()


def test_warm_runs_the_filter_once_and_the_model_once_with_the_filter_off():
    model = _Model()
    assert stt.warm_model(model) >= 0
    assert [c["vad_filter"] for c in model.calls] == [True, False]
    assert all(c["samples"] == 16000 and c["language"] == "en" and c["beam_size"] == 1 for c in model.calls)
    assert model.calls[1]["max_new_tokens"] == 8 and model.calls[1]["without_timestamps"] is True


def test_a_failed_warm_up_is_not_an_error():
    assert stt.warm_model(_Model(fail=True)) == -1


@pytest.fixture
def _opened(monkeypatch):
    model = _Model()
    state = {"loads": 0}

    def get_model(name, path=None):
        if state["loads"] == 0:
            state["loads"] = 1
            monkeypatch.setattr(stt, "_load_count", 1)
        return model

    monkeypatch.setattr(stt, "get_model", get_model)
    monkeypatch.setattr(stt, "_load_count", 0)
    return model


def test_the_load_op_warms_only_a_model_it_opened(_opened):
    first = stt.handle_request({"op": "load", "model": "small", "model_path": "x"})
    assert first["ok"] is True and first["warmMs"] >= 0 and len(_opened.calls) == 2
    again = stt.handle_request({"op": "load", "model": "small", "model_path": "x"})
    assert again["ok"] is True and again["warmMs"] == 0 and len(_opened.calls) == 2
