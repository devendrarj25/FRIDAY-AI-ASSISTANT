"""Chroma's client is synchronous and its first query downloads a 79 MB embedding model. It used to run on the
kernel's event loop, so one slow download froze every request (the readiness RESTART step timed out on it in CI and
a first recall could freeze FRIDAY for minutes). The calls now run in a worker thread, one at a time, and a failing
call moves memory to the local index."""

import asyncio
import importlib
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

VectorMemory = importlib.import_module("memory").VectorMemory


class SlowCollection:
    """What a first Chroma query does: block for a while, on whichever thread called it."""

    def __init__(self, delay=0.3, fail=False):
        self.delay = delay
        self.fail = fail
        self.threads: list[int] = []
        self.added: list[dict] = []
        self.running = 0
        self.most_at_once = 0

    def _work(self):
        self.threads.append(threading.get_ident())
        self.running += 1
        self.most_at_once = max(self.most_at_once, self.running)
        time.sleep(self.delay)
        self.running -= 1
        if self.fail:
            raise RuntimeError("model download failed")

    def query(self, query_texts, n_results):
        self._work()
        return {
            "documents": [["a note"]],
            "metadatas": [[{"kind": "document", "title": "t", "id": "1"}]],
            "distances": [[0.1]],
            "ids": [["1"]],
        }

    def upsert(self, ids, documents, metadatas):
        self._work()
        self.added.append({"ids": ids})

    def add(self, ids, documents, metadatas):
        self.upsert(ids, documents, metadatas)

    def delete(self, ids):
        self._work()


def _memory(collection):
    store = VectorMemory(Path(tempfile.mkdtemp()))
    store.collection = collection
    return store


def test_a_slow_chroma_call_runs_off_the_event_loop_and_the_loop_keeps_answering():
    async def scenario():
        collection = SlowCollection(delay=0.4)
        store = _memory(collection)
        ticks = 0

        async def heartbeat():
            nonlocal ticks
            while True:
                await asyncio.sleep(0.02)
                ticks += 1

        beat = asyncio.create_task(heartbeat())
        rows = await store.search("hello")
        beat.cancel()
        return rows, collection, ticks

    rows, collection, ticks = asyncio.run(scenario())
    assert rows and rows[0]["title"] == "t"
    assert collection.threads and collection.threads[0] != threading.get_ident()
    # A blocked loop would have ticked about once; a free one ticks every 20 ms for the 0.4 s the call took.
    assert ticks >= 8


def test_two_calls_do_not_run_at_once_so_the_model_is_downloaded_once():
    async def scenario():
        collection = SlowCollection(delay=0.15)
        store = _memory(collection)
        await asyncio.gather(store.search("a"), store.search("b"), store.add("x", "document", "x"))
        return collection

    collection = asyncio.run(scenario())
    assert len(collection.threads) == 3
    # The lock serialises them: never two Chroma calls in flight at the same time.
    assert collection.most_at_once == 1


def test_a_failing_chroma_call_moves_memory_to_the_local_index_and_keeps_the_record():
    async def scenario():
        collection = SlowCollection(delay=0.01, fail=True)
        store = _memory(collection)
        store._open_fallback()
        await store.add("keep this", "note", "kept", record_id="r1")
        found = await store.search("keep this")
        return store, found

    store, found = asyncio.run(scenario())
    assert store.backend == "numpy"
    assert any(row.get("id") == "r1" or "keep" in row.get("snippet", "") for row in found)
