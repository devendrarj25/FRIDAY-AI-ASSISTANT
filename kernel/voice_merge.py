"""Merge same-architecture speech checkpoints into one ear, then convert it for the CPU runtime.

A merge is only honest between checkpoints that share one architecture: the same config (layers, widths, heads,
vocabulary size, mel bins), the same tensor names and shapes, and the same token-to-id table. Two fine-tunes of one
base qualify; a large model and a turbo model do not (different decoder depth), and neither do two vocabularies.
``check_same_architecture`` and ``check_same_vocabulary`` refuse anything else with the first difference named.

Every source carries its licence. Only permissive licences are merged (``ALLOWED_LICENCES``); a non-commercial,
share-alike, no-derivatives, GPL-family or unknown licence is refused, because a merge is a derivative work and the
result ships to the owner's PC.

The merge math works on one tensor at a time (``merge_tensor``), so a 1.5-billion-parameter checkpoint streams from
memory-mapped safetensors without ever being held whole: linear averaging, task arithmetic, TIES (trim, elect sign,
disjoint mean) and DARE (random drop with rescale, optionally with TIES sign election). DARE masks are seeded from the
recipe seed and the tensor name, so a merge is reproducible.

``merge_checkpoints`` and ``convert_ct2`` are the heavy parts and run only when called with real folders: the first
writes a merged ``model.safetensors`` plus a ``merge.json`` manifest (sources, revisions, SHA-256, recipe), the second
builds a CTranslate2 Whisper model (int8 by default) straight from numpy arrays, without torch or transformers. Both
are build-time tools; FRIDAY never merges at run time.

    python voice_merge.py merge recipe.json OUT_DIR
    python voice_merge.py convert MERGED_DIR CT2_DIR [--quantization int8]
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import sys
import zlib
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np

METHODS = ("linear", "task_arithmetic", "ties", "dare_linear", "dare_ties")
ALLOWED_LICENCES = frozenset(
    {"mit", "apache-2.0", "bsd-2-clause", "bsd-3-clause", "isc", "cc0-1.0", "cc-by-4.0", "unlicense"}
)
# Config fields that fix the shape of a Whisper-family network; any difference makes a merge meaningless.
ARCH_KEYS = (
    "model_type",
    "d_model",
    "encoder_layers",
    "decoder_layers",
    "encoder_attention_heads",
    "decoder_attention_heads",
    "encoder_ffn_dim",
    "decoder_ffn_dim",
    "vocab_size",
    "num_mel_bins",
    "max_source_positions",
    "max_target_positions",
)
SIDE_FILES = (
    "config.json",
    "generation_config.json",
    "preprocessor_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.json",
    "merges.txt",
    "added_tokens.json",
    "special_tokens_map.json",
    "normalizer.json",
)
_DTYPES = {"F16": np.float16, "F32": np.float32, "F64": np.float64, "I64": np.int64, "I32": np.int32, "I8": np.int8,
           "U8": np.uint8, "BOOL": np.bool_}  # fmt: skip
_CODES = {np.dtype(v).str: k for k, v in _DTYPES.items()}


class MergeRefused(ValueError):
    """A merge that would be invalid (architecture, vocabulary, licence or recipe) is refused before any work."""


# ---- licence ---------------------------------------------------------------------------------------------------


def licence_problem(licence: str | None) -> str | None:
    """Why a source licence cannot be merged, or None when it is a permissive licence on the allow-list."""
    text = (licence or "").strip().lower().replace("_", "-")
    if not text or text in {"unknown", "other", "none", "proprietary"}:
        return f"licence {licence!r} is unknown"
    if re.search(r"(^|[-\s])nc([-\s]|$)|non-?commercial", text):
        return f"licence {licence!r} is non-commercial"
    if re.search(r"(^|[-\s])sa([-\s]|$)|share-?alike", text):
        return f"licence {licence!r} is share-alike"
    if re.search(r"(^|[-\s])nd([-\s]|$)|no-?deriv", text):
        return f"licence {licence!r} forbids derivatives"
    if "gpl" in text:
        return f"licence {licence!r} is copyleft (GPL family)"
    if text not in ALLOWED_LICENCES:
        return f"licence {licence!r} is not on the permissive allow-list"
    return None


def check_licences(sources: Sequence[Mapping[str, Any]]) -> None:
    for src in sources:
        problem = licence_problem(src.get("licence"))
        if problem:
            raise MergeRefused(f"{src.get('repo') or src.get('path')}: {problem}")


# ---- architecture and vocabulary -------------------------------------------------------------------------------


def architecture_signature(config: Mapping[str, Any], shapes: Mapping[str, Sequence[int]]) -> dict:
    """The parts of a checkpoint that must match for a merge: config shape fields and every tensor name and shape."""
    return {
        "config": {k: config.get(k) for k in ARCH_KEYS},
        "tensors": {name: tuple(int(d) for d in shape) for name, shape in shapes.items()},
    }


def check_same_architecture(signatures: Sequence[Mapping[str, Any]], labels: Sequence[str] | None = None) -> None:
    """Refuse unless every signature equals the first; the message names the first difference found."""
    if len(signatures) < 2:
        raise MergeRefused("a merge needs at least two checkpoints")
    names = list(labels or [f"#{i}" for i in range(len(signatures))])
    first = signatures[0]
    for label, sig in zip(names[1:], signatures[1:], strict=True):
        for key in ARCH_KEYS:
            a, b = first["config"].get(key), sig["config"].get(key)
            if a != b:
                raise MergeRefused(f"{label}: config {key} is {b!r}, base has {a!r}; different architectures")
        ta, tb = first["tensors"], sig["tensors"]
        missing, extra = sorted(set(ta) - set(tb)), sorted(set(tb) - set(ta))
        if missing or extra:
            what = f"missing {missing[0]}" if missing else f"extra {extra[0]}"
            raise MergeRefused(f"{label}: tensor names differ ({what}); different architectures")
        for name in ta:
            if ta[name] != tb[name]:
                raise MergeRefused(f"{label}: tensor {name} has shape {tb[name]}, base has {ta[name]}")


def load_vocabulary(folder: Path) -> dict[str, int]:
    """Token to id as the tokenizer sees it: vocab.json plus added_tokens.json (both Hugging Face Whisper files)."""
    vocab: dict[str, int] = {}
    for name in ("vocab.json", "added_tokens.json"):
        path = folder / name
        if path.is_file():
            vocab.update({str(k): int(v) for k, v in json.loads(path.read_text(encoding="utf-8")).items()})
    return vocab


def check_same_vocabulary(vocabs: Sequence[Mapping[str, int]], labels: Sequence[str] | None = None) -> None:
    """A merged embedding row only means something when every checkpoint maps the same token to the same id."""
    names = list(labels or [f"#{i}" for i in range(len(vocabs))])
    first = vocabs[0]
    for label, vocab in zip(names[1:], vocabs[1:], strict=True):
        if vocab == first:
            continue
        diff = sorted(t for t in set(first) | set(vocab) if first.get(t) != vocab.get(t))
        raise MergeRefused(f"{label}: vocabulary differs from the base at {len(diff)} tokens (first {diff[0]!r})")


# ---- merge math (one tensor at a time) -------------------------------------------------------------------------


def _seed_for(name: str, seed: int) -> int:
    return (zlib.crc32(name.encode("utf-8")) ^ (int(seed) * 2654435761)) & 0xFFFFFFFF


def trim_top(delta: np.ndarray, density: float) -> np.ndarray:
    """Keep the ``density`` share of entries with the largest magnitude, zero the rest (ties keep a few extra)."""
    if density >= 1.0:
        return delta
    flat = np.abs(delta).ravel()
    k = int(np.ceil(density * flat.size))
    if k <= 0:
        return np.zeros_like(delta)
    threshold = np.partition(flat, flat.size - k)[flat.size - k]
    return np.where(np.abs(delta) >= threshold, delta, 0).astype(delta.dtype, copy=False)


def dare_drop(delta: np.ndarray, drop: float, rng: np.random.Generator) -> np.ndarray:
    """Drop each entry with probability ``drop`` and rescale the survivors by 1/(1-drop), keeping the expectation."""
    if drop <= 0:
        return delta
    keep = rng.random(delta.shape, dtype=np.float32) >= drop
    return np.where(keep, delta / (1.0 - drop), 0).astype(delta.dtype, copy=False)


def elect_and_mean(deltas: Sequence[np.ndarray]) -> np.ndarray:
    """TIES: the sign with the larger total mass wins per entry; average only the deltas that agree with it."""
    stack = np.stack(deltas)
    sign = np.sign(stack.sum(axis=0))
    agree = (np.sign(stack) == sign) & (stack != 0)
    count = agree.sum(axis=0)
    total = np.where(agree, stack, 0).sum(axis=0)
    return np.where(count > 0, total / np.maximum(count, 1), 0).astype(stack.dtype, copy=False)


def merge_tensor(name: str, base: np.ndarray, others: Sequence[np.ndarray], recipe: Mapping[str, Any]) -> np.ndarray:
    """Merge one tensor in float32. ``others`` follow ``recipe['models']``; integer tensors keep the base value."""
    if not np.issubdtype(base.dtype, np.floating):
        return np.asarray(base)
    method = recipe["method"]
    weights = [float(m.get("weight", 1.0)) for m in recipe["models"]]
    b = np.asarray(base, dtype=np.float32)
    if method == "linear":
        parts = [float(recipe.get("base_weight", 1.0)), *weights]
        acc = b * parts[0]
        for w, t in zip(parts[1:], others, strict=True):
            acc = acc + w * np.asarray(t, dtype=np.float32)
        return acc / sum(parts)
    deltas = [np.asarray(t, dtype=np.float32) - b for t in others]
    if method == "task_arithmetic":
        return b + sum((w * d for w, d in zip(weights, deltas, strict=True)), np.zeros_like(b))
    if method in ("dare_linear", "dare_ties"):
        rng = np.random.default_rng(_seed_for(name, int(recipe.get("seed", 0))))
        deltas = [dare_drop(d, float(recipe.get("drop", 0.9)), rng) for d in deltas]
    else:
        deltas = [trim_top(d, float(recipe.get("density", 0.2))) for d in deltas]
    scaled = [w * d for w, d in zip(weights, deltas, strict=True)]
    if method == "dare_linear":
        merged = sum(scaled, np.zeros_like(b))
    else:
        merged = elect_and_mean(scaled)
    return b + float(recipe.get("lambda", 1.0)) * merged


def check_recipe(recipe: Mapping[str, Any]) -> None:
    if recipe.get("method") not in METHODS:
        raise MergeRefused(f"method {recipe.get('method')!r} is not one of {', '.join(METHODS)}")
    models = recipe.get("models") or []
    if not models:
        raise MergeRefused("a recipe needs at least one model besides the base")
    if "base" not in recipe:
        raise MergeRefused("a recipe needs a base checkpoint")
    if not 0.0 < float(recipe.get("density", 0.2)) <= 1.0:
        raise MergeRefused("density must be in (0, 1]")
    if not 0.0 <= float(recipe.get("drop", 0.9)) < 1.0:
        raise MergeRefused("drop must be in [0, 1)")
    if recipe["method"] == "linear" and float(recipe.get("base_weight", 1.0)) + sum(
        float(m.get("weight", 1.0)) for m in models
    ) <= 0:  # fmt: skip
        raise MergeRefused("linear weights must sum above zero")
    check_licences([recipe["base"], *models])


# ---- safetensors (numpy only, memory-mapped) -------------------------------------------------------------------


def read_header(path: Path) -> tuple[dict, int]:
    """The safetensors JSON header and the byte offset where tensor data starts."""
    with path.open("rb") as fh:
        size = int.from_bytes(fh.read(8), "little")
        if size <= 0 or size > 100_000_000:
            raise MergeRefused(f"{path.name}: not a safetensors file")
        header = json.loads(fh.read(size))
    return header, 8 + size


class Checkpoint:
    """Tensors of one checkpoint folder (single file or sharded index), each opened as a read-only memory map."""

    def __init__(self, folder: Path):
        self.folder = Path(folder)
        index = self.folder / "model.safetensors.index.json"
        if index.is_file():
            files = sorted(set(json.loads(index.read_text(encoding="utf-8"))["weight_map"].values()))
        elif (self.folder / "model.safetensors").is_file():
            files = ["model.safetensors"]
        else:
            raise MergeRefused(f"{self.folder}: no model.safetensors or model.safetensors.index.json")
        self.files = [self.folder / f for f in files]
        self.entries: dict[str, tuple[Path, int, dict]] = {}
        for path in self.files:
            if path.resolve().parent != self.folder.resolve():
                raise MergeRefused(f"{path}: shard outside the checkpoint folder")
            header, start = read_header(path)
            for name, info in header.items():
                if name != "__metadata__":
                    self.entries[name] = (path, start, info)
        self.config = json.loads((self.folder / "config.json").read_text(encoding="utf-8"))

    def shapes(self) -> dict[str, tuple[int, ...]]:
        return {n: tuple(e[2]["shape"]) for n, e in self.entries.items()}

    def dtype(self, name: str) -> str:
        return self.entries[name][2]["dtype"]

    def tensor(self, name: str) -> np.ndarray:
        path, start, info = self.entries[name]
        begin, end = info["data_offsets"]
        shape = tuple(info["shape"])
        bf16 = info["dtype"] == "BF16"
        dtype = np.uint16 if bf16 else _DTYPES.get(info["dtype"])
        if dtype is None:
            raise MergeRefused(f"{name}: dtype {info['dtype']} is not supported")
        if not 0 <= begin <= end or end - begin != int(np.prod(shape, dtype=np.int64)) * np.dtype(dtype).itemsize:
            raise MergeRefused(f"{name}: data size does not match its shape")
        if not shape or end == begin:
            with path.open("rb") as fh:
                fh.seek(start + begin)
                array = np.frombuffer(fh.read(end - begin), dtype=dtype).reshape(shape).copy()
        else:
            array = np.memmap(path, dtype=dtype, mode="c", offset=start + begin, shape=shape)
        return (array.astype(np.uint32) << 16).view(np.float32) if bf16 else array

    def signature(self) -> dict:
        return architecture_signature(self.config, self.shapes())


def write_safetensors(path: Path, plan: Sequence[tuple[str, tuple[int, ...], str]],
                      tensors: Iterable[np.ndarray], metadata: Mapping[str, str] | None = None) -> None:  # fmt: skip
    """Stream tensors into a safetensors file: the header comes from ``plan`` (name, shape, dtype code) up front."""
    header: dict[str, Any] = {"__metadata__": dict(metadata or {})}
    offset = 0
    for name, shape, code in plan:
        size = int(np.prod(shape, dtype=np.int64)) * np.dtype(_DTYPES[code]).itemsize
        header[name] = {"dtype": code, "shape": list(shape), "data_offsets": [offset, offset + size]}
        offset += size
    blob = json.dumps(header, separators=(",", ":")).encode("utf-8")
    blob += b" " * (-len(blob) % 8)
    with path.open("wb") as fh:
        fh.write(len(blob).to_bytes(8, "little"))
        fh.write(blob)
        for (name, shape, code), array in zip(plan, tensors, strict=True):
            out = np.ascontiguousarray(array, dtype=_DTYPES[code])
            if tuple(out.shape) != tuple(shape):
                raise MergeRefused(f"{name}: merged shape {out.shape} does not match the plan {shape}")
            fh.write(out.tobytes())


def sha256_file(path: Path, chunk: int = 1 << 22) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        while block := fh.read(chunk):
            digest.update(block)
    return digest.hexdigest()


# ---- heavy loop -----------------------------------------------------------------------------------------------


def open_sources(recipe: Mapping[str, Any]) -> tuple[Checkpoint, list[Checkpoint]]:
    """Check recipe and licences, open every checkpoint, refuse a different architecture or vocabulary."""
    check_recipe(recipe)
    base = Checkpoint(Path(recipe["base"]["path"]))
    others = [Checkpoint(Path(m["path"])) for m in recipe["models"]]
    labels = [str(s.get("repo") or s["path"]) for s in [recipe["base"], *recipe["models"]]]
    check_same_architecture([base.signature(), *[o.signature() for o in others]], labels)
    check_same_vocabulary([load_vocabulary(c.folder) for c in [base, *others]], labels)
    return base, others


def merge_checkpoints(recipe: Mapping[str, Any], out_dir: Path, log: Callable[[str], None] = print) -> dict:
    """Merge tensor by tensor into ``out_dir/model.safetensors`` (base dtype) and write ``merge.json``."""
    base, others = open_sources(recipe)
    out_dir.mkdir(parents=True, exist_ok=True)
    names = sorted(base.entries)
    plan = []
    for n in names:
        code = base.dtype(n)
        plan.append((n, base.shapes()[n], "F32" if code == "BF16" else code))

    def stream() -> Iterator[np.ndarray]:
        for i, n in enumerate(names):
            yield merge_tensor(n, base.tensor(n), [o.tensor(n) for o in others], recipe)
            if i % 50 == 0:
                log(f"merged {i + 1}/{len(names)} {n}")

    target = out_dir / "model.safetensors"
    write_safetensors(target, plan, stream(), {"format": "pt"})
    for side in SIDE_FILES:
        if (base.folder / side).is_file():
            shutil.copyfile(base.folder / side, out_dir / side)

    def describe(spec: Mapping[str, Any], ckpt: Checkpoint) -> dict:
        keep = {k: spec[k] for k in ("repo", "revision", "licence", "weight") if k in spec}
        return {**keep, "files": {p.name: sha256_file(p) for p in ckpt.files}}

    manifest = {
        "name": recipe.get("name"),
        "method": recipe["method"],
        "params": {k: recipe[k] for k in ("base_weight", "density", "drop", "lambda", "seed") if k in recipe},
        "base": describe(recipe["base"], base),
        "models": [describe(m, o) for m, o in zip(recipe["models"], others, strict=True)],
        "output": {"model.safetensors": sha256_file(target), "bytes": target.stat().st_size},
    }
    (out_dir / "merge.json").write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
    return manifest


def _ns(**kw: Any) -> SimpleNamespace:
    return SimpleNamespace(**kw)


def whisper_view(ckpt: Checkpoint) -> SimpleNamespace:
    """A Hugging Face Whisper model shaped from numpy arrays, enough for the CTranslate2 Whisper loader."""
    t = ckpt.tensor

    def lin(p: str) -> SimpleNamespace:
        bias = f"{p}.bias"
        return _ns(weight=t(f"{p}.weight"), bias=t(bias) if bias in ckpt.entries else None)

    def attn(p: str) -> SimpleNamespace:
        return _ns(q_proj=lin(f"{p}.q_proj"), k_proj=lin(f"{p}.k_proj"), v_proj=lin(f"{p}.v_proj"),
                   out_proj=lin(f"{p}.out_proj"))  # fmt: skip

    cfg = ckpt.config

    def layer(p: str, cross: bool) -> SimpleNamespace:
        extra = {"encoder_attn": attn(f"{p}.encoder_attn"),
                 "encoder_attn_layer_norm": lin(f"{p}.encoder_attn_layer_norm")} if cross else {}  # fmt: skip
        return _ns(self_attn=attn(f"{p}.self_attn"), self_attn_layer_norm=lin(f"{p}.self_attn_layer_norm"),
                   fc1=lin(f"{p}.fc1"), fc2=lin(f"{p}.fc2"), final_layer_norm=lin(f"{p}.final_layer_norm"),
                   **extra)  # fmt: skip

    enc, dec = "model.encoder", "model.decoder"
    encoder = _ns(conv1=lin(f"{enc}.conv1"), conv2=lin(f"{enc}.conv2"), embed_positions=lin(f"{enc}.embed_positions"),
                  layer_norm=lin(f"{enc}.layer_norm"),
                  layers=[layer(f"{enc}.layers.{i}", False) for i in range(cfg["encoder_layers"])])  # fmt: skip
    embed = lin(f"{dec}.embed_tokens")
    decoder = _ns(embed_tokens=embed, embed_positions=lin(f"{dec}.embed_positions"),
                  layer_norm=lin(f"{dec}.layer_norm"),
                  layers=[layer(f"{dec}.layers.{i}", True) for i in range(cfg["decoder_layers"])])  # fmt: skip
    proj = lin("proj_out") if "proj_out.weight" in ckpt.entries else _ns(weight=embed.weight, bias=None)
    gen_path = ckpt.folder / "generation_config.json"
    gen = json.loads(gen_path.read_text(encoding="utf-8")) if gen_path.is_file() else None
    return _ns(config=_ns(**cfg), model=_ns(encoder=encoder, decoder=decoder), proj_out=proj,
               generation_config=_ns(**gen) if gen else None, name_or_path=str(ckpt.folder))  # fmt: skip


class _VocabTokenizer:
    def __init__(self, vocab: Mapping[str, int]):
        self._vocab = dict(vocab)

    def get_vocab(self) -> dict[str, int]:
        return dict(self._vocab)


def convert_ct2(merged_dir: Path, out_dir: Path, quantization: str = "int8") -> dict:
    """Build a CTranslate2 Whisper model from a safetensors folder; copies the tokenizer and preprocessor files."""
    from ctranslate2.converters.transformers import WhisperLoader  # noqa: PLC0415 - build-time only

    class NumpyWhisperLoader(WhisperLoader):
        def set_linear(self, spec: Any, module: Any, quant_type: Any = None) -> None:
            spec.weight = module.weight
            if getattr(module, "bias", None) is not None:
                spec.bias = module.bias

    ckpt = Checkpoint(Path(merged_dir))
    if ckpt.config.get("model_type") != "whisper":
        raise MergeRefused(f"{merged_dir}: only Whisper checkpoints convert here")
    spec = NumpyWhisperLoader()(whisper_view(ckpt), _VocabTokenizer(load_vocabulary(ckpt.folder)))
    spec.validate()
    spec.optimize(quantization=quantization)
    out_dir.mkdir(parents=True, exist_ok=True)
    spec.save(str(out_dir))
    for side in ("tokenizer.json", "preprocessor_config.json"):
        if (ckpt.folder / side).is_file():
            shutil.copyfile(ckpt.folder / side, out_dir / side)
    model = out_dir / "model.bin"
    return {"quantization": quantization, "model.bin": sha256_file(model), "bytes": model.stat().st_size}


def main(argv: Sequence[str]) -> int:
    if len(argv) >= 3 and argv[0] == "merge":
        recipe = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
        print(json.dumps(merge_checkpoints(recipe, Path(argv[2])), indent=1))
        return 0
    if len(argv) >= 3 and argv[0] == "convert":
        quant = argv[argv.index("--quantization") + 1] if "--quantization" in argv else "int8"
        print(json.dumps(convert_ct2(Path(argv[1]), Path(argv[2]), quant), indent=1))
        return 0
    print("usage: voice_merge.py merge RECIPE.json OUT_DIR | convert MERGED_DIR CT2_DIR [--quantization Q]",
          file=sys.stderr)  # fmt: skip
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
