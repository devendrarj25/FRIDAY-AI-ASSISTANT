"""One thread budget for the voice stack: the roles that run together never ask for more threads than the cores."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import voice_budget as vb  # noqa: E402

CORES = (1, 2, 3, 4, 6, 8, 12, 16, 32)


@pytest.fixture(autouse=True)
def _no_override(monkeypatch):
    monkeypatch.delenv("FRIDAY_VOICE_THREADS", raising=False)


@pytest.mark.parametrize("cores", CORES)
@pytest.mark.parametrize("phase", vb.PHASES)
def test_concurrent_roles_never_exceed_the_cores(cores, phase):
    groups = vb.plan(phase, cores)
    assert sum(g.threads for g in groups) <= cores
    assert all(g.threads >= 1 for g in groups)
    for role in vb.ROLES:
        assert vb.threads(role, phase, cores) >= 1


@pytest.mark.parametrize("cores", CORES)
@pytest.mark.parametrize("phase", vb.PHASES)
def test_every_active_role_is_in_exactly_one_group_and_gets_its_groups_threads(cores, phase):
    seen: dict[str, int] = {}
    for group in vb.plan(phase, cores):
        for role in group.roles:
            assert role not in seen
            seen[role] = group.threads
    for role, count in seen.items():
        assert vb.threads(role, phase, cores) == count


def test_four_cores_give_speech_two_threads_and_the_light_roles_one_shared():
    assert vb.threads("tts", "speaking", 4) >= 2
    assert vb.threads("asr_stream", "speaking", 4) >= 1
    audio = [g for g in vb.plan("speaking", 4) if "vad" in g.roles][0]
    assert audio.threads == 1 and "turn" in audio.roles
    assert sum(g.threads for g in vb.plan("speaking", 4)) == 4


def test_the_listener_and_the_final_reader_take_the_cores_the_speaker_leaves():
    assert vb.threads("asr_stream", "listening", 4) == 3
    assert vb.threads("asr_final", "thinking", 4) == 3


def test_two_cores_give_every_role_one_thread_and_one_core_shares_everything():
    for phase in vb.PHASES:
        for role in vb.ROLES:
            assert vb.threads(role, phase, 2) == 1
            assert vb.threads(role, phase, 1) == 1
    assert len(vb.plan("speaking", 1)) == 1


def test_more_cores_never_give_a_role_fewer_threads():
    for phase in vb.PHASES:
        for role in vb.ROLES:
            counts = [vb.threads(role, phase, c) for c in CORES]
            assert counts == sorted(counts)


def test_light_roles_always_one_thread_and_heavy_roles_are_capped():
    for cores in CORES:
        for phase in vb.PHASES:
            for role in ("vad", "wake", "denoise", "turn"):
                assert vb.threads(role, phase, cores) == 1
    assert vb.threads("tts", "speaking", 64) == 4
    assert vb.threads("asr_final", "thinking", 64) == 6


def test_steady_is_the_budget_of_the_phase_the_role_works_in():
    assert vb.steady("asr_final", 4) == vb.threads("asr_final", "thinking", 4)
    assert vb.steady("asr_stream", 4) == vb.threads("asr_stream", "listening", 4)
    assert vb.steady("tts", 4) == vb.threads("tts", "speaking", 4)
    assert vb.steady("vad", 4) == 1


def test_an_injected_cpu_count_is_used_when_cores_is_not_given(monkeypatch):
    monkeypatch.setattr(vb, "cpu_count", lambda: 8)
    assert vb.threads("tts", "speaking") == vb.threads("tts", "speaking", 8)
    monkeypatch.setattr(vb, "cpu_count", lambda: 2)
    assert vb.steady("asr_final") == 1
    monkeypatch.setattr(vb, "cpu_count", lambda: None)
    assert vb.steady("asr_final") >= 1


def test_the_same_inputs_give_the_same_answer():
    assert [vb.threads(r, p, 6) for r in vb.ROLES for p in vb.PHASES] == [
        vb.threads(r, p, 6) for r in vb.ROLES for p in vb.PHASES
    ]


def test_unknown_names_are_refused():
    with pytest.raises(ValueError):
        vb.threads("nope", "idle", 4)
    with pytest.raises(ValueError):
        vb.threads("tts", "nope", 4)


def test_the_env_override_sets_every_role_or_named_roles(monkeypatch):
    monkeypatch.setenv("FRIDAY_VOICE_THREADS", "3")
    assert vb.threads("tts", "speaking", 16) == 3
    assert vb.steady("asr_final", 16) == 3
    monkeypatch.setenv("FRIDAY_VOICE_THREADS", "tts=2, asr_final=5")
    assert vb.threads("tts", "speaking", 16) == 2
    assert vb.steady("asr_final", 16) == 5
    assert vb.threads("vad", "idle", 16) == 1
    for junk in ("", "0", "-2", "x", "tts=abc", "nope=2", "999"):
        monkeypatch.setenv("FRIDAY_VOICE_THREADS", junk)
        assert 1 <= vb.threads("tts", "speaking", 4) <= 32


def test_session_settings_are_explicit_and_background_roles_do_not_spin():
    for role in ("vad", "wake", "denoise", "turn", "asr_stream"):
        got = vb.session_settings(role, None, 4)
        assert got == {"intra_op": vb.steady(role, 4), "inter_op": 1, "allow_spinning": 0}
    assert vb.session_settings("tts", "speaking", 4)["allow_spinning"] == 0
    assert vb.session_settings("tts", "speaking", 16)["allow_spinning"] == 1
    assert vb.session_settings("asr_final", "thinking", 4)["inter_op"] == 1


def test_ort_session_options_apply_the_settings_to_a_real_options_object():
    ort = pytest.importorskip("onnxruntime")
    options = vb.ort_session_options("turn", None, 4)
    assert isinstance(options, ort.SessionOptions)
    assert options.intra_op_num_threads == 1
    assert options.inter_op_num_threads == 1
    assert options.get_session_config_entry("session.intra_op.allow_spinning") == "0"
    wide = vb.ort_session_options("asr_final", "thinking", 4)
    assert wide.intra_op_num_threads == 3


def test_a_missing_onnxruntime_gives_no_options_instead_of_a_crash(monkeypatch):
    monkeypatch.setitem(sys.modules, "onnxruntime", None)
    assert vb.ort_session_options("turn", None, 4) is None
