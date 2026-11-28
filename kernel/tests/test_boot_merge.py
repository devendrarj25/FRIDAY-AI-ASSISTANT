"""Boot folds the local records into the vector store through one guarded path: it never raises, never runs two
folds at once, and a memory forgotten while it is pending or running is not brought back."""

from __future__ import annotations

import asyncio
import importlib
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

memory = importlib.import_module("memory")
NumpyIndex = memory.NumpyIndex
VectorMemory = memory.VectorMemory

MAIN = Path(__file__).resolve().parents[1] / "main.py"


class Collection:
    def __init__(self, gate: threading.Event | None = None):
        self.rows: dict[str, str] = {}
        self.gate = gate
        self.entered = threading.Event()
        self.upsert_calls = 0

    def upsert(self, ids, documents, metadatas):
        self.upsert_calls += 1
        self.entered.set()
        if self.gate is not None:
            self.gate.wait(10)
        for rid, doc in zip(ids, documents, strict=True):
            self.rows[rid] = doc

    def add(self, ids, documents, metadatas):
        self.upsert(ids, documents, metadatas)

    def delete(self, ids):
        for rid in ids:
            self.rows.pop(rid, None)

    def count(self):
        return len(self.rows)


def _store(tmp_path, collection) -> VectorMemory:
    store = VectorMemory(tmp_path)
    store.collection = collection
    store._merge_needed = True
    return store


def test_a_missing_local_log_does_not_raise_at_boot(tmp_path):
    store = _store(tmp_path, Collection())

    async def scenario():
        store.start_merge()
        assert store._merge_task is not None
        await store._merge_task
        return store._merge_task.exception()

    assert asyncio.run(scenario()) is None
    assert store._merge_needed is False


def test_a_lone_backup_is_folded_without_raising(tmp_path):
    local = NumpyIndex(tmp_path / "local")
    local.add("first", kind="note", title="d", record_id="d1")
    local.add("first edited", kind="note", title="d", record_id="d1")
    local.records_file.unlink()
    assert local.records_file.with_name("records.jsonl.bak").exists()
    collection = Collection()
    store = _store(tmp_path, collection)

    async def scenario():
        store.start_merge()
        await store._merge_task
        return store._merge_task.exception()

    assert asyncio.run(scenario()) is None
    assert "d1" in collection.rows
    assert not (tmp_path / "local" / "records.jsonl.bak").exists()
    assert store._merge_needed is False


def test_a_failing_fold_is_logged_and_never_raises(tmp_path, caplog):
    NumpyIndex(tmp_path / "local").add("kept", kind="note", title="d", record_id="d1")

    class Broken(Collection):
        def upsert(self, ids, documents, metadatas):
            raise RuntimeError("store is locked")

    store = _store(tmp_path, Broken())

    async def scenario():
        store.start_merge()
        await store._merge_task

    with caplog.at_level("WARNING", logger="friday.memory"):
        asyncio.run(scenario())
    assert store._merge_task.exception() is None
    assert store._merge_needed is True
    assert "store is locked" in caplog.text


def test_one_fold_runs_at_a_time_and_add_does_not_start_a_second(tmp_path):
    NumpyIndex(tmp_path / "local").add("kept", kind="note", title="d", record_id="d1")
    gate = threading.Event()
    collection = Collection(gate)
    store = _store(tmp_path, collection)

    async def scenario():
        store.start_merge()
        first = store._merge_task
        await asyncio.to_thread(collection.entered.wait, 5)
        store.start_merge()
        adder = asyncio.create_task(store.add("another", "note", "t", "x1"))
        await asyncio.sleep(0.05)
        same = store._merge_task is first
        gate.set()
        await adder
        await first
        return same

    assert asyncio.run(scenario()) is True
    assert collection.upsert_calls == 2  # one fold upsert plus the add, never two folds


def test_a_memory_forgotten_during_the_fold_is_not_recalled_afterwards(tmp_path):
    local = NumpyIndex(tmp_path / "local")
    for n in range(119):
        local.add(f"keep {n}", kind="note", title="k", record_id=f"k{n}")
    local.add("forget me", kind="note", title="f", record_id="f1")  # lands in the second batch of 100
    gate = threading.Event()
    collection = Collection(gate)
    store = _store(tmp_path, collection)

    async def scenario():
        store.start_merge()
        await asyncio.to_thread(collection.entered.wait, 5)
        removing = asyncio.create_task(store.remove(["f1"]))
        await asyncio.sleep(0.05)
        gate.set()
        await removing
        await store._merge_task

    asyncio.run(scenario())
    assert "k0" in collection.rows and "k118" in collection.rows
    assert "f1" not in collection.rows


def test_a_memory_forgotten_before_the_fold_is_not_folded_in(tmp_path):
    local = NumpyIndex(tmp_path / "local")
    local.add("keep me", kind="note", title="k", record_id="k1")
    local.add("forget me", kind="note", title="f", record_id="f1")
    collection = Collection()
    store = _store(tmp_path, collection)

    async def scenario():
        await store.remove(["f1"])
        store.start_merge()
        await store._merge_task

    asyncio.run(scenario())
    assert collection.rows == {"k1": "keep me"}
    archived = NumpyIndex(tmp_path / "local")
    assert not archived.records_file.exists()


def test_a_forgotten_memory_leaves_the_local_log_even_if_the_fold_never_runs(tmp_path):
    local = NumpyIndex(tmp_path / "local")
    local.add("forget me", kind="note", title="f", record_id="f1")
    store = _store(tmp_path, Collection())
    asyncio.run(store.remove(["f1"]))
    fresh = NumpyIndex(tmp_path / "local")
    fresh.load()
    assert fresh.records == []


def test_startup_folds_through_the_guarded_path_not_a_bare_task():
    source = MAIN.read_text(encoding="utf-8")
    start = source.index("async def on_startup")
    body = source[start : source.index("\nasync def ", start + 10)]
    assert "memory.start_merge()" in body
    assert "merge_fallback" not in body
