"""FRIDAY's own int8 build of a pinned voice graph, and the gate that decides whether it may be used.

``derive`` writes a dynamic int8 copy of named graphs with one fixed recipe and records each result file's SHA-256 and
size. It runs in a scratch folder, never inside the product: the derived hash is pinned only after ``accept`` says the
copy is as accurate and as fast as the pinned fp32 file, and the owner has decided to bundle it. The ``onnx`` package is
imported only inside ``derive`` (it is not a kernel dependency), so everything else here runs without it.

The recipe is fixed on purpose. The weights are signed 8-bit per channel, the activations stay fp32 and are scaled while
running, and ``reduce_range`` is always on: the file is made once and the CPU that reads it is not known, so the safe
7-bit range is used instead of a guess about VNNI. Vocoders (convolution graphs) are not quantised by any recipe here.

``accept`` is a pure function over two metric dicts, ``base`` (the fp32 run) and ``cand`` (the int8 run). Rates are
fractions (0.021 is 2.1 percent); the limits below are in percentage points. A missing number fails the gate, so a
half-measured candidate never passes.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Mapping
from pathlib import Path, PurePosixPath
from typing import Any

# The limits of the gate, in percentage points (accuracy) or as a ratio (speed).
MAX_STT_DELTA_POINTS = 0.5  # int8 minus fp32, for WER and for CER, per language
MAX_STT_CI_HIGH_POINTS = 1.0  # upper end of the paired 95% interval of that difference
MAX_TTS_DELTA_POINTS = 1.0  # round-trip CER, int8 minus fp32
MAX_SLOWER = 0.10  # int8 may take at most 10% more time than fp32 on any measured speed

_EPS = 1e-9  # a limit is inclusive: 0.5 points of difference passes, floating point noise does not fail it

WEIGHT_TYPE = "QInt8"

# What each pinned model gets: the graphs to quantise, relative to the model folder. The encoder of the streaming ear
# is already int8 in the pinned export; the TTS vocoder and the flow-matching estimator stay fp32.
GRAPHS: dict[str, tuple[str, ...]] = {
    "friday-ear": ("decoder.onnx", "joint.onnx"),
    "friday-voice": ("onnx/text_encoder.onnx", "onnx/duration_predictor.onnx"),
}


class DeriveError(ValueError):
    """The recipe or a path was refused, or a graph could not be quantised."""


def make_recipe(model: str, graphs: tuple[str, ...] | None = None) -> dict[str, Any]:
    """The one recipe for ``model`` (a key of ``GRAPHS``) or for an explicit list of graphs."""
    chosen = tuple(graphs) if graphs is not None else GRAPHS.get(model)
    if not chosen:
        raise DeriveError(f"no graphs are listed for {model!r}")
    return {
        "model": model,
        "method": "dynamic",
        "weightType": WEIGHT_TYPE,
        "perChannel": True,
        "reduceRange": True,
        "graphs": list(chosen),
    }


def recipe_id(recipe: Mapping[str, Any]) -> str:
    """A short name that changes with every field of the recipe: ``<model>-int8-<8 hex of the canonical JSON>``."""
    body = json.dumps(dict(recipe), sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return f"{recipe.get('model', 'model')}-int8-{hashlib.sha256(body.encode('utf-8')).hexdigest()[:8]}"


def _check_recipe(recipe: Mapping[str, Any]) -> list[str]:
    if recipe.get("method") != "dynamic":
        raise DeriveError("only the dynamic recipe is allowed")
    if recipe.get("weightType") != WEIGHT_TYPE:
        raise DeriveError(f"the weights must be {WEIGHT_TYPE}")
    if recipe.get("perChannel") is not True:
        raise DeriveError("per_channel must be on")
    if recipe.get("reduceRange") is not True:
        raise DeriveError("reduce_range must be on: the file does not know which CPU will read it")
    graphs = recipe.get("graphs")
    if not isinstance(graphs, list) or not graphs or not all(isinstance(g, str) for g in graphs):
        raise DeriveError("the recipe names no graphs")
    for name in graphs:
        where = PurePosixPath(name)
        if not where.parts or where.is_absolute() or ".." in where.parts or "\\" in name or where.suffix != ".onnx":
            raise DeriveError(f"not a graph inside the model folder: {name!r}")
    if len(set(graphs)) != len(graphs):
        raise DeriveError("a graph is listed twice")
    return list(graphs)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _ort_quantize(source: Path, target: Path, recipe: Mapping[str, Any]) -> None:
    """The real quantiser. Imported here: neither ``onnx`` nor the quantisation tools are kernel dependencies."""
    from onnxruntime.quantization import QuantType, quantize_dynamic  # type: ignore[import-untyped]

    quantize_dynamic(
        model_input=str(source),
        model_output=str(target),
        weight_type=getattr(QuantType, str(recipe["weightType"])),
        per_channel=bool(recipe["perChannel"]),
        reduce_range=bool(recipe["reduceRange"]),
    )


def _ort_version() -> str:
    import onnxruntime as ort  # type: ignore[import-untyped]

    return str(ort.__version__)


def derive(
    src_folder: str | Path,
    out_folder: str | Path,
    recipe: Mapping[str, Any],
    *,
    quantize: Callable[[Path, Path, Mapping[str, Any]], None] | None = None,
    ort_version: str | None = None,
) -> dict[str, Any]:
    """Quantise the recipe's graphs from ``src_folder`` into ``out_folder`` (same relative names).

    Returns ``{"files": {name: {"sha256", "bytes"}}, "recipeId", "ortVersion"}``. Raises ``DeriveError`` for a refused
    recipe or path or a graph that is missing, and lets the quantiser's own error through. ``quantize`` and
    ``ort_version`` are for tests; the defaults use onnxruntime and import it lazily. Nothing is written when a source
    graph is missing, and the source folder is never changed.
    """
    graphs = _check_recipe(recipe)
    src, out = Path(src_folder), Path(out_folder)
    if src.resolve() == out.resolve():
        raise DeriveError("the output folder must differ from the source folder")
    for name in graphs:
        if not (src / name).is_file():
            raise DeriveError(f"missing graph: {name}")
    run = quantize or _ort_quantize
    files: dict[str, dict[str, Any]] = {}
    for name in graphs:
        target = out / name
        target.parent.mkdir(parents=True, exist_ok=True)
        run(src / name, target, recipe)
        if not target.is_file() or target.stat().st_size == 0:
            raise DeriveError(f"the quantiser wrote nothing for {name}")
        files[name] = {"sha256": _sha256_file(target), "bytes": target.stat().st_size}
    return {"files": files, "recipeId": recipe_id(recipe), "ortVersion": ort_version or _ort_version()}


# ---- the gate ----------------------------------------------------------------------------------------------------


def _num(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if value == value else None  # NaN is a missing number


def _dig(tree: Any, *path: str) -> Any:
    for key in path:
        if not isinstance(tree, Mapping):
            return None
        tree = tree.get(key)
    return tree


def _check_stt(base: Mapping[str, Any], cand: Mapping[str, Any], reasons: list[str]) -> bool:
    """Every language the baseline measured: WER and CER up by at most 0.5 points, paired CI high at most 1.0."""
    seen = False
    for lang, row in sorted(base.items()):
        seen = True
        other = cand.get(lang)
        for metric in ("wer", "cer"):
            b, c = _num(_dig(row, metric)), _num(_dig(other, metric))
            if b is None:
                continue
            if c is None:
                reasons.append(f"stt {lang} {metric}: candidate has no number")
                continue
            delta = (c - b) * 100.0
            if delta > MAX_STT_DELTA_POINTS + _EPS:
                reasons.append(f"stt {lang} {metric}: +{delta:.2f} points (limit {MAX_STT_DELTA_POINTS})")
            high = _num(_dig(other, "ci", metric, "high"))
            if high is None:
                reasons.append(f"stt {lang} {metric}: no paired interval")
            elif high * 100.0 > MAX_STT_CI_HIGH_POINTS + _EPS:
                said = f"{high * 100.0:.2f} points (limit {MAX_STT_CI_HIGH_POINTS})"
                reasons.append(f"stt {lang} {metric}: interval high {said}")
    return seen


def _check_tts(base: Mapping[str, Any], cand: Mapping[str, Any], reasons: list[str]) -> bool:
    seen = False
    for key, row in sorted(base.items()):
        b = _num(row)
        if b is None:
            continue
        seen = True
        c = _num(cand.get(key))
        if c is None:
            reasons.append(f"tts {key}: candidate has no number")
        elif (c - b) * 100.0 > MAX_TTS_DELTA_POINTS + _EPS:
            reasons.append(f"tts {key}: +{(c - b) * 100.0:.2f} points (limit {MAX_TTS_DELTA_POINTS})")
    return seen


def _check_speed(base: Mapping[str, Any], cand: Mapping[str, Any], reasons: list[str]) -> bool:
    """Each measured time (lower is better): the candidate takes at most 10% longer than the baseline."""
    seen = False
    for key, value in sorted(base.items()):
        b = _num(value)
        if b is None or b <= 0:
            continue
        seen = True
        c = _num(cand.get(key))
        if c is None:
            reasons.append(f"speed {key}: candidate has no number")
        elif c > b * (1.0 + MAX_SLOWER) + _EPS:
            slower = f"{(c / b - 1) * 100:.1f}% slower, limit {MAX_SLOWER * 100:.0f}%"
            reasons.append(f"speed {key}: {c:.3f} against {b:.3f} ({slower})")
    return seen


def accept(base_metrics: Mapping[str, Any], cand_metrics: Mapping[str, Any]) -> dict[str, Any]:
    """Judge an int8 candidate against the fp32 baseline. Returns ``{"ok": bool, "reasons": [str]}``.

    Metric shape (all keys optional, but a section the baseline has must be in the candidate):
      * ``stt``: ``{lang: {"wer", "cer"}}`` for both; the candidate rows also carry the paired 95% interval of the
        difference, ``"ci": {"wer": {"low", "high"}, "cer": {...}}``.
      * ``tts``: ``{name: round-trip CER}``.
      * ``speed``: ``{name: time}`` (milliseconds or an RTF; lower is better), for example the p95 per chunk, the first
        audio time, and the same numbers measured while another job loads the CPU.
    At least one accuracy section and the speed section are required: a candidate that was only timed, or only scored,
    does not pass.
    """
    reasons: list[str] = []
    stt_b, stt_c = _dig(base_metrics, "stt"), _dig(cand_metrics, "stt")
    tts_b, tts_c = _dig(base_metrics, "tts"), _dig(cand_metrics, "tts")
    spd_b, spd_c = _dig(base_metrics, "speed"), _dig(cand_metrics, "speed")
    accuracy = False
    if isinstance(stt_b, Mapping) and stt_b:
        accuracy = _check_stt(stt_b, stt_c if isinstance(stt_c, Mapping) else {}, reasons) or accuracy
    if isinstance(tts_b, Mapping) and tts_b:
        accuracy = _check_tts(tts_b, tts_c if isinstance(tts_c, Mapping) else {}, reasons) or accuracy
    if not accuracy:
        reasons.append("no accuracy number in the baseline")
    if not (isinstance(spd_b, Mapping) and _check_speed(spd_b, spd_c if isinstance(spd_c, Mapping) else {}, reasons)):
        reasons.append("no speed number in the baseline")
    return {"ok": not reasons, "reasons": reasons}
