"""The "auto" streaming ear on this PC: the self-bench (synthetic audio, 10 chunks of 320 ms, the p95 compute time per
chunk) a ``stream-warm`` with ``bench`` runs, the execution-provider choice (DirectML or a verified CUDA first, the CPU
last; no GPU leaves the CPU path exactly as before), faster-whisper's device choice, and the one word list the
renderer, Electron and the kernel share. Fake engines and a fake clock: no GPU, no network, no date."""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

import pytest

KERNEL = Path(__file__).resolve().parent.parent
REPO = KERNEL.parent
sys.path.insert(0, str(KERNEL))

import stream_ear  # noqa: E402
import stt  # noqa: E402
from fake_transducer import install_fake_engine  # noqa: E402
from stream_ear import (  # noqa: E402
    BENCH_CHUNK_MS,
    BENCH_CHUNKS,
    CPU_PROVIDER,
    CUDA_PROVIDER,
    DML_PROVIDER,
    StreamHost,
    bench_audio,
    choose_providers,
    p95,
    self_bench,
)


class TickClock:
    """A clock the fake engine moves: each feed costs the next number of milliseconds in ``costs``."""

    def __init__(self, costs: list[float]) -> None:
        self.now = 0.0
        self.costs = list(costs)

    def __call__(self) -> float:
        return self.now

    def spend(self) -> None:
        self.now += (self.costs.pop(0) if self.costs else 0.0) / 1000.0


class TimedEngine:
    name = stream_ear.ENGINE_NAME

    def __init__(self, clock: TickClock) -> None:
        self.clock = clock
        self.fed: list[int] = []
        self.resets = 0

    def feed(self, pcm: bytes) -> list[dict[str, Any]]:
        self.fed.append(len(pcm))
        self.clock.spend()
        return []

    def reset(self) -> None:
        self.resets += 1


# ---- the bench ----------------------------------------------------------------------------------------------------


def test_the_bench_audio_is_fixed_speech_like_pcm():
    first, again = bench_audio(), bench_audio()
    assert first == again  # the same bytes on every run
    assert len(first) == BENCH_CHUNKS and all(len(c) == 16000 * BENCH_CHUNK_MS // 1000 * 2 for c in first)
    import array

    samples = array.array("h")
    samples.frombytes(b"".join(first))
    if sys.byteorder == "big":
        samples.byteswap()
    peak = max(abs(s) for s in samples)
    assert 3000 < peak < 32767  # voiced, not silence and not clipped
    assert bench_audio(seed=8) != first


def test_p95_is_the_nearest_rank():
    assert p95([]) == 0.0
    assert p95([float(n) for n in range(1, 11)]) == 10.0
    assert p95([float(n) for n in range(1, 21)]) == 19.0


def test_the_bench_times_ten_chunks_after_one_untimed_priming_chunk():
    clock = TickClock([900.0] + [50.0] * 9 + [140.0])
    engine = TimedEngine(clock)
    result = self_bench(engine, clock=clock)
    assert len(engine.fed) == BENCH_CHUNKS + 1
    assert result["chunks"] == 10 and result["chunkMs"] == 320
    assert result["p95Ms"] == 140.0 and result["maxMs"] == 140.0
    assert engine.resets == 2  # reset before and after: no stream state survives


def test_the_bench_request_is_clamped():
    clock = TickClock([])
    engine = TimedEngine(clock)
    result = self_bench(engine, chunks=999, chunk_ms=5, clock=clock)
    assert result["chunks"] == 20 and result["chunkMs"] == 80


def test_a_failing_feed_still_resets_the_engine():
    class Broken(TimedEngine):
        def feed(self, pcm: bytes) -> list[dict[str, Any]]:
            raise RuntimeError("boom")

    engine = Broken(TickClock([]))
    with pytest.raises(RuntimeError):
        self_bench(engine)
    assert engine.resets == 2


@pytest.fixture
def worker(monkeypatch, tmp_path):
    monkeypatch.setattr(stt, "_model", None)
    monkeypatch.setattr(stt, "_model_name", None)
    monkeypatch.setattr(stt.hindi_ear, "_model", None)
    monkeypatch.setattr(stt.hindi_ear, "_timed", None)
    host = StreamHost()
    monkeypatch.setattr(stt.stream_ear, "HOST", host)
    model = install_fake_engine(monkeypatch, tmp_path)
    return host, model


def test_a_warm_with_bench_measures_the_loaded_ear(worker):
    host, _ = worker
    reply = stt.handle_request(
        {"op": "stream-warm", "streamEngine": "auto", "locale": "en-US", "bench": {"chunks": 10, "chunkMs": 320}}
    )
    assert reply["ok"] is True
    bench = reply["bench"]
    assert bench["chunks"] == 10 and bench["chunkMs"] == 320
    assert isinstance(bench["p95Ms"], float) and bench["p95Ms"] >= 0
    assert bench["providers"] == [CPU_PROVIDER]
    assert host.active is None  # no stream was opened
    again = stt.handle_request({"op": "stream-warm", "streamEngine": "auto", "bench": True})
    assert again["already"] is True and again["bench"]["chunks"] == BENCH_CHUNKS


def test_a_warm_without_bench_is_unchanged(worker):
    reply = stt.handle_request({"op": "stream-warm", "streamEngine": "auto", "locale": "en-US"})
    assert reply["ok"] is True and "bench" not in reply


def test_no_bench_while_a_stream_is_live(worker):
    host, _ = worker
    assert stt.handle_request({"op": "stream-open", "streamEngine": "auto", "locale": "en-US"})["ok"] is True
    reply = stt.handle_request({"op": "stream-warm", "streamEngine": "auto", "bench": True})
    assert "bench" not in reply
    assert host.active is not None


# ---- providers ----------------------------------------------------------------------------------------------------


def test_no_gpu_keeps_the_cpu_path_exactly():
    assert choose_providers(None, available=[CPU_PROVIDER], cuda_ok=False, windows=True) is None
    assert choose_providers(None, available=[], cuda_ok=True, windows=True) is None
    # A CUDA build of the runtime without the verified CUDA 12 libraries is no GPU.
    assert choose_providers(None, available=[CUDA_PROVIDER, CPU_PROVIDER], cuda_ok=False, windows=False) is None
    # DirectML exists only on Windows.
    assert choose_providers(None, available=[DML_PROVIDER, CPU_PROVIDER], cuda_ok=False, windows=False) is None


def test_a_gpu_goes_first_and_the_cpu_stays_last():
    dml = choose_providers(None, available=[DML_PROVIDER, CPU_PROVIDER], cuda_ok=False, windows=True)
    assert dml == [DML_PROVIDER, CPU_PROVIDER]
    cuda = choose_providers(None, available=[CUDA_PROVIDER, CPU_PROVIDER], cuda_ok=True, windows=False)
    assert cuda == [CUDA_PROVIDER, CPU_PROVIDER]
    both = choose_providers(None, available=[CUDA_PROVIDER, DML_PROVIDER, CPU_PROVIDER], cuda_ok=True, windows=True)
    assert both == [DML_PROVIDER, CUDA_PROVIDER, CPU_PROVIDER]


def test_a_callers_own_list_is_kept():
    assert choose_providers(["CPUExecutionProvider"], available=[DML_PROVIDER], cuda_ok=True, windows=True) == [
        CPU_PROVIDER
    ]


def test_the_host_reads_the_pc_once_and_hands_the_list_to_the_session():
    host = StreamHost()
    asked: list[int] = []
    host.windows = True
    host.cuda_ok = lambda: False

    def have() -> list[str]:
        asked.append(1)
        return [DML_PROVIDER, CPU_PROVIDER]

    host.available = have
    assert host.providers_for({}) == [DML_PROVIDER, CPU_PROVIDER]
    assert host.providers_for({"providers": None}) == [DML_PROVIDER, CPU_PROVIDER]
    assert host.providers_for({"providers": ["CPUExecutionProvider"]}) == [CPU_PROVIDER]
    assert len(asked) == 1


def test_a_cpu_only_host_passes_none_as_before():
    host = StreamHost()
    host.available = lambda: [CPU_PROVIDER]
    assert host.providers_for({}) is None


def test_a_gpu_that_cannot_open_the_graph_falls_back_to_the_cpu(monkeypatch, tmp_path):
    from transducer_loop import NemotronStream

    model = install_fake_engine(monkeypatch, tmp_path)
    model.refuse.add(DML_PROVIDER)
    spec = stream_ear._REGISTRY[stream_ear.ENGINE_NAME]
    tried: list[list[str]] = []

    def factory(path: str, providers: list[str], threads: int) -> Any:
        tried.append(list(providers))
        return model.factory(path, providers, threads)

    gpu_spec = stream_ear.EngineSpec(
        spec.name,
        spec.folder,
        spec.files,
        lambda: stream_ear.TransducerEngine(
            NemotronStream(factory, threads=1, available=lambda: [DML_PROVIDER, CPU_PROVIDER])
        ),
        aliases=spec.aliases,
        languages=spec.languages,
        priority=spec.priority,
    )
    monkeypatch.setattr(stream_ear, "_REGISTRY", {spec.name: gpu_spec})
    host = StreamHost()
    host.windows = True
    host.available = lambda: [DML_PROVIDER, CPU_PROVIDER]
    reply = host.warm({"streamEngine": "auto", "locale": "en-US", "bench": True})
    assert reply["ok"] is True
    assert tried[0] == [DML_PROVIDER, CPU_PROVIDER]  # the GPU was asked first
    assert reply["bench"]["providers"] == [CPU_PROVIDER]  # and the session runs on the CPU
    assert host.status()["providers"] == [CPU_PROVIDER]


def test_the_worker_wires_the_cuda_verdict():
    source = (KERNEL / "stt.py").read_text(encoding="utf-8")
    assert "stream_ear.HOST.cuda_ok = cuda_runtime_ready" in source


# ---- faster-whisper -----------------------------------------------------------------------------------------------


def test_faster_whisper_uses_cuda_float16_only_when_verified():
    assert stt.choose_stt_device(True)["device"] == "cuda"
    assert stt.choose_stt_device(True)["compute_type"] == "float16"
    cpu = stt.choose_stt_device(False)
    assert cpu["device"] == "cpu" and cpu["compute_type"] == "int8"


def test_no_gpu_flag_means_no_cuda(monkeypatch):
    monkeypatch.delenv("FRIDAY_GPU", raising=False)
    monkeypatch.delenv("FRIDAY_STT_CUDA", raising=False)
    assert stt.cuda_runtime_ready() is False
    assert stt.model_load_kwargs("small")["device"] == "cpu"
    assert stt.model_load_kwargs("small")["compute_type"] == "int8"


# ---- one word list ------------------------------------------------------------------------------------------------


def _ts_list(text: str, name: str) -> list[str]:
    found = re.search(rf"{name} = \[([^\]]*)\]", text)
    assert found, name
    return re.findall(r'"([^"]+)"', found.group(1))


def test_renderer_electron_and_kernel_share_the_words():
    picks = _ts_list((REPO / "src/lib/friday/preferences.ts").read_text(encoding="utf-8"), "STREAM_ENGINE_PICKS")
    engines = _ts_list((REPO / "electron/stt.cjs").read_text(encoding="utf-8"), "STREAM_ENGINES")
    assert picks == engines == list(stream_ear.SETTING_WORDS)
    spec = stream_ear.EngineSpec(stream_ear.ENGINE_NAME, "x", {}, stream_ear.TransducerEngine, aliases=("nemotron",))
    for word in stream_ear.SETTING_WORDS:
        if word in stream_ear.OFF_VALUES:
            assert stream_ear.choose_tier(word).reason == "off"
        else:
            assert stream_ear._wants(word, spec), word


def test_the_bench_numbers_match_the_electron_rule():
    rule = (REPO / "electron/voice-weights.cjs").read_text(encoding="utf-8")
    assert f"benchChunks: {BENCH_CHUNKS}," in rule
    assert f"chunkMs: {BENCH_CHUNK_MS}," in rule
