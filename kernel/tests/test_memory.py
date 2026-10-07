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
