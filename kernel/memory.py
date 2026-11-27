"""Vector memory over files, chats, past tasks and self-written lessons.

Two interchangeable backends behind one small add/search interface:

* Chroma       - default when the package is installed.
* NumpyIndex   - offline fallback with deterministic hashed embeddings. It
                 keeps ``records.jsonl`` (authoritative; rewritten when the
                 same id is upserted) plus a disposable ``vectors.npy`` matrix
                 that can always be rebuilt from the records with ``reindex()``.

The fallback means recall never silently disappears on a machine where Chroma
could not be installed; it only degrades in quality.
"""

from __future__ import annotations

import asyncio
import functools
import json
import logging
import math
import os
import re
import shutil
import threading
import time
import unicodedata
import uuid
from hashlib import blake2b
from hashlib import sha1 as _sha1
from pathlib import Path

import file_tools
import privacy

log = logging.getLogger("friday.memory")

TEXT_SUFFIXES = {".md", ".txt", ".py", ".ts", ".tsx", ".js", ".json", ".yaml", ".yml", ".toml", ".sql"}

EMBED_DIM = 384
# Bumped whenever _tokens/embed change what a text hashes to: a stored vectors.npy from an older version is
# rebuilt from records.jsonl instead of being searched with vectors the new query side cannot match.
EMBED_VERSION = 2
# Letters, digits and underscore of every script, plus the whole Devanagari block except the danda signs: a bare
# \w drops the matras and the virama (Mn/Mc) and shatters a Hindi word into single consonants.
_TOKEN = re.compile(r"[\w\u0900-\u0963\u0966-\u097f]+")
_INVISIBLE = re.compile(r"[\u200b\u200c\u200d\u2060\ufeff]")
_HINDI_STOP = frozenset("है हैं था थी थे हूँ हूं हो का की के को में मैं मुझे हम तुम आप और से पर यह ये वह वो एक भी तो ही कि क्या".split())


def _point_chroma_model_cache() -> None:
    """Chroma 1.x keeps its embedding model under ~/.cache/chroma and ignores CHROMA_CACHE_DIR. The desktop app sets
    that variable to <FRIDAY_ROOT>/cache/chroma (where setup fetched the model); this points Chroma there, so the
    packaged app uses the files setup downloaded and nothing is fetched into the user profile. A Chroma without the
    class, or without the variable, changes nothing."""
    cache = os.environ.get("CHROMA_CACHE_DIR", "").strip()
    if not cache:
        return
    try:
        from chromadb.utils.embedding_functions.onnx_mini_lm_l6_v2 import ONNXMiniLM_L6_V2

        ONNXMiniLM_L6_V2.DOWNLOAD_PATH = Path(cache) / "onnx_models" / ONNXMiniLM_L6_V2.MODEL_NAME
    except Exception:  # an older or newer Chroma: its own location stays
        return


def _tokens(text: str) -> list[str]:
    folded = _INVISIBLE.sub("", unicodedata.normalize("NFC", text)).lower()
    words = [w for w in _TOKEN.findall(folded) if w not in _HINDI_STOP]
    # Word unigrams plus bigrams: cheap, deterministic, and good enough for
    # nearest-neighbour recall without downloading an embedding model.
    out = words + [f"{a}_{b}" for a, b in zip(words, words[1:], strict=False)]
    # Hindi inflects by suffix, so a non-ASCII word also contributes padded character trigrams: a form that was
    # stored with one ending still shares keys with the same stem asked with another.
    for word in words:
        if word.isascii() or len(word) < 3:
            continue
        padded = f"^{word}$"
        out.extend(f"c3:{padded[i : i + 3]}" for i in range(len(padded) - 2))
    return out


def embed(text: str) -> list[float]:
    """Hashed bag-of-ngrams embedding. Offline, stable across runs."""
    vec = [0.0] * EMBED_DIM
    for token in _tokens(text):
        digest = blake2b(token.encode("utf-8"), digest_size=8).digest()
        bucket = int.from_bytes(digest[:4], "big") % EMBED_DIM
        sign = 1.0 if digest[4] % 2 == 0 else -1.0
        vec[bucket] += sign
    norm = math.sqrt(sum(v * v for v in vec))
    if norm == 0:
        return vec
    return [v / norm for v in vec]


def _synchronized(method):
    """Run a NumpyIndex method under its lock: add_many and remove run in a worker thread while search runs on the
    event loop."""

    @functools.wraps(method)
    def run(self, *args, **kwargs):
        with self._lock:
            return method(self, *args, **kwargs)

    return run


class NumpyIndex:
    """Exact cosine search over hashed embeddings.

    Works with numpy when present and falls back to pure Python lists so a
    machine without numpy still gets recall.
    """

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.mkdir(parents=True, exist_ok=True)
        self.records_file = self.path / "records.jsonl"
        self.matrix_file = self.path / "vectors.npy"
        self.version_file = self.path / "vectors.version"
        # A worker thread writes while the event loop searches: one lock keeps records and vectors in step.
        self._lock = threading.RLock()
        self.records: list[dict] = []
        self.vectors: list[list[float]] = []
        self._matrix = None
        self._matrix_saved_at = 0.0
        self._np = None
        try:
            import numpy  # noqa: PLC0415

            self._np = numpy
        except ImportError:
            self._np = None

    @_synchronized
    def load(self) -> None:
        self.records = []
        self.vectors = []
        backup = self.records_file.with_name(self.records_file.name + ".bak")
        source = self.records_file
        if not source.exists():
            # A rewrite that was interrupted between the backup and the swap leaves only the backup. The backup is
            # kept in step with the log (remove() rewrites it, a merge deletes it), so it never replays a gone id.
            source = backup
            if not source.exists():
                return
        self.records = self._parse(source)
        if source is self.records_file and not self.records and backup.exists() and self._unreadable(source):
            self.records = self._parse(backup)  # the main file exists but holds nothing readable
        matrix = None
        if self._np is not None and self.matrix_file.exists() and self._version_current():
            try:
                loaded = self._np.load(self.matrix_file)
                if loaded.shape[0] == len(self.records) and loaded.shape[1] == EMBED_DIM:
                    matrix = loaded
            except Exception:
                matrix = None  # disposable: rebuilt below
        if matrix is None:
            self.vectors = [embed(r.get("text", "")) for r in self.records]
            self._persist_matrix()
        else:
            self.vectors = [list(map(float, row)) for row in matrix]

    @staticmethod
    def _parse(source: Path) -> list[dict]:
        records: list[dict] = []
        for line in source.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue  # a truncated tail never invalidates the whole store
            if isinstance(value, dict):
                records.append(value)
        return records

    @staticmethod
    def _unreadable(source: Path) -> bool:
        """True when the file has content but not one line of it is a record (an empty log is a valid empty log)."""
        try:
            return bool(source.read_text(encoding="utf-8", errors="replace").strip())
        except OSError:
            return True

    def _version_current(self) -> bool:
        try:
            return self.version_file.read_text(encoding="utf-8").strip() == str(EMBED_VERSION)
        except OSError:
            return False

    def _persist_matrix(self, defer: bool = False) -> None:
        if self._np is None or not self.vectors:
            return
        # The matrix is only a cache of the records: load() rebuilds it when the row count differs. A bulk
        # add therefore writes it at most every two seconds instead of once per record (quadratic work).
        now = time.monotonic()
        if defer and now - self._matrix_saved_at < 2.0:
            return
        self._matrix_saved_at = now
        try:
            self._np.save(self.matrix_file, self._np.array(self.vectors, dtype="float32"))
            self.version_file.write_text(str(EMBED_VERSION), encoding="utf-8")
        except Exception:  # noqa: S110 — the index is disposable; records.jsonl stays authoritative
            pass

    def _rewrite_records(self, keep_previous: bool = True) -> None:
        """Write the whole log to a temp file, flush it to disk, keep one backup of the old log, then swap it in. A
        crash at any point leaves the previous records.jsonl (or its .bak) loadable, never a half-written file."""
        tmp = self.records_file.with_name(self.records_file.name + ".tmp")
        try:
            with tmp.open("w", encoding="utf-8") as fh:
                for rec in self.records:
                    fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
                fh.flush()
                os.fsync(fh.fileno())
            if keep_previous and self.records_file.exists():
                shutil.copy2(self.records_file, self.records_file.with_name(self.records_file.name + ".bak"))
            os.replace(tmp, self.records_file)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
        self._persist_matrix()

    def add(self, text: str, kind: str, title: str, record_id: str | None = None) -> None:
        self.add_many([{"id": record_id, "text": text, "kind": kind, "title": title}])

    def add_many(self, items: list[dict]) -> None:
        """Upsert many records with at most one rewrite of the log: new ids are appended together, and a changed
        existing id replaces its row in memory and costs one rewrite for the whole call, never one per record. A
        record that is already stored exactly as given touches nothing."""
        with self._lock:
            positions = {rec.get("id"): n for n, rec in enumerate(self.records)}
            appended: list[dict] = []
            rewrite = False
            for item in items:
                rid = (item.get("id") or "").strip() or uuid.uuid4().hex
                record = {"id": rid, "text": item["text"], "kind": item["kind"], "title": item["title"]}
                at = positions.get(rid)
                if at is not None and self.records[at] == record:
                    continue
                vector = embed(record["text"])
                if at is None:
                    positions[rid] = len(self.records)
                    self.records.append(record)
                    self.vectors.append(vector)
                    appended.append(record)
                    continue
                self.records[at] = record
                if at < len(self.vectors):
                    self.vectors[at] = vector
                else:
                    self.vectors.append(vector)
                rewrite = True
            if not rewrite and not appended:
                return
            self._matrix = None
            if rewrite:
                self._rewrite_records()
                return
            with self.records_file.open("a", encoding="utf-8") as fh:
                for record in appended:
                    fh.write(json.dumps(record, ensure_ascii=False) + "\n")
            self._persist_matrix(defer=True)

    @_synchronized
    def remove(self, record_ids: list[str]) -> int:
        """Drop records by id. Returns how many were removed. The log is authoritative; the matrix follows."""
        wanted = {str(rid).strip() for rid in record_ids if str(rid).strip()}
        if not wanted:
            return 0
        keep = [i for i, rec in enumerate(self.records) if rec.get("id") not in wanted]
        removed = len(self.records) - len(keep)
        if not removed:
            return 0
        self.records = [self.records[i] for i in keep]
        self.vectors = [self.vectors[i] for i in keep if i < len(self.vectors)]
        self._matrix = None
        # The backup holds the log as it was before this call, i.e. the removed ids. Replace it with the new log.
        self._rewrite_records(keep_previous=False)
        backup = self.records_file.with_name(self.records_file.name + ".bak")
        try:
            fresh = backup.with_name(backup.name + ".tmp")
            shutil.copy2(self.records_file, fresh)
            os.replace(fresh, backup)
        except OSError:
            backup.unlink(missing_ok=True)  # no backup is safer than one that brings a removed record back
        if not self.vectors and self._np is not None and self.matrix_file.exists():
            try:
                self.matrix_file.unlink()
            except OSError:
                pass
        return removed

    def _matrix_array(self):
        """The search matrix, built once and rebuilt only after the vectors change."""
        if self._matrix is None or self._matrix.shape[0] != len(self.vectors):
            self._matrix = self._np.array(self.vectors, dtype="float32")
        return self._matrix

    @_synchronized
    def search(self, query: str, k: int = 8) -> list[dict]:
        if not self.records:
            return []
        q = embed(query)
        if self._np is not None:
            matrix = self._matrix_array()
            scores = matrix @ self._np.array(q, dtype="float32")
            order = scores.argsort()[::-1][:k]
            pairs = [(int(i), float(scores[int(i)])) for i in order]
        else:
            scored = [(i, sum(a * b for a, b in zip(vec, q, strict=False))) for i, vec in enumerate(self.vectors)]
            scored.sort(key=lambda p: p[1], reverse=True)
            pairs = scored[:k]
        out = []
        for index, score in pairs:
            if score <= 0:
                continue
            rec = self.records[index]
            row = {
                "kind": rec.get("kind", "document"),
                "title": rec.get("title", ""),
                "snippet": rec.get("text", "")[:400],
                "score": round(score, 3),
            }
            if rec.get("id"):
                row["id"] = rec["id"]
            out.append(row)
        return out

    @_synchronized
    def reindex(self) -> dict:
        """Rebuild every vector from the authoritative record log."""
        self.load()
        self.vectors = [embed(r.get("text", "")) for r in self.records]
        self._persist_matrix()
        return {"ok": True, "backend": "numpy", "records": len(self.records)}


# A recall may never hold a turn: the chat budget is the longest the planner or router waits for memory, the voice
# budget is what a spoken turn can afford. A call that overruns keeps running in the background (it holds Chroma's
# lock), and the turns after it skip recall until it ends instead of queueing behind it.
RECALL_TIMEOUT_CHAT = 1.5
RECALL_TIMEOUT_VOICE = 0.4
# Chroma scores are 1 - squared L2 distance of normalised vectors (2*cos - 1); the hashed index scores plain cosine.
# A row below the floor is a nearest neighbour of nothing in particular and is not worth a place in the prompt.
RECALL_FLOOR_CHROMA = -0.25
RECALL_FLOOR_NUMPY = 0.08
# A Chroma call that has not come back after this long is wedged (an offline model download, a locked store):
# recall stops waiting for it and memory moves to the local index.
PENDING_MAX_SECONDS = 120.0
# Changed chunks are written in batches of this size, so a big folder costs a handful of log rewrites.
INDEX_BATCH = 200
_monotonic = time.monotonic

MAX_LESSONS = 200
LESSON_TITLE_CAP = 160
MAX_INDEX_FILES = 2000
MAX_INDEX_FILE_BYTES = 512 * 1024
INDEX_CHUNK = 2000
CHUNK_CONTEXT = 200
# Folders a user-chosen index root never descends into: vendor trees, hidden folders and FRIDAY's own data.
FRIDAY_DATA_DIRS = frozenset(
    {"config", "security", "database", "memory", "brain-data", "conversations", "backup", "cache"}
    | {"models", "system", "temporary", "debug", "voice-enrollment"}
)
INDEX_SKIP_DIRS = FRIDAY_DATA_DIRS | {
    *("node_modules", "__pycache__", "venv", "site-packages", "dist", "build", "target", "vendor"),
}


def sha1(data: bytes):
    """A stable short id, not a security hash."""
    return _sha1(data, usedforsecurity=False)


def _atomic_write_json(path: Path, value: object) -> None:
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(value, fh, ensure_ascii=False)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def _read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


class VectorMemory:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.mkdir(parents=True, exist_ok=True)
        self.collection = None
        self.fallback: NumpyIndex | None = None
        # Chroma's client is synchronous and the first query downloads a 79 MB embedding model, so one call at a
        # time runs in a worker thread: the kernel keeps answering every other request, and two first calls do not
        # both download it. The thread lock also covers the warm-up thread started by open().
        self._lock = asyncio.Lock()
        self._thread_lock = threading.Lock()
        self._pending: asyncio.Future | None = None
        self._pending_since = 0.0
        self._copy_task: asyncio.Future | None = None
        self._merge_task: asyncio.Future | None = None
        self._merge_needed = False
        # One fold of the local log into Chroma at a time. remove() shares this lock for the local log, and every id
        # forgotten while a fold is pending or running is deleted again after the last upsert so it is never recalled.
        self._merge_lock = asyncio.Lock()
        self._forgotten: set[str] = set()
        # Records written to Chroma while a fold of the local log runs: the fold would otherwise upsert an older
        # local copy of the same id after them.
        self._fresh: dict[str, tuple[str, dict]] = {}
        self._lessons_lock = asyncio.Lock()

    def _locked(self, fn, /, *args, **kwargs):
        with self._thread_lock:
            return fn(*args, **kwargs)

    async def _chroma(self, fn, /, *args, **kwargs):
        """Run one Chroma call off the event loop. A call that fails (offline, a download that was cut, a locked
        store) moves memory to the local index instead of failing the request again and again."""
        async with self._lock:
            try:
                return await asyncio.to_thread(self._locked, fn, *args, **kwargs)
            except Exception as exc:
                self._degrade(exc)
                raise

    def _degrade(self, exc: Exception) -> None:
        if self.collection is None:
            return
        log.warning("vector store call failed (%s) - using local vector index", exc)
        broken = self.collection
        self.collection = None
        if self.fallback is None:
            self._open_fallback()
        self._start_copy(broken)

    def _start_copy(self, broken) -> None:
        """Copy what Chroma already held into the local index, once, off the event loop, so a memory stored before
        the failure is still found after it."""
        if self.fallback is None:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._copy_task = loop.create_task(self._copy_chroma_to_fallback(broken))

    async def _copy_chroma_to_fallback(self, col) -> int:
        def pull() -> list[tuple[str, str, dict]]:
            rows: list[tuple[str, str, dict]] = []
            offset = 0
            while True:
                res = col.get(include=["documents", "metadatas"], limit=500, offset=offset)
                ids = list(res.get("ids") or [])
                docs = list(res.get("documents") or [])
                metas = list(res.get("metadatas") or [])
                for i, rid in enumerate(ids):
                    rows.append(
                        (str(rid), docs[i] if i < len(docs) else "", (metas[i] if i < len(metas) else None) or {})
                    )
                offset += len(ids)
                if len(ids) < 500:
                    return rows

        try:
            rows = await asyncio.wait_for(asyncio.to_thread(self._locked, pull), 30)
        except Exception as exc:
            log.warning("could not copy the vector store into the local index (%s)", exc)
            return 0
        index = self.fallback
        if index is None:
            return 0
        have = {rec.get("id") for rec in index.records}
        copied = 0
        for n, (rid, doc, meta) in enumerate(rows):
            if rid in have:  # written in degraded mode: newer than the Chroma copy
                continue
            index.add(doc, kind=meta.get("kind", "document"), title=meta.get("title", ""), record_id=rid)
            copied += 1
            if n % 50 == 49:
                await asyncio.sleep(0)
        return copied

    def _warm_in_thread(self, col) -> None:
        try:
            self._locked(col.query, query_texts=["warm up"], n_results=1)
        except Exception:  # noqa: S110 - a real call finds the same failure and degrades there
            pass

    async def open(self) -> None:
        """Open the vector store. Missing/broken Chroma degrades to the local
        numpy index instead of stopping recall or the kernel from starting."""
        try:
            import chromadb
        except ImportError:
            log.info("chromadb not installed - using local vector index")
            self._open_fallback()
            return
        _point_chroma_model_cache()
        try:
            client = chromadb.PersistentClient(path=str(self.path))
            self.collection = client.get_or_create_collection("friday")
        except Exception as exc:  # corrupt store, locked file, ...
            log.warning("vector store unavailable (%s) - using local vector index", exc)
            self._open_fallback()
            return
        # Records written to the local index while Chroma was down go back into Chroma on the first live turn.
        self._merge_needed = self._fallback_file().exists() and self._fallback_file().stat().st_size > 0
        # Load the embedding model now, on a daemon thread: the first spoken turn must not pay for it, and the
        # short-lived loop this runs on must not wait for it either.
        threading.Thread(target=self._warm_in_thread, args=(self.collection,), daemon=True).start()

    def _fallback_file(self) -> Path:
        return self.path / "local" / "records.jsonl"

    def start_merge(self) -> None:
        """Fold the local log into Chroma in the background: one task at a time, kept so nothing starts a second."""
        if not self._merge_needed or self.collection is None:
            return
        if self._merge_task is not None and not self._merge_task.done():
            return
        try:
            self._merge_task = asyncio.get_running_loop().create_task(self.merge_fallback())
        except RuntimeError:
            return

    async def merge_fallback(self) -> int:
        """Upsert the local index's records into Chroma, then archive the local log. Returns how many moved. A
        failure is logged and leaves the local log in place for the next turn; it never raises."""
        if self.collection is None:
            return 0
        async with self._merge_lock:
            try:
                return await self._merge_records(self.collection)
            except Exception as exc:
                log.warning("local records could not be folded into the vector store (%s)", exc)
                return 0

    async def _merge_records(self, col) -> int:
        local = self.path / "local"
        index = NumpyIndex(local)
        await asyncio.to_thread(index.load)
        records = [r for r in index.records if r.get("id") and r.get("text")]
        try:
            for i in range(0, len(records), 100):
                batch = [
                    r for r in records[i : i + 100] if r["id"] not in self._forgotten and r["id"] not in self._fresh
                ]
                if not batch:
                    continue
                await self._chroma(
                    col.upsert,
                    ids=[r["id"] for r in batch],
                    documents=[r["text"] for r in batch],
                    metadatas=[
                        {"kind": r.get("kind", "document"), "title": r.get("title", ""), "id": r["id"]} for r in batch
                    ],
                )
            local_ids = {r["id"] for r in records}
            newer = {rid: row for rid, row in self._fresh.items() if rid in local_ids}
            if newer:
                # Written while the fold ran: the newer copy wins over the local one an in-flight batch carried.
                await self._chroma(
                    col.upsert,
                    ids=list(newer),
                    documents=[text for text, _meta in newer.values()],
                    metadatas=[meta for _text, meta in newer.values()],
                )
            if self._forgotten:
                # A remove() that ran while a batch was in flight lost the race to that upsert: delete it again.
                # An id added again after its remove() left this set in add(), so the new record is not deleted.
                await self._chroma(col.delete, ids=sorted(self._forgotten))
        except Exception as exc:
            log.warning("could not move local records into the vector store yet (%s)", exc)
            return 0
        if index.records_file.exists():
            os.replace(index.records_file, index.records_file.with_name("records.jsonl.merged"))
        for leftover in (
            index.matrix_file,
            index.version_file,
            index.records_file.with_name(index.records_file.name + ".bak"),
        ):
            leftover.unlink(missing_ok=True)
        moved = len([r for r in records if r["id"] not in self._forgotten])
        self._merge_needed = False
        self._forgotten.clear()
        self._fresh.clear()
        return moved

    def _open_fallback(self) -> None:
        try:
            index = NumpyIndex(self.path / "local")
            index.load()
            self.fallback = index
        except Exception as exc:
            log.warning("local vector index unavailable (%s) - recall disabled", exc)
            self.fallback = None

    @property
    def backend(self) -> str:
        if self.collection is not None:
            return "chroma"
        if self.fallback is not None:
            return "numpy"
        return "none"

    @property
    def available(self) -> bool:
        return self.collection is not None or self.fallback is not None

    @property
    def warming(self) -> bool:
        """True while an earlier recall that overran its budget is still running."""
        return self._pending is not None and not self._pending.done()

    def _expire_pending(self) -> None:
        """A recall that never came back wedged the vector store: stop waiting for it and use the local index, so
        every later turn gets its memory instead of an empty list until the next restart."""
        pending, self._pending = self._pending, None
        if pending is not None:
            pending.cancel()
        self._degrade(TimeoutError(f"a vector store call did not finish in {PENDING_MAX_SECONDS:.0f}s"))

    def count(self) -> int | None:
        """How many records the open backend holds, or None when it cannot say."""
        try:
            if self.collection is not None:
                return int(self.collection.count())
            if self.fallback is not None:
                return len(self.fallback.records)
        except Exception:
            return None
        return None

    def _ensure(self):
        if self.collection is None:
            raise RuntimeError("vector memory unavailable")
        return self.collection

    async def search(self, query: str, k: int = 8) -> list[dict]:
        if self.collection is None:
            return self.fallback.search(query, k=k) if self.fallback else []
        col = self._ensure()
        try:
            res = await self._chroma(col.query, query_texts=[query], n_results=k)
        except Exception:
            return self.fallback.search(query, k=k) if self.fallback else []
        docs = (res.get("documents") or [[]])[0]
        metas = (res.get("metadatas") or [[]])[0]
        dists = (res.get("distances") or [[]])[0]
        ids = (res.get("ids") or [[]])[0]
        out: list[dict] = []
        for index, (doc, meta, dist) in enumerate(zip(docs, metas, dists, strict=False)):
            rid = (meta or {}).get("id") or (ids[index] if index < len(ids) else None)
            row = {
                "kind": (meta or {}).get("kind", "document"),
                "title": (meta or {}).get("title", ""),
                "snippet": doc[:400],
                "score": round(1 - float(dist), 3),
            }
            if rid:
                row["id"] = rid
            out.append(row)
        return out

    async def recall(self, prompt: str, k: int = 6, *, voice: bool = False, timeout: float | None = None) -> list[dict]:
        """Context injected before planning or answering. It never holds a turn: past the budget it returns no
        rows, the search finishes in the background, and later turns skip recall until it has."""
        if self.warming:
            if _monotonic() - self._pending_since < PENDING_MAX_SECONDS:
                return []
            self._expire_pending()
        self._pending = None
        self.start_merge()
        budget = timeout if timeout is not None else (RECALL_TIMEOUT_VOICE if voice else RECALL_TIMEOUT_CHAT)
        task = asyncio.ensure_future(self.search(prompt, k=k))
        try:
            rows = await asyncio.wait_for(asyncio.shield(task), budget)
        except TimeoutError:
            self._pending = task
            self._pending_since = _monotonic()
            task.add_done_callback(lambda t: t.cancelled() or t.exception())
            return []
        except Exception:
            return []
        floor = RECALL_FLOOR_CHROMA if self.collection is not None else RECALL_FLOOR_NUMPY
        return [row for row in rows if float(row.get("score", 0.0)) >= floor]

    def _folding(self) -> bool:
        return self._merge_lock.locked() or (self._merge_task is not None and not self._merge_task.done())

    async def add(self, text: str, kind: str, title: str, record_id: str | None = None) -> None:
        await self.add_many([{"id": record_id, "text": text, "kind": kind, "title": title}])

    async def add_many(self, items: list[dict]) -> None:
        """Store several records with one call to the open backend (one log rewrite on the local index)."""
        rows = [
            {
                "id": (item.get("id") or "").strip() or uuid.uuid4().hex,
                "text": item["text"],
                "kind": item["kind"],
                "title": item["title"],
            }
            for item in items
        ]
        if not rows:
            return
        self.start_merge()
        folding = self._folding()
        for row in rows:
            # Added again after a remove(): the fold's final delete must not take the new record away.
            self._forgotten.discard(row["id"])
        if self.collection is None:
            await self._add_local(rows)
            return
        col = self._ensure()
        ids = [row["id"] for row in rows]
        docs = [row["text"] for row in rows]
        metas = [{"kind": row["kind"], "title": row["title"], "id": row["id"]} for row in rows]
        if folding:
            self._fresh.update({rid: (doc, meta) for rid, doc, meta in zip(ids, docs, metas, strict=True)})
        try:
            try:
                await self._chroma(col.upsert, ids=ids, documents=docs, metadatas=metas)
            except Exception:
                if self.collection is None:
                    raise
                await self._chroma(col.add, ids=ids, documents=docs, metadatas=metas)
        except Exception:
            # The store moved to the local index (see _degrade): the records are kept there.
            await self._add_local(rows)

    async def _add_local(self, rows: list[dict]) -> None:
        if self.fallback is not None:
            await asyncio.to_thread(self.fallback.add_many, rows)

    async def remove(self, record_ids: list[str]) -> int:
        """Forget records by id in whichever backend is open. A forgotten memory must not be recalled."""
        ids = [str(rid).strip() for rid in record_ids if str(rid).strip()]
        if not ids:
            return 0
        if self.collection is None:
            return await self._remove_local(ids)
        if self._merge_needed:
            # Local records still waiting to be folded in would bring this id back: remember it for a running fold,
            # and drop it from the local log when no fold is running.
            self._forgotten.update(ids)
            for rid in ids:
                self._fresh.pop(rid, None)
            if not self._merge_lock.locked():
                async with self._merge_lock:
                    await asyncio.to_thread(self._forget_local, ids)
        try:
            await self._chroma(self._ensure().delete, ids=ids)
        except Exception:
            return await self._remove_local(ids)
        return len(ids)

    async def _remove_local(self, ids: list[str]) -> int:
        if self.fallback is None:
            return 0
        return await asyncio.to_thread(self.fallback.remove, ids)

    def _forget_local(self, ids: list[str]) -> None:
        if not self._fallback_file().exists():
            return
        index = NumpyIndex(self.path / "local")
        index.load()
        index.remove(ids)

    async def add_lesson(self, rule: str, context: str) -> None:
        """A self-written lesson. The id is the hash of the rule (the same lesson twice is one row), the title is
        capped, and only the newest MAX_LESSONS are kept, so a flaky tool cannot grow the store without bound."""
        rule = " ".join(str(rule).split())
        if not rule:
            return
        rid = "lesson-" + sha1(rule.lower().encode("utf-8")).hexdigest()[:20]
        manifest = self.path / "lessons.json"
        # Read, add, evict and write happen as one step: two lessons learned at once must not both start from the
        # same list and lose one of the evictions.
        async with self._lessons_lock:
            order = [x for x in await asyncio.to_thread(_read_json, manifest, []) if isinstance(x, str) and x != rid]
            order.append(rid)
            evicted = order[:-MAX_LESSONS]
            order = order[-MAX_LESSONS:]
            await self.add(
                f"{rule}\n\nLearned from: {context}", kind="lesson", title=rule[:LESSON_TITLE_CAP], record_id=rid
            )
            if evicted:
                await self.remove(evicted)
            await asyncio.to_thread(_atomic_write_json, manifest, order)

    async def reindex(self) -> dict:
        """Rebuild the disposable index. Chroma maintains its own index, so
        this only has work to do for the local numpy backend."""
        if self.collection is not None:
            return {"ok": True, "backend": "chroma", "records": None}
        if self.fallback is None:
            return {"ok": False, "backend": "none", "reason": "vector memory unavailable"}
        return self.fallback.reindex()

    @staticmethod
    def _chunk_id(path: str, index: int) -> str:
        return "doc-" + sha1(f"{path}\0{index}".encode()).hexdigest()[:24]

    @staticmethod
    def _walk(base: Path) -> tuple[list[Path], int]:
        """Indexable files under base, and how many were skipped (hidden, vendor, FRIDAY data, sensitive, large)."""
        files: list[Path] = []
        skipped = 0
        if file_tools.is_sensitive(base) or base.name.lower() in FRIDAY_DATA_DIRS:
            return files, 1
        for dirpath, dirnames, filenames in os.walk(base):
            kept = []
            for name in dirnames:
                if (
                    name.startswith(".")
                    or name.lower() in INDEX_SKIP_DIRS
                    or file_tools.is_sensitive(Path(dirpath) / name)
                ):
                    skipped += 1
                else:
                    kept.append(name)
            dirnames[:] = sorted(kept)
            for name in sorted(filenames):
                path = Path(dirpath) / name
                if path.suffix.lower() not in TEXT_SUFFIXES:
                    continue
                try:
                    too_big = path.stat().st_size > MAX_INDEX_FILE_BYTES
                except OSError:
                    too_big = True
                if (
                    name.startswith(".")
                    or too_big
                    or path.is_symlink()  # a link could point at a credential file outside the chosen folder
                    or file_tools.is_sensitive(path)
                    or len(files) >= MAX_INDEX_FILES
                ):
                    skipped += 1
                    continue
                files.append(path)
        return files, skipped

    @staticmethod
    def _public_chunks(path: Path) -> tuple[int, dict[int, str]]:
        """The file's chunk slots and the public ones. A chunk the privacy classifier does not call public (a
        password, a card number, a private address) is never embedded."""
        text = path.read_text(encoding="utf-8", errors="replace")
        slots = 0
        keep: dict[int, str] = {}
        for i in range(0, len(text), INDEX_CHUNK):
            chunk = text[i : i + INDEX_CHUNK]
            # Judge the chunk with 200 characters of its neighbours: a label at the end of one chunk and its value
            # at the start of the next must not slip through as two public halves.
            window = text[max(0, i - CHUNK_CONTEXT) : i + INDEX_CHUNK + CHUNK_CONTEXT]
            if chunk.strip() and privacy.classify(window).get("level") == "public":
                keep[slots] = chunk
            slots += 1
        return slots, keep

    @staticmethod
    def _manifest_key(path: Path) -> str:
        """One key per file however the folder was spelled: the resolved path, case-folded where the OS folds it."""
        return os.path.normcase(os.path.realpath(path))

    @staticmethod
    def _chunk_hash(chunk: str) -> str:
        return blake2b(chunk.encode("utf-8"), digest_size=12).hexdigest()

    @staticmethod
    def _read_manifest(manifest_file: Path) -> dict[str, dict]:
        """Per file: the slot count and a content hash per stored chunk. The first release stored a bare slot count
        per file; that shape still loads (no hashes, so every chunk of it is written once and then hashed)."""
        out: dict[str, dict] = {}
        for key, value in _read_json(manifest_file, {}).items():
            if not isinstance(key, str):
                continue
            if isinstance(value, int) and not isinstance(value, bool):
                out[key] = {"slots": value, "hashes": {}}
            elif isinstance(value, dict) and isinstance(value.get("slots"), int):
                hashes = value.get("hashes")
                clean = {str(k): v for k, v in hashes.items() if isinstance(v, str)} if isinstance(hashes, dict) else {}
                out[key] = {"slots": value["slots"], "hashes": clean}
        return out

    async def index_path(self, root: str) -> dict:
        if not self.available:
            return {"ok": False, "reason": "vector memory unavailable", "files": 0, "chunks": 0}
        base = Path(root)
        manifest_file = self.path / "index-manifest.json"
        manifest = await asyncio.to_thread(self._read_manifest, manifest_file)
        # A wiped or rebuilt store holds none of what the manifest remembers: then every chunk is written again.
        trust_hashes = bool(self.count())
        # Walking a folder and reading its files is disk work: off the event loop, so a large folder does not
        # stall every other request while it is indexed.
        files, skipped = await asyncio.to_thread(self._walk, base)
        seen: set[str] = set()
        chunks = 0
        batch: list[dict] = []
        for file in files:
            title = str(file)
            key = self._manifest_key(file)
            seen.add(key)
            slots, keep = await asyncio.to_thread(self._public_chunks, file)
            old = manifest.get(key, {"slots": 0, "hashes": {}})
            hashes: dict[str, str] = {}
            for i, chunk in keep.items():
                digest = self._chunk_hash(chunk)
                hashes[str(i)] = digest
                chunks += 1
                if trust_hashes and old["hashes"].get(str(i)) == digest:
                    continue  # stored as it is: nothing to write
                batch.append({"id": self._chunk_id(key, i), "text": chunk, "kind": "document", "title": title})
            if len(batch) >= INDEX_BATCH:
                await self.add_many(batch)
                batch = []
            stale = [self._chunk_id(key, i) for i in range(old["slots"]) if i not in keep]
            if stale:
                await self.remove(stale)
            manifest[key] = {"slots": slots, "hashes": hashes}
        if batch:
            await self.add_many(batch)
        prefix = os.path.normcase(os.path.realpath(base)).rstrip(os.sep) + os.sep
        for key in [k for k in manifest if k not in seen and k.startswith(prefix)]:
            await self.remove([self._chunk_id(key, i) for i in range(manifest.pop(key)["slots"])])
        await asyncio.to_thread(_atomic_write_json, manifest_file, manifest)
        return {"ok": True, "files": len(files), "chunks": chunks, "skipped": skipped, "backend": self.backend}
