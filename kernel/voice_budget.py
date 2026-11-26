"""One thread budget for the voice stack: the roles that run together never ask for more threads than the PC has.

Each model used to pick its own thread count (about fifteen threads on four cores), and under load the speaker was five
times slower and the Hindi reader four times. Here every role asks one pure function.

Roles: ``asr_final`` (the final reader of a turn), ``asr_stream`` (the live reader), ``tts`` (FRIDAY Voice) and the
light roles ``turn`` (Smart Turn), ``vad``, ``wake`` and ``denoise``. ``punct`` (the Hindi punctuation model) runs
right after the final reader and ``tts_light`` (the light Hindi voice) instead of the speaker, so each takes the
budget of that role. The light roles run one after another on the audio
frame loop, so they are one group that holds one thread. Phases: ``idle``, ``listening``, ``speaking``, ``thinking``.

* ``listening``: the live reader and the audio group. ``thinking``: the final reader and the audio group.
* ``speaking``: the speaker, the live reader (it only watches for a barge-in) and the audio group. A barge-in stops
  the speech before the final reader starts, so the speaker and the final reader never both compute.
* ``idle``: the audio group alone.

The plan puts every group on its own thread when the cores allow it. With fewer cores the audio group joins the live
reader, and on one core everything takes turns on one thread. What is left over goes to the speaker first, then the
readers, each up to its cap. ``FRIDAY_VOICE_THREADS`` is one number for every role, or ``role=n`` pairs.
"""

from __future__ import annotations

import os
from typing import Any, NamedTuple

ROLES = ("asr_final", "asr_stream", "tts", "turn", "vad", "wake", "denoise", "punct", "tts_light")
SHARES = {"punct": "asr_final", "tts_light": "tts"}  # runs in the place of that role, one after it, on its threads
PHASES = ("idle", "listening", "speaking", "thinking")
AUDIO = ("wake", "denoise", "vad", "turn")  # one group: the frame loop calls them one after the other
CAPS = {"tts": 4, "asr_stream": 4, "asr_final": 6}
HOME = {"asr_final": "thinking", "asr_stream": "listening", "tts": "speaking"}  # the phase a role works in
HEAVY = {
    "idle": (),
    "listening": ("asr_stream",),
    "speaking": ("tts", "asr_stream"),
    "thinking": ("asr_final",),
}
BACKGROUND = ("asr_stream", *AUDIO)  # these never spin their idle threads; the foreground roles do on wide PCs
SPIN_FROM_CORES = 8
MAX_THREADS = 32
ENV = "FRIDAY_VOICE_THREADS"


class Group(NamedTuple):
    """Roles that take turns on the same threads, and how many threads they hold together."""

    roles: tuple[str, ...]
    threads: int


def cpu_count() -> int | None:
    """The logical processors this process may use (the affinity mask when the OS has one)."""
    try:
        return len(os.sched_getaffinity(0))  # type: ignore[attr-defined]
    except (AttributeError, OSError):
        return os.cpu_count()


def _cores(cores: int | None) -> int:
    found = cores if cores is not None else cpu_count()
    return max(1, int(found or 1))


def _check(role: str | None, phase: str | None) -> None:
    if role is not None and role not in ROLES:
        raise ValueError(f"unknown voice role: {role!r}")
    if phase is not None and phase not in PHASES:
        raise ValueError(f"unknown voice phase: {phase!r}")


def plan(phase: str, cores: int | None = None) -> list[Group]:
    """The groups that run at the same time in ``phase``, with their threads; the sum never exceeds ``cores``."""
    _check(None, phase)
    total = _cores(cores)
    groups = [[(role,), CAPS[role]] for role in HEAVY[phase]] + [[AUDIO, 1]]
    while len(groups) > total:  # fewer cores than groups: the last two take turns on one slot
        last = groups.pop()
        groups[-1][0] = (*groups[-1][0], *last[0])
    counts = [1] * len(groups)
    extra = total - len(groups)
    open_ = [i for i, g in enumerate(groups) if g[0] is not AUDIO]
    while extra > 0 and open_:
        for i in list(open_):
            if extra == 0:
                break
            if counts[i] < groups[i][1]:
                counts[i] += 1
                extra -= 1
            else:
                open_.remove(i)
    return [Group(tuple(roles), count) for (roles, _), count in zip(groups, counts, strict=True)]


def _override(role: str) -> int | None:
    raw = os.environ.get(ENV, "").strip()
    if not raw:
        return None
    try:
        if "=" not in raw:
            return max(1, min(MAX_THREADS, int(raw)))
        for part in raw.split(","):
            name, _, value = part.partition("=")
            if name.strip() == role:
                return max(1, min(MAX_THREADS, int(value)))
    except ValueError:
        return None
    return None


def threads(role: str, phase: str, cores: int | None = None) -> int:
    """Threads ``role`` may use in ``phase``. A role that does not run in that phase gets one."""
    _check(role, phase)
    forced = _override(role)
    if forced is None and role in SHARES:
        forced = _override(SHARES[role])
    if forced is not None:
        return forced
    role = SHARES.get(role, role)
    for group in plan(phase, cores):
        if role in group.roles:
            return group.threads
    return 1


def steady(role: str, cores: int | None = None) -> int:
    """The count to build a session with (it keeps that count): the role's budget in the phase it works in."""
    _check(role, None)
    return threads(role, HOME.get(SHARES.get(role, role), "idle"), cores)


def session_settings(
    role: str, phase: str | None = None, cores: int | None = None, intra: int | None = None
) -> dict[str, int]:
    """``intra_op``, ``inter_op`` and ``allow_spinning`` for one onnxruntime session of ``role``.

    ``intra`` is a count the caller was told to use (a ``threads=`` argument); it replaces the budget's own."""
    _check(role, phase)
    if intra is None:
        intra = threads(role, phase, cores) if phase else steady(role, cores)
    intra = max(1, intra)
    spin = 0 if SHARES.get(role, role) in BACKGROUND or _cores(cores) < SPIN_FROM_CORES else 1
    return {"intra_op": intra, "inter_op": 1, "allow_spinning": spin}


def ort_session_options(role: str, phase: str | None = None, cores: int | None = None, intra: int | None = None) -> Any:
    """An onnxruntime ``SessionOptions`` with the explicit counts, or ``None`` when onnxruntime is not installed."""
    settings = session_settings(role, phase, cores, intra)
    try:
        import onnxruntime as ort  # type: ignore

        options = ort.SessionOptions()
    except Exception:  # noqa: BLE001 — no runtime: the caller opens its session the plain way and fails there
        return None
    options.intra_op_num_threads = settings["intra_op"]
    options.inter_op_num_threads = settings["inter_op"]
    options.add_session_config_entry("session.intra_op.allow_spinning", str(settings["allow_spinning"]))
    return options
