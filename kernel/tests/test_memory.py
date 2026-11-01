"""Canonical memory ids survive add + search on the numpy fallback."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from memory import NumpyIndex  # noqa: E402


class NumpyMemoryIdTests(unittest.TestCase):
    def test_add_keeps_canonical_id_and_search_returns_it(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            idx = NumpyIndex(Path(tmp))
            idx.add(
                "FRIDAY owner is Devendra Singh Meena",
                kind="permanent",
                title="Owner",
                record_id="mem-owner-1",
            )
            hits = idx.search("Devendra", k=3)
            self.assertTrue(hits)
            self.assertEqual(hits[0]["id"], "mem-owner-1")
            self.assertIn("Devendra", hits[0]["snippet"])
            idx.add(
                "FRIDAY owner is someone else entirely",
                kind="permanent",
                title="Owner",
                record_id="mem-owner-1",
            )
            self.assertEqual(len(idx.records), 1)
            updated = idx.search("someone else", k=3)
            self.assertTrue(updated)
            self.assertEqual(updated[0]["id"], "mem-owner-1")
            self.assertIn("someone else", updated[0]["snippet"])

    def test_generated_id_is_returned_when_none_supplied(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            idx = NumpyIndex(Path(tmp))
            idx.add("a unique hashed fact about widgets", kind="note", title="Widgets")
            hits = idx.search("widgets", k=3)
            self.assertTrue(hits)
            self.assertTrue(hits[0]["id"])


if __name__ == "__main__":
    unittest.main()


class NumpyMemoryRemoveTests(unittest.TestCase):
    def test_a_removed_record_is_gone_from_search_and_from_disk(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            idx = NumpyIndex(Path(tmp))
            idx.add("owner phone is a Pixel 6", kind="semantic", title="Phone", record_id="m1")
            idx.add("owner city is Jaipur", kind="semantic", title="City", record_id="m2")
            self.assertEqual(idx.remove(["m1", "unknown", ""]), 1)
            self.assertEqual([r["id"] for r in idx.records], ["m2"])
            self.assertFalse([h for h in idx.search("Pixel phone", k=5) if h.get("id") == "m1"])
            reopened = NumpyIndex(Path(tmp))
            reopened.load()
            self.assertEqual([r["id"] for r in reopened.records], ["m2"])
            self.assertEqual(len(reopened.vectors), 1)

    def test_removing_nothing_changes_nothing_and_the_last_record_can_go(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            idx = NumpyIndex(Path(tmp))
            idx.add("one fact", kind="semantic", title="One", record_id="only")
            self.assertEqual(idx.remove([]), 0)
            self.assertEqual(idx.remove(["only"]), 1)
            self.assertEqual(idx.search("one fact", k=3), [])

    def test_search_sees_a_record_added_after_an_earlier_search(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            idx = NumpyIndex(Path(tmp))
            idx.add("alpha topic about gardens", kind="semantic", title="A", record_id="a")
            idx.search("gardens", k=3)
            idx.add("beta topic about harbours", kind="semantic", title="B", record_id="b")
            hits = idx.search("harbours", k=3)
            self.assertEqual(hits[0]["id"], "b")


class VectorMemoryCountTests(unittest.TestCase):
    def test_count_and_remove_follow_the_local_index(self) -> None:
        import asyncio

        from memory import VectorMemory  # noqa: PLC0415

        with tempfile.TemporaryDirectory() as tmp:
            store = VectorMemory(Path(tmp))
            store.fallback = NumpyIndex(Path(tmp) / "local")
            self.assertEqual(store.count(), 0)
            asyncio.run(store.add("a fact about tea", kind="semantic", title="Tea", record_id="t1"))
            asyncio.run(store.add("a fact about rice", kind="semantic", title="Rice", record_id="r1"))
            self.assertEqual(store.count(), 2)
            self.assertEqual(asyncio.run(store.remove(["t1", "missing"])), 1)
            self.assertEqual(store.count(), 1)
            self.assertEqual(asyncio.run(store.remove([])), 0)
