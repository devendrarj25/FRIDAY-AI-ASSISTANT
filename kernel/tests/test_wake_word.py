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

    def test_fixture_is_scored_only_when_explicitly_allowed_never_as_production(self):
        import shutil
        import tempfile

        bundle = KERNEL.parent / "testing" / "wake-fixture"
        demo = bundle / "friday-demo.wav"
        noise = bundle / "noise-demo.wav"
        self.assertTrue(demo.is_file())
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "models" / "wake"
            dest.mkdir(parents=True)
            shutil.copy(bundle / "friday-wake.json", dest / "friday-wake.json")

            def run(args, extra=None):
                env = {**__import__("os").environ, "FRIDAY_ROOT": tmp, **(extra or {})}
                env.pop("FRIDAY_WAKE_ALLOW_FIXTURE", None) if extra is None else None
                done = subprocess.run(
                    [sys.executable, str(SCRIPT), *args],
                    cwd=str(KERNEL),
                    capture_output=True,
                    text=True,
                    timeout=60,
                    env=env,
                )
                self.assertEqual(done.returncode, 0, done.stderr)
                return json.loads(done.stdout.strip().splitlines()[-1])

            # The app never sets the switch: a synthetic model is not ready and answers nothing.
            refused = run(["--audio", str(demo), "--wake-word", "friday"])
            self.assertFalse(refused.get("ok"))
            self.assertEqual(refused.get("reason"), "not-production")
            probe = run(["--probe", "--wake-word", "friday"])
            self.assertFalse(probe.get("ready"))
            self.assertEqual(probe.get("engine"), "transcript")
            self.assertIn("synthetic", (probe.get("error") or "").lower())
            # Tests and development may opt in to exercise the scoring code.
            allow = {"FRIDAY_WAKE_ALLOW_FIXTURE": "1"}
            hit = run(["--audio", str(demo), "--wake-word", "friday"], allow)
            self.assertTrue(hit.get("ok") and hit.get("detected"))
            self.assertEqual(hit.get("engine"), "friday-linear")
            miss = run(["--audio", str(noise), "--wake-word", "friday"], allow)
            self.assertTrue(miss.get("ok"))
            self.assertFalse(miss.get("detected"))

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
        bundle = KERNEL.parent / "testing" / "wake-fixture"
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "models" / "wake"
            dest.mkdir(parents=True)
            shutil.copy(bundle / "friday-wake.json", dest / "friday-wake.json")
            old = __import__("os").environ.get("FRIDAY_ROOT")
            __import__("os").environ["FRIDAY_ROOT"] = tmp
            try:
                self.assertIsNone(mod.pick_model("jarvis", None))
                friday = mod.pick_model("friday", None)
                self.assertIsNotNone(friday)
                self.assertTrue(str(friday).endswith("friday-wake.json"))
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

        bundle = KERNEL.parent / "testing" / "wake-fixture"
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "models" / "wake"
            dest.mkdir(parents=True)
            shutil.copy(bundle / "friday-wake.json", dest / "friday-wake.json")
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


class WakeEngineManifestTests(unittest.TestCase):
    """The engine comes from what the model says it is, not from its file name."""

    def setUp(self):
        sys.path.insert(0, str(KERNEL))
        import importlib

        import wake_word

        self.wake = importlib.reload(wake_word)

    def test_a_real_model_named_friday_is_not_taken_for_the_linear_scorer(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            model = Path(tmp) / "friday.onnx"
            model.write_bytes(b"\0" * 200_000)  # a real model is far larger than the bundled scorer
            (Path(tmp) / "friday-wake.json").write_text(json.dumps({"kind": "friday-linear-v1"}), encoding="utf-8")
            self.assertEqual(self.wake.engine_for_path(str(model)), "openwakeword")

    def test_the_bundled_scorer_is_still_the_linear_engine(self):
        bundled = KERNEL.parent / "testing" / "wake-fixture" / "friday-wake.json"
        self.assertEqual(self.wake.engine_for_path(str(bundled)), "friday-linear")

    def test_a_recorded_hash_must_match_the_file(self):
        import hashlib
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            model = Path(tmp) / "friday.onnx"
            model.write_bytes(b"abc")
            good = hashlib.sha256(b"abc").hexdigest()
            manifest = Path(tmp) / "friday-wake.json"
            manifest.write_text(json.dumps({"kind": "friday-linear-v1", "modelSha256": good}), encoding="utf-8")
            self.assertEqual(self.wake.engine_for_path(str(model)), "friday-linear")
            manifest.write_text(json.dumps({"kind": "friday-linear-v1", "modelSha256": "0" * 64}), encoding="utf-8")
            self.assertEqual(self.wake.engine_for_path(str(model)), "openwakeword")

    def test_a_sidecar_names_the_engine_outright(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            model = Path(tmp) / "hey-friday.onnx"
            model.write_bytes(b"x")
            (Path(tmp) / "hey-friday.wake.json").write_text(json.dumps({"engine": "friday-linear"}), encoding="utf-8")
            self.assertEqual(self.wake.engine_for_path(str(model)), "friday-linear")

    def test_no_path_is_no_engine(self):
        self.assertIsNone(self.wake.engine_for_path(None))


class WakeFrameScorerTests(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, str(KERNEL))
        import importlib

        import wake_word

        self.wake = importlib.reload(wake_word)

    def scorer(self, scores, **kw):
        it = iter(scores)
        return self.wake.WakeFrameScorer(lambda _frame: next(it, 0.0), **kw)

    def frame(self):
        return [0] * self.wake.FRAME_SAMPLES

    def test_chunks_of_any_size_are_cut_into_80_ms_frames(self):
        s = self.scorer([0.0, 0.0])
        out = s.feed([0] * 1000)
        self.assertEqual(out["frames"], 0)
        out = s.feed([0] * 1560)  # 2560 samples in all = two frames
        self.assertEqual(out["frames"], 2)
        self.assertEqual(len(s.pending), 0)

    def test_it_needs_consecutive_hot_frames_and_fires_once(self):
        s = self.scorer([0.9, 0.1, 0.9, 0.9, 0.9, 0.9], min_frames=2, cooldown_ms=0)
        fired = [s.feed(self.frame())["detected"] for _ in range(6)]
        self.assertEqual(fired, [False, False, False, True, False, False])

    def test_it_stays_latched_until_the_score_falls_and_the_cooldown_passes(self):
        s = self.scorer([0.9, 0.9] + [0.9] * 3 + [0.0, 0.0, 0.9, 0.9], min_frames=2, cooldown_ms=240)
        results = [s.feed(self.frame())["detected"] for _ in range(9)]
        self.assertEqual(results.count(True), 2)
        self.assertTrue(results[1])  # first phrase
        self.assertTrue(results[8])  # second phrase only after the release

    def test_reset_clears_the_state(self):
        s = self.scorer([0.9, 0.9])
        s.feed(self.frame())
        s.feed(self.frame())
        s.reset()
        self.assertFalse(s.latched)
        self.assertEqual(s.pending, [])

    def test_frame_op_needs_an_openwakeword_model_and_valid_audio(self):
        import base64
        import os
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            os.environ["FRIDAY_ROOT"] = tmp
            try:
                directory = Path(tmp) / "models" / "wake"
                directory.mkdir(parents=True)
                (directory / "friday.onnx").write_bytes(b"\0" * 100_000)
                self.wake._frame_scorers.clear()
                predictor = lambda _path: lambda _frame: 0.9  # noqa: E731
                chunk = base64.b64encode(b"\0\0" * 1280).decode()
                req = {"op": "frame", "session": "a", "pcm": chunk, "minFrames": 1}
                first = self.wake.frame_op(req, "friday", None, 0.5, make_predictor=predictor)
                self.assertTrue(first["ok"])
                self.assertTrue(first["detected"])
                again = self.wake.frame_op(req, "friday", None, 0.5, make_predictor=predictor)
                self.assertFalse(again["detected"])  # latched: one phrase, one trigger
                odd = self.wake.frame_op({**req, "pcm": base64.b64encode(b"\0").decode()}, "friday", None, 0.5)
                self.assertEqual(odd["reason"], "bad-request")
                cleared = self.wake.frame_op({"session": "a", "reset": True}, "friday", None, 0.5)
                self.assertTrue(cleared["ok"])
                # the bundled linear scorer cannot score live frames
                (directory / "friday.onnx").write_bytes(b"\0" * 100)
                (directory / "friday-wake.json").write_text(json.dumps({"kind": "friday-linear-v1"}), encoding="utf-8")
                linear = self.wake.frame_op({**req, "session": "b"}, "friday", None, 0.5)
                self.assertEqual(linear["reason"], "frame-unsupported")
            finally:
                os.environ.pop("FRIDAY_ROOT", None)
                self.wake._frame_scorers.clear()


class WakeEvaluationTests(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, str(KERNEL))
        import importlib

        import wake_word

        self.wake = importlib.reload(wake_word)

    def predictor(self):
        # A stand-in model: a frame that starts with 1000 is "the wake phrase", anything else is not.
        return lambda frame: 0.9 if frame[0] == 1000 else 0.05

    def clip(self, hot_frames, total_frames):
        n = self.wake.FRAME_SAMPLES
        out = []
        for i in range(total_frames):
            out.extend([1000 if i in hot_frames else 0] * n)
        return out

    def test_reports_rejections_accepts_per_hour_and_delay(self):
        positives = [self.clip({3, 4, 5}, 8), self.clip({2, 3, 4}, 8), self.clip(set(), 8)]  # the last is missed
        negatives = [self.clip(set(), 2250), self.clip({100, 101}, 2250)]  # two clips of three minutes each
        report = self.wake.evaluate_wake(positives, negatives, self.predictor, cooldown_ms=0)
        self.assertEqual(report["positives"], 3)
        self.assertAlmostEqual(report["falseRejectionRate"], 0.3333, places=3)
        self.assertEqual(report["negativeHours"], 0.1)
        self.assertEqual(report["falseAcceptsPerHour"], 10.0)  # one trigger in six minutes
        self.assertIsNotNone(report["triggerDelaySeconds"]["median"])
        self.assertFalse(report["meetsTargets"])  # 33 % rejection is far over the 5 % target

    def test_meets_targets_only_when_both_rates_are_under_the_limit(self):
        positives = [self.clip({2, 3}, 6) for _ in range(30)]
        negatives = [self.clip(set(), 2250)]
        report = self.wake.evaluate_wake(positives, negatives, self.predictor, cooldown_ms=0)
        self.assertEqual(report["falseRejectionRate"], 0.0)
        self.assertEqual(report["falseAcceptsPerHour"], 0.0)
        self.assertTrue(report["meetsTargets"])

    def test_no_clips_never_claims_the_targets_are_met(self):
        report = self.wake.evaluate_wake([], [], self.predictor)
        self.assertIsNone(report["falseRejectionRate"])
        self.assertIsNone(report["falseAcceptsPerHour"])
        self.assertFalse(report["meetsTargets"])

    def test_the_folder_run_refuses_without_an_openwakeword_model(self):
        import os
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            os.environ["FRIDAY_ROOT"] = tmp
            try:
                out = self.wake.evaluate_directories(tmp, tmp, "friday", None, 0.5)
                self.assertFalse(out["ok"])
                self.assertEqual(out["reason"], "no-model")
            finally:
                os.environ.pop("FRIDAY_ROOT", None)


class FridayEmbedEngineTests(unittest.TestCase):
    """The friday-embed engine: chosen by its manifest, never faked when its embedding model is missing."""

    def setUp(self):
        import hashlib
        import importlib
        import os
        import tempfile
        from unittest import mock

        import numpy as np

        sys.path.insert(0, str(KERNEL))
        import wake_features
        import wake_word

        self.np = np
        self.wf = wake_features
        self.wake = importlib.reload(wake_word)
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        patcher = mock.patch.dict(os.environ, {"FRIDAY_ROOT": tmp.name})
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop("FRIDAY_WAKE_ALLOW_FIXTURE", None)
        os.environ.pop("FRIDAY_WAKE_EMBED_MODEL", None)
        self.dir = Path(tmp.name) / "models" / "wake"
        self.dir.mkdir(parents=True)
        self.embedding_bytes = b"embedding-model-stand-in"
        self.embedding_sha = hashlib.sha256(self.embedding_bytes).hexdigest()
        self.manifest_path = self.dir / "friday-wake.json"

    def use_fake_embed(self):
        from unittest import mock

        patcher = mock.patch.object(self.wake, "embed_fn", lambda _manifest: self.fake_embed)
        patcher.start()
        self.addCleanup(patcher.stop)

    def fake_embed(self, windows):
        return self.np.asarray(windows, dtype=self.np.float32).mean(axis=1)

    def write_manifest(self, production=True, sha=None, **extra):
        np = self.np
        dim = 32
        manifest = {
            "kind": "friday-embed-v1",
            "provenance": "real-speech",
            "production": production,
            "embedding": {"file": "wake-embed.onnx", "sha256": self.embedding_sha if sha is None else sha},
            "head": {
                "window": 16,
                "mean": self.wf.encode_tensor(np.zeros(dim)),
                "std": self.wf.encode_tensor(np.ones(dim)),
                # loud audio has high mel values, silence very low ones: this head answers 1 for sound, 0 for quiet
                "layers": [
                    {"w": self.wf.encode_tensor(np.full((dim * 16, 1), 0.01)), "b": self.wf.encode_tensor([0.0])}
                ],
            },
            "threshold": 0.5,
            "evaluation": {"meetsTargets": production, "independent": True},
            **extra,
        }
        self.manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    def install_embedding(self):
        (self.dir / "wake-embed.onnx").write_bytes(self.embedding_bytes)

    def loud(self, seconds):
        rng = self.np.random.default_rng(4)
        return [int(v) for v in rng.normal(0, 4000, int(seconds * 16000))]

    def test_the_manifest_names_the_engine_and_a_sidecar_can_too(self):
        self.write_manifest()
        self.assertEqual(self.wake.engine_for_path(str(self.manifest_path)), "friday-embed")
        (self.dir / "hey.wake.json").write_text(json.dumps({"engine": "friday-embed"}), encoding="utf-8")
        self.assertEqual(self.wake.engine_for_path(str(self.dir / "hey.onnx")), "friday-embed")

    def test_without_the_embedding_model_it_is_not_ready_and_says_why(self):
        import os

        self.write_manifest()
        os.environ["FRIDAY_WAKE_ALLOW_FIXTURE"] = "1"  # the fixture switch never waives a missing model
        allowed, why = self.wake.production_status(str(self.manifest_path))
        self.assertFalse(allowed)
        self.assertIn("not installed", why)
        probe = self.wake.probe_payload("friday")
        self.assertFalse(probe["ready"])
        self.assertEqual(probe["engine"], "transcript")
        self.assertIn("not installed", probe["error"])
        detected = self.wake.detect_audio(str(self.dir / "none.wav"), "friday", None, 0.5)
        self.assertEqual((detected["ok"], detected["reason"]), (False, "not-production"))
        frames = self.wake.frame_op({"pcm": "AAAA", "session": "s1"}, "friday", None, 0.5)
        self.assertEqual((frames["ok"], frames["reason"]), (False, "missing-embedding-model"))
        self.assertEqual(
            self.wake.score_embed([0] * 100, str(self.manifest_path), 0.5)["reason"], "missing-embedding-model"
        )

    def test_an_embedding_model_that_is_not_the_trained_one_is_refused(self):
        self.write_manifest(sha="0" * 64)
        self.install_embedding()
        allowed, why = self.wake.production_status(str(self.manifest_path))
        self.assertFalse(allowed)
        self.assertIn("not the one", why)

    def test_the_embed_head_is_preferred_only_when_its_model_is_installed(self):
        self.write_manifest()
        oww = self.dir / "friday.onnx"
        oww.write_bytes(b"\0" * 20000)
        self.assertEqual(self.wake.pick_model("friday", None), str(oww))  # fallback while the embedding is missing
        self.install_embedding()
        self.assertEqual(self.wake.pick_model("friday", None), str(self.manifest_path))

    def test_the_real_speech_gate_still_applies_to_the_embed_head(self):
        self.install_embedding()
        self.write_manifest(production=False, notProductionBecause=["3 speakers needed"])
        allowed, why = self.wake.production_status(str(self.manifest_path))
        self.assertFalse(allowed)
        self.assertIn("3 speakers", why)
        self.write_manifest(provenance="synthetic-fixture")
        self.assertFalse(self.wake.production_status(str(self.manifest_path))[0])
        self.write_manifest()
        self.assertEqual(self.wake.production_status(str(self.manifest_path)), (True, ""))
        self.assertTrue(self.wake.probe_payload("friday")["ready"])
        self.assertEqual(self.wake.probe_payload("friday")["engine"], "friday-embed")

    def test_live_frames_are_scored_by_the_stream_after_it_primes(self):
        import base64

        self.write_manifest()
        self.install_embedding()
        self.use_fake_embed()
        audio = self.np.asarray(self.loud(4.0), dtype="<i2")
        results = []
        for index in range(40):
            chunk = audio[index * 1280 : (index + 1) * 1280]
            results.append(
                self.wake.frame_op(
                    {"pcm": base64.b64encode(chunk.tobytes()).decode(), "session": "live", "minFrames": 2},
                    "friday",
                    None,
                    0.5,
                )
            )
        self.assertTrue(all(r["ok"] and r["engine"] == "friday-embed" for r in results))
        self.assertTrue(all(r["score"] == 0.0 for r in results[:24]))  # 10 steps to the first embedding, 16 to a window
        self.assertGreater(results[24]["score"], 0.9)
        self.assertEqual(sum(1 for r in results if r["detected"]), 1)
        self.wake._frame_scorers.clear()

    def test_a_clip_is_scored_and_quiet_audio_is_not_a_wake_word(self):
        import wave

        self.write_manifest()
        self.install_embedding()
        self.use_fake_embed()

        def wav(name, samples):
            path = self.dir.parent / name
            with wave.open(str(path), "wb") as handle:
                handle.setnchannels(1)
                handle.setsampwidth(2)
                handle.setframerate(16000)
                handle.writeframes(self.np.asarray(samples, dtype="<i2").tobytes())
            return str(path)

        hit = self.wake.detect_audio(wav("loud.wav", self.loud(1.5)), "friday", None, 0.5)
        miss = self.wake.detect_audio(wav("quiet.wav", [0] * 24000), "friday", None, 0.5)
        self.assertTrue(hit["ok"], hit)
        self.assertEqual((hit["engine"], hit["detected"]), ("friday-embed", True))
        self.assertEqual((miss["ok"], miss["detected"]), (True, False))
        self.assertGreater(hit["score"], miss["score"])

    def test_the_folder_evaluation_runs_on_the_embed_engine(self):
        import wave

        self.write_manifest()
        self.install_embedding()
        self.use_fake_embed()
        for kind, samples in (("pos", self.loud(1.5)), ("neg", [0] * 24000)):
            folder = self.dir.parent / kind
            folder.mkdir()
            with wave.open(str(folder / "a.wav"), "wb") as handle:
                handle.setnchannels(1)
                handle.setsampwidth(2)
                handle.setframerate(16000)
                handle.writeframes(self.np.asarray(samples, dtype="<i2").tobytes())
        report = self.wake.evaluate_directories(
            str(self.dir.parent / "pos"), str(self.dir.parent / "neg"), "friday", None, 0.5
        )
        self.assertTrue(report["ok"], report)
        self.assertEqual((report["positives"], report["negatives"]), (1, 1))
        self.assertEqual(report["falseRejectionRate"], 0.0)
        self.assertEqual(report["falseAcceptsPerHour"], 0.0)

    def test_the_old_engines_still_answer_beside_it(self):
        bundled = KERNEL.parent / "testing" / "wake-fixture" / "friday-wake.json"
        self.assertEqual(self.wake.engine_for_path(str(bundled)), "friday-linear")
        model = self.dir / "other.onnx"
        model.write_bytes(b"\0" * 20000)
        self.assertEqual(self.wake.engine_for_path(str(model)), "openwakeword")


if __name__ == "__main__":
    unittest.main()
