"""
FRIDAY · local LoRA / QLoRA fine-tuning

Trains a small adapter on FRIDAY's OWN experience data, entirely on this PC.
Nothing is uploaded: the dataset comes from the local experience store, the
base model comes from the local models folder or the local Hugging Face cache,
and the finished adapter is written under <FRIDAY_ROOT>/models/adapters/.

Usage:
    python finetune_lora.py --config <path to job json>

The job JSON is written by electron/finetune.cjs and looks like:

    {
      "id": "ft-...",
      "base": "Qwen/Qwen2.5-1.5B-Instruct",   # local path or HF id
      "dataset": "C:/FRIDAY/database/finetune/ft-....jsonl",
      "output": "C:/FRIDAY/models/adapters/ft-...",
      "epochs": 2,
      "learningRate": 0.0002,
      "rank": 16,
      "quantised": true                       # QLoRA (4-bit) when possible
    }

Progress is printed as one JSON object per line on stdout so the desktop app
can show a real progress bar instead of a spinner.

A finished adapter is only kept when it passes the gate: `eval.json` holds its
scores, `gate` refuses any score that dropped against the current model, and
`rollback_adapter` removes a refused adapter while the previous one stays. The
adapter is converted to GGUF by a pinned llama.cpp script that runs from the
separate trainer environment, never from the voice environment: torch, peft and
transformers are imported only inside the trainer entry, so this module imports
cleanly where none of them is installed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
from collections.abc import Callable, Mapping
from pathlib import Path

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")


# llama.cpp release the convert script is taken from. The script's sha256 is pinned HERE, in code: a job file may
# repeat it but never replace it. None means no pin is known and the conversion refuses (fail closed).
LLAMA_CPP_TAG = "b12230"
# sha256 of convert_lora_to_gguf.py at tag b12230 (ggml-org/llama.cpp), read from raw.githubusercontent.com on
# 2026-11-27 (23258 bytes, git blob f9adecbb11d8dcecd64794fd16a2a6bf6458fe27); two fetches gave the same hash.
CONVERT_SCRIPT_SHA256: str | None = "ddb143ac34022b0646e51d9c35e9cfa3ec3d0a36091975ebc88f553dd18ca350"
SCORE_KEYS = ("heldout", "safety", "toolcall", "language")
EVAL_SCHEMA_VERSION = 1
CONVERT_TIMEOUT_SECONDS = 1800
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


class ConvertError(RuntimeError):
    """The GGUF conversion was refused or failed; nothing is left half converted."""


def emit(stage: str, **fields) -> None:
    """One line of machine-readable progress."""
    payload = {"stage": stage, "at": time.time(), **fields}
    print(json.dumps(payload), flush=True)


def fail(message: str, code: int = 1) -> None:
    emit("failed", error=message)
    sys.exit(code)


def load_dataset(path: str):
    """Read the JSONL experience dataset: {"prompt": ..., "response": ...}."""
    rows = []
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            prompt = str(row.get("prompt", "")).strip()
            response = str(row.get("response", "")).strip()
            if prompt and response:
                rows.append({"prompt": prompt, "response": response})
    return rows


# ---- probe: a short timed run before the real one ----------------------------------------------------------------


def _proxy_step() -> Callable[[], None]:
    """A small forward/backward pass that stands in for one training step; torch is loaded only here."""
    import torch

    weight = torch.randn(512, 512, requires_grad=True)
    batch = torch.randn(32, 512)

    def step() -> None:
        loss = (batch @ weight).square().mean()
        loss.backward()
        weight.grad = None

    return step


def probe(
    steps: int = 20,
    *,
    step_fn: Callable[[], object] | None = None,
    clock: Callable[[], float] = time.monotonic,
    planned_steps: int = 200,
    cap_seconds: float = 3600.0,
) -> dict:
    """Time `steps` steps and say go or no-go for this PC: go only when the planned run fits the time cap."""
    steps = max(1, int(steps))
    result: dict = {"steps": steps, "seconds": 0.0, "secPerStep": 0.0, "projectedSeconds": 0.0, "go": False}
    try:
        run_step = step_fn if step_fn is not None else _proxy_step()
        started = clock()
        for _ in range(steps):
            run_step()
        seconds = max(0.0, clock() - started)
    except ImportError as error:
        return {**result, "reason": f"torch is not installed in the trainer environment ({error})"}
    except Exception as error:
        return {**result, "reason": f"a probe step failed: {error}"}
    per_step = seconds / steps
    projected = per_step * max(1, int(planned_steps))
    go = projected <= cap_seconds
    reason = "fits the time cap" if go else f"projected {projected:.0f}s is over the {cap_seconds:.0f}s cap"
    return {
        **result,
        "seconds": seconds,
        "secPerStep": per_step,
        "projectedSeconds": projected,
        "go": go,
        "reason": reason,
    }


# ---- eval.json and the gate ---------------------------------------------------------------------------------------


def _score_ok(value: object) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value) and 0 <= value <= 1


def validate_eval(data: object) -> dict:
    """Check the frozen eval.json shape: {v, id, baseSha256, scores{heldout,safety,toolcall,language}, steps, at}."""
    if not isinstance(data, Mapping):
        raise ValueError("eval must be an object")
    if data.get("v") != EVAL_SCHEMA_VERSION:
        raise ValueError(f"eval v must be {EVAL_SCHEMA_VERSION}")
    if not isinstance(data.get("id"), str) or not _SAFE_ID.match(data["id"]):
        raise ValueError("eval id must be a plain adapter id")
    if not isinstance(data.get("baseSha256"), str) or not _SHA256.match(data["baseSha256"]):
        raise ValueError("eval baseSha256 must be 64 lowercase hex characters")
    scores = data.get("scores")
    if not isinstance(scores, Mapping) or set(scores) != set(SCORE_KEYS):
        raise ValueError(f"eval scores must be exactly {', '.join(SCORE_KEYS)}")
    for key in SCORE_KEYS:
        if not _score_ok(scores[key]):
            raise ValueError(f"eval score {key} must be a number from 0 to 1")
    steps = data.get("steps")
    if not isinstance(steps, int) or isinstance(steps, bool) or steps < 0:
        raise ValueError("eval steps must be a whole number of 0 or more")
    at = data.get("at")
    if not (isinstance(at, str) and at) and not (isinstance(at, int | float) and not isinstance(at, bool)):
        raise ValueError("eval at must be a timestamp")
    return {key: data[key] if key != "scores" else {k: scores[k] for k in SCORE_KEYS} for key in data}


def write_eval_json(path: str | os.PathLike[str], data: Mapping) -> dict:
    """Validate then write eval.json atomically; a refused shape writes nothing."""
    clean = validate_eval(data)
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(target.name + ".tmp")
    temp.write_text(json.dumps(clean, indent=2), encoding="utf-8")
    os.replace(temp, target)
    return clean


def _scores_of(value: Mapping) -> Mapping:
    inner = value.get("scores")
    return inner if isinstance(inner, Mapping) else value


def gate(before: Mapping, after: Mapping) -> dict:
    """No score may drop: any lower, missing or non-finite score in `after` refuses the adapter."""
    base = _scores_of(before)
    for key in SCORE_KEYS:
        if not _score_ok(base.get(key)):
            raise ValueError(f"the baseline is missing a valid {key} score")
    new = _scores_of(after)
    dropped = [key for key in SCORE_KEYS if not _score_ok(new.get(key)) or new[key] < base[key]]
    return {"ok": not dropped, "dropped": dropped}


# ---- GGUF conversion ------------------------------------------------------------------------------------------------


def run_subprocess(argv: list[str]) -> int:
    """The real runner: argv form, no shell, bounded time."""
    return subprocess.run(argv, check=False, timeout=CONVERT_TIMEOUT_SECONDS).returncode  # noqa: S603


def _inside(path: Path, folder: Path) -> bool:
    try:
        path.relative_to(folder)
    except ValueError:
        return False
    return True


def convert_to_gguf(
    adapter_dir: str | os.PathLike[str],
    runner: Callable[[list[str]], int],
    *,
    trainer_python: str,
    script: str | os.PathLike[str],
    script_sha256: str | None = None,
    base_dir: str,
    outtype: str = "f16",
) -> Path:
    """Convert a saved adapter to <adapter_dir>/adapter.gguf with the pinned llama.cpp script.

    The script must match the sha256 pinned in code (CONVERT_SCRIPT_SHA256) and runs with the separate trainer
    environment's Python, never the voice environment's. ``script_sha256`` is what a job file claims: None means
    the job said nothing; any other value must equal the code pin, it never overrides it. The runner takes an
    argv list and returns the exit code.
    """
    adapter = Path(adapter_dir)
    python = (trainer_python or "").strip()
    if not python:
        raise ConvertError("no trainer environment is configured")
    here = Path(sys.prefix).resolve()
    candidate = Path(python)
    if python == sys.executable or _inside(candidate.resolve(), here) or _inside(candidate.absolute(), here):
        raise ConvertError("the trainer must be its own environment, not the voice environment")
    pinned = (CONVERT_SCRIPT_SHA256 or "").strip().lower()
    if not _SHA256.match(pinned):
        raise ConvertError("no pinned sha256 is known for the convert script, so it will not run")
    if script_sha256 is not None and (script_sha256 or "").strip().lower() != pinned:
        raise ConvertError("the job's convert script sha256 differs from the one pinned in code")
    script_path = Path(script)
    if not script_path.is_file():
        raise ConvertError("the convert script must exist (its sha256 is pinned)")
    if hashlib.sha256(script_path.read_bytes()).hexdigest() != pinned:
        raise ConvertError(f"the convert script does not match its pinned sha256 (llama.cpp {LLAMA_CPP_TAG})")
    if not adapter.is_dir() or not (base_dir or "").strip():
        raise ConvertError("the adapter folder and the base model folder are both needed")
    out = adapter / "adapter.gguf"
    out.unlink(missing_ok=True)
    argv = [python, str(script_path), "--base", base_dir, "--outfile", str(out), "--outtype", outtype, str(adapter)]
    code = runner(argv)
    if code != 0:
        out.unlink(missing_ok=True)
        raise ConvertError(f"the convert script ended with exit code {code}")
    if not out.is_file() or out.stat().st_size == 0:
        out.unlink(missing_ok=True)
        raise ConvertError("the convert script did not write adapter.gguf")
    return out


# ---- rollback ---------------------------------------------------------------------------------------------------


def _kept_ids(root: Path) -> set[str]:
    try:
        active = json.loads((root / "active.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return set()
    if not isinstance(active, Mapping):
        return set()
    return {str(active[key]) for key in ("id", "previous") if active.get(key)}


def rollback_adapter(adapters_root: str | os.PathLike[str], adapter_id: str) -> bool:
    """Delete one new adapter folder. The active and the previous adapter, and anything outside the root, stay."""
    root = Path(adapters_root)
    if not isinstance(adapter_id, str) or not _SAFE_ID.match(adapter_id) or adapter_id in _kept_ids(root):
        return False
    target = root / adapter_id
    if target.is_symlink() or not target.is_dir() or not _inside(target.resolve(), root.resolve()):
        return False
    shutil.rmtree(target)
    return True


def finish_candidate(
    adapters_root: str | os.PathLike[str], adapter_id: str, result: Mapping, *, before: Mapping
) -> dict:
    """Write eval.json for the candidate, run the gate, and roll the candidate back when any score dropped."""
    root = Path(adapters_root)
    if result.get("id") != adapter_id:
        raise ValueError("the eval belongs to a different adapter")
    verdict = gate(before, result)
    if not verdict["ok"]:
        return {"promoted": False, "dropped": verdict["dropped"], "rolledBack": rollback_adapter(root, adapter_id)}
    write_eval_json(root / adapter_id / "eval.json", result)
    return {"promoted": True, "dropped": [], "rolledBack": False}


def main() -> None:
    parser = argparse.ArgumentParser(description="FRIDAY local LoRA/QLoRA fine-tuning")
    parser.add_argument("--config", required=True)
    args = parser.parse_args()

    try:
        with open(args.config, encoding="utf-8") as handle:
            job = json.load(handle)
    except OSError as error:
        fail(f"Could not read the training job: {error}")
        return

    mode = job.get("mode")
    if mode == "probe":
        emit(
            "probe",
            **probe(
                int(job.get("steps", 20)),
                planned_steps=int(job.get("plannedSteps", 200)),
                cap_seconds=float(job.get("capSeconds", 3600)),
            ),
        )
        return
    if mode == "gate":
        try:
            verdict = finish_candidate(job["adaptersRoot"], job["id"], job["eval"], before=job["before"])
        except (KeyError, ValueError) as error:
            fail(f"The adapter gate could not run: {error}")
            return
        emit("gated", id=job["id"], **verdict)
        return

    dataset_path = job.get("dataset")
    output_dir = job.get("output")
    base_model = job.get("base")
    if not (dataset_path and output_dir and base_model):
        fail("The training job is missing base / dataset / output.")
        return

    emit("preparing", detail="Checking the local training libraries")
    try:
        import torch  # noqa: F401
        from datasets import Dataset
        from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
        from transformers import (
            AutoModelForCausalLM,
            AutoTokenizer,
            DataCollatorForLanguageModeling,
            Trainer,
            TrainerCallback,
            TrainingArguments,
        )
    except ImportError as error:
        fail(
            "Local fine-tuning needs torch, transformers, datasets and peft. "
            f"Install them from Install Manager, then try again. ({error})"
        )
        return

    rows = load_dataset(dataset_path)
    if len(rows) < 8:
        fail(
            f"Only {len(rows)} verified example(s) available — that is not enough to "
            "train on. Keep working normally and try again later."
        )
        return
    emit("dataset", examples=len(rows))

    quantised = bool(job.get("quantised", True))
    cuda = bool(__import__("torch").cuda.is_available())
    load_kwargs = {}
    if quantised and cuda:
        try:
            from transformers import BitsAndBytesConfig

            load_kwargs["quantization_config"] = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_compute_dtype=__import__("torch").bfloat16,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_use_double_quant=True,
            )
            emit("mode", detail="QLoRA (4-bit) on GPU")
        except Exception as error:  # bitsandbytes missing or unusable
            emit("mode", detail=f"LoRA (bitsandbytes unavailable: {error})")
    else:
        emit("mode", detail="LoRA on CPU" if not cuda else "LoRA on GPU")

    emit("loading", detail=f"Loading {base_model}")
    try:
        tokenizer = AutoTokenizer.from_pretrained(base_model, trust_remote_code=False)
        if tokenizer.pad_token is None:
            tokenizer.pad_token = tokenizer.eos_token
        model = AutoModelForCausalLM.from_pretrained(base_model, trust_remote_code=False, **load_kwargs)
    except Exception as error:
        fail(f"The base model could not be loaded locally: {error}")
        return

    if "quantization_config" in load_kwargs:
        model = prepare_model_for_kbit_training(model)

    rank = int(job.get("rank", 16))
    peft_config = LoraConfig(
        r=rank,
        lora_alpha=rank * 2,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
    )
    model = get_peft_model(model, peft_config)

    max_len = int(job.get("maxLength", 1024))

    def render(example):
        text = f"<|user|>\n{example['prompt']}\n<|assistant|>\n{example['response']}{tokenizer.eos_token or ''}"
        return tokenizer(text, truncation=True, max_length=max_len)

    data = Dataset.from_list(rows).map(render, remove_columns=["prompt", "response"])

    epochs = float(job.get("epochs", 2))
    total_steps = max(1, int(len(rows) * epochs))

    class Progress(TrainerCallback):
        def on_log(self, _args, state, _control, logs=None, **_kwargs):
            emit(
                "training",
                step=int(state.global_step),
                total=total_steps,
                loss=float((logs or {}).get("loss", 0.0)),
            )

    training_args = TrainingArguments(
        output_dir=os.path.join(output_dir, "checkpoints"),
        num_train_epochs=epochs,
        per_device_train_batch_size=int(job.get("batchSize", 1)),
        gradient_accumulation_steps=int(job.get("gradientAccumulation", 4)),
        learning_rate=float(job.get("learningRate", 2e-4)),
        logging_steps=1,
        save_strategy="no",
        report_to=[],
        fp16=cuda,
    )

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=data,
        data_collator=DataCollatorForLanguageModeling(tokenizer, mlm=False),
        callbacks=[Progress()],
    )

    emit("training", step=0, total=total_steps, loss=0.0)
    try:
        result = trainer.train()
    except Exception as error:
        fail(f"Training stopped: {error}")
        return

    os.makedirs(output_dir, exist_ok=True)
    model.save_pretrained(output_dir)
    tokenizer.save_pretrained(output_dir)
    with open(os.path.join(output_dir, "friday-adapter.json"), "w", encoding="utf-8") as handle:
        json.dump(
            {
                "id": job.get("id"),
                "base": base_model,
                "examples": len(rows),
                "epochs": epochs,
                "rank": rank,
                "loss": float(getattr(result, "training_loss", 0.0) or 0.0),
                "finishedAt": time.time(),
            },
            handle,
            indent=2,
        )

    convert = job.get("gguf")
    if convert:
        emit("converting", detail=f"Converting the adapter to GGUF (llama.cpp {LLAMA_CPP_TAG})")
        try:
            convert_to_gguf(
                output_dir,
                run_subprocess,
                trainer_python=str(convert.get("trainerPython", "")),
                script=str(convert.get("script", "")),
                script_sha256=None if convert.get("scriptSha256") is None else str(convert.get("scriptSha256")),
                base_dir=str(convert.get("baseDir", "")),
            )
        except ConvertError as error:
            fail(f"The adapter could not be converted to GGUF: {error}")
            return

    emit(
        "done",
        output=output_dir,
        examples=len(rows),
        loss=float(getattr(result, "training_loss", 0.0) or 0.0),
    )


if __name__ == "__main__":
    main()
