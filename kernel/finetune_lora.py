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
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")


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
    with open(path, "r", encoding="utf-8") as handle:
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


def main() -> None:
    parser = argparse.ArgumentParser(description="FRIDAY local LoRA/QLoRA fine-tuning")
    parser.add_argument("--config", required=True)
    args = parser.parse_args()

    try:
        with open(args.config, "r", encoding="utf-8") as handle:
            job = json.load(handle)
    except OSError as error:
        fail(f"Could not read the training job: {error}")
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
    cuda = bool(getattr(__import__("torch"), "cuda").is_available())
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
        model = AutoModelForCausalLM.from_pretrained(
            base_model, trust_remote_code=False, **load_kwargs
        )
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
        text = (
            f"<|user|>\n{example['prompt']}\n<|assistant|>\n{example['response']}"
            f"{tokenizer.eos_token or ''}"
        )
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

    emit(
        "done",
        output=output_dir,
        examples=len(rows),
        loss=float(getattr(result, "training_loss", 0.0) or 0.0),
    )


if __name__ == "__main__":
    main()
