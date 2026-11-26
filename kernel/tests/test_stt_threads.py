"""The thread counts of the voice stack's last hard-coded sites all come from voice_budget."""

from __future__ import annotations

import re
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import stt  # noqa: E402
import voice_budget as vb  # noqa: E402
import voice_runtime  # noqa: E402

KERNEL = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    monkeypatch.delenv("FRIDAY_VOICE_THREADS", raising=False)
    monkeypatch.delenv("FRIDAY_STT_THREADS", raising=False)


@pytest.mark.parametrize("cores", (1, 2, 4, 8, 16))
def test_the_cpu_reader_takes_the_final_reader_budget(monkeypatch, cores):
    monkeypatch.setattr(vb, "cpu_count", lambda: cores)
    assert stt.cpu_threads() == vb.steady("asr_final", cores)


@pytest.mark.parametrize("cores", (1, 2, 4, 8, 16))
def test_the_speaker_takes_the_speaker_budget(monkeypatch, cores):
    monkeypatch.setattr(vb, "cpu_count", lambda: cores)
    assert voice_runtime._voice_threads() == vb.steady("tts", cores)


def test_four_cores_never_oversubscribe(monkeypatch):
    monkeypatch.setattr(vb, "cpu_count", lambda: 4)
    assert stt.cpu_threads() == 3 and voice_runtime._voice_threads() == 2


def test_the_stt_env_override_still_wins(monkeypatch):
    monkeypatch.setattr(vb, "cpu_count", lambda: 4)
    monkeypatch.setenv("FRIDAY_STT_THREADS", "6")
    assert stt.cpu_threads() == 6
    monkeypatch.setenv("FRIDAY_STT_THREADS", "0")
    assert stt.cpu_threads() == 3
    monkeypatch.setenv("FRIDAY_STT_THREADS", "x")
    assert stt.cpu_threads() == 3


def test_the_shared_voice_override_reaches_both_sites(monkeypatch):
    monkeypatch.setenv("FRIDAY_VOICE_THREADS", "asr_final=5,tts=1")
    assert stt.cpu_threads() == 5 and voice_runtime._voice_threads() == 1


def test_the_stt_override_beats_the_shared_override(monkeypatch):
    monkeypatch.setenv("FRIDAY_VOICE_THREADS", "asr_final=5")
    monkeypatch.setenv("FRIDAY_STT_THREADS", "2")
    assert stt.cpu_threads() == 2


def _function(path: str, name: str) -> str:
    text = (KERNEL / path).read_text(encoding="utf-8")
    match = re.search(rf"^def {name}\(.*?(?=^def |\Z)", text, re.S | re.M)
    assert match, name
    return match.group(0)


def test_no_site_keeps_a_core_formula():
    assert "cpu_count" not in _function("stt.py", "cpu_threads")
    assert "cpu_count" not in _function("voice_runtime.py", "_voice_threads")
    for path in ("hindi_punct.py", "tts_hindi_light.py", "transducer_loop.py"):
        assert "cpu_count" not in (KERNEL / path).read_text(encoding="utf-8"), path


def test_the_new_light_roles_share_the_budget_of_the_role_they_stand_in_for():
    for cores in (2, 4, 8):
        assert vb.steady("punct", cores) == vb.steady("asr_final", cores)
        assert vb.steady("tts_light", cores) == vb.steady("tts", cores)
    assert vb.session_settings("punct", None, 4)["allow_spinning"] == 0
    assert vb.threads("punct", "thinking", 4) == vb.threads("asr_final", "thinking", 4)


def test_the_shared_override_names_a_stand_in_role_or_its_base(monkeypatch):
    monkeypatch.setenv("FRIDAY_VOICE_THREADS", "tts=3")
    assert vb.steady("tts_light", 4) == 3
    monkeypatch.setenv("FRIDAY_VOICE_THREADS", "tts=3,tts_light=1")
    assert vb.steady("tts_light", 4) == 1 and vb.steady("tts", 4) == 3


def _fake_ort(monkeypatch, opened: list):
    class Options:
        def __init__(self):
            self.entries: dict[str, str] = {}
            self.intra_op_num_threads = 0
            self.inter_op_num_threads = 0

        def add_session_config_entry(self, key, value):
            self.entries[key] = value

    class Session:
        def __init__(self, path, sess_options=None, providers=None, *rest):
            options = sess_options
            assert options is not None
            opened.append((options.intra_op_num_threads, options.inter_op_num_threads, dict(options.entries)))

        def get_inputs(self):
            return [types.SimpleNamespace(name="x")]

    module = types.ModuleType("onnxruntime")
    module.SessionOptions = Options  # type: ignore[attr-defined]
    module.InferenceSession = Session  # type: ignore[attr-defined]
    module.GraphOptimizationLevel = types.SimpleNamespace(ORT_ENABLE_ALL=99)  # type: ignore[attr-defined]
    module.ExecutionMode = types.SimpleNamespace(ORT_SEQUENTIAL=1)  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "onnxruntime", module)


NO_SPIN = {"session.intra_op.allow_spinning": "0"}


def test_the_audio_models_open_one_thread_and_never_spin(monkeypatch, tmp_path):
    import denoise_onnx
    import vad_onnx
    import wake_features

    opened: list = []
    _fake_ort(monkeypatch, opened)
    monkeypatch.setattr(denoise_onnx, "_SESSIONS", {})
    monkeypatch.setattr(vad_onnx, "_SESSIONS", {})
    denoise_onnx._session(tmp_path / "d.onnx")
    vad_onnx._session(tmp_path / "v.onnx")
    wake_features.load_embedder(str(tmp_path / "w.onnx"))
    assert opened == [(1, 1, NO_SPIN)] * 3


@pytest.mark.parametrize("cores", (2, 4, 8))
def test_the_punctuation_model_opens_on_its_budget(monkeypatch, tmp_path, cores):
    import hindi_punct

    opened: list = []
    _fake_ort(monkeypatch, opened)
    monkeypatch.setattr(vb, "cpu_count", lambda: cores)
    sp = types.ModuleType("sentencepiece")
    sp.SentencePieceProcessor = lambda: types.SimpleNamespace(LoadFromSerializedProto=lambda data: None)  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "sentencepiece", sp)
    monkeypatch.setattr(hindi_punct, "read_config", lambda folder: ([], 8))
    (tmp_path / hindi_punct.SPM_FILE).write_bytes(b"x")
    hindi_punct._load_runtime(tmp_path)
    spin = str(vb.session_settings("punct", None, cores)["allow_spinning"])
    assert opened == [(vb.steady("punct", cores), 1, {"session.intra_op.allow_spinning": spin})]


@pytest.mark.parametrize("cores", (2, 4, 8))
def test_the_streaming_loop_default_follows_the_budget_and_opens_without_spinning(monkeypatch, tmp_path, cores):
    import transducer_loop

    opened: list = []
    _fake_ort(monkeypatch, opened)
    monkeypatch.setattr(vb, "cpu_count", lambda: cores)
    stream = transducer_loop.NemotronStream(lambda path, providers, threads: None)
    assert stream.threads == vb.steady("asr_stream", cores)
    transducer_loop.default_session_factory(str(tmp_path / "m.onnx"), ["CPUExecutionProvider"], 3)
    assert opened == [(3, 1, NO_SPIN)]
