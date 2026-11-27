"""Races in the memory store: an id added again after it was forgotten survives the fold, a wedged vector store call
expires instead of silencing recall forever, and lessons learned at the same moment are not lost."""

import asyncio
import importlib
import json
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

memory = importlib.import_module("memory")
NumpyIndex = memory.NumpyIndex
VectorMemory = memory.VectorMemory


class GatedCollection:
    """Keeps rows in a dict; every upsert waits for the gate, so a test decides what overlaps the fold."""

    def __init__(self, gate: threading.Event | None = None, hang: threading.Event | None = None):
        self.rows: dict[str, str] = {}
        self.gate = gate
        self.hang = hang
        self.entered = threading.Event()

    def upsert(self, ids, documents, metadatas):
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

    def query(self, query_texts, n_results):
        if self.hang is not None:
            self.hang.wait(10)
        return {"documents": [[]], "metadatas": [[]], "distances": [[]], "ids": [[]]}

    def get(self, include=None, limit=None, offset=0):
        return {"ids": [], "documents": [], "metadatas": []}

    def count(self):
        return len(self.rows)


def _fold_store(tmp_path, collection, n_local=119):
    local = NumpyIndex(tmp_path / "local")
    for n in range(n_local):
        local.add(f"keep {n}", kind="note", title="k", record_id=f"k{n}")
    local.add("old text", kind="note", title="f", record_id="f1")  # lands in the second batch of 100
    store = VectorMemory(tmp_path)
    store.collection = collection
    store._merge_needed = True
    return store


def test_an_id_forgotten_and_added_again_during_the_fold_survives_it(tmp_path):
    gate = threading.Event()
    collection = GatedCollection(gate)
    store = _fold_store(tmp_path, collection)

    async def scenario():
        store.start_merge()
        await asyncio.to_thread(collection.entered.wait, 5)
        removing = asyncio.create_task(store.remove(["f1"]))
        await asyncio.sleep(0.05)
        adding = asyncio.create_task(store.add("new text", kind="note", title="f", record_id="f1"))
        await asyncio.sleep(0.05)
        gate.set()
        await removing
        await adding
        await store._merge_task

    try:
        asyncio.run(scenario())
    finally:
        gate.set()
    assert collection.rows.get("f1") == "new text"  # was deleted by the fold's last step
    assert "k0" in collection.rows and "k118" in collection.rows


def test_a_record_written_during_the_fold_is_not_overwritten_by_its_older_local_copy(tmp_path):
    gate = threading.Event()
    collection = GatedCollection(gate)
    store = _fold_store(tmp_path, collection)

    async def scenario():
        store.start_merge()
        await asyncio.to_thread(collection.entered.wait, 5)
        adding = asyncio.create_task(store.add("new text", kind="note", title="f", record_id="f1"))
        await asyncio.sleep(0.05)
        gate.set()
        await adding
        await store._merge_task

    try:
        asyncio.run(scenario())
    finally:
        gate.set()
    assert collection.rows["f1"] == "new text"


def test_a_wedged_vector_store_call_expires_and_recall_uses_the_local_index(monkeypatch, tmp_path):
    hang = threading.Event()
    clock = [1000.0]
    monkeypatch.setattr(memory, "_monotonic", lambda: clock[0])

    async def scenario():
        store = VectorMemory(tmp_path)
        store.collection = GatedCollection(hang=hang)
        local = NumpyIndex(tmp_path / "local")
        local.add("the owner drinks tea every morning", kind="n", title="tea", record_id="t")
        store.fallback = local
        first = await store.recall("tea", timeout=0.05)  # overran its budget: the call is now pending
        wedged = store.warming
        clock[0] += memory.PENDING_MAX_SECONDS - 1
        still = await store.recall("tea", timeout=0.05)  # not old enough: skipped, not queued
        clock[0] += 2
        later = await store.recall("tea in the morning", timeout=0.5)
        hang.set()  # the worker thread ends before the loop closes
        return store, first, wedged, still, later

    try:
        store, first, wedged, still, later = asyncio.run(scenario())
    finally:
        hang.set()
    assert first == [] and wedged is True and still == []
    assert store.backend == "numpy" and store.warming is False
    assert later and later[0]["id"] == "t"


def test_lessons_learned_at_the_same_moment_keep_the_count_and_the_manifest_in_step(monkeypatch, tmp_path):
    monkeypatch.setattr(memory, "MAX_LESSONS", 10)

    async def scenario():
        store = VectorMemory(tmp_path)
        store.fallback = NumpyIndex(tmp_path / "local")
        await asyncio.gather(*(store.add_lesson(f"rule number {n}", context="g") for n in range(30)))
        return store

    store = asyncio.run(scenario())
    order = json.loads((tmp_path / "lessons.json").read_text(encoding="utf-8"))
    stored = {r["id"] for r in store.fallback.records}
    assert len(order) == 10  # a lost update left more than ten behind
    assert stored == set(order)
