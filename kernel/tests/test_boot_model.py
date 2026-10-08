"""The speech worker loads a local folder. The size plan lives in the app."""

import unittest
from pathlib import Path

from kernel import stt


class ModelLoadTests(unittest.TestCase):
    def test_loader_stays_on_local_files(self):
        spec = stt.model_load_kwargs("base", "/models/base")
        self.assertEqual(spec["target"], "/models/base")
        self.assertTrue(spec["local_files_only"])
        self.assertNotIn("boot_model", dir(stt))

    def test_a_size_name_still_refuses_a_download(self):
        spec = stt.model_load_kwargs("small", None)
        self.assertEqual(spec["target"], "small")
        self.assertTrue(spec["local_files_only"])

    def test_the_size_plan_is_not_copied_here(self):
        source = Path("kernel/stt.py").read_text(encoding="utf-8")
        self.assertNotIn("def boot_model", source)
        self.assertIn('"local_files_only": True', source)
        self.assertNotIn("snapshot_download", source)


if __name__ == "__main__":
    unittest.main()
