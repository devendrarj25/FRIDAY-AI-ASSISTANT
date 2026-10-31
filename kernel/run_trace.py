"""A redacted, local, opt-in record of what the kernel did for one turn.

Off unless ``FRIDAY_RUN_TRACE=1``. One JSON line per event in ``<FRIDAY_ROOT>/logs/run-trace.jsonl`` (or the
folder named by ``FRIDAY_RUN_TRACE_DIR``). It stores the run id the desktop sent, the event name and numbers
(model id, milliseconds, counts) and never prompt text, answers, tool arguments, paths or keys. There is no
exporter and no network; the file is only ever read from this PC.
"""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path

RUN_ID = re.compile(r"^[\w.-]{1,64}$")
MAX_BYTES = 2_000_000
#: Fields a caller may attach. Anything else is dropped so content can never be logged by accident.
ALLOWED = {"model", "ms", "count", "ok", "effort", "tools", "errors", "provider"}


def enabled() -> bool:
    return os.environ.get("FRIDAY_RUN_TRACE") == "1"


def valid_run_id(raw: object) -> str | None:
    return raw if isinstance(raw, str) and RUN_ID.match(raw) else None


def trace_file() -> Path:
    base = os.environ.get("FRIDAY_RUN_TRACE_DIR") or str(Path(os.environ.get("FRIDAY_ROOT", ".")) / "logs")
    return Path(base) / "run-trace.jsonl"


def clean(fields: dict) -> dict:
    out: dict = {}
    for key, value in fields.items():
        if key not in ALLOWED:
            continue
        if isinstance(value, bool) or isinstance(value, (int, float)):
            out[key] = value
        elif isinstance(value, str):
            out[key] = value[:80] if re.match(r"^[\w.:/@+-]*$", value[:80]) else "redacted"
        elif isinstance(value, list):
            out[key] = [str(item)[:40] for item in value[:20] if re.match(r"^[\w.:-]*$", str(item)[:40])]
    return out


def record(run_id: object, event: str, **fields: object) -> bool:
    """Append one line when tracing is on and the run id is well formed. Never raises into a turn."""
    rid = valid_run_id(run_id)
    if not enabled() or rid is None:
        return False
    try:
        path = trace_file()
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() and path.stat().st_size > MAX_BYTES:
            path.replace(path.with_suffix(".jsonl.old"))
        line = {
            "at": round(time.time(), 3),
            "runId": rid,
            "event": re.sub(r"[^\w.-]", "_", event)[:40],
            **clean(fields),
        }
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(line, separators=(",", ":")) + "\n")
        return True
    except OSError:
        return False
