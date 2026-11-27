"""Self-test of one optional voice pin, run by the Doctor (``electron/voice-verify.cjs``) on the owner's PC.

A pinned file that matches its SHA-256 is whole, not working. The self-test opens the model the way its runtime would
and checks what it declares, so a wrong build, a missing runtime library or a half-copied folder is a red row and not a
silent fallback:

* ``onnx-signature``: onnxruntime opens ``file``, the graph declares exactly the pinned inputs and outputs (name, type,
  shape), and one pass over zeros returns the declared output shape.
* ``ct2-folder``: the CTranslate2 folder is whole, carries every file in ``needs`` and ``ctranslate2`` can import.
  A ``companion`` file (one the pinned repository does not hold, such as a tokenizer from another pin) that is absent is
  reported as ``blocked`` with its reason: the download is fine, so it is not a failure and no repair helps.

The expected signature is passed in (``--spec``, the JSON from ``electron/voice-pins.cjs`` ``SELF_TESTS``), so the
pin file stays the one place that states it. No audio, no network, no download. A pass says the engine OPENS; it
is not a quality claim, and it never makes an engine the default.

    python voice_pin_selftest.py --dir <model folder> --spec '{"kind": "onnx-signature", ...}'
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from types import ModuleType
from typing import Any

import friday_runtime

_TYPES = {"float32": "tensor(float)", "float16": "tensor(float16)", "int64": "tensor(int64)", "int32": "tensor(int32)"}


def _dims_match(expected: list[Any], actual: list[Any] | tuple[Any, ...]) -> bool:
    """A number must be equal; a name ("B", "T") stands for a dynamic dimension (a name, None or any number)."""
    if len(expected) != len(actual):
        return False
    for want, got in zip(expected, actual, strict=True):
        if isinstance(want, str):
            continue
        if want != got:
            return False
    return True


def _run_shape(declared: list[Any], run: list[Any] | None) -> list[int] | None:
    shape = run if run else declared
    if not all(isinstance(dim, int) and dim > 0 for dim in shape):
        return None
    return [int(dim) for dim in shape]


def selftest_onnx(
    folder: Path, spec: dict[str, Any], ort: ModuleType | None = None, np: ModuleType | None = None
) -> dict:
    """Open the graph and compare it with the pinned signature. ``ort`` and ``np`` are injectable for a test."""
    path = folder / str(spec.get("file") or "")
    if not path.is_file():
        return {"ok": False, "reason": "file-missing", "detail": f"{spec.get('file')} is not in the model folder"}
    try:
        if ort is None:
            import onnxruntime as ort  # type: ignore[no-redef]  # noqa: PLC0415
        if np is None:
            import numpy as np  # type: ignore[no-redef]  # noqa: PLC0415
    except Exception as exc:  # noqa: BLE001 — a missing runtime is the answer, not a crash
        return {"ok": False, "reason": "runtime-missing", "detail": f"{type(exc).__name__}: {str(exc)[:160]}"}
    if ort is None or np is None:
        return {"ok": False, "reason": "runtime-missing", "detail": "onnxruntime or numpy is not available"}
    try:
        session = friday_runtime.open_session(path, "turn", ort_module=ort)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "reason": "cannot-open", "detail": f"{type(exc).__name__}: {str(exc)[:160]}"}

    wanted_in = list(spec.get("inputs") or [])
    wanted_out = list(spec.get("outputs") or [])
    have_in = {item.name: item for item in session.get_inputs()}
    have_out = {item.name: item for item in session.get_outputs()}
    if set(have_in) != {str(item["name"]) for item in wanted_in}:
        return {"ok": False, "reason": "inputs-differ", "detail": f"graph inputs are {sorted(have_in)}"}
    if set(have_out) != {str(item["name"]) for item in wanted_out}:
        return {"ok": False, "reason": "outputs-differ", "detail": f"graph outputs are {sorted(have_out)}"}
    feed: dict[str, Any] = {}
    for item in wanted_in:
        got = have_in[str(item["name"])]
        if not _dims_match(list(item["shape"]), list(got.shape)):
            return {"ok": False, "reason": "input-shape-differs", "detail": f"{item['name']} is {list(got.shape)}"}
        kind = _TYPES.get(str(item.get("type") or "float32"), "tensor(float)")
        if got.type != kind:
            return {"ok": False, "reason": "input-type-differs", "detail": f"{item['name']} is {got.type}"}
        shape = _run_shape(list(item["shape"]), item.get("run"))
        if shape is None:
            return {"ok": False, "reason": "no-run-shape", "detail": f"{item['name']} needs a fixed run shape"}
        feed[str(item["name"])] = np.zeros(shape, dtype=str(item.get("type") or "float32"))
    for item in wanted_out:
        got = have_out[str(item["name"])]
        if not _dims_match(list(item["shape"]), list(got.shape)):
            return {"ok": False, "reason": "output-shape-differs", "detail": f"{item['name']} is {list(got.shape)}"}
    try:
        names = [str(item["name"]) for item in wanted_out]
        arrays: list[Any] = list(session.run(names, feed))
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "reason": "run-failed", "detail": f"{type(exc).__name__}: {str(exc)[:160]}"}
    for item, array in zip(wanted_out, arrays, strict=True):
        if not _dims_match(list(item["shape"]), list(array.shape)):
            came = list(array.shape)
            return {"ok": False, "reason": "output-wrong-shape", "detail": f"{item['name']} came back {came}"}
    return {"ok": True, "reason": "", "detail": "opens, declares the pinned signature and ran one pass of zeros"}


def selftest_ct2(folder: Path, spec: dict[str, Any], importer: Any = None) -> dict:
    """The folder is whole and the CTranslate2 library can be imported."""
    missing = [name for name in spec.get("needs") or [] if not (folder / str(name)).is_file()]
    if missing:
        return {"ok": False, "reason": "files-missing", "detail": f"{', '.join(missing)} not in the model folder"}
    companion = spec.get("companion")
    if isinstance(companion, dict) and not (folder / str(companion.get("file") or "")).is_file():
        name = str(companion.get("file") or "companion file")
        return {
            "ok": True,
            "blocked": True,
            "reason": f"blocked-needs-{name}",
            "detail": str(companion.get("reason") or f"{name} is not beside the model yet")[:200],
        }
    try:
        (importer or __import__)("ctranslate2")
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "reason": "runtime-missing", "detail": f"{type(exc).__name__}: {str(exc)[:160]}"}
    return {"ok": True, "reason": "", "detail": "the folder is whole and ctranslate2 imports"}


def run(folder: Path, spec: dict[str, Any]) -> dict:
    kind = str(spec.get("kind") or "")
    if kind == "onnx-signature":
        return selftest_onnx(folder, spec)
    if kind == "ct2-folder":
        return selftest_ct2(folder, spec)
    return {"ok": False, "reason": "no-self-test", "detail": f"unknown self-test kind {kind!r}"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", required=True)
    parser.add_argument("--spec", required=True)
    args = parser.parse_args()
    try:
        spec = json.loads(args.spec)
        if not isinstance(spec, dict):
            raise ValueError("the spec must be an object")
    except ValueError as exc:
        print(json.dumps({"ok": False, "reason": "bad-spec", "detail": str(exc)[:160]}))
        return 0
    print(json.dumps(run(Path(args.dir), spec)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
