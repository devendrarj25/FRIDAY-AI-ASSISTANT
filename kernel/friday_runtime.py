"""FRIDAY Runtime: the one door through which FRIDAY's own voice code opens an onnxruntime session.

Every FRIDAY-owned loop (the ears, the speaker, the light roles, the wake word, the self-test) asks ``open_session`` for
a graph. The door gives it, in one place:

* the thread budget of its role (``voice_budget.ort_session_options``), so the roles that run together never ask for
  more threads than the PC has;
* an optional SHA-256 check that is done once per file stamp (``verify``): a 650 MB file that did not change is never
  hashed again on a cold load, and a changed size or modified time makes the next check a full hash again;
* a CPU fallback when a GPU provider cannot open the graph;
* an optional optimised-graph cache, keyed by the file hash, the onnxruntime version and the CPU flags. It is off
  unless ``FRIDAY_RUNTIME_OPTIMIZED_CACHE=1`` and it needs the file hash;
* one error type, ``FridayRuntimeError``, with the original error chained.

Outside the door, by design (named so nobody believes the door is the only way in): the ``supertonic`` package that
``voice_runtime`` falls back to, and the ``onnx_asr`` package that ``hindi_ear`` loads, open their own sessions inside
those packages. They are FRIDAY's pip-path engines, not FRIDAY-owned loops. ``onnx_asr.load_model`` (0.12) takes
``sess_options``, so ``hindi_ear`` can hand it the budgeted options from ``session_options``; ``supertonic`` has no
such argument.
"""

from __future__ import annotations

import hashlib
import os
import platform
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

import voice_budget

NAME = "FRIDAY Runtime"
CPU = "CPUExecutionProvider"
CACHE_ENV = "FRIDAY_RUNTIME_OPTIMIZED_CACHE"
_CHUNK = 1 << 20

Configure = Callable[[Any, Any, list[str]], None]


class FridayRuntimeError(RuntimeError):
    """A graph could not be opened. The original error, when there was one, is the ``__cause__``."""


# ---- file hash, verified once per stamp ----------------------------------------------------------------------------

_verified: dict[str, tuple[int, int, str]] = {}  # resolved path -> (size, mtime_ns, sha256) of a file that matched
_verified_lock = threading.Lock()


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while chunk := handle.read(_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def verify(path: str | os.PathLike[str], sha256: str, force: bool = False) -> bool:
    """True when the file's SHA-256 is ``sha256``.

    A file that matched once is not hashed again while its size and modified time stay the same; ``force`` (Doctor's
    ask) and a changed stamp hash it in full. A mismatch is never remembered."""
    target = Path(path)
    want = str(sha256 or "").strip().lower()
    if not want:
        return False
    try:
        info = target.stat()
    except OSError:
        return False
    key = str(target.resolve())
    stamp = (info.st_size, info.st_mtime_ns)
    with _verified_lock:
        held = _verified.get(key)
        if not force and held is not None and held[:2] == stamp and held[2] == want:
            return True
    try:
        got = _hash_file(target)
    except OSError:
        return False
    with _verified_lock:
        if got == want:
            _verified[key] = (*stamp, got)
            return True
        _verified.pop(key, None)
    return False


# ---- the optimised-graph cache (off by default) ----------------------------------------------------------------------


def _cache_enabled(flag: bool | None) -> bool:
    if flag is not None:
        return flag
    return os.environ.get(CACHE_ENV, "").strip().lower() in ("1", "true", "yes", "on")


def _cpu_signature() -> str:
    """The processor identity the optimised graph was fused for: it must not travel to a different CPU."""
    parts = [platform.machine(), platform.processor(), os.environ.get("PROCESSOR_IDENTIFIER", "")]
    try:
        with open("/proc/cpuinfo", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("flags"):
                    parts.append(line)
                    break
    except OSError:
        pass
    return hashlib.sha256("|".join(parts).encode("utf-8", "replace")).hexdigest()[:12]


def _default_cache_dir() -> Path:
    root = os.environ.get("FRIDAY_ROOT", "").strip()
    return (Path(root) if root else Path.home() / ".friday") / "cache" / "ort-graphs"


def _cache_file(sha256: str, ort: Any, cache_dir: Path | None) -> Path:
    version = str(getattr(ort, "__version__", "unknown"))
    name = f"{sha256[:24]}-ort{version}-{_cpu_signature()}.onnx"
    return (cache_dir or _default_cache_dir()) / name


# ---- options and the door ------------------------------------------------------------------------------------------


def _import_ort() -> Any:
    try:
        import onnxruntime as ort  # type: ignore
    except Exception as exc:  # noqa: BLE001 — a missing or broken runtime is one named failure
        raise FridayRuntimeError(f"onnxruntime is not available: {type(exc).__name__}: {exc}"[:300]) from exc
    return ort


def _budget_options(ort: Any, injected: bool, role: str, phase: str | None, intra: int | None) -> Any:
    """The role's budgeted ``SessionOptions``; ``None`` when the runtime has no ``SessionOptions`` to build one."""
    if not injected:
        return voice_budget.ort_session_options(role, phase, intra=intra)
    try:
        settings = voice_budget.session_settings(role, phase, intra=intra)
        options = ort.SessionOptions()
    except Exception:  # noqa: BLE001
        return None
    options.intra_op_num_threads = settings["intra_op"]
    options.inter_op_num_threads = settings["inter_op"]
    options.add_session_config_entry("session.intra_op.allow_spinning", str(settings["allow_spinning"]))
    return options


def session_options(role: str, phase: str | None = None, *, intra: int | None = None) -> Any:
    """The budgeted ``SessionOptions`` of ``role`` for a package that opens its own session (``onnx_asr``); ``None``
    when onnxruntime is not installed."""
    _check_role(role)
    return voice_budget.ort_session_options(role, phase, intra=intra)


def _check_role(role: str) -> None:
    if role not in voice_budget.ROLES:
        raise FridayRuntimeError(f"unknown voice role: {role!r}")


def _create(ort: Any, path: Path, options: Any, providers: list[str]) -> Any:
    given = (str(path),) if options is None else (str(path), options)
    return ort.InferenceSession(*given, providers=providers)


def open_session(
    path: str | os.PathLike[str],
    role: str,
    phase: str | None = None,
    *,
    sha256: str | None = None,
    providers: list[str] | tuple[str, ...] | None = None,
    intra: int | None = None,
    configure: Configure | None = None,
    ort_module: Any = None,
    optimized_cache: bool | None = None,
    cache_dir: Path | None = None,
) -> Any:
    """An onnxruntime session for ``path`` with the thread budget of ``role`` (and ``phase``).

    ``sha256`` makes the door check the file first (once per stamp, see ``verify``). ``providers`` is the wish list;
    when a GPU provider cannot open the graph the door opens it on the CPU. ``intra`` is a thread count the caller was
    told to use. ``configure(options, ort, providers)`` sets the options only this graph needs. ``ort_module`` is a
    runtime handed in by a caller that owns one (tests, the self-test). Raises ``FridayRuntimeError``."""
    _check_role(role)
    target = Path(path)
    if sha256 and not verify(target, sha256):
        raise FridayRuntimeError(f"{target.name} does not match its pinned SHA-256 (or is missing)")
    ort = ort_module if ort_module is not None else _import_ort()
    wanted = [str(name) for name in providers] if providers else [CPU]
    attempts = [wanted] if wanted == [CPU] else [wanted, [CPU]]
    use_cache = bool(sha256) and wanted == [CPU] and _cache_enabled(optimized_cache)
    error: Exception | None = None
    for attempt in attempts:
        try:
            options = _budget_options(ort, ort_module is not None, role, phase, intra)
            if options is None:
                try:
                    options = ort.SessionOptions()
                except Exception:  # noqa: BLE001 — a runtime without SessionOptions takes the plain open
                    options = None
            if options is not None and configure is not None:
                configure(options, ort, attempt)
            if use_cache and sha256:
                return _open_cached(ort, target, options, attempt, sha256, cache_dir)
            return _create(ort, target, options, attempt)
        except Exception as exc:  # noqa: BLE001 — every failure of the open is one error type
            error = exc
    raise FridayRuntimeError(f"{target.name} did not open: {type(error).__name__}: {error}"[:300]) from error


def _open_cached(
    ort: Any, target: Path, options: Any, providers: list[str], sha256: str, cache_dir: Path | None
) -> Any:
    """Open the optimised copy when there is one; otherwise open the file and keep the graph onnxruntime fused."""
    cached = _cache_file(sha256, ort, cache_dir)
    if options is not None and cached.is_file():
        try:
            options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
            return _create(ort, cached, options, providers)
        except Exception:  # noqa: BLE001 — a damaged copy is dropped and the real file opens
            cached.unlink(missing_ok=True)
            options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    pending: Path | None = None
    if options is not None:
        try:
            cached.parent.mkdir(parents=True, exist_ok=True)
            pending = cached.with_name(f"{cached.name}.{os.getpid()}.tmp")
            options.optimized_model_filepath = str(pending)
        except OSError:
            pending = None
    session = _create(ort, target, options, providers)
    if pending is not None:
        try:
            if pending.stat().st_size > 0:
                os.replace(pending, cached)
        except OSError:
            pass
        finally:
            pending.unlink(missing_ok=True)
    return session


def runtime_info() -> dict[str, Any]:
    """The facts for a Doctor row: the layer's name, the engine under it, its version and the providers it has."""
    info: dict[str, Any] = {"name": NAME, "engine": "onnxruntime", "engineVersion": None, "providers": []}
    try:
        import onnxruntime as ort  # type: ignore

        info["engineVersion"] = str(getattr(ort, "__version__", "")) or None
        info["providers"] = [str(name) for name in ort.get_available_providers()]
    except Exception:  # noqa: BLE001 — no runtime is the answer, not a crash
        return info
    return info
