"""Wake-word probe must never fake a ready openWakeWord engine."""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

KERNEL = Path(__file__).resolve().parent.parent
SCRIPT = KERNEL / "wake_word.py"


class WakeWordProbeTests(unittest.TestCase):
    def test_probe_does_not_claim_a_friday_model_that_is_not_there(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--probe", "--wake-word", "friday"],
            cwd=str(KERNEL),
            capture_output=True,
            text=True,
            timeout=30,
            env={**__import__("os").environ, "FRIDAY_ROOT": str(KERNEL / "tests" / "_empty_root")},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout.strip().splitlines()[-1])
        # Missing openwakeword OR missing friday.onnx — never ready:true.
        self.assertFalse(payload.get("ready"))
        if payload.get("ok") is True:
            self.assertIsNone(payload.get("model"))
            self.assertIn("no wake model", (payload.get("error") or "").lower())
        else:
            self.assertIn(payload.get("reason"), {"missing-dependency", "no-model"})

    def test_bundled_model_detects_demo_wav_and_rejects_noise(self):
        import shutil
        import tempfile

        bundle = KERNEL.parent / "resources" / "wake"
        demo = bundle / "friday-demo.wav"
        noise = bundle / "noise-demo.wav"
        self.assertTrue((bundle / "friday.onnx").is_file())
        self.assertTrue(demo.is_file())
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "models" / "wake"
            dest.mkdir(parents=True)
            shutil.copy(bundle / "friday.onnx", dest / "friday.onnx")
            shutil.copy(bundle / "friday-wake.json", dest / "friday-wake.json")
            env = {**__import__("os").environ, "FRIDAY_ROOT": tmp}
            hit = subprocess.run(
                [sys.executable, str(SCRIPT), "--audio", str(demo), "--wake-word", "friday"],
                cwd=str(KERNEL),
                capture_output=True,
                text=True,
                timeout=30,
                env=env,
            )
            self.assertEqual(hit.returncode, 0, hit.stderr)
            payload = json.loads(hit.stdout.strip().splitlines()[-1])
            self.assertTrue(payload.get("ok"))
            self.assertTrue(payload.get("detected"))
            self.assertEqual(payload.get("engine"), "friday-linear")
            miss = subprocess.run(
                [sys.executable, str(SCRIPT), "--audio", str(noise), "--wake-word", "friday"],
                cwd=str(KERNEL),
                capture_output=True,
                text=True,
                timeout=30,
                env=env,
            )
            self.assertEqual(miss.returncode, 0, miss.stderr)
            rejected = json.loads(miss.stdout.strip().splitlines()[-1])
            self.assertTrue(rejected.get("ok"))
            self.assertFalse(rejected.get("detected"))

    def test_detect_without_audio_does_not_invent_a_hit(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--wake-word", "friday"],
            cwd=str(KERNEL),
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertFalse(payload.get("detected"))
        self.assertNotEqual(payload.get("ok"), True)

    def test_pick_model_does_not_fall_back_to_friday_for_jarvis(self):
        import importlib.util
        import shutil
        import tempfile

        spec = importlib.util.spec_from_file_location("wake_word", SCRIPT)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        bundle = KERNEL.parent / "resources" / "wake"
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "models" / "wake"
            dest.mkdir(parents=True)
            shutil.copy(bundle / "friday.onnx", dest / "friday.onnx")
            shutil.copy(bundle / "friday-wake.json", dest / "friday-wake.json")
            old = __import__("os").environ.get("FRIDAY_ROOT")
            __import__("os").environ["FRIDAY_ROOT"] = tmp
            try:
                self.assertIsNone(mod.pick_model("jarvis", None))
                friday = mod.pick_model("friday", None)
                self.assertIsNotNone(friday)
                self.assertTrue(str(friday).endswith("friday.onnx"))
                probe = subprocess.run(
                    [sys.executable, str(SCRIPT), "--probe", "--wake-word", "jarvis"],
                    cwd=str(KERNEL),
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=30,
                    env={
                        **__import__("os").environ,
                        "FRIDAY_ROOT": tmp,
                        "PYTHONIOENCODING": "utf-8",
                    },
                )
                self.assertEqual(probe.returncode, 0, probe.stderr)
                payload = json.loads(probe.stdout.strip().splitlines()[-1])
                self.assertFalse(payload.get("ready"))
                self.assertIsNone(payload.get("model"))
            finally:
                if old is None:
                    __import__("os").environ.pop("FRIDAY_ROOT", None)
                else:
                    __import__("os").environ["FRIDAY_ROOT"] = old

    def test_serve_probe_does_not_claim_jarvis_ready_from_friday_model(self):
        import shutil
        import tempfile

        bundle = KERNEL.parent / "resources" / "wake"
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "models" / "wake"
            dest.mkdir(parents=True)
            shutil.copy(bundle / "friday.onnx", dest / "friday.onnx")
            proc = subprocess.Popen(
                [sys.executable, str(SCRIPT), "--serve"],
                cwd=str(KERNEL),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                env={
                    **__import__("os").environ,
                    "FRIDAY_ROOT": tmp,
                    "PYTHONIOENCODING": "utf-8",
                },
            )
            try:
                assert proc.stdin and proc.stdout
                proc.stdin.write(json.dumps({"id": 1, "op": "probe", "wakeWord": "jarvis"}) + "\n")
                proc.stdin.flush()
                line = proc.stdout.readline()
                payload = json.loads(line)
                self.assertEqual(payload.get("id"), 1)
                self.assertFalse(payload.get("ready"))
                proc.stdin.write(json.dumps({"id": 2, "op": "shutdown"}) + "\n")
                proc.stdin.flush()
                proc.wait(timeout=10)
            finally:
                if proc.poll() is None:
                    proc.kill()


if __name__ == "__main__":
    unittest.main()
