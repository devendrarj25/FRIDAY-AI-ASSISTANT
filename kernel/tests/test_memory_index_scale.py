"""Re-indexing a folder must stay linear: an unchanged chunk is skipped by content hash, changed chunks go in one
batch with one log rewrite, the local index runs off the event loop, and the manifest keys do not depend on how the
path was spelled."""

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


def _words(seed: int) -> str:
    # Plain public prose, long enough to fill exactly one chunk, different per seed.
    base = f"note {seed} about the garden and the weather on day {seed} "
    return (base * (memory.INDEX_CHUNK // len(base) + 1))[: memory.INDEX_CHUNK]


def _tree(root: Path, files: int = 3, chunks: int = 100) -> None:
    root.mkdir(parents=True)
    for f in range(files):
        (root / f"f{f}.md").write_text("".join(_words(f * 1000 + c) for c in range(chunks)), encoding="utf-8")


def _count_rewrites(monkeypatch) -> list[int]:
    calls: list[int] = []
    original = NumpyIndex._rewrite_records

    def counted(self, *args, **kwargs):
        calls.append(1)
        return original(self, *args, **kwargs)

    monkeypatch.setattr(NumpyIndex, "_rewrite_records", counted)
    return calls


def test_reindexing_300_unchanged_chunks_rewrites_the_log_zero_times(monkeypatch, tmp_path):
    root = tmp_path / "docs"
    _tree(root)
    calls = _count_rewrites(monkeypatch)

    async def scenario():
        store = VectorMemory(tmp_path / "store")
        store.fallback = NumpyIndex(tmp_path / "store" / "local")
        first = await store.index_path(str(root))
        after_first = len(calls)
        second = await store.index_path(str(root))
        return store, first, second, after_first

    store, first, second, after_first = asyncio.run(scenario())
    assert first["chunks"] == second["chunks"] == 300
    assert len(store.fallback.records) == 300
    assert after_first == 0
    assert len(calls) == 0  # was one rewrite per chunk (300) before the content hash


def test_one_changed_chunk_costs_one_rewrite_and_replaces_only_that_chunk(monkeypatch, tmp_path):
    root = tmp_path / "docs"
    _tree(root, files=1, chunks=50)
    target = root / "f0.md"
    calls = _count_rewrites(monkeypatch)

    async def scenario():
        store = VectorMemory(tmp_path / "store")
        store.fallback = NumpyIndex(tmp_path / "store" / "local")
        await store.index_path(str(root))
        text = target.read_text(encoding="utf-8")
        target.write_text(
            text[: memory.INDEX_CHUNK * 7] + _words(99999) + text[memory.INDEX_CHUNK * 8 :], encoding="utf-8"
        )
        await store.index_path(str(root))
        return store

    store = asyncio.run(scenario())
    assert len(calls) == 1
    assert len(store.fallback.records) == 50
    assert any("day 99999" in r["text"] for r in store.fallback.records)


def test_a_manifest_from_before_the_hashes_still_prunes_and_is_upgraded(tmp_path):
    root = tmp_path / "docs"
    _tree(root, files=1, chunks=4)
    target = root / "f0.md"
    key = str(target.resolve())

    async def scenario():
        store = VectorMemory(tmp_path / "store")
        store.fallback = NumpyIndex(tmp_path / "store" / "local")
        await store.index_path(str(root))
        (tmp_path / "store" / "index-manifest.json").write_text(json.dumps({key: 4}), encoding="utf-8")  # old shape
        target.write_text(_words(1), encoding="utf-8")
        await store.index_path(str(root))
        return store

    store = asyncio.run(scenario())
    assert len(store.fallback.records) == 1
    saved = json.loads((tmp_path / "store" / "index-manifest.json").read_text(encoding="utf-8"))
    assert saved[key]["slots"] == 1


def test_an_empty_store_re_embeds_chunks_the_manifest_calls_unchanged(tmp_path):
    root = tmp_path / "docs"
    _tree(root, files=1, chunks=3)

    async def scenario():
        store = VectorMemory(tmp_path / "store")
        store.fallback = NumpyIndex(tmp_path / "store" / "local")
        await store.index_path(str(root))
        store.fallback = NumpyIndex(tmp_path / "other" / "local")  # the vector store was wiped
        await store.index_path(str(root))
        return store

    assert len(asyncio.run(scenario()).fallback.records) == 3


def test_add_many_writes_one_rewrite_for_any_number_of_updates(monkeypatch, tmp_path):
    index = NumpyIndex(tmp_path / "local")
    index.add_many([{"id": f"r{i}", "text": f"first {i}", "kind": "n", "title": "t"} for i in range(40)])
    calls = _count_rewrites(monkeypatch)
    index.add_many([{"id": f"r{i}", "text": f"second {i}", "kind": "n", "title": "t"} for i in range(40)])
    assert len(calls) == 1
    assert [r["text"] for r in index.records][:2] == ["second 0", "second 1"]
    reloaded = NumpyIndex(tmp_path / "local")
    reloaded.load()
    assert len(reloaded.records) == 40 and reloaded.records[39]["text"] == "second 39"


def test_adding_the_same_record_again_does_not_touch_the_disk(monkeypatch, tmp_path):
    index = NumpyIndex(tmp_path / "local")
    index.add("same text", kind="n", title="t", record_id="a")
    calls = _count_rewrites(monkeypatch)
    before = index.records_file.stat().st_size
    index.add("same text", kind="n", title="t", record_id="a")
    assert calls == [] and index.records_file.stat().st_size == before and len(index.records) == 1


def test_the_local_index_is_written_and_pruned_off_the_event_loop(monkeypatch, tmp_path):
    loop_thread = threading.get_ident()
    seen: dict[str, int] = {}
    for name in ("add_many", "remove"):
        original = getattr(NumpyIndex, name)

        def wrap(self, *args, _o=original, _n=name, **kwargs):
            seen[_n] = threading.get_ident()
            return _o(self, *args, **kwargs)

        monkeypatch.setattr(NumpyIndex, name, wrap)

    async def scenario():
        store = VectorMemory(tmp_path / "store")
        store.fallback = NumpyIndex(tmp_path / "store" / "local")
        await store.add("a note", kind="n", title="t", record_id="a")
        await store.remove(["a"])

    asyncio.run(scenario())
    assert seen["add_many"] != loop_thread and seen["remove"] != loop_thread


def test_the_same_folder_spelled_two_ways_gives_one_set_of_chunks(tmp_path):
    root = tmp_path / "docs"
    _tree(root, files=1, chunks=5)
    other_spelling = str(tmp_path / "docs" / ".." / "docs")

    async def scenario():
        store = VectorMemory(tmp_path / "store")
        store.fallback = NumpyIndex(tmp_path / "store" / "local")
        await store.index_path(str(root))
        await store.index_path(other_spelling)
        return store

    store = asyncio.run(scenario())
    assert len(store.fallback.records) == 5
    manifest = json.loads((tmp_path / "store" / "index-manifest.json").read_text(encoding="utf-8"))
    assert len(manifest) == 1


def test_memory_failures_go_to_the_logger_not_to_stdout(caplog, capsys, tmp_path):
    class Broken:
        def get(self, **kwargs):
            raise RuntimeError("gone")

    async def scenario():
        store = VectorMemory(tmp_path)
        store.fallback = NumpyIndex(tmp_path / "local")
        with caplog.at_level("WARNING", logger="friday.memory"):
            await store._copy_chroma_to_fallback(Broken())
            store._degrade(RuntimeError("boom"))

    asyncio.run(scenario())
    assert capsys.readouterr().out == ""
    assert any("could not copy" in r.getMessage() for r in caplog.records)
