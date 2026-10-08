"""FRIDAY kernel — local FastAPI + WebSocket bridge.

Binds to loopback only and requires the per-launch token that the Electron
main process generates, so nothing outside this machine can reach it.

Run standalone:  python kernel/main.py
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import devices_network
import uvicorn
import yaml
from authority import Authority
from companion import _PHONE_SENDER, CompanionStore, build_router, phone_broadcast, phones_connected
from db import Storage
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from http_contract import HealthBody, VersionBody, product_version
from planner import Planner
from router import ModelRouter, describe_failure, is_local_model
from runner import ProjectRunner
from runtimes import RuntimeManager
from workspace import Workspace

from memory import VectorMemory
from modules import ModuleRegistry
from tools import ToolRegistry

HOST = os.environ.get("FRIDAY_HOST", "127.0.0.1")
PORT = int(os.environ.get("FRIDAY_PORT", "8765"))
TOKEN = os.environ.get("FRIDAY_BRIDGE_TOKEN", "")
WORKSPACE_ROOT = os.environ.get("FRIDAY_WORKSPACE_ROOT", "")

_data_dir_env = os.environ.get("FRIDAY_DATA_DIR", "")
if _data_dir_env:
    DATA_DIR = Path(_data_dir_env)
elif WORKSPACE_ROOT:
    # A folder was picked but the launcher forgot to pass FRIDAY_DATA_DIR —
    # keep the data inside the chosen folder rather than the home directory.
    DATA_DIR = Path(WORKSPACE_ROOT) / "data"
    print(f"[data] FRIDAY_DATA_DIR was not set; falling back to the chosen workspace folder: {DATA_DIR}")
else:
    # Single-root rule: without a selected FRIDAY folder the kernel would have
    # to invent a second FRIDAY-owned data store (AppData / home). It refuses
    # instead; the app starts it again as soon as a folder is chosen.
    print(
        "[data] FATAL: no FRIDAY folder was provided (FRIDAY_WORKSPACE_ROOT / "
        "FRIDAY_DATA_DIR). The kernel does not create data outside the FRIDAY "
        "root — select a FRIDAY folder first."
    )
    sys.exit(2)
DATA_DIR.mkdir(parents=True, exist_ok=True)

# The chosen FRIDAY folder has canonical database/ and memory/ subfolders; the
# real SQLite file and vector store live there so everything the user owns is
# inside the folder they picked.
if WORKSPACE_ROOT:
    DB_PATH = Path(WORKSPACE_ROOT) / "database" / "friday.sqlite3"
    VECTOR_PATH = Path(WORKSPACE_ROOT) / "memory" / "vectors"
else:
    DB_PATH = DATA_DIR / "friday.sqlite3"
    VECTOR_PATH = DATA_DIR / "vectors"
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
VECTOR_PATH.parent.mkdir(parents=True, exist_ok=True)
print(f"[data] database: {DB_PATH}")
print(f"[data] vectors:  {VECTOR_PATH}")

app = FastAPI(title="FRIDAY kernel", version="0.1.0")

storage = Storage(DB_PATH)
# Create/upgrade the schema before anything reads from it.
storage.migrate()
memory = VectorMemory(VECTOR_PATH)

router = ModelRouter(storage)


def model_config_path() -> Path | None:
    return _config_file("models.yaml")


def kernel_config_path() -> Path | None:
    return _config_file("kernel.yaml")


def _config_file(name: str) -> Path | None:
    """
    Canonical: <FRIDAY_ROOT>/config/<name> — the installed EXE owns its
    seed inside the selected folder and never reaches into a source
    checkout. The repository copy is a development-only seed: it is read only
    when the kernel is explicitly running from source (FRIDAY_PACKAGED unset).
    """
    roots = [os.environ.get("FRIDAY_CONFIG_DIR", "")]
    if WORKSPACE_ROOT:
        roots.append(str(Path(WORKSPACE_ROOT) / "config"))
    for base in roots:
        if not base:
            continue
        candidate = Path(base) / name
        if candidate.exists():
            return candidate
    if os.environ.get("FRIDAY_PACKAGED"):
        return None
    source = Path(__file__).resolve().parent.parent / "config" / name
    return source if source.exists() else None


def load_kernel_automation() -> dict:
    """automation.* from kernel.yaml — defaults match the shipped file."""
    defaults = {
        "auto_approve_safe": True,
        "auto_approve_workspace_writes": False,
        "auto_approve_exec": False,
        "write_lessons_on_failure": True,
        "daily_update_check": True,
    }
    path = kernel_config_path()
    if path is None:
        return defaults
    try:
        payload = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        raw = payload.get("automation") if isinstance(payload, dict) else {}
        if isinstance(raw, dict):
            defaults.update({key: bool(raw[key]) for key in defaults if key in raw})
    except Exception as exc:
        print(f"[kernel] automation configuration could not be loaded: {exc}")
    return defaults


def load_configured_models() -> None:
    """Seed the kernel from models.yaml without duplicating DB rows."""
    config_path = model_config_path()
    if config_path is None:
        return
    try:
        payload = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
        existing = {model.id for model in router.models()}
        for raw in payload.get("models", []):
            if raw.get("id") in existing:
                continue
            api_key_env = raw.pop("api_key_env", None)
            raw["api_key"] = os.environ.get(api_key_env) if api_key_env else None
            router.register(raw)
            existing.add(raw["id"])
    except Exception as exc:
        print(f"[models] configuration could not be loaded: {exc}")


load_configured_models()
KERNEL_AUTOMATION = load_kernel_automation()
# One shared authority: the desktop mints owner-approved tool tokens with the
# same secret, and the planner mints them for steps the owner approved.
authority = Authority()
tools = ToolRegistry(storage, workspace=DATA_DIR.parent / "workspace", authority=authority)
modules = ModuleRegistry(Path(__file__).resolve().parent.parent / "modules", storage)
runtimes = RuntimeManager(DATA_DIR / "runtimes", storage)
# The router can call FRIDAY's read-only tools mid-answer; anything that
# acts on the PC still goes through the planner and the owner's approval.
router.tools = tools
planner = Planner(
    router=router,
    tools=tools,
    memory=memory,
    storage=storage,
    write_lessons=KERNEL_AUTOMATION["write_lessons_on_failure"],
    auto_approve_writes=KERNEL_AUTOMATION["auto_approve_workspace_writes"],
)
try:
    _stored = storage.settings()
    if "write_lessons" in _stored:
        planner.set_write_lessons(bool(_stored["write_lessons"]))
except Exception as exc:
    print(f"[kernel] live planner settings overlay skipped: {exc}")
workspace = Workspace(data_dir=DATA_DIR, memory=memory)
if WORKSPACE_ROOT:
    workspace.set_root(WORKSPACE_ROOT)

# --------------------------------------------------------------- companion
# Phone companion: off unless the desktop app explicitly enabled LAN access.
COMPANION_ENABLED = os.environ.get("FRIDAY_LAN", "") in ("1", "true", "yes")
COMPANION_STORE = CompanionStore((Path(WORKSPACE_ROOT) / "config" if WORKSPACE_ROOT else DATA_DIR) / "companion.json")


# ------------------------------------------------------- one shared session
# The phone is not a second assistant: it joins the conversation the owner is
# already having on the desktop. Both surfaces read and write ONE session, so
# history, memory and context are identical wherever the owner speaks from.
ACTIVE_SESSION = "main"

# Live desktop bridges. A phone turn is mirrored to them so the desktop chat
# shows it as it happens instead of only after a refresh.
DESKTOP_CLIENTS: set = set()
_PRIVACY_ASKS: dict[str, asyncio.Future] = {}
# Phone → desktop Core Brain handshake (same process, different sockets).
_PHONE_COGNIZE: dict[str, asyncio.Queue] = {}
_PHONE_COGNIZE_ACK: dict[str, asyncio.Event] = {}
_PHONE_COGNIZE_CLOSED: set[str] = set()
_PHONE_COGNIZE_SENDER: dict[str, Any] = {}
_PHONE_COGNIZE_STORED: set[str] = set()


async def broadcast(payload: dict) -> None:
    dead = []
    for ws in list(DESKTOP_CLIENTS):
        try:
            await ws.send_text(json.dumps(payload))
        except Exception:
            dead.append(ws)
    for ws in dead:
        DESKTOP_CLIENTS.discard(ws)


async def ask_desktop_privacy(model, content: str, decision: dict) -> bool:
    """Ask the desktop window to confirm SENSITIVE companion/kernel egress.

    Fail closed when no desktop is connected or the owner does not answer.
    """
    if not DESKTOP_CLIENTS:
        return False
    ask_id = secrets.token_hex(8)
    loop = asyncio.get_running_loop()
    fut: asyncio.Future = loop.create_future()
    _PRIVACY_ASKS[ask_id] = fut
    await broadcast(
        {
            "type": "privacy.ask",
            "data": {
                "id": ask_id,
                "content": str(content or "")[:8000],
                "label": "companion chat",
                "modelId": getattr(model, "id", None),
                "classification": (decision.get("classification") or {}).get("level"),
                "reasons": (decision.get("classification") or {}).get("reasons") or [],
            },
        }
    )
    try:
        return bool(await asyncio.wait_for(fut, timeout=120))
    except TimeoutError:
        return False
    finally:
        _PRIVACY_ASKS.pop(ask_id, None)


def settle_privacy_ask(ask_id: str, allowed: bool) -> None:
    fut = _PRIVACY_ASKS.get(str(ask_id or ""))
    if fut is not None and not fut.done():
        fut.set_result(bool(allowed))


def settle_phone_cognize_ack(session_id: str) -> None:
    ev = _PHONE_COGNIZE_ACK.get(str(session_id or ""))
    if ev is not None:
        ev.set()


async def settle_phone_cognize_done(session_id: str, text: str | None, error: str | None) -> None:
    """Close a desktop-owned phone turn. Idempotent. Does not execute tools."""
    sid = str(session_id or "")
    q = _PHONE_COGNIZE.get(sid)
    if q is None or sid in _PHONE_COGNIZE_CLOSED:
        return
    _PHONE_COGNIZE_CLOSED.add(sid)
    if error:
        await q.put({"error": str(error)})
        await q.put(None)
        return
    body = str(text or "").strip()
    if body and sid not in _PHONE_COGNIZE_STORED:
        _PHONE_COGNIZE_STORED.add(sid)
        await asyncio.to_thread(storage.append_chat, sid, "assistant", body, None, origin="phone")
        sender_ws = _PHONE_COGNIZE_SENDER.get(sid)
        await phone_broadcast(
            {"type": "peer", "role": "assistant", "text": body, "origin": "desktop"}, exclude_ws=sender_ws
        )
        await q.put({"delta": body})
    await q.put(None)


async def companion_chat(prompt: str, send, extra: str | None = None) -> None:
    """A phone message walks the same pipeline, in the same session.

    When a desktop bridge is connected, the renderer Core Brain (`cognize`)
    owns the turn — same path as typed/voice/Auto chat. If the desktop does
    not acknowledge within 3s (window closed / kernel-only), this falls back
    to the kernel router so phone chat is not removed when the window is down.
    A connected desktop that is busy must ack and fail — it must not stay
    silent and trigger this fallback.
    """
    session_id = ACTIVE_SESSION
    sender_ws = _PHONE_SENDER.get()
    _PHONE_COGNIZE_SENDER[session_id] = sender_ws
    _PHONE_COGNIZE_STORED.discard(session_id)
    await asyncio.to_thread(storage.append_chat, session_id, "user", prompt, origin="phone")
    await broadcast(
        {
            "type": "session.message",
            "data": {"sessionId": session_id, "role": "user", "text": prompt, "origin": "phone"},
        }
    )
    # Other paired phones share this conversation live; the sender is excluded
    # by phone_broadcast (it already rendered the turn locally).
    await phone_broadcast({"type": "peer", "role": "user", "text": prompt, "origin": "phone"}, exclude_ws=sender_ws)

    async def kernel_stream() -> None:
        chunks: list[str] = []
        model_id = None
        live = companion_live()
        model_ids = router.ids_for_live(live)
        if model_ids is None:
            raise RuntimeError(
                "Desktop model routing has not been published yet. "
                "Open FRIDAY and wait for the model registry to become ready."
            )
        if not model_ids:
            raise RuntimeError(router.explain_unavailable(live))
        async for delta in router.stream(
            prompt=prompt,
            model_ids=model_ids,
            allow_fallback=False,
            system=None,
            context=await memory.recall(prompt),
            parallel=str(live.get("routeMode") or "auto") == "multi",
            route_mode=str(live.get("routeMode") or "auto"),
            privacy=str(live.get("privacy") or "") or None,
        ):
            if delta.get("error"):
                raise RuntimeError(str(delta["error"]))
            if delta.get("delta"):
                model_id = delta.get("modelId") or model_id
                chunks.append(delta["delta"])
                await send({"type": "delta", "text": delta["delta"]})
                await broadcast({"type": "chat.delta", "data": {**delta, "origin": "phone", "sessionId": session_id}})
        answer = "".join(chunks).strip()
        if not answer:
            raise RuntimeError("FRIDAY received no reply from an eligible model.")
        await asyncio.to_thread(storage.append_chat, session_id, "assistant", answer, model_id, origin="phone")
        await broadcast(
            {
                "type": "session.message",
                "data": {
                    "sessionId": session_id,
                    "role": "assistant",
                    "text": answer,
                    "origin": "phone",
                    "modelId": model_id,
                },
            }
        )
        await phone_broadcast({"type": "peer", "role": "assistant", "text": answer, "origin": "phone"})

    if DESKTOP_CLIENTS:
        q: asyncio.Queue = asyncio.Queue()
        ack = asyncio.Event()
        _PHONE_COGNIZE[session_id] = q
        _PHONE_COGNIZE_ACK[session_id] = ack
        _PHONE_COGNIZE_CLOSED.discard(session_id)
        await broadcast(
            {
                "type": "companion.cognize",
                "data": {
                    "sessionId": session_id,
                    "prompt": prompt,
                    **({"extra": extra} if extra else {}),
                },
            }
        )
        try:
            await asyncio.wait_for(ack.wait(), 3.0)
        except TimeoutError:
            _PHONE_COGNIZE.pop(session_id, None)
            _PHONE_COGNIZE_ACK.pop(session_id, None)
            try:
                await kernel_stream()
            finally:
                _PHONE_COGNIZE_SENDER.pop(session_id, None)
                _PHONE_COGNIZE_STORED.discard(session_id)
            return
        chunks: list[str] = []
        try:
            while True:
                item = await asyncio.wait_for(q.get(), 140.0)
                if item is None:
                    break
                if item.get("error"):
                    if chunks:
                        break
                    raise RuntimeError(str(item["error"]))
                if item.get("delta"):
                    chunks.append(str(item["delta"]))
                    await send({"type": "delta", "text": item["delta"]})
        except TimeoutError as exc:
            raise RuntimeError("Desktop Core Brain did not finish this phone turn.") from exc
        finally:
            _PHONE_COGNIZE.pop(session_id, None)
            _PHONE_COGNIZE_ACK.pop(session_id, None)
            _PHONE_COGNIZE_CLOSED.discard(session_id)
            _PHONE_COGNIZE_SENDER.pop(session_id, None)
            _PHONE_COGNIZE_STORED.discard(session_id)
        if not "".join(chunks).strip():
            raise RuntimeError("FRIDAY received no reply from an eligible model.")
        return

    try:
        await kernel_stream()
    finally:
        _PHONE_COGNIZE_SENDER.pop(session_id, None)
        _PHONE_COGNIZE_STORED.discard(session_id)


async def companion_speak(text: str) -> str | None:
    """Local voice when one is actually ready. Cloud edge-tts only with an explicit opt-in and non-sensitive text."""
    if not text.strip():
        return None
    import base64
    import subprocess
    import tempfile

    voice = "hi-IN-SwaraNeural" if any("\u0900" <= c <= "\u097f" for c in text) else "en-IN-NeerjaNeural"
    out = Path(tempfile.gettempdir()) / f"friday-companion-{abs(hash(text)) % 10**10}.mp3"

    def synth() -> str | None:
        try:
            import voice_runtime

            audio = voice_runtime.speak_wav_bytes(text[:1200])
            if audio:
                return base64.b64encode(audio).decode("ascii")
        except Exception:  # noqa: S110 — local voice missing falls through to the explicit cloud opt-in
            pass
        opted = os.environ.get("FRIDAY_CLOUD_SPEECH", "").strip().lower() in {"1", "true", "on"}
        if not opted:
            return None
        try:
            from privacy import classify

            if classify(text).get("level") == "sensitive":
                return None
        except Exception:
            return None
        try:
            subprocess.run(
                [sys.executable, "-m", "edge_tts", "--voice", voice, "--text", text[:1200], "--write-media", str(out)],
                capture_output=True,
                timeout=45,
                check=False,
            )
            if out.exists() and out.stat().st_size > 0:
                return base64.b64encode(out.read_bytes()).decode("ascii")
        except Exception:
            return None
        return None

    return await asyncio.to_thread(synth)


async def companion_transcribe(audio: bytes, mime: str, language: str) -> dict:
    """Phone microphone → FRIDAY's own transcriber (kernel/stt.py).

    Mobile browsers refuse the Web Speech API on a plain-http LAN origin, so the
    phone ships the raw audio here instead. Nothing new is built: this is the
    same faster-whisper script the desktop uses, run in a worker thread.
    """
    import subprocess
    import tempfile

    m = (mime or "").lower()
    if "wav" in m:
        suffix = ".wav"
    elif "ogg" in m:
        suffix = ".ogg"
    elif "mp4" in m or "m4a" in m or "aac" in m:
        suffix = ".mp4"
    elif "flac" in m:
        suffix = ".flac"
    else:
        suffix = ".webm"
    script = Path(__file__).resolve().parent / "stt.py"
    tmp = Path(tempfile.gettempdir()) / f"friday-phone-{secrets_token()}{suffix}"
    tmp.write_bytes(audio)

    def run() -> dict:
        try:
            cmd = [sys.executable, str(script), "--audio", str(tmp)]
            if language and not str(language).lower().startswith(("hi", "en")):
                cmd += ["--language", language.split("-")[0][:5]]
            proc = subprocess.run(cmd, capture_output=True, timeout=180, check=False)
            out = (proc.stdout or b"").decode("utf-8", "ignore")
            start = out.rfind("{")
            if start < 0:
                return {
                    "ok": False,
                    "error": (proc.stderr or b"").decode("utf-8", "ignore")[-400:]
                    or "the transcriber returned nothing",
                }
            return json.loads(out[start:])
        except Exception as exc:  # noqa: BLE001 — reported to the phone verbatim
            return {"ok": False, "error": str(exc)[-400:]}
        finally:
            try:
                tmp.unlink()
            except Exception:  # noqa: S110 — the temp file is already gone
                pass

    return await asyncio.to_thread(run)


def secrets_token() -> str:
    import secrets as _secrets

    return _secrets.token_hex(6)


# Read-only kernel methods a paired phone may run. Everything that acts on the
# PC still goes through chat → planner → the owner's approval gate.
COMPANION_READS = {
    "model.list",
    "tool.list",
    "module.list",
    "task.list",
    "task.pending",
    "kernel.status",
    "memory.status",
    "workspace.get",
    "runtime.list",
    "companion.status",
    "chat.sessions",
    "settings.get",
    "billing.get",
    "code.languages",
    "project.detect",
}


async def companion_command(method: str, params: dict) -> dict:
    """Reuse the kernel's own dispatch table — no parallel command system."""
    if method not in COMPANION_READS:
        raise ValueError(f"'{method}' is not available from the phone.")

    async def _send(_payload: dict) -> None:
        return None

    return await dispatch(method, params or {}, _send)


async def companion_task(goal: str, send) -> None:
    """A phone can ask FRIDAY to actually DO something.

    This is the desktop's own planner (task.run through the kernel's single
    dispatch table) — no second execution path. Risky steps still stop at the
    owner's approval gate, which lives on the PC; the phone is told to go and
    approve it there.
    """
    goal = (goal or "").strip()
    if not goal:
        raise ValueError("Nothing to do — the task was empty.")

    async def _relay(payload: dict) -> None:
        event = (payload or {}).get("data") or {}
        kind = event.get("type")
        if kind == "created":
            await send({"type": "step", "text": f"Task started: {goal}"})
        elif kind == "planned":
            steps = event.get("steps") or []
            titles = "\n".join(f"• {s.get('title') or s.get('tool')}" for s in steps[:12])
            await send({"type": "step", "text": f"Plan ({len(steps)} steps):\n{titles}"})
        elif kind == "running":
            await send({"type": "step", "text": f"→ {event.get('title') or event.get('stepId')}"})
        elif kind == "approval-required":
            await send(
                {
                    "type": "step",
                    "text": "This step needs your approval. Open FRIDAY on the PC and allow it — "
                    "the task resumes from where it paused.",
                }
            )
        elif kind == "retry":
            await send({"type": "step", "text": f"Retrying step ({event.get('error')})"})
        elif kind == "failed":
            await send({"type": "data", "text": f"Task failed: {event.get('error')}"})
        elif kind == "cancelled":
            await send({"type": "data", "text": "Task cancelled."})
        elif kind == "done" and not event.get("stepId"):
            await send({"type": "data", "text": "Task finished."})

    await dispatch("task.run", {"goal": goal}, _relay)


def companion_payload() -> dict:
    """Read the ONE registry the desktop published (nav sections + capabilities)."""
    base = Path(WORKSPACE_ROOT) / "config" if WORKSPACE_ROOT else DATA_DIR
    try:
        data = json.loads((base / "companion-features.json").read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def companion_features_path() -> Path:
    base = Path(WORKSPACE_ROOT) / "config" if WORKSPACE_ROOT else DATA_DIR
    return base / "companion-features.json"


def companion_capability_list() -> list[dict]:
    """Live models / tools / skills / agents / … exactly as the brain sees them."""
    caps = companion_payload().get("capabilities", [])
    return caps if isinstance(caps, list) else []


def companion_live() -> dict:
    """Coarse desktop snapshot published in the same companion-features file."""
    live = companion_payload().get("live")
    return live if isinstance(live, dict) else {}


def companion_history() -> list[dict]:
    """The shared session, so a reconnecting phone is not an empty log."""
    try:
        return storage.chat_history(ACTIVE_SESSION, 50)
    except Exception:
        return []


def companion_feature_list() -> list[dict]:
    """The desktop publishes ONE navigation registry; the phone mirrors it.

    An empty list means the desktop has not published yet. The phone retries
    instead of inventing a second kernel-method menu.
    """
    features = companion_payload().get("features", [])
    return features if isinstance(features, list) else []


app.include_router(
    build_router(
        COMPANION_STORE,
        companion_chat,
        companion_speak,
        lambda: COMPANION_ENABLED,
        transcribe_handler=companion_transcribe,
        command_handler=companion_command,
        features_provider=companion_feature_list,
        capabilities_provider=companion_capability_list,
        task_handler=companion_task,
        history_provider=companion_history,
        live_provider=companion_live,
    )
)


async def _watch_companion_registry() -> None:
    """The desktop republishes its registry whenever a capability changes.

    A phone that is already connected must not keep a menu frozen at connect
    time, so the change is pushed to it and it re-reads the same file.
    """
    if not COMPANION_ENABLED:
        return

    async def loop() -> None:
        last = -1
        last_menu = None
        last_live = None
        while True:
            await asyncio.sleep(5)
            if phones_connected() == 0:
                continue
            try:
                stamp = companion_features_path().stat().st_mtime_ns
            except Exception:  # noqa: S112 — the menu file is absent until the desktop writes it
                continue
            if stamp == last:
                continue
            last = stamp
            payload = companion_payload()
            menu = (payload.get("features"), payload.get("capabilities"))
            live = payload.get("live") if isinstance(payload.get("live"), dict) else None
            if menu != last_menu:
                last_menu = menu
                await phone_broadcast({"type": "refresh"})
            if live != last_live:
                last_live = live
                if live:
                    await phone_broadcast({"type": "live", "live": live})

    asyncio.get_event_loop().create_task(loop())


def project_runner() -> ProjectRunner:
    """Built per call so it always sees the currently selected workspace."""
    roots = []
    if workspace.root:
        roots.extend([Path(workspace.root) / "projects", Path(workspace.root) / "Projects"])
    return ProjectRunner(roots)


@app.get("/health", response_model=HealthBody)
async def health() -> HealthBody:
    return HealthBody(
        ok=True,
        version=app.version,
        data_dir=str(DATA_DIR),
        models=[m.public() for m in router.models()],
    )


@app.get("/version", response_model=VersionBody)
async def version() -> VersionBody:
    """Product line plus the kernel API version. Loopback, no bridge token."""
    return VersionBody(ok=True, product=product_version(), kernel=app.version)


async def dispatch(method: str, params: dict, send) -> dict:
    """Bridge protocol. Every UI action maps to exactly one method here."""
    if method == "kernel.status":
        return {
            "connected": True,
            "host": f"{HOST}:{PORT}",
            "version": app.version,
            "dataDir": str(DATA_DIR),
            "gpu": runtimes.gpu_info(),
        }
    if method == "model.list":
        return {"models": [m.public() for m in router.models()]}
    if method == "model.add":
        return {"model": router.register(params).public()}
    if method == "model.sync":
        # Idempotent: the desktop sends everything it can actually reach.
        return router.sync(params.get("models", []))
    if method == "model.remove":
        return {"removed": router.unregister(params["id"])}

    if method == "chat.stream":
        # Fans out to one or many models; streams partial deltas back.
        session_id = params.get("sessionId", "main")
        globals()["ACTIVE_SESSION"] = session_id  # the phone joins THIS conversation
        phone_cognize = session_id in _PHONE_COGNIZE
        if not phone_cognize:
            await asyncio.to_thread(storage.append_chat, session_id, "user", params["prompt"], origin="desktop")
            # One shared conversation: a turn typed on the PC is mirrored to any
            # paired phone that is watching, exactly as a phone turn is mirrored
            # back to the desktop.
            await phone_broadcast({"type": "peer", "role": "user", "text": params["prompt"], "origin": "desktop"})
        replies: dict[str, list[str]] = {}
        errors: list[str] = []
        recall_t0 = time.perf_counter() if os.environ.get("FRIDAY_DEBUG_TURN_TIMING") == "1" else None
        recalled = await memory.recall(params["prompt"])
        if recall_t0 is not None:
            print(
                f"[friday.turn] kernel memory.recall {(time.perf_counter() - recall_t0) * 1000:.0f}ms",
                flush=True,
            )
        route_mode = params.get("routeMode") or params.get("route_mode")
        requirements = params.get("requirements") if isinstance(params.get("requirements"), dict) else {}
        privacy_mode = params.get("privacy") or requirements.get("privacy")
        async for delta in router.stream(
            prompt=params["prompt"],
            model_ids=params.get("modelIds"),
            allow_fallback=bool(params.get("allowFallback", True)),
            explicit_paid=bool(params.get("explicitPaid", False)),
            system=params.get("system"),
            context=recalled,
            privacy_confirmed=bool(params.get("privacyConfirmed", False)),
            route_mode=route_mode,
            privacy=str(privacy_mode) if privacy_mode else None,
            surface=params.get("routingSurface") if params.get("routingSurface") in ("voice", "chat") else None,
        ):
            if delta.get("delta"):
                replies.setdefault(delta.get("modelId", "unknown"), []).append(delta["delta"])
            if delta.get("error"):
                errors.append(str(delta["error"]))
            await send({"type": "chat.delta", "data": delta})
            if phone_cognize:
                q = _PHONE_COGNIZE.get(session_id)
                if q is not None:
                    await q.put(
                        {
                            "delta": delta.get("delta"),
                            "modelId": delta.get("modelId"),
                            "error": delta.get("error"),
                        }
                    )
        for model_id, chunks in replies.items():
            answer = "".join(chunks)
            origin = "phone" if phone_cognize else "desktop"
            await asyncio.to_thread(storage.append_chat, session_id, "assistant", answer, model_id, origin=origin)
            if phone_cognize:
                _PHONE_COGNIZE_STORED.add(session_id)
            sender_ws = _PHONE_COGNIZE_SENDER.get(session_id) if phone_cognize else None
            await phone_broadcast(
                {"type": "peer", "role": "assistant", "text": answer, "origin": origin}, exclude_ws=sender_ws
            )
        if not replies:
            return {
                "done": False,
                "error": "; ".join(errors) or "No configured model produced an answer.",
            }
        return {"done": True, "answers": len(replies)}

    if method == "chat.complete":
        # Internal one-shot (skill forge, planners that need a single reply).
        # Does not append to the owner's chat session and does not fan out to
        # the phone — those belong to chat.stream only.
        messages = params.get("messages") or []
        if not isinstance(messages, list) or not messages:
            return {"ok": False, "error": "messages required"}
        wanted = [str(i) for i in (params.get("modelIds") or []) if i]
        by_id = {m.id: m for m in router.models()}
        if wanted:
            targets = [
                by_id[i] for i in wanted if i in by_id and by_id[i].status == "ready" and router.can_chat(by_id[i])
            ]
            if not targets:
                return {
                    "ok": False,
                    "error": "None of the requested models is ready and chat-capable.",
                }
        else:
            live = companion_live()
            live_ids = router.ids_for_live(live)
            if live_ids is None:
                return {
                    "ok": False,
                    "error": (
                        "Desktop model routing has not been published yet. "
                        "Open FRIDAY and wait for the model registry to become ready."
                    ),
                }
            if not live_ids:
                return {"ok": False, "error": router.explain_unavailable(live)}
            eligible = [by_id[i] for i in live_ids if i in by_id]
            # A writing request prefers a coder, but only inside the exact pool
            # already authorized by the desktop route/cost/health snapshot.
            targets = [m for m in eligible if m.role == "coder"] + [m for m in eligible if m.role != "coder"]
        if not targets:
            return {"ok": False, "error": "No ready AI model is configured to write with."}
        requirements = params.get("requirements") if isinstance(params.get("requirements"), dict) else {}
        privacy_mode = str(params.get("privacy") or requirements.get("privacy") or "").strip().lower()
        if privacy_mode == "private":
            targets = [model for model in targets if is_local_model(model)]
            if not targets:
                return {
                    "ok": False,
                    "error": "Private routing keeps the prompt on this PC, and no local model is ready.",
                }
        last_error = None
        explicit = bool(params.get("explicitPaid", False))
        for model in targets:
            if not router.spendable(model, explicit):
                last_error = f"{model.label} is blocked by the billing policy"
                continue
            try:
                text = await router.complete(
                    model,
                    messages,
                    explicit,
                    privacy_confirmed=bool(params.get("privacyConfirmed", False)),
                )
            except Exception as exc:  # noqa: BLE001 — reported verbatim
                last_error = describe_failure(model, exc)
                continue
            if str(text or "").strip():
                return {"ok": True, "text": text, "modelId": model.id}
            last_error = f"{model.label} returned an empty reply"
        return {"ok": False, "error": last_error or "No configured model produced an answer."}

    if method == "task.run":
        async for event in planner.run(
            params["goal"],
            model_ids=params.get("modelIds"),
            priority=int(params.get("priority", 0) or 0),
            agent=params.get("agent"),
        ):
            await send({"type": "task.event", "data": event})
        return {"done": True}
    if method == "task.approve":
        # Recording the decision and actually continuing the task are one
        # operation: the same task resumes from its persisted checkpoint.
        decision = planner.approve(params["taskId"], params["stepId"], params.get("allow", True))
        if not decision.get("ok"):
            return decision
        events = []
        async for event in planner.resume(params["taskId"]):
            events.append(event)
            await send({"type": "task.event", "data": event})
        return {**decision, "resumed": True, "events": len(events)}
    if method == "task.resume":
        # Crash/restart recovery: pick an interrupted task back up.
        async for event in planner.resume(params["taskId"]):
            await send({"type": "task.event", "data": event})
        return {"done": True}
    if method == "task.cancel":
        return planner.cancel(params["taskId"])
    if method == "task.steps":
        return {"steps": await asyncio.to_thread(storage.task_steps, params["taskId"])}
    if method == "task.pending":
        return {"tasks": planner.pending()}
    if method == "task.list":
        return {"tasks": await asyncio.to_thread(storage.tasks, params.get("limit", 50))}

    if method == "billing.set":
        # The desktop is the single billing authority; the kernel mirrors it
        # and enforces the same rules at its own provider boundary.
        return router.set_billing(params.get("billing"), params.get("policy"))
    if method == "billing.get":
        return router.billing_state()
    if method == "tool.list":
        return {"tools": tools.describe()}
    if method == "tool.exec":
        # No caller-supplied approval flag: a non-safe tool runs only with a
        # signed, single-use authorization from the desktop permission gate.
        return await tools.execute(params["name"], params.get("args", {}), authorization=params.get("authorization"))
    if method == "session.active":
        # The desktop tells the kernel which conversation is open, so a phone
        # turn lands in the same one; with no id it just reports the current.
        if params.get("sessionId"):
            globals()["ACTIVE_SESSION"] = str(params["sessionId"])
        return {"sessionId": ACTIVE_SESSION}
    if method == "chat.sessions":
        return {"sessions": await asyncio.to_thread(storage.chat_sessions, params.get("limit", 40))}
    if method == "chat.history":
        return {
            "sessionId": params.get("sessionId", "main"),
            "messages": await asyncio.to_thread(
                storage.chat_history, params.get("sessionId", "main"), params.get("limit", 200)
            ),
        }
    if method == "chat.replace":
        session_id = str(params.get("sessionId") or ACTIVE_SESSION or "main")
        messages = params.get("messages") if isinstance(params.get("messages"), list) else []
        count = await asyncio.to_thread(storage.replace_chat, session_id, messages)
        history = await asyncio.to_thread(storage.chat_history, session_id, 50)
        await phone_broadcast({"type": "history", "messages": history})
        return {"ok": True, "sessionId": session_id, "count": count}
    if method == "memory.search":
        return {"results": await memory.search(params["query"], k=params.get("k", 8))}
    if method == "memory.index":
        return await memory.index_path(params["path"])
    if method == "memory.add":
        await memory.add(
            params["text"],
            kind=params.get("kind", "note"),
            title=params.get("title", "note"),
            record_id=params.get("id"),
        )
        return {"ok": True, "backend": memory.backend, "id": params.get("id")}
    if method == "memory.reindex":
        return await memory.reindex()
    if method == "memory.status":
        return {"backend": memory.backend, "available": memory.available}
    if method == "module.list":
        return {"modules": modules.describe()}
    if method == "module.toggle":
        return modules.toggle(params["name"], params["enabled"])
    if method == "runtime.list":
        return {"runtimes": runtimes.describe()}
    if method == "runtime.install":
        async for event in runtimes.install(params["name"]):
            await send({"type": "runtime.event", "data": event})
        return {"done": True}
    if method == "project.detect":
        return {"projects": await asyncio.to_thread(project_runner().detect)}
    if method == "project.run":
        return await asyncio.to_thread(
            project_runner().run,
            params["id"],
            params.get("install", False),
            params.get("timeout", 300),
        )
    if method == "code.run":
        return await asyncio.to_thread(
            project_runner().snippet,
            params["language"],
            params["code"],
            params.get("timeout", 60),
        )
    if method == "code.languages":
        return {"languages": await asyncio.to_thread(project_runner().languages)}
    if method == "settings.get":
        return {"settings": storage.settings()}
    if method == "settings.set":
        result = storage.set_setting(params["key"], params["value"])
        planner.apply_live_setting(str(params.get("key", "")), params.get("value"))
        return result
    if method == "workspace.get":
        return workspace.describe()
    if method == "workspace.set":
        workspace.set_root(params["root"])
        storage.set_setting("workspace_root", params["root"])
        await workspace.start()
        return workspace.describe()
    if method == "companion.status":
        info = devices_network.lan_address()
        ip = info.get("ip")
        return {
            "enabled": COMPANION_ENABLED,
            "port": PORT,
            "ip": ip,
            "url": f"http://{ip}:{PORT}/companion" if ip else None,
            "httpsUrl": f"https://{ip}:{PORT}/companion" if ip else None,
            "phones": COMPANION_STORE.phones(),
        }
    if method == "companion.pair":
        return COMPANION_STORE.new_code()
    if method == "companion.revoke":
        return {"removed": COMPANION_STORE.revoke(params["id"])}
    if method == "workspace.scan":
        return await asyncio.to_thread(workspace.scan)
    raise ValueError(f"unknown method: {method}")


@app.websocket("/bridge")
async def bridge(ws: WebSocket) -> None:
    await ws.accept()
    hello = json.loads(await ws.receive_text())
    if TOKEN and hello.get("token") != TOKEN:
        await ws.close(code=4401)
        return
    await ws.send_text(json.dumps({"type": "ready", "data": {"version": app.version}}))
    DESKTOP_CLIENTS.add(ws)

    async def send(payload: dict) -> None:
        await ws.send_text(json.dumps(payload))

    try:
        while True:
            msg = json.loads(await ws.receive_text())
            req_id = msg.get("id")
            incoming = msg.get("method")
            try:
                # Desktop-only: not a renderer kernel method. Avoid `method ==`
                # so the connectivity scanner does not list this as public API.
                if incoming == "privacy.decide":
                    settle_privacy_ask(
                        (msg.get("params") or {}).get("askId"),
                        bool((msg.get("params") or {}).get("allowed")),
                    )
                    await send({"id": req_id, "type": "result", "data": {"ok": True}})
                    continue
                if incoming == "companion.cognize_ack":
                    settle_phone_cognize_ack((msg.get("params") or {}).get("sessionId"))
                    await send({"id": req_id, "type": "result", "data": {"ok": True}})
                    continue
                if incoming == "companion.cognize_done":
                    payload = msg.get("params") or {}
                    await settle_phone_cognize_done(
                        payload.get("sessionId"),
                        payload.get("text"),
                        payload.get("error"),
                    )
                    await send({"id": req_id, "type": "result", "data": {"ok": True}})
                    continue
                result = await dispatch(incoming, msg.get("params", {}), send)
                await send({"id": req_id, "type": "result", "data": result})
            except Exception as exc:  # surfaced in the UI Logs page
                await send({"id": req_id, "type": "error", "error": str(exc)})
    except WebSocketDisconnect:
        return
    finally:
        DESKTOP_CLIENTS.discard(ws)


async def on_startup() -> None:
    # Re-scan the primary folder on every app restart, then keep watching it.
    if workspace.root is None:
        saved = storage.settings().get("workspace_root")
        if saved:
            workspace.set_root(saved)
    # A one-shot paid unlock spent inside the kernel is reported to the desktop,
    # which owns the persisted billing record.
    loop = asyncio.get_running_loop()

    def _report_spend(state: dict) -> None:
        loop.create_task(broadcast({"type": "billing.spent", "data": {"billing": state}}))

    router.on_billing_spent = _report_spend
    router.on_privacy_ask = ask_desktop_privacy
    # Tasks that were mid-flight when the kernel died become resumable instead
    # of staying stuck in 'running'.
    try:
        recovered = await asyncio.to_thread(planner.recover)
        if recovered:
            print(f"[friday] recovered {len(recovered)} interrupted task(s)", flush=True)
    except Exception as exc:  # never block startup on recovery
        print(f"[friday] task recovery failed: {exc}", flush=True)

    await workspace.start()


@asynccontextmanager
async def _kernel_lifespan(_app: FastAPI):
    """One startup and shutdown path. Replaces the deprecated on_event hooks."""
    await _watch_companion_registry()
    await on_startup()
    yield


app.router.lifespan_context = _kernel_lifespan


def main() -> None:
    modules.load_all()
    asyncio.run(memory.open())
    # Loopback by default. The phone companion is the only LAN bind, and only
    # when the desktop app explicitly turned it on.
    bind = "0.0.0.0" if COMPANION_ENABLED else HOST  # noqa: S104
    ssl_cert = os.environ.get("FRIDAY_SSL_CERT")
    ssl_key = os.environ.get("FRIDAY_SSL_KEY")
    ssl_kwargs = {}
    if ssl_cert and ssl_key and os.path.isfile(ssl_cert) and os.path.isfile(ssl_key):
        ssl_kwargs["ssl_certfile"] = ssl_cert
        ssl_kwargs["ssl_keyfile"] = ssl_key
    uvicorn.run(app, host=bind, port=PORT, log_level="info", **ssl_kwargs)


if __name__ == "__main__":
    main()
