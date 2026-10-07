"""Persistent STT worker: status/ping without loading weights; shutdown reaps."""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

KERNEL = Path(__file__).resolve().parent.parent
SCRIPT = KERNEL / "stt.py"


class SttServeTests(unittest.TestCase):
    def test_serve_status_does_not_construct_a_model(self):
        proc = subprocess.Popen(
            [sys.executable, str(SCRIPT), "--serve"],
            cwd=str(KERNEL),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            assert proc.stdin and proc.stdout
            proc.stdin.write(json.dumps({"id": 1, "op": "status"}) + "\n")
            proc.stdin.flush()
            first = json.loads(proc.stdout.readline())
            self.assertEqual(first.get("id"), 1)
            self.assertEqual(first.get("loadCount"), 0)
            proc.stdin.write(json.dumps({"id": 2, "op": "status"}) + "\n")
            proc.stdin.flush()
            second = json.loads(proc.stdout.readline())
            self.assertEqual(second.get("id"), 2)
            self.assertEqual(second.get("loadCount"), 0)
            proc.stdin.write(json.dumps({"id": 3, "op": "shutdown"}) + "\n")
            proc.stdin.flush()
            proc.wait(timeout=10)
            self.assertEqual(proc.returncode, 0)
        finally:
            if proc.poll() is None:
                proc.kill()


if __name__ == "__main__":
    unittest.main()
