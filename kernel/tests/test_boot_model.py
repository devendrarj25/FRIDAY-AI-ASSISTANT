"""The speech size plan lives in the app. The worker only opens a local folder."""

import unittest
from pathlib import Path

from kernel import stt


class ModelLoadTests(unittest.TestCase):
    def test_the_size_plan_is_not_copied_here(self):
        root = Path(__file__).resolve().parents[2]
        app = (root / "electron" / "voice-install.cjs").read_text(encoding="utf-8")
        worker = Path(stt.__file__).read_text(encoding="utf-8")
        self.assertIn("function bootModel", app)
        self.assertNotIn("def boot_model", worker)
        self.assertNotIn("boot_model", dir(stt))
        self.assertIn("local_files_only=True", worker)


if __name__ == "__main__":
    unittest.main()
