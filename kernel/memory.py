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

import json
import math
import re
import uuid
from hashlib import blake2b
from pathlib import Path

TEXT_SUFFIXES = {".md", ".txt", ".py", ".ts", ".tsx", ".js", ".json", ".yaml", ".yml", ".toml", ".sql"}

EMBED_DIM = 384
_TOKEN = re.compile(r"[a-z0-9_]+")


def _tokens(text: str) -> list[str]:
    words = _TOKEN.findall(text.lower())
    # Word unigrams plus bigrams: cheap, deterministic, and good enough for
    # nearest-neighbour recall without downloading an embedding model.
    return words + [f"{a}_{b}" for a, b in zip(words, words[1:])]


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
        self.records: list[dict] = []
        self.vectors: list[list[float]] = []
        self._np = None
        try:
            import numpy  # noqa: PLC0415

            self._np = numpy
        except ImportError:
            self._np = None

    def load(self) -> None:
        self.records = []
        self.vectors = []
        if not self.records_file.exists():
            return
        for line in self.records_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                self.records.append(json.loads(line))
            except json.JSONDecodeError:
                continue  # a truncated tail never invalidates the whole store
        matrix = None
        if self._np is not None and self.matrix_file.exists():
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

    def _persist_matrix(self) -> None:
        if self._np is None or not self.vectors:
            return
        try:
            self._np.save(self.matrix_file, self._np.array(self.vectors, dtype="float32"))
        except Exception:
            pass  # the index is disposable; records.jsonl stays authoritative

    def _rewrite_records(self) -> None:
        with self.records_file.open("w", encoding="utf-8") as fh:
            for rec in self.records:
                fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
        self._persist_matrix()

    def add(self, text: str, kind: str, title: str, record_id: str | None = None) -> None:
        rid = (record_id or "").strip() or uuid.uuid4().hex
        record = {"id": rid, "text": text, "kind": kind, "title": title}
        vector = embed(text)
        for index, rec in enumerate(self.records):
            if rec.get("id") == rid:
                self.records[index] = record
                if index < len(self.vectors):
                    self.vectors[index] = vector
                else:
                    self.vectors.append(vector)
                self._rewrite_records()
                return
        self.records.append(record)
        self.vectors.append(vector)
        with self.records_file.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        self._persist_matrix()

    def search(self, query: str, k: int = 8) -> list[dict]:
        if not self.records:
            return []
        q = embed(query)
        if self._np is not None:
            matrix = self._np.array(self.vectors, dtype="float32")
            scores = matrix @ self._np.array(q, dtype="float32")
            order = scores.argsort()[::-1][:k]
            pairs = [(int(i), float(scores[int(i)])) for i in order]
        else:
            scored = [(i, sum(a * b for a, b in zip(vec, q))) for i, vec in enumerate(self.vectors)]
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

    def reindex(self) -> dict:
        """Rebuild every vector from the authoritative record log."""
        self.load()
        self.vectors = [embed(r.get("text", "")) for r in self.records]
        self._persist_matrix()
        return {"ok": True, "backend": "numpy", "records": len(self.records)}


class VectorMemory:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.mkdir(parents=True, exist_ok=True)
        self.collection = None
        self.fallback: NumpyIndex | None = None

    async def open(self) -> None:
        """Open the vector store. Missing/broken Chroma degrades to the local
        numpy index instead of stopping recall or the kernel from starting."""
        try:
            import chromadb
        except ImportError:
            print("[memory] chromadb not installed - using local vector index")
            self._open_fallback()
            return
        try:
            client = chromadb.PersistentClient(path=str(self.path))
            self.collection = client.get_or_create_collection("friday")
        except Exception as exc:  # corrupt store, locked file, ...
            print(f"[memory] vector store unavailable ({exc}) - using local vector index")
            self._open_fallback()

    def _open_fallback(self) -> None:
        try:
            index = NumpyIndex(self.path / "local")
            index.load()
            self.fallback = index
        except Exception as exc:
            print(f"[memory] local vector index unavailable ({exc}) - recall disabled")
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

    def _ensure(self):
        if self.collection is None:
            raise RuntimeError("vector memory unavailable")
        return self.collection

    async def search(self, query: str, k: int = 8) -> list[dict]:
        if self.collection is None:
            return self.fallback.search(query, k=k) if self.fallback else []
        col = self._ensure()
        res = col.query(query_texts=[query], n_results=k)
        docs = res.get("documents", [[]])[0]
        metas = res.get("metadatas", [[]])[0]
        dists = res.get("distances", [[]])[0]
        ids = res.get("ids", [[]])[0] if res.get("ids") else []
        out: list[dict] = []
        for index, (doc, meta, dist) in enumerate(zip(docs, metas, dists)):
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

    async def recall(self, prompt: str, k: int = 6) -> list[dict]:
        """Context injected before planning or answering."""
        try:
            return await self.search(prompt, k=k)
        except Exception:
            return []

    async def add(self, text: str, kind: str, title: str, record_id: str | None = None) -> None:
        rid = (record_id or "").strip() or uuid.uuid4().hex
        meta = {"kind": kind, "title": title, "id": rid}
        if self.collection is None:
            if self.fallback:
                self.fallback.add(text, kind=kind, title=title, record_id=rid)
            return
        col = self._ensure()
        try:
            col.upsert(ids=[rid], documents=[text], metadatas=[meta])
        except Exception:
            col.add(ids=[rid], documents=[text], metadatas=[meta])

    async def add_lesson(self, rule: str, context: str) -> None:
        await self.add(f"{rule}\n\nLearned from: {context}", kind="lesson", title=rule)

    async def reindex(self) -> dict:
        """Rebuild the disposable index. Chroma maintains its own index, so
        this only has work to do for the local numpy backend."""
        if self.collection is not None:
            return {"ok": True, "backend": "chroma", "records": None}
        if self.fallback is None:
            return {"ok": False, "backend": "none", "reason": "vector memory unavailable"}
        return self.fallback.reindex()

    async def index_path(self, root: str) -> dict:
        if not self.available:
            return {"ok": False, "reason": "vector memory unavailable", "files": 0, "chunks": 0}
        base = Path(root)
        files = [p for p in base.rglob("*") if p.is_file() and p.suffix.lower() in TEXT_SUFFIXES]
        chunks = 0
        for file in files:
            text = file.read_text(encoding="utf-8", errors="replace")
            for i in range(0, len(text), 2000):
                await self.add(text[i : i + 2000], kind="document", title=str(file))
                chunks += 1
        return {"ok": True, "files": len(files), "chunks": chunks, "backend": self.backend}
