"""SQLite storage: settings, models, chats, tasks, steps, permissions, modules."""

from __future__ import annotations

import functools
import json
import sqlite3
import threading
import time
from pathlib import Path

from failure_guard import restore_database_file

# Bumped when ADDED_COLUMNS changes. migrate() writes this after the backup.
SCHEMA_VERSION = 2

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY, label TEXT, provider TEXT, endpoint TEXT, role TEXT,
  api_key TEXT, params TEXT, context_k INTEGER DEFAULT 8, status TEXT DEFAULT 'ready'
);
CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT, role TEXT, model_id TEXT,
  text TEXT, origin TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, goal TEXT, state TEXT DEFAULT 'queued',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, finished_at TEXT
);
CREATE TABLE IF NOT EXISTS task_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, step_id TEXT, tool TEXT,
  result TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, step_id TEXT,
  allowed INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS task_checkpoints (
  task_id TEXT PRIMARY KEY, goal TEXT, plan TEXT, step_index INTEGER DEFAULT 0,
  state TEXT DEFAULT 'waiting-approval', model_ids TEXT, results TEXT,
  retries INTEGER DEFAULT 0, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
-- A cancel request must survive a restart, so it lives on disk next to the
-- checkpoint instead of in process memory.
CREATE TABLE IF NOT EXISTS task_control (
  task_id TEXT PRIMARY KEY, cancelled INTEGER DEFAULT 0,
  reason TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tool_state (name TEXT PRIMARY KEY, enabled INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS modules (name TEXT PRIMARY KEY, version TEXT, enabled INTEGER, manifest TEXT);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT, source TEXT, message TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
-- The two lookups that grow with use: one conversation's rows, and one task's steps.
CREATE INDEX IF NOT EXISTS idx_chats_session_id ON chats(session, id);
CREATE INDEX IF NOT EXISTS idx_task_steps_task_id ON task_steps(task_id, id);
"""

BUSY_TIMEOUT_MS = 5000


def _locked(method):
    @functools.wraps(method)
    def run(self, *args, **kwargs):
        with self._lock:
            return method(self, *args, **kwargs)

    return run


def _serialised(cls):
    """One connection is shared by every worker thread (asyncio.to_thread), so every public method takes the lock."""
    for name, member in list(vars(cls).items()):
        if not name.startswith("_") and callable(member):
            setattr(cls, name, _locked(member))
    return cls


@_serialised
class Storage:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self._lock = threading.RLock()
        self._conn: sqlite3.Connection | None = None
        self._health: dict = {"state": "ok", "corruptPath": None, "storedVersion": None}
        self._open()

    # open and recover ---------------------------------------------------
    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, check_same_thread=False, timeout=BUSY_TIMEOUT_MS / 1000)
        conn.row_factory = sqlite3.Row
        return conn

    @staticmethod
    def _passes_quick_check(conn: sqlite3.Connection) -> bool:
        try:
            rows = conn.execute("PRAGMA quick_check").fetchall()
        except sqlite3.DatabaseError:
            return False
        return len(rows) == 1 and str(rows[0][0]).lower() == "ok"

    def _set_aside(self) -> Path:
        """Rename the damaged file (and its journal files) to `<name>.corrupt-<stamp>`; the bytes are kept."""
        stamp = time.strftime("%Y%m%d-%H%M%S")
        aside = Path(f"{self.path}.corrupt-{stamp}")
        count = 1
        while aside.exists():
            count += 1
            aside = Path(f"{self.path}.corrupt-{stamp}-{count}")
        self.path.replace(aside)
        for suffix in ("-wal", "-shm"):
            leftover = Path(str(self.path) + suffix)
            if leftover.exists():
                leftover.replace(Path(str(aside) + suffix))
        return aside

    def _open(self) -> None:
        conn = self._connect()
        if not self._passes_quick_check(conn):
            # Never stop the kernel at import for a damaged file: keep it, then restore the backup or start fresh.
            conn.close()
            aside = self._set_aside()
            state = "recreated"
            if restore_database_file(self.path):
                conn = self._connect()
                if self._passes_quick_check(conn):
                    state = "restored"
                else:
                    conn.close()
                    self.path.unlink(missing_ok=True)
                    conn = self._connect()
            else:
                conn = self._connect()
            self._health = {"state": state, "corruptPath": str(aside), "storedVersion": None}
        self._conn = conn
        try:
            # WAL: a reader never blocks the writer. busy_timeout: a short overlap waits instead of failing.
            conn.execute("PRAGMA journal_mode=WAL")
        except sqlite3.DatabaseError:  # noqa: S110 — a read-only folder keeps the default journal
            pass
        conn.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")

    def health(self) -> dict:
        """What Doctor shows: ok, restored, recreated (with the set-aside path) or newer-schema."""
        return {**self._health, "schemaVersion": SCHEMA_VERSION}

    @property
    def conn(self) -> sqlite3.Connection:
        """Open connection. A closed database raises instead of returning None."""
        conn = self._conn
        if conn is None:
            raise RuntimeError("database is closed")
        return conn

    def close(self) -> None:
        """Release the file. Windows will not delete a database that is still open."""
        conn = self._conn
        self._conn = None
        if conn is None:
            return
        try:
            conn.close()
        except Exception:  # noqa: S110 — a second close on Windows is already finished
            pass

    # Columns added after the first release. Adding them here (instead of
    # rewriting SCHEMA) keeps every existing friday.db upgradeable in place.
    ADDED_COLUMNS = (
        ("tasks", "priority", "INTEGER DEFAULT 0"),
        ("tasks", "agent", "TEXT"),
        ("tasks", "error", "TEXT"),
        ("task_steps", "args", "TEXT"),
        ("task_steps", "model_id", "TEXT"),
        ("task_steps", "ok", "INTEGER"),
        ("task_steps", "error", "TEXT"),
        ("task_steps", "attempt", "INTEGER DEFAULT 1"),
        ("task_steps", "duration_ms", "INTEGER"),
        ("chats", "origin", "TEXT"),
        ("tasks", "idempotency_key", "TEXT"),
    )

    def backup_database(self) -> str:
        """Consistent copy beside the live file, before a schema change is published."""
        conn = self._conn
        if conn is None:
            raise RuntimeError("database is closed")
        dest = Path(str(self.path) + ".bak")
        # Written beside, then swapped in: a cut-off backup never replaces the last good one, and a damaged
        # old backup cannot make the new one fail.
        fresh = Path(str(dest) + ".tmp")
        fresh.unlink(missing_ok=True)
        bak = sqlite3.connect(fresh)
        try:
            conn.backup(bak)
        finally:
            bak.close()
        fresh.replace(dest)
        return str(dest)

    def migrate(self) -> None:
        self.conn.executescript(SCHEMA)
        pending = []
        for table, column, decl in self.ADDED_COLUMNS:
            have = {r["name"] for r in self.conn.execute(f"PRAGMA table_info({table})").fetchall()}
            if column not in have:
                pending.append((table, column, decl))
        if pending:
            self.backup_database()
            for table, column, decl in pending:
                self.conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
        stored = self.settings().get("schema_version")
        if isinstance(stored, int) and stored > SCHEMA_VERSION:
            # A newer build wrote this file (the owner rolled back). Keep working, never write the number down.
            self._health = {**self._health, "state": "newer-schema", "storedVersion": stored}
        else:
            self.set_setting("schema_version", SCHEMA_VERSION)
        # Older builds persisted provider API keys in this table. Scrub them
        # once on open; the desktop re-supplies keys from its secure store.
        self.conn.execute("UPDATE models SET api_key=NULL WHERE api_key IS NOT NULL")
        self.conn.commit()

    # settings -----------------------------------------------------------
    def settings(self) -> dict:
        rows = self.conn.execute("SELECT key, value FROM settings").fetchall()
        return {r["key"]: json.loads(r["value"]) for r in rows}

    def set_setting(self, key: str, value) -> dict:
        self.conn.execute(
            "INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(value)),
        )
        self.conn.commit()
        return {"ok": True}

    # models -------------------------------------------------------------
    def models(self) -> list[dict]:
        rows = self.conn.execute("SELECT * FROM models").fetchall()
        return [
            {
                "id": r["id"],
                "label": r["label"],
                "provider": r["provider"],
                "endpoint": r["endpoint"],
                "role": r["role"] or "brain",
                # Keys are never persisted (see ModelRouter.register); the
                # desktop re-sends them on every boot from its secure store.
                "api_key": None,
                "params": r["params"] or "",
                "context_k": r["context_k"] or 8,
                "status": r["status"] or "ready",
            }
            for r in rows
        ]

    def upsert_model(self, model: dict) -> None:
        self.conn.execute(
            """INSERT INTO models(id,label,provider,endpoint,role,api_key,params,context_k,status)
               VALUES(:id,:label,:provider,:endpoint,:role,:api_key,:params,:contextK,:status)
               ON CONFLICT(id) DO UPDATE SET label=excluded.label, provider=excluded.provider,
                 endpoint=excluded.endpoint, role=excluded.role, api_key=excluded.api_key,
                 params=excluded.params, context_k=excluded.context_k, status=excluded.status""",
            {**model, "api_key": None},
        )
        self.conn.commit()

    # chat ---------------------------------------------------------------
    def append_chat(
        self,
        session: str,
        role: str,
        text: str,
        model_id: str | None = None,
        origin: str | None = None,
    ) -> None:
        self.conn.execute(
            "INSERT INTO chats(session, role, model_id, text, origin) VALUES(?,?,?,?,?)",
            (session, role, model_id, text, origin),
        )
        self.conn.commit()

    def chat_sessions(self, limit: int = 40) -> list[dict]:
        """One row per conversation, newest first, with a preview title taken
        from the first thing the user said in it."""
        rows = self.conn.execute(
            """SELECT session,
                      COUNT(*) AS messages,
                      MAX(created_at) AS updated_at,
                      MIN(created_at) AS started_at
                 FROM chats
                WHERE session IS NOT NULL
             GROUP BY session
             ORDER BY updated_at DESC
                LIMIT ?""",
            (int(limit),),
        ).fetchall()
        out = []
        for row in rows:
            first = self.conn.execute(
                "SELECT text FROM chats WHERE session=? AND role='user' ORDER BY id ASC LIMIT 1",
                (row["session"],),
            ).fetchone()
            out.append(
                {
                    "id": row["session"],
                    "title": ((first["text"] if first else "") or "Conversation").strip()[:60],
                    "messages": row["messages"],
                    "startedAt": row["started_at"],
                    "updatedAt": row["updated_at"],
                }
            )
        return out

    def chat_history(self, session: str, limit: int = 200) -> list[dict]:
        """Full transcript of one conversation in chronological order."""
        rows = self.conn.execute(
            "SELECT id, role, model_id, text, origin, created_at FROM chats WHERE session=? ORDER BY id DESC LIMIT ?",
            (session, int(limit)),
        ).fetchall()
        return [
            {
                "id": r["id"],
                "role": r["role"],
                "modelId": r["model_id"],
                "text": r["text"],
                "origin": r["origin"],
                "createdAt": r["created_at"],
            }
            for r in reversed(rows)
        ]

    def replace_chat(self, session: str, messages: list) -> int:
        """Swap one session's transcript. Empty list = clear. Phone replay uses this.

        One transaction: the old transcript is only deleted when the new one is stored in full.
        """
        rows = []
        for item in messages or []:
            if not isinstance(item, dict):
                continue
            role = str(item.get("role") or "").strip()
            if role == "friday":
                role = "assistant"
            text = str(item.get("text") or item.get("content") or "").strip()
            if not role or not text:
                continue
            rows.append((session, role, item.get("modelId") or item.get("model_id"), text, item.get("origin")))
        try:
            self.conn.execute("DELETE FROM chats WHERE session=?", (session,))
            self.conn.executemany("INSERT INTO chats(session, role, model_id, text, origin) VALUES(?,?,?,?,?)", rows)
            self.conn.commit()
        except BaseException:
            self.conn.rollback()
            raise
        return len(rows)

    # tools / tasks ------------------------------------------------------
    def enabled_tools(self) -> dict:
        rows = self.conn.execute("SELECT name, enabled FROM tool_state").fetchall()
        return {r["name"]: bool(r["enabled"]) for r in rows}

    def create_task(
        self,
        task_id: str,
        goal: str,
        *,
        priority: int = 0,
        agent: str | None = None,
        idempotency_key: str | None = None,
    ) -> str:
        key = (idempotency_key or "").strip() or None
        if key:
            existing = self.conn.execute("SELECT id FROM tasks WHERE idempotency_key=?", (key,)).fetchone()
            if existing is not None:
                return str(existing["id"])
        self.conn.execute(
            "INSERT INTO tasks(id, goal, state, priority, agent, idempotency_key) VALUES(?,?,'running',?,?,?)",
            (task_id, goal, int(priority), agent, key),
        )
        self.conn.execute(
            "INSERT INTO task_control(task_id, cancelled) VALUES(?,0) "
            "ON CONFLICT(task_id) DO UPDATE SET cancelled=0, reason=NULL",
            (task_id,),
        )
        self.conn.commit()
        return task_id

    def finish_task(self, task_id: str, state: str, error: str | None = None) -> None:
        self.conn.execute(
            "UPDATE tasks SET state=?, error=?, finished_at=CURRENT_TIMESTAMP WHERE id=?",
            (state, error, task_id),
        )
        self.conn.commit()

    def log_step(
        self,
        task_id: str,
        step_id: str,
        tool: str,
        result: dict,
        *,
        args: dict | None = None,
        model_id: str | None = None,
        attempt: int = 1,
        duration_ms: int | None = None,
    ) -> None:
        """One executed step, with everything needed to explain it later."""
        self.conn.execute(
            """INSERT INTO task_steps(task_id, step_id, tool, result, args, model_id,
                                      ok, error, attempt, duration_ms)
               VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (
                task_id,
                step_id,
                tool,
                json.dumps(result)[:200_000],
                json.dumps(args or {})[:50_000],
                model_id,
                1 if result.get("ok") else 0,
                None if result.get("ok") else str(result.get("error") or "")[:2000],
                int(attempt),
                None if duration_ms is None else int(duration_ms),
            ),
        )
        self.conn.commit()

    def task_steps(self, task_id: str) -> list[dict]:
        rows = self.conn.execute("SELECT * FROM task_steps WHERE task_id=? ORDER BY id", (task_id,)).fetchall()
        return [
            {
                "stepId": r["step_id"],
                "tool": r["tool"],
                "args": json.loads(r["args"] or "{}"),
                "modelId": r["model_id"],
                "ok": bool(r["ok"]),
                "error": r["error"],
                "attempt": r["attempt"] or 1,
                "durationMs": r["duration_ms"],
                "result": json.loads(r["result"] or "{}"),
                "createdAt": r["created_at"],
            }
            for r in rows
        ]

    # cancellation --------------------------------------------------------
    def request_cancel(self, task_id: str, reason: str | None = None) -> None:
        self.conn.execute(
            "INSERT INTO task_control(task_id, cancelled, reason) VALUES(?,1,?) "
            "ON CONFLICT(task_id) DO UPDATE SET cancelled=1, reason=excluded.reason,"
            " updated_at=CURRENT_TIMESTAMP",
            (task_id, reason),
        )
        self.conn.commit()

    def cancel_requested(self, task_id: str) -> bool:
        row = self.conn.execute("SELECT cancelled FROM task_control WHERE task_id=?", (task_id,)).fetchone()
        return bool(row and row["cancelled"])

    def clear_cancel(self, task_id: str) -> None:
        self.conn.execute("UPDATE task_control SET cancelled=0, reason=NULL WHERE task_id=?", (task_id,))
        self.conn.commit()

    def record_permission(self, task_id: str, step_id: str, allowed: bool) -> None:
        self.conn.execute(
            "INSERT INTO permissions(task_id, step_id, allowed) VALUES(?,?,?)",
            (task_id, step_id, 1 if allowed else 0),
        )
        self.conn.commit()

    # task checkpoints ---------------------------------------------------
    # A paused task must survive a UI close, a kernel restart and a crash, so
    # the whole resume payload lives on disk, not in process memory.
    def save_checkpoint(self, task_id: str, checkpoint: dict) -> None:
        self.conn.execute(
            """INSERT INTO task_checkpoints(task_id, goal, plan, step_index, state, model_ids,
                                            results, retries, updated_at)
               VALUES(?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
               ON CONFLICT(task_id) DO UPDATE SET goal=excluded.goal, plan=excluded.plan,
                 step_index=excluded.step_index, state=excluded.state,
                 model_ids=excluded.model_ids, results=excluded.results,
                 retries=excluded.retries, updated_at=CURRENT_TIMESTAMP""",
            (
                task_id,
                checkpoint.get("goal", ""),
                json.dumps(checkpoint.get("plan", [])),
                int(checkpoint.get("stepIndex", 0)),
                checkpoint.get("state", "waiting-approval"),
                json.dumps(checkpoint.get("modelIds") or []),
                json.dumps(checkpoint.get("results") or [])[:200_000],
                int(checkpoint.get("retries", 0)),
            ),
        )
        self.conn.commit()

    def load_checkpoint(self, task_id: str) -> dict | None:
        row = self.conn.execute("SELECT * FROM task_checkpoints WHERE task_id=?", (task_id,)).fetchone()
        if row is None:
            return None
        return {
            "taskId": row["task_id"],
            "goal": row["goal"],
            "plan": json.loads(row["plan"] or "[]"),
            "stepIndex": row["step_index"] or 0,
            "state": row["state"],
            "modelIds": json.loads(row["model_ids"] or "[]"),
            "results": json.loads(row["results"] or "[]"),
            "retries": row["retries"] or 0,
            "updatedAt": row["updated_at"],
        }

    def open_checkpoints(self) -> list[dict]:
        rows = self.conn.execute(
            "SELECT task_id FROM task_checkpoints WHERE state != 'done' ORDER BY updated_at DESC"
        ).fetchall()
        loaded: list[dict] = []
        for row in rows:
            item = self.load_checkpoint(row["task_id"])
            if item is not None:
                loaded.append(item)
        return loaded

    def clear_checkpoint(self, task_id: str) -> None:
        self.conn.execute("DELETE FROM task_checkpoints WHERE task_id=?", (task_id,))
        self.conn.commit()

    def tasks(self, limit: int = 50) -> list[dict]:
        rows = self.conn.execute(
            "SELECT id, goal, state, priority, agent, error, created_at, finished_at FROM tasks "
            "ORDER BY priority DESC, created_at DESC LIMIT ?",
            (int(limit),),
        ).fetchall()
        return [
            {
                "id": r["id"],
                "goal": r["goal"],
                "state": r["state"],
                "priority": r["priority"] or 0,
                "agent": r["agent"],
                "error": r["error"],
                "createdAt": r["created_at"],
                "finishedAt": r["finished_at"],
            }
            for r in rows
        ]
