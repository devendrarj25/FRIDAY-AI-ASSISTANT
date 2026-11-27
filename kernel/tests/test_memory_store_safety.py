"""Memory store safety: an interrupted rewrite keeps the old log, a Chroma failure keeps what Chroma held, local
records go back into Chroma, folder indexing is repeatable and privacy-aware, and a hung store never holds a turn."""

import asyncio
import importlib
import json
import sys
import threading
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

memory = importlib.import_module("memory")
NumpyIndex = memory.NumpyIndex
VectorMemory = memory.VectorMemory


def _records(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


class FakeCollection:
    """A Chroma stand-in that keeps rows in a dict and can be told to fail or to hang."""

    def __init__(self, rows=None, *, fail_query=False, hang: threading.Event | None = None):
        self.rows: dict[str, tuple[str, dict]] = dict(rows or {})
        self.fail_query = fail_query
        self.hang = hang
        self.upserts: list[list[str]] = []

    def query(self, query_texts, n_results):
        if self.hang is not None:
            self.hang.wait(30)
        if self.fail_query:
            raise RuntimeError("model download failed")
        items = list(self.rows.items())[:n_results]
        return {
            "documents": [[doc for _, (doc, _m) in items]],
            "metadatas": [[meta for _, (_d, meta) in items]],
            "distances": [[0.2 for _ in items]],
            "ids": [[rid for rid, _ in items]],
        }

    def get(self, include=None, limit=None, offset=0):
        items = list(self.rows.items())[offset : offset + (limit or len(self.rows))]
        return {
            "ids": [rid for rid, _ in items],
            "documents": [doc for _, (doc, _m) in items],
            "metadatas": [meta for _, (_d, meta) in items],
        }

    def upsert(self, ids, documents, metadatas):
        self.upserts.append(list(ids))
        for rid, doc, meta in zip(ids, documents, metadatas, strict=True):
            self.rows[rid] = (doc, meta)

    def add(self, ids, documents, metadatas):
        self.upsert(ids, documents, metadatas)

    def delete(self, ids):
        for rid in ids:
            self.rows.pop(rid, None)

    def count(self):
        return len(self.rows)


def test_an_interrupted_rewrite_keeps_the_old_log_loadable(monkeypatch, tmp_path):
    idx = NumpyIndex(tmp_path)
    idx.add("first fact about tea", kind="note", title="a", record_id="a")
    idx.add("second fact about milk", kind="note", title="b", record_id="b")
    before = idx.records_file.read_text(encoding="utf-8")

    def boom(_fd):
        raise OSError("disk went away")

    monkeypatch.setattr(memory.os, "fsync", boom)
    with pytest.raises(OSError):
        idx.add("second fact about oat milk", kind="note", title="b", record_id="b")
    monkeypatch.undo()

    assert idx.records_file.read_text(encoding="utf-8") == before
    assert not list(tmp_path.glob("*.tmp"))
    fresh = NumpyIndex(tmp_path)
    fresh.load()
    assert [r["id"] for r in fresh.records] == ["a", "b"]


def test_a_rewrite_keeps_one_backup_and_a_lone_backup_still_loads(tmp_path):
    idx = NumpyIndex(tmp_path)
    idx.add("one", kind="note", title="a", record_id="a")
    idx.add("one changed", kind="note", title="a", record_id="a")
    bak = tmp_path / "records.jsonl.bak"
    assert bak.exists() and _records(bak)[0]["text"] == "one"
    idx.records_file.unlink()
    fresh = NumpyIndex(tmp_path)
    fresh.load()
    assert [r["id"] for r in fresh.records] == ["a"]


def test_a_truncated_last_line_loses_only_that_line(tmp_path):
    idx = NumpyIndex(tmp_path)
    idx.add("kept fact", kind="note", title="a", record_id="a")
    with idx.records_file.open("a", encoding="utf-8") as fh:
        fh.write('{"id": "b", "text": "cut o')
    fresh = NumpyIndex(tmp_path)
    fresh.load()
    assert [r["id"] for r in fresh.records] == ["a"]


def test_records_stored_before_a_chroma_failure_are_still_found_after_it(tmp_path):
    async def scenario():
        rows = {"r1": ("my sister lives in Pune", {"kind": "semantic", "title": "sister", "id": "r1"})}
        store = VectorMemory(tmp_path)
        store.collection = FakeCollection(rows, fail_query=True)
        found = await store.search("sister Pune")
        await store._copy_task
        later = await store.search("sister Pune")
        return store, found, later

    store, found, later = asyncio.run(scenario())
    assert store.backend == "numpy"
    assert any(row.get("id") == "r1" for row in later)


def test_a_record_added_in_degraded_mode_is_not_overwritten_by_the_chroma_copy(tmp_path):
    async def scenario():
        rows = {"r1": ("old text about tea", {"kind": "n", "title": "t", "id": "r1"})}
        store = VectorMemory(tmp_path)
        store.collection = FakeCollection(rows, fail_query=True)
        await store.search("tea")
        store.fallback.add("new text about tea", kind="n", title="t", record_id="r1")
        await store._copy_task
        return store

    store = asyncio.run(scenario())
    assert [r["text"] for r in store.fallback.records if r["id"] == "r1"] == ["new text about tea"]


def test_local_records_go_back_into_chroma_and_the_local_log_is_archived(tmp_path):
    local = NumpyIndex(tmp_path / "local")
    local.add("written while chroma was down", kind="note", title="d", record_id="d1")
    collection = FakeCollection()

    async def scenario():
        store = VectorMemory(tmp_path)
        store.collection = collection
        store._merge_needed = True
        moved = await store.merge_fallback()
        return store, moved

    store, moved = asyncio.run(scenario())
    assert moved == 1
    assert collection.rows["d1"][0] == "written while chroma was down"
    assert not (tmp_path / "local" / "records.jsonl").exists()
    assert (tmp_path / "local" / "records.jsonl.merged").exists()
    assert store._merge_needed is False


def test_open_notices_local_records_and_a_live_turn_merges_them(tmp_path, monkeypatch):
    NumpyIndex(tmp_path / "local").add("kept offline", kind="note", title="o", record_id="o1")
    collection = FakeCollection()
    client = types.SimpleNamespace(get_or_create_collection=lambda name: collection)
    fake = types.ModuleType("chromadb")
    fake.__dict__["PersistentClient"] = lambda path: client
    monkeypatch.setitem(sys.modules, "chromadb", fake)

    async def scenario():
        store = VectorMemory(tmp_path)
        await store.open()
        assert store._merge_needed is True
        await store.recall("anything", timeout=2)
        await store._merge_task
        return store

    store = asyncio.run(scenario())
    assert "o1" in collection.rows and store._merge_needed is False


def _tree(root: Path) -> None:
    (root / "notes").mkdir(parents=True)
    (root / "notes" / "a.md").write_text("tea notes " * 300, encoding="utf-8")  # 3000 chars: two chunks
    (root / ".ssh").mkdir()
    (root / ".ssh" / "keys.txt").write_text("not for the index", encoding="utf-8")
    (root / ".git").mkdir()
    (root / ".git" / "x.txt").write_text("hidden", encoding="utf-8")
    (root / "node_modules").mkdir()
    (root / "node_modules" / "pkg.js").write_text("vendor", encoding="utf-8")
    (root / "config").mkdir()
    (root / "config" / "settings.json").write_text('{"a": 1}', encoding="utf-8")
    (root / "big.txt").write_text("x" * (memory.MAX_INDEX_FILE_BYTES + 10), encoding="utf-8")


def test_index_path_twice_gives_no_duplicates_and_skips_sensitive_and_vendor_folders(tmp_path):
    root = tmp_path / "docs"
    _tree(root)

    async def scenario():
        store = VectorMemory(tmp_path / "store")
        store.fallback = NumpyIndex(tmp_path / "store" / "local")
        first = await store.index_path(str(root))
        count_one = len(store.fallback.records)
        second = await store.index_path(str(root))
        return store, first, second, count_one

    store, first, second, count_one = asyncio.run(scenario())
    assert first["files"] == 1 and first["chunks"] == 2 and first["skipped"] >= 4
    assert len(store.fallback.records) == count_one == 2
    assert second["chunks"] == 2
    titles = {r["title"] for r in store.fallback.records}
    assert titles == {str(root / "notes" / "a.md")}


def test_a_shrunk_or_deleted_file_loses_its_old_chunks(tmp_path):
    root = tmp_path / "docs"
    _tree(root)
    target = root / "notes" / "a.md"

    async def scenario():
        store = VectorMemory(tmp_path / "store")
        store.fallback = NumpyIndex(tmp_path / "store" / "local")
        await store.index_path(str(root))
        target.write_text("short now", encoding="utf-8")
        await store.index_path(str(root))
        after_shrink = len(store.fallback.records)
        target.unlink()
        await store.index_path(str(root))
        return after_shrink, len(store.fallback.records)

    assert asyncio.run(scenario()) == (1, 0)


def test_a_chunk_with_a_secret_is_not_embedded(tmp_path):
    root = tmp_path / "docs"
    root.mkdir()
    secret = "pass" + "word: " + "hunter" + "2x9"
    (root / "mixed.txt").write_text("plain notes about tea\n" + secret, encoding="utf-8")
    (root / "ok.txt").write_text("plain notes about coffee", encoding="utf-8")
    # The secret sits in the same 2000-char chunk as the notes, so the whole chunk is withheld.

    async def scenario():
        store = VectorMemory(tmp_path / "store")
        store.fallback = NumpyIndex(tmp_path / "store" / "local")
        out = await store.index_path(str(root))
        return store, out

    store, out = asyncio.run(scenario())
    assert out["chunks"] == 1
    assert all("hunter" not in r["text"] for r in store.fallback.records)


def test_a_hung_chroma_call_returns_no_rows_inside_the_deadline_and_the_next_turn_is_not_blocked(tmp_path):
    release = threading.Event()

    async def scenario():
        store = VectorMemory(tmp_path)
        store.collection = FakeCollection({"r": ("a note", {"id": "r"})}, hang=release)
        loop = asyncio.get_running_loop()
        t0 = loop.time()
        first = await store.recall("hello", timeout=0.2)
        first_took = loop.time() - t0
        t1 = loop.time()
        second = await store.recall("hello again", timeout=0.2)
        second_took = loop.time() - t1
        warming = store.warming
        release.set()
        await asyncio.sleep(0.1)
        return first, first_took, second, second_took, warming, store.warming

    try:
        first, first_took, second, second_took, warming, still = asyncio.run(scenario())
    finally:
        release.set()
    assert first == [] and first_took < 1.0
    assert second == [] and second_took < 0.1  # skipped, not queued behind the lock
    assert warming is True and still is False


def test_recall_drops_rows_under_the_score_floor(tmp_path):
    async def scenario():
        store = VectorMemory(tmp_path)
        index = NumpyIndex(tmp_path / "local")
        index.add("the owner drinks tea every morning", kind="n", title="tea", record_id="t")
        store.fallback = index
        return await store.recall("tea in the morning"), await store.recall("zzzz qqqq")

    hit, miss = asyncio.run(scenario())
    assert hit and hit[0]["id"] == "t"
    assert miss == []


def test_a_lesson_has_a_stable_id_a_capped_title_and_a_bounded_count(tmp_path):
    async def scenario():
        store = VectorMemory(tmp_path)
        store.fallback = NumpyIndex(tmp_path / "local")
        await store.add_lesson("Check the folder exists before writing", context="goal")
        await store.add_lesson("Check the folder exists before writing", context="other goal")
        same = len(store.fallback.records)
        await store.add_lesson("x" * 500, context="g")
        long_title = max(len(r["title"]) for r in store.fallback.records)
        for i in range(memory.MAX_LESSONS + 5):
            await store.add_lesson(f"unique rule number {i}", context="g")
        return same, long_title, len(store.fallback.records)

    same, long_title, total = asyncio.run(scenario())
    assert same == 1
    assert long_title <= memory.LESSON_TITLE_CAP
    assert total == memory.MAX_LESSONS


def test_a_symlink_to_a_file_outside_the_folder_is_not_indexed(tmp_path):
    root = tmp_path / "docs"
    root.mkdir()
    outside = tmp_path / "elsewhere.txt"
    outside.write_text("private notes outside the chosen folder", encoding="utf-8")
    (root / "ok.txt").write_text("plain notes about tea", encoding="utf-8")
    try:
        (root / "link.txt").symlink_to(outside)
    except OSError:
        pytest.skip("symlinks are not available here")

    async def scenario():
        store = VectorMemory(tmp_path / "store")
        store.fallback = NumpyIndex(tmp_path / "store" / "local")
        out = await store.index_path(str(root))
        return store, out

    store, out = asyncio.run(scenario())
    assert out["files"] == 1
    assert all("outside the chosen" not in r["text"] for r in store.fallback.records)


def test_a_root_that_is_a_friday_data_folder_indexes_nothing(tmp_path):
    root = tmp_path / "database"
    root.mkdir()
    (root / "notes.txt").write_text("plain notes about tea", encoding="utf-8")

    async def scenario():
        store = VectorMemory(tmp_path / "store")
        store.fallback = NumpyIndex(tmp_path / "store" / "local")
        return await store.index_path(str(root))

    out = asyncio.run(scenario())
    assert out["files"] == 0 and out["chunks"] == 0


def _ids(path: Path) -> list[str]:
    idx = NumpyIndex(path)
    idx.load()
    return sorted(r["id"] for r in idx.records)


def test_a_removed_record_does_not_come_back_from_the_backup(tmp_path):
    idx = NumpyIndex(tmp_path)
    idx.add("keep me", kind="note", title="k", record_id="keep")
    idx.add("forget me", kind="note", title="f", record_id="gone")
    idx.add("keep me v2", kind="note", title="k", record_id="keep")  # a rewrite leaves a backup
    assert idx.remove(["gone"]) == 1
    bak = tmp_path / "records.jsonl.bak"
    assert all(r["id"] != "gone" for r in _records(bak))
    idx.records_file.unlink()  # the main file is lost: the backup must not resurrect the removed record
    assert _ids(tmp_path) == ["keep"]


def test_the_backup_is_read_when_the_main_file_is_unreadable_and_never_resurrects_a_removed_id(tmp_path):
    idx = NumpyIndex(tmp_path)
    for rid in ("a", "b", "c"):
        idx.add(f"text {rid}", kind="note", title=rid, record_id=rid)
    idx.add("text b2", kind="note", title="b", record_id="b")
    idx.remove(["c"])
    idx.records_file.write_bytes(b"\x00\x01 not json at all\n{broken\n")
    assert _ids(tmp_path) == ["a", "b"]


def test_a_damaged_tail_still_loads_the_main_file_not_the_backup(tmp_path):
    idx = NumpyIndex(tmp_path)
    idx.add("one", kind="note", title="a", record_id="a")
    idx.add("two", kind="note", title="b", record_id="b")
    idx.add("two again", kind="note", title="b", record_id="b")
    with idx.records_file.open("a", encoding="utf-8") as fh:
        fh.write('{"id": "c", "text": "tru')
    assert _ids(tmp_path) == ["a", "b"]


def test_a_merge_archives_the_log_and_drops_its_backup_so_nothing_is_replayed(tmp_path):
    local = NumpyIndex(tmp_path / "local")
    local.add("first", kind="note", title="d", record_id="d1")
    local.add("first edited", kind="note", title="d", record_id="d1")
    assert (tmp_path / "local" / "records.jsonl.bak").exists()
    collection = FakeCollection()

    async def scenario():
        store = VectorMemory(tmp_path)
        store.collection = collection
        store._merge_needed = True
        return await store.merge_fallback()

    assert asyncio.run(scenario()) == 1
    assert not (tmp_path / "local" / "records.jsonl.bak").exists()
    assert _ids(tmp_path / "local") == []


def test_a_secret_split_across_a_chunk_boundary_is_not_embedded(tmp_path):
    root = tmp_path / "docs"
    root.mkdir()
    label = "pass" + "word: "
    value = "hunter" + "2x9Q"
    pad = "plain words about tea. " * 200
    body = pad[: memory.INDEX_CHUNK - len(label)] + label + value + " and more plain notes after it"
    (root / "split.txt").write_text(body, encoding="utf-8")

    async def scenario():
        store = VectorMemory(tmp_path / "store")
        store.fallback = NumpyIndex(tmp_path / "store" / "local")
        out = await store.index_path(str(root))
        return store, out

    store, out = asyncio.run(scenario())
    assert all(value not in r["text"] for r in store.fallback.records)
