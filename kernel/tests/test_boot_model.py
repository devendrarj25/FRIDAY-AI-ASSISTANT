"""The speech worker loads a local folder. The size plan lives in the app."""

import unittest
from pathlib import Path
from unittest import mock

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

    def test_missing_cuda_libraries_stay_on_cpu_int8(self):
        spec = stt.model_load_kwargs("base", "/models/base")
        self.assertEqual(spec["device"], "cpu")
        self.assertEqual(spec["compute_type"], "int8")
        self.assertIn("CPU int8", spec["reason"])

    def test_cuda_libraries_select_the_gpu_and_a_failure_returns_to_cpu(self):
        with mock.patch.object(stt, "cuda_runtime_ready", return_value=True):
            spec = stt.model_load_kwargs("base", "/models/base")
        self.assertEqual(spec["device"], "cuda")
        self.assertEqual(spec["compute_type"], "float16")

        class Boom:
            def __init__(self, *_args, **kwargs):
                if kwargs.get("device") == "cuda":
                    raise RuntimeError("cublas missing")
                self.device = kwargs.get("device")

        model, used = stt.open_whisper(Boom, "base", spec)
        self.assertEqual(used, "cpu")
        self.assertEqual(model.device, "cpu")

    def test_the_size_plan_is_not_copied_here(self):
        root = Path(__file__).resolve().parents[2]
        app = (root / "electron" / "voice-install.cjs").read_text(encoding="utf-8")
        worker = Path(stt.__file__).read_text(encoding="utf-8")
        self.assertIn("function bootModel", app)
        self.assertNotIn("def boot_model", worker)
        self.assertNotIn("boot_model", dir(stt))
        self.assertIn('"local_files_only": True', worker)
        self.assertNotIn("snapshot_download", worker)


if __name__ == "__main__":
    unittest.main()
