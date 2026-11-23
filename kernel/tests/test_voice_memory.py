"""The voice check names the machine's memory, from the one reader in stt.py (no package, nothing downloaded)."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

KERNEL = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(KERNEL))

import stt  # noqa: E402
import voice_runtime  # noqa: E402


class MemoryStatusTests(unittest.TestCase):
    def test_reports_total_and_free_in_gb_from_the_stt_reader(self):
        with mock.patch.object(stt, "read_memory_mb", return_value=(10240.0, 16000.0)):
            memory = voice_runtime.memory_status()
        self.assertEqual(memory, {"known": True, "totalGb": 15.6, "freeGb": 10.0})

    def test_an_unreadable_machine_is_unknown_not_an_error(self):
        with mock.patch.object(stt, "read_memory_mb", return_value=None):
            self.assertEqual(voice_runtime.memory_status(), {"known": False, "totalGb": None, "freeGb": None})
        with mock.patch.object(stt, "read_memory_mb", side_effect=OSError("denied")):
            self.assertFalse(voice_runtime.memory_status()["known"])

    def test_the_check_has_one_memory_line_and_the_status_carries_it(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"FRIDAY_ROOT": tmp}):
            with mock.patch.object(stt, "read_memory_mb", return_value=(10240.0, 16384.0)):
                lines = voice_runtime.check_lines()
                payload = voice_runtime.status()
            with mock.patch.object(stt, "read_memory_mb", return_value=None):
                unknown = [line for line in voice_runtime.check_lines() if " memory" in line]
        memory = [line for line in lines if line.split(" ")[1:2] == ["memory"]]
        self.assertEqual(memory, ["PASS memory total=16.0GB free=10.0GB"])
        self.assertEqual(payload["memory"], {"known": True, "totalGb": 16.0, "freeGb": 10.0})
        self.assertEqual(unknown, ["OPTIONAL memory unmeasured on this system"])


if __name__ == "__main__":
    unittest.main()
