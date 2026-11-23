"""STT worker cache: idle unload, memory pressure, load timing and fallback counters.

Every test injects the clock, the memory reading and the engine; nothing depends on this machine.
"""

from __future__ import annotations

import ctypes
import threading

import hindi_ear
import pytest
import stt

GB = 1024


class _Clock:
    def __init__(self, start: float = 1_000.0):
        self.t = start

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


class _Engine:
    """A fake faster-whisper class: opening it takes `load_s` on the fake clock."""

    def __init__(self, clock: _Clock, load_s: float = 1.5, opened_as: str | None = None):
        self.clock = clock
        self.load_s = load_s
        self.opened_as = opened_as
        self.opened: list[str] = []
        self.resident_when_opened: list[object] = []


@pytest.fixture
def clock(monkeypatch):
    fake = _Clock()
    monkeypatch.setattr(stt, "_now", fake)
    return fake


@pytest.fixture
def worker(monkeypatch, clock):
    """A clean cache and a fake engine."""
    monkeypatch.setattr(stt, "_model", None)
    monkeypatch.setattr(stt, "_model_name", None)
    monkeypatch.setattr(stt, "_load_count", 0)
    monkeypatch.setattr(stt, "_last_used", None)
    monkeypatch.setattr(stt, "_idle_limit_s", stt.IDLE_UNLOAD_S)
    monkeypatch.setattr(stt, "_load_ms", {})
    monkeypatch.setattr(stt, "_fallbacks", {})
    monkeypatch.setattr(stt, "_unloads", 0)
    monkeypatch.setattr(hindi_ear, "_model", None)
    monkeypatch.setattr(hindi_ear, "_timed", None)
    monkeypatch.setattr(hindi_ear, "_model_dir", "")
    monkeypatch.delenv("FRIDAY_STT_TIER", raising=False)
    engine = _Engine(clock)

    def kwargs(name, model_path=None):
        return {
            "target": (model_path or "").strip() or name,
            "device": "cpu",
            "compute_type": "int8",
            "reason": "test",
            "download_root": "",
            "local_files_only": True,
            "cpu_threads": 4,
        }

    def open_whisper(_cls, wanted, spec):
        engine.opened.append(wanted)
        engine.resident_when_opened.append(stt._model)
        clock.advance(engine.load_s)
        return object(), engine.opened_as or spec["device"]

    monkeypatch.setattr(stt, "_import_whisper", lambda: object)
    monkeypatch.setattr(stt, "model_load_kwargs", kwargs)
    monkeypatch.setattr(stt, "open_whisper", open_whisper)
    monkeypatch.setattr(stt, "memory_pressure", lambda reader=None: _pressure("ok", 10 * GB, 16 * GB))
    return engine


def _pair(reading: tuple[float, float] | None) -> tuple[float, float]:
    assert reading is not None
    return reading


def _pressure(level: str, available_mb: int, total_mb: int) -> dict:
    return {"level": level, "availableMb": available_mb, "totalMb": total_mb, "known": True}


# --- reading the machine ------------------------------------------------------


def test_meminfo_gives_available_and_total_in_megabytes():
    text = "MemTotal:       16384000 kB\nMemFree:  100 kB\nMemAvailable:    8192000 kB\nBuffers: 5 kB\n"
    avail, total = _pair(stt.parse_meminfo(text))
    assert round(total) == 16000 and round(avail) == 8000


def test_meminfo_without_memavailable_adds_free_buffers_and_cache():
    text = "MemTotal: 2048000 kB\nMemFree: 1024000 kB\nBuffers: 512000 kB\nCached: 512000 kB\n"
    avail, total = _pair(stt.parse_meminfo(text))
    assert round(avail) == 2000 and round(total) == 2000


@pytest.mark.parametrize(
    "text", ["", "garbage", "MemTotal: lots kB\n", "MemAvailable: 5 kB\n", "MemTotal: 0 kB\nMemAvailable: 0 kB"]
)
def test_meminfo_that_cannot_be_read_is_none(text):
    assert stt.parse_meminfo(text) is None


def test_linux_reader_reads_the_file_it_is_given(tmp_path):
    path = tmp_path / "meminfo"
    path.write_text("MemTotal: 8192000 kB\nMemAvailable: 4096000 kB\n", encoding="utf-8")
    avail, total = _pair(stt._linux_memory_mb(str(path)))
    assert round(avail) == 4000 and round(total) == 8000
    assert stt._linux_memory_mb(str(tmp_path / "missing")) is None


def test_the_windows_status_structure_has_the_size_the_api_checks():
    assert ctypes.sizeof(stt.MemoryStatusEx) == 64


def test_the_platform_picks_the_reader(monkeypatch):
    monkeypatch.setattr(stt, "_windows_memory_mb", lambda: (111.0, 222.0))
    monkeypatch.setattr(stt, "_linux_memory_mb", lambda path="/proc/meminfo": (333.0, 444.0))
    monkeypatch.setattr(stt.sys, "platform", "win32")
    assert stt.read_memory_mb() == (111.0, 222.0)
    monkeypatch.setattr(stt.sys, "platform", "linux")
    assert stt.read_memory_mb() == (333.0, 444.0)
    monkeypatch.setattr(stt.sys, "platform", "darwin")
    assert stt.read_memory_mb() is None


# --- pressure levels ----------------------------------------------------------


@pytest.mark.parametrize(
    ("available", "total", "level"),
    [
        (9 * GB, 16 * GB, "ok"),
        (3 * GB, 16 * GB, "ok"),
        (2 * GB, 16 * GB, "high"),
        (1500, 16 * GB, "high"),
        (900, 16 * GB, "critical"),
        (100, 16 * GB, "critical"),
        (20 * GB, 64 * GB, "ok"),
        (4 * GB, 64 * GB, "ok"),
        (2500, 64 * GB, "high"),
        (3 * GB, 64 * GB, "ok"),
    ],
)
def test_pressure_level_follows_the_free_memory(available, total, level):
    got = stt.memory_pressure(lambda: (available, total))
    assert got["level"] == level
    assert got["availableMb"] == int(available) and got["totalMb"] == int(total) and got["known"] is True


@pytest.mark.parametrize("reader", [lambda: None, lambda: (_ for _ in ()).throw(OSError("no counters"))])
def test_a_machine_that_cannot_be_read_is_not_under_pressure(reader):
    got = stt.memory_pressure(reader)
    assert got == {"level": "ok", "availableMb": None, "totalMb": None, "known": False}


# --- model size and the 16 GB rule ------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "heavy"),
    [
        ("tiny", False),
        ("base", False),
        ("small", False),
        ("medium", True),
        ("large-v3", True),
        ("large-v3-turbo", True),
        ("turbo", True),
        ("distil-large-v3", True),
        ("C:\\data\\models\\whisper-small", False),
        ("C:\\Users\\turbo\\models\\whisper-base", False),
        ("/models/whisper-medium", True),
        ("hinglish-ear", False),
    ],
)
def test_heavy_models_are_medium_and_up(name, heavy):
    assert stt.is_heavy_model(name) is heavy


def test_model_sizes_are_ranked_and_an_unknown_name_has_no_rank():
    ranks = [stt.model_rank(n) or 0 for n in ("tiny", "base", "small", "medium", "large-v3-turbo", "large-v3")]
    assert ranks == sorted(ranks) and len(set(ranks)) == len(ranks) and ranks[0] > 0
    assert stt.model_rank("hinglish-ear") is None


# --- load timing and idle unload ----------------------------------------------


def test_a_load_records_how_long_it_took(worker):
    stt.get_model("small")
    assert stt._load_ms == {"small": 1500}
    status = stt.cache_status()
    assert status["loadMs"] == {"small": 1500}
    assert [row["name"] for row in status["loadedModels"]] == ["small"]
    assert status["loadedModels"][0]["loadMs"] == 1500


def test_status_reports_idle_seconds_and_last_use(worker, clock):
    assert stt.cache_status()["idleSec"] is None and stt.cache_status()["lastUsed"] is None
    stt.get_model("small")
    used = clock.t
    clock.advance(42)
    status = stt.cache_status()
    assert status["lastUsed"] == used
    assert status["idleSec"] == 42
    assert status["idleUnloadSec"] == 600


def test_a_reuse_of_the_open_model_refreshes_the_idle_clock(worker, clock):
    stt.get_model("small")
    clock.advance(500)
    stt.get_model("small")
    clock.advance(500)
    assert stt.unload_idle() == []
    assert stt._model is not None and stt._load_count == 1


def test_the_model_unloads_after_ten_idle_minutes_and_loads_again_on_demand(worker, clock):
    stt.get_model("small")
    clock.advance(599)
    assert stt.unload_idle() == []
    clock.advance(1)
    assert stt.unload_idle() == ["small"]
    assert stt._model is None and stt._model_name is None
    status = stt.cache_status()
    assert status["loadedModels"] == [] and status["idleSec"] is None
    assert status["unloadCount"] == 1
    assert status["loadMs"] == {"small": 1500}
    stt.get_model("small")
    assert stt._load_count == 2


def test_the_hindi_ear_unloads_with_the_rest(worker, clock, monkeypatch):
    monkeypatch.setattr(hindi_ear, "_model", object())
    monkeypatch.setattr(hindi_ear, "_timed", (object(), object()))
    monkeypatch.setattr(hindi_ear, "_model_dir", "C:\\ears\\hi")
    stt.touch()
    names = [row["name"] for row in stt.cache_status()["loadedModels"]]
    assert names == [stt.HINDI_EAR_NAME]
    clock.advance(601)
    assert stt.unload_idle() == [stt.HINDI_EAR_NAME]
    assert hindi_ear._model is None and hindi_ear._timed is None and hindi_ear._model_dir == ""


def test_nothing_loaded_means_nothing_to_unload_and_no_idle_clock(worker, clock):
    stt.touch()
    clock.advance(10_000)
    assert stt.unload_idle() == []
    assert stt.cache_status()["idleSec"] is None


def test_a_request_can_set_the_idle_time_within_limits(worker):
    stt.handle_request({"op": "ping-config", "idleUnloadSec": 30})
    assert stt._idle_limit_s == 30
    stt.handle_request({"op": "ping-config", "idleUnloadSec": 0.01})
    assert stt._idle_limit_s == stt.IDLE_UNLOAD_MIN_S
    stt.handle_request({"op": "ping-config", "idleUnloadSec": 10**9})
    assert stt._idle_limit_s == stt.IDLE_UNLOAD_MAX_S
    stt.handle_request({"op": "ping-config", "idleUnloadSec": 120})
    for junk in ("soon", None, True, [5], float("nan"), float("inf"), -5):
        stt.handle_request({"op": "ping-config", "idleUnloadSec": junk})
        assert stt._idle_limit_s == 120, junk


def test_a_number_too_big_for_a_float_does_not_raise(worker):
    stt.handle_request({"op": "ping-config", "idleUnloadSec": 120})
    stt.configure_idle({"idleUnloadSec": -(10**400)})
    assert stt._idle_limit_s == 120
    stt.configure_idle({"idleUnloadSec": 10**400})
    assert stt._idle_limit_s == stt.IDLE_UNLOAD_MAX_S
    stt.configure_idle({"idleUnloadSec": 120})
    reply = stt.handle_request({"op": "ping-config", "idle_unload_sec": 10**400})
    assert reply is not None and stt._idle_limit_s == stt.IDLE_UNLOAD_MAX_S


def test_zero_turns_the_idle_unload_off(worker, clock):
    stt.handle_request({"op": "ping-config", "idleUnloadSec": 0})
    stt.get_model("small")
    clock.advance(10**6)
    assert stt.unload_idle() == []
    assert stt._model is not None
    assert stt.cache_status()["idleUnloadSec"] == 0


def test_a_status_question_does_not_count_as_use(worker, clock, monkeypatch):
    monkeypatch.setattr(stt, "status_payload", lambda: {"ok": True, **stt.cache_status()})
    stt.get_model("small")
    used = stt._last_used
    clock.advance(300)
    reply = stt.handle_request({"op": "status"})
    assert stt._last_used == used
    assert reply["idleSec"] == 300


def test_a_load_request_counts_as_use_and_a_late_one_reloads(worker, clock, monkeypatch):
    monkeypatch.setattr(stt, "warm_model", lambda _m: 0)
    first = stt.handle_request({"op": "load", "model": "small"})
    assert first["ok"] and first["loadMs"] == 1500 and first["loadCount"] == 1
    clock.advance(700)
    second = stt.handle_request({"op": "load", "model": "small"})
    assert second["ok"] and second["loadCount"] == 2
    assert stt._last_used == clock.t


def test_the_watch_tick_unloads_under_the_lock_and_the_thread_stops(worker, clock):
    stt.get_model("small")
    clock.advance(601)
    stop = threading.Event()
    thread = stt.start_idle_watch(interval_s=0.01, stop=stop)
    try:
        assert _wait(lambda: stt._model is None)
    finally:
        stop.set()
        thread.join(timeout=2)
    assert not thread.is_alive()
    assert stt._unloads == 1


def test_one_failed_tick_does_not_end_the_idle_watch(worker, clock, monkeypatch):
    stt.get_model("small")
    clock.advance(601)
    calls = {"n": 0}
    real = stt.unload_idle

    def flaky():
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("a model refused to close")
        return real()

    monkeypatch.setattr(stt, "unload_idle", flaky)
    stop = threading.Event()
    thread = stt.start_idle_watch(interval_s=0.01, stop=stop)
    try:
        assert _wait(lambda: stt._model is None)
        assert thread.is_alive()
    finally:
        stop.set()
        thread.join(timeout=2)
    assert calls["n"] >= 2
    assert stt._unloads == 1


def _wait(check, seconds: float = 3.0) -> bool:
    done = threading.Event()
    deadline_hits = int(seconds / 0.01)
    for _ in range(deadline_hits):
        if check():
            return True
        done.wait(0.01)
    return check()


# --- memory pressure and the loader -------------------------------------------


def _under(monkeypatch, level: str, total_gb: int = 16, available_mb: int = 1200):
    monkeypatch.setattr(stt, "memory_pressure", lambda reader=None: _pressure(level, available_mb, total_gb * GB))


def test_under_high_pressure_a_larger_model_is_not_loaded_the_resident_one_answers(worker, monkeypatch):
    stt.get_model("small")
    _under(monkeypatch, "high")
    resident = stt._model
    assert stt.get_model("medium") is resident
    assert stt._model_name == "small" and stt._load_count == 1 and worker.opened == ["small"]
    assert stt.cache_status()["fallbacks"]["byKind"] == {"low-memory-resident": 1}


def test_under_high_pressure_a_smaller_model_replaces_the_idle_one_after_evicting_it(worker, monkeypatch):
    stt.get_model("small")
    _under(monkeypatch, "high")
    stt.get_model("base")
    assert stt._model_name == "base"
    assert worker.resident_when_opened[-1] is None, "the old model must be gone before the new one opens"


def test_with_room_the_old_model_stays_until_the_new_one_is_open(worker):
    stt.get_model("small")
    first = stt._model
    stt.get_model("medium")
    assert worker.resident_when_opened[-1] is first
    assert stt._model_name == "medium"


def test_the_same_model_under_pressure_is_just_reused(worker, monkeypatch):
    stt.get_model("small")
    _under(monkeypatch, "critical", available_mb=300)
    resident = stt._model
    assert stt.get_model("small") is resident and stt._load_count == 1
    assert stt.cache_status()["fallbacks"]["total"] == 0


@pytest.mark.parametrize("name", ["medium", "large-v3", "large-v3-turbo", "turbo"])
@pytest.mark.parametrize("level", ["high", "critical"])
def test_an_automatic_heavy_load_on_16_gb_under_pressure_is_refused(worker, monkeypatch, name, level):
    _under(monkeypatch, level)
    with pytest.raises(stt.SttFault) as caught:
        stt.get_model(name, auto=True)
    assert caught.value.kind == "low-memory"
    assert "low-memory" in str(caught.value) and name in str(caught.value)
    assert stt._model is None and worker.opened == []
    assert stt.cache_status()["fallbacks"]["byKind"] == {"low-memory-refused": 1}


def test_the_refusal_reaches_the_reply_as_its_own_class(worker, monkeypatch):
    fault = stt.classify_stt_exception(stt.SttFault("low-memory", "low-memory: medium needs more free memory"))
    assert fault.kind == "low-memory" and "low-memory" in stt.STT_CLASSES


def test_an_automatic_heavy_load_is_fine_when_memory_is_free(worker):
    stt.get_model("medium", auto=True)
    assert stt._model_name == "medium"


def test_a_big_machine_may_load_heavy_models_even_when_busy(worker, monkeypatch):
    _under(monkeypatch, "high", total_gb=64, available_mb=3 * GB)
    stt.get_model("large-v3", auto=True)
    assert stt._model_name == "large-v3"


def test_the_owner_choice_is_not_refused_when_nothing_is_open(worker, monkeypatch):
    _under(monkeypatch, "critical", available_mb=300)
    stt.get_model("medium", auto=False)
    assert stt._model_name == "medium"


def test_an_unreadable_machine_never_blocks_a_load(worker, monkeypatch):
    monkeypatch.setattr(
        stt,
        "memory_pressure",
        lambda reader=None: {"level": "ok", "availableMb": None, "totalMb": None, "known": False},
    )
    stt.get_model("large-v3", auto=True)
    assert stt._model_name == "large-v3"


def test_auto_is_what_the_tier_setting_picked_not_what_the_owner_locked(monkeypatch):
    monkeypatch.setenv("FRIDAY_STT_TIER", "auto")
    assert stt.is_auto_pick("") is True and stt.is_auto_pick("auto") is True
    assert stt.is_auto_pick("medium") is False
    monkeypatch.delenv("FRIDAY_STT_TIER")
    assert stt.is_auto_pick("") is False


# --- fallback counters --------------------------------------------------------


def test_a_cuda_load_that_fell_back_to_the_cpu_is_counted(worker, monkeypatch):
    monkeypatch.setattr(
        stt,
        "model_load_kwargs",
        lambda name, path=None: {
            "target": name,
            "device": "cuda",
            "compute_type": "float16",
            "reason": "gpu",
            "download_root": "",
            "local_files_only": True,
            "cpu_threads": 4,
        },
    )
    worker.opened_as = "cpu"
    stt.get_model("small")
    assert stt.cache_status()["fallbacks"] == {"total": 1, "byKind": {"cuda-to-cpu": 1}}
    assert stt._device_name == "cpu"


def test_the_counter_starts_empty_and_counts_each_kind(worker):
    assert stt.cache_status()["fallbacks"] == {"total": 0, "byKind": {}}
    stt.note_fallback("ear-to-generic")
    stt.note_fallback("ear-to-generic")
    stt.note_fallback("model-to-windows-speech")
    assert stt.cache_status()["fallbacks"] == {
        "total": 3,
        "byKind": {"ear-to-generic": 2, "model-to-windows-speech": 1},
    }


def test_status_carries_the_memory_reading(worker):
    memory = stt.cache_status()["memory"]
    assert memory["level"] == "ok" and memory["totalMb"] == 16 * GB and memory["availableMb"] == 10 * GB
