"""The wake trainer: real-speech gating, held-out evaluation, and the runtime refusing anything else.

The audio made here is band-limited noise shaped like words, enough to exercise the code. It is not speech, and
nothing in this file claims a model is good: it proves that a model is only ever called production when the
dataset is attested, large and varied enough, and meets its held-out targets, and that the app ignores the rest.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path
from typing import Any

import numpy as np

KERNEL = Path(__file__).resolve().parent.parent
ROOT = KERNEL.parent
SCRIPT = ROOT / "scripts" / "train-friday-wake.py"
sys.path.insert(0, str(KERNEL))

import wake_features as wf  # noqa: E402
import wake_word  # noqa: E402


def load_trainer() -> Any:
    spec = importlib.util.spec_from_file_location("train_friday_wake", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["train_friday_wake"] = module
    spec.loader.exec_module(module)
    return module


def band_noise(rng, seconds, bands, pulses):
    """Noise passed through spectral bands and cut into syllable-like pulses (not tones, not speech)."""
    n = int(seconds * wf.RATE)
    spectrum = np.fft.rfft(rng.normal(size=n))
    freqs = np.fft.rfftfreq(n, 1 / wf.RATE)
    mask = np.zeros_like(freqs)
    for low, high in bands:
        mask[(freqs >= low) & (freqs <= high)] = 1.0
    x = np.fft.irfft(spectrum * mask, n)
    x = x / (np.abs(x).max() + 1e-9)
    env = np.zeros(n)
    for start, length in pulses:
        a = int(start * wf.RATE)
        b = min(n, a + int(length * wf.RATE))
        env[a:b] = np.hanning(b - a)
    return (x * env * 0.5 * 32767).astype(np.int16)


def positive(rng):
    return band_noise(rng, 1.4, [(500, 700), (1200, 1600), (2600, 3000)], [(0.2, 0.18), (0.45, 0.2), (0.75, 0.25)])


def negative(rng, seconds=8.0):
    kind = int(rng.integers(0, 3))
    bands = [[(100, 400)], [(300, 7000)], [(4000, 7500)]][kind]
    pulses = [(float(t), 0.3) for t in np.arange(0.2, seconds - 0.4, 1.1)]
    return band_noise(rng, seconds, bands, pulses)


def write(path: Path, pcm: np.ndarray):
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(wf.RATE)
        handle.writeframes(pcm.astype("<i2").tobytes())


def make_dataset(root: Path, speakers=4, takes=6, sources=4, clips=3, attested=True, tonal=False):
    rng = np.random.default_rng(3)
    for s in range(speakers):
        for t in range(takes):
            pcm = positive(rng)
            if tonal:
                x = np.arange(pcm.size) / wf.RATE
                pcm = (0.5 * 32767 * np.sin(2 * np.pi * 800 * x)).astype(np.int16)
            write(root / "positives" / f"spk{s}" / f"take{t}.wav", pcm)
    for k in range(sources):
        for c in range(clips):
            write(root / "negatives" / f"src{k}" / f"clip{c}.wav", negative(rng))
    for c in range(4):
        write(root / "negatives" / "near-miss" / f"spk{c % 2}" / f"nm{c}.wav", negative(rng, 3.0))
    if attested:
        (root / "PROVENANCE.json").write_text(json.dumps({"realSpeech": True, "recordedBy": "test"}), encoding="utf-8")


class ProductionStatusTests(unittest.TestCase):
    def status(self, manifest):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "friday-wake.json"
            path.write_text(json.dumps(manifest), encoding="utf-8")
            return wake_word.production_status(str(path))

    def setUp(self):
        os.environ.pop("FRIDAY_WAKE_ALLOW_FIXTURE", None)

    def test_the_old_synthetic_scorer_is_never_production(self):
        ok, why = self.status({"kind": "friday-linear-v1", "production": True, "provenance": "real-speech"})
        self.assertFalse(ok)
        self.assertIn("synthetic", why)

    def test_a_candidate_that_missed_its_targets_is_not_production(self):
        ok, why = self.status(
            {
                "kind": "friday-linear-v2",
                "provenance": "real-speech",
                "production": False,
                "notProductionBecause": ["3 speakers needed"],
                "evaluation": {"meetsTargets": False},
            }
        )
        self.assertFalse(ok)
        self.assertIn("3 speakers", why)

    def test_a_flag_without_independent_held_out_numbers_is_not_production(self):
        base = {"kind": "friday-linear-v2", "provenance": "real-speech", "production": True}
        self.assertFalse(self.status({**base, "evaluation": {"meetsTargets": True}})[0])
        self.assertFalse(self.status({**base, "evaluation": {"meetsTargets": True, "independent": False}})[0])
        self.assertFalse(self.status({**base, "provenance": "synthetic-fixture", "evaluation": {}})[0])

    def test_only_real_evaluated_speech_is_production(self):
        manifest = {
            "kind": "friday-linear-v2",
            "provenance": "real-speech",
            "production": True,
            "evaluation": {"meetsTargets": True, "independent": True},
        }
        self.assertEqual(self.status(manifest), (True, ""))

    def test_the_fixture_switch_is_for_tests_only(self):
        os.environ["FRIDAY_WAKE_ALLOW_FIXTURE"] = "1"
        try:
            self.assertTrue(self.status({"kind": "friday-linear-v1"})[0])
        finally:
            os.environ.pop("FRIDAY_WAKE_ALLOW_FIXTURE", None)

    def test_an_openwakeword_model_is_judged_by_its_own_engine(self):
        self.assertEqual(wake_word.production_status("/models/wake/friday.onnx"), (True, ""))


class TrainerTests(unittest.TestCase):
    def setUp(self):
        self.trainer = load_trainer()
        # Plumbing-sized minimums: the real ones are far larger and are asserted separately.
        self.trainer.MIN_POSITIVES = 20
        self.trainer.MIN_NEGATIVE_MINUTES = 1.0
        self.trainer.MIN_NEAR_MISS = 2
        self.trainer.MIN_HELD_OUT_NEGATIVE_HOURS = 0.005
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name) / "data"
        self.out = Path(self.tmp.name) / "out"

    def manifest(self):
        return json.loads((self.out / "friday-wake.json").read_text(encoding="utf-8"))

    def test_the_real_minimums_are_not_toy_sized(self):
        real = load_trainer()
        self.assertGreaterEqual(real.MIN_POSITIVES, 60)
        self.assertGreaterEqual(real.MIN_SPEAKERS, 3)
        self.assertGreaterEqual(real.MIN_NEGATIVE_MINUTES, 20)
        self.assertLessEqual(real.TARGET_FRR, 0.05)
        self.assertLessEqual(real.TARGET_FA_PER_HOUR, 0.5)

    def test_an_unattested_set_never_becomes_production(self):
        make_dataset(self.data, attested=False)
        code = self.trainer.train(self.data, self.out)
        self.assertEqual(code, 2)
        manifest = self.manifest()
        self.assertFalse(manifest["production"])
        self.assertTrue(any("PROVENANCE.json" in r for r in manifest["notProductionBecause"]))
        ok, _ = wake_word.production_status(str(self.out / "friday-wake.json"))
        self.assertFalse(ok)

    def test_pure_tones_are_refused_even_with_a_statement(self):
        make_dataset(self.data, tonal=True)
        self.assertEqual(self.trainer.train(self.data, self.out), 2)
        self.assertTrue(any("pure tones" in r for r in self.manifest()["notProductionBecause"]))

    def test_too_few_speakers_cannot_be_held_apart_and_so_is_not_production(self):
        make_dataset(self.data, speakers=2, sources=2)
        self.assertEqual(self.trainer.train(self.data, self.out), 2)
        manifest = self.manifest()
        self.assertFalse(manifest["evaluation"]["independent"])
        self.assertFalse(manifest["production"])

    def test_a_varied_attested_set_trains_a_model_the_app_accepts_and_scores(self):
        make_dataset(self.data, speakers=6, takes=6, sources=6, clips=3)
        code = self.trainer.train(self.data, self.out)
        manifest = self.manifest()
        self.assertTrue(manifest["evaluation"]["independent"])
        self.assertEqual(manifest["kind"], "friday-linear-v2")
        self.assertEqual(manifest["provenance"], "real-speech")
        if code == 0:  # the band-noise stand-in is separable, so the gate normally opens
            self.assertTrue(manifest["production"])
            ok, _ = wake_word.production_status(str(self.out / "friday-wake.json"))
            self.assertTrue(ok)
            rng = np.random.default_rng(99)
            hit = wf.score_clip(positive(rng), manifest)
            miss = wf.score_clip(negative(rng, 3.0), manifest)
            self.assertGreater(hit, manifest["threshold"])
            self.assertLess(miss, manifest["threshold"])
            # The kernel's own clip scorer agrees with the trainer's.
            wav = Path(self.tmp.name) / "hit.wav"
            write(wav, positive(np.random.default_rng(99)))
            result = wake_word.score_linear(
                [int(v) for v in (wake_word._decode_wav(str(wav)) or [])], str(self.out / "friday-wake.json"), 0.5
            )
            self.assertTrue(result and result["detected"])
        else:
            self.assertEqual(code, 2)
            self.assertFalse(manifest["production"])

    def test_a_candidate_is_never_written_into_resources_wake(self):
        make_dataset(self.data, attested=False)
        target = Path(self.tmp.name) / "resources" / "wake"
        self.trainer.PRODUCTION_DIR = target
        self.assertEqual(self.trainer.train(self.data, target), 3)
        self.assertFalse((target / "friday-wake.json").exists())

    def test_the_fixture_is_never_written_into_resources_wake(self):
        target = Path(self.tmp.name) / "resources" / "wake"
        self.trainer.PRODUCTION_DIR = target
        self.assertEqual(self.trainer.fixture(target), 3)
        self.assertEqual(self.trainer.fixture(target / "sub"), 3)
        self.assertEqual(self.trainer.fixture(Path(self.tmp.name) / "fixture"), 0)
        written = json.loads((Path(self.tmp.name) / "fixture" / "friday-wake.json").read_text(encoding="utf-8"))
        self.assertEqual((written["provenance"], written["production"]), ("synthetic-fixture", False))

    def test_validate_names_what_is_missing(self):
        make_dataset(self.data, speakers=1, takes=2, sources=1, clips=1)
        self.trainer.MIN_POSITIVES = 60
        self.assertEqual(self.trainer.validate(self.data), 2)

    def test_evaluate_scores_a_model_on_unseen_audio(self):
        make_dataset(self.data, speakers=6, takes=6, sources=6, clips=3)
        if self.trainer.train(self.data, self.out) not in (0, 2):
            self.fail("training failed")
        fresh = Path(self.tmp.name) / "fresh"
        make_dataset(fresh, speakers=2, takes=4, sources=2, clips=2, attested=False)
        code = self.trainer.evaluate(fresh, self.out, None)
        self.assertIn(code, (0, 2))

    def test_the_command_line_runs(self):
        done = subprocess.run(
            [sys.executable, str(SCRIPT), "validate", "--dataset", str(self.data)],
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(done.returncode, 2, done.stderr)
        self.assertIn("needed:", done.stdout)


class ClipEvaluationTests(unittest.TestCase):
    def test_false_accepts_are_counted_per_hour_with_a_cooldown(self):
        always = {
            "mean": [0.0] * wf.FEATURE_DIM,
            "std": [1.0] * wf.FEATURE_DIM,
            "weights": [0.0] * wf.FEATURE_DIM,
            "bias": 10.0,
        }
        rng = np.random.default_rng(1)
        clip = negative(rng, 6.0)
        times = wf.detections(clip, always, 0.5, cooldown_s=1.5)
        self.assertGreaterEqual(len(times), 3)
        self.assertTrue(all(b - a >= 1.5 for a, b in zip(times, times[1:], strict=False)))
        report = wf.evaluate_clips([clip], [clip], always, 0.5)
        self.assertEqual(report["falseRejectionRate"], 0.0)
        self.assertGreater(report["falseAcceptsPerHour"], 100)


def pooled_embed(windows):
    """A stand-in embedding model: the time average of each mel window, (n, 76, 32) -> (n, 32)."""
    return np.asarray(windows, dtype=np.float32).mean(axis=1)


class HeadFitTests(unittest.TestCase):
    def setUp(self):
        self.trainer = load_trainer()

    def blobs(self, centres, labels, per=200, spread=0.4, seed=0):
        rng = np.random.default_rng(seed)
        x = np.concatenate([rng.normal(c, spread, (per, len(c))) for c in centres])
        y = np.concatenate([np.full(per, label) for label in labels])
        return x.astype(np.float32), y.astype(np.float64)

    def accuracy(self, layers, x, y):
        head = {"mean": np.zeros(x.shape[1], np.float32), "std": np.ones(x.shape[1], np.float32), "layers": layers}
        head["window"] = 1
        scores = wf.head_scores(x[:, None, :], head)
        return float(np.mean((scores > 0.5) == (y > 0.5)))

    def test_the_logistic_head_converges_on_separable_data(self):
        x, y = self.blobs([(2.0, 2.0, 0.0), (-2.0, -2.0, 0.0)], [1, 0])
        layers = self.trainer.fit_head(x, y, hidden=0, epochs=15)
        self.assertEqual(len(layers), 1)
        self.assertGreater(self.accuracy(layers, x, y), 0.99)

    def test_a_hidden_layer_solves_what_a_line_cannot(self):
        centres = [(2, 2), (-2, -2), (2, -2), (-2, 2)]
        x, y = self.blobs(centres, [1, 1, 0, 0])
        line = self.trainer.fit_head(x, y, hidden=0, epochs=30)
        net = self.trainer.fit_head(x, y, hidden=16, epochs=60)
        self.assertLess(self.accuracy(line, x, y), 0.8)
        self.assertGreater(self.accuracy(net, x, y), 0.97)

    def test_training_is_repeatable_for_a_seed_and_balances_a_rare_positive(self):
        rng = np.random.default_rng(2)
        x = np.concatenate([rng.normal(1.5, 0.5, (20, 8)), rng.normal(-1.5, 0.5, (980, 8))]).astype(np.float32)
        y = np.concatenate([np.ones(20), np.zeros(980)])
        first = self.trainer.fit_head(x, y, hidden=4, epochs=20, seed=5)
        again = self.trainer.fit_head(x, y, hidden=4, epochs=20, seed=5)
        self.assertTrue(all(np.array_equal(a[0], b[0]) for a, b in zip(first, again, strict=True)))
        head = {"mean": np.zeros(8, np.float32), "std": np.ones(8, np.float32), "layers": first, "window": 1}
        recall = float(np.mean(wf.head_scores(x[:20, None, :], head) > 0.5))
        self.assertGreater(recall, 0.9)


class EmbedTrainerTests(unittest.TestCase):
    def setUp(self):
        self.trainer = load_trainer()
        self.trainer.MIN_POSITIVES = 20
        self.trainer.MIN_NEGATIVE_MINUTES = 1.0
        self.trainer.MIN_NEAR_MISS = 2
        self.trainer.MIN_HELD_OUT_NEGATIVE_HOURS = 0.005
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name) / "data"
        self.out = Path(self.tmp.name) / "out"

    def manifest(self):
        return json.loads((self.out / "friday-wake.json").read_text(encoding="utf-8"))

    def test_a_varied_attested_set_trains_a_head_that_scores_on_the_streaming_path(self):
        make_dataset(self.data, speakers=6, takes=6, sources=6, clips=3)
        code = self.trainer.train_embed(self.data, self.out, pooled_embed, "ab" * 32)
        manifest = self.manifest()
        self.assertIn(code, (0, 2))
        self.assertEqual(manifest["kind"], "friday-embed-v1")
        self.assertEqual(
            manifest["embedding"], {"file": "wake-embed.onnx", "sha256": "ab" * 32, "frames": 76, "dim": 96}
        )
        self.assertTrue(manifest["evaluation"]["independent"])
        self.assertIn("80 ms", manifest["evaluation"]["measuredAs"])
        head = wf.load_head(manifest)
        self.assertEqual(head["window"], 16)
        rng = np.random.default_rng(99)
        hit = wf.score_embed_clip(positive(rng), pooled_embed, head)
        miss = wf.score_embed_clip(negative(rng, 3.0), pooled_embed, head)
        self.assertGreater(hit, miss)
        self.assertGreater(hit, manifest["threshold"])
        self.assertLess(miss, manifest["threshold"])
        if code == 0:  # the band-noise stand-in is separable, so the gate normally opens
            self.assertTrue(manifest["production"])
            self.assertEqual(manifest["notProductionBecause"], [])

    def test_the_trained_head_is_one_json_file_the_kernel_can_open(self):
        make_dataset(self.data, speakers=4, takes=4, sources=4, clips=2)
        self.trainer.train_embed(self.data, self.out, pooled_embed, "cd" * 32)
        self.assertEqual(sorted(p.name for p in self.out.iterdir()), ["friday-wake.json", "friday-wake.report.json"])
        manifest = self.manifest()
        self.assertEqual(wake_word.engine_for_path(str(self.out / "friday-wake.json")), "friday-embed")
        self.assertEqual(manifest["head"]["layers"][-1]["w"]["shape"][1], 1)

    def test_an_unattested_set_is_a_candidate_the_app_will_not_use(self):
        make_dataset(self.data, attested=False)
        self.assertEqual(self.trainer.train_embed(self.data, self.out, pooled_embed), 2)
        manifest = self.manifest()
        self.assertFalse(manifest["production"])
        self.assertTrue(any("PROVENANCE.json" in r for r in manifest["notProductionBecause"]))

    def test_too_few_speakers_cannot_be_held_apart(self):
        make_dataset(self.data, speakers=2, sources=2)
        self.assertEqual(self.trainer.train_embed(self.data, self.out, pooled_embed), 2)
        self.assertFalse(self.manifest()["evaluation"]["independent"])

    def test_a_candidate_is_never_written_into_resources_wake(self):
        make_dataset(self.data, attested=False)
        target = Path(self.tmp.name) / "resources" / "wake"
        self.trainer.PRODUCTION_DIR = target
        self.assertEqual(self.trainer.train_embed(self.data, target, pooled_embed), 3)
        self.assertFalse((target / "friday-wake.json").exists())

    def test_the_embedding_model_is_needed_to_train_and_the_command_line_says_so(self):
        done = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "train-embed",
                "--dataset",
                str(self.data),
                "--embedding",
                str(Path(self.tmp.name) / "missing.onnx"),
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(done.returncode, 1, done.stderr)
        self.assertIn("is not there", done.stderr)

    def test_evaluate_scores_an_embed_head_on_unseen_audio_with_the_streaming_rule(self):
        make_dataset(self.data, speakers=6, takes=6, sources=6, clips=3)
        self.trainer.train_embed(self.data, self.out, pooled_embed)
        fresh = Path(self.tmp.name) / "fresh"
        make_dataset(fresh, speakers=2, takes=4, sources=2, clips=2, attested=False)
        self.trainer.load_embedding = lambda _path: (pooled_embed, "")
        self.assertIn(self.trainer.evaluate(fresh, self.out, None), (0, 2))
        manifest = self.manifest()
        report = wf.evaluate_embed_clips(
            [positive(np.random.default_rng(i)) for i in range(4)],
            [negative(np.random.default_rng(50 + i), 6.0) for i in range(3)],
            pooled_embed,
            wf.load_head(manifest),
            manifest["threshold"],
        )
        self.assertEqual(report["falseRejectionRate"], 0.0)
        self.assertEqual(report["falseAcceptsPerHour"], 0.0)
        self.assertEqual(report["negativeHours"], round(18.0 / 3600.0, 4))

    def test_positive_windows_end_just_after_the_word_and_negatives_are_subsampled(self):
        rng = np.random.default_rng(4)
        windows = self.trainer.positive_embed_windows(positive(rng), pooled_embed)
        passes = len(self.trainer.POSITIVE_GAINS) * len(self.trainer.POSITIVE_TAILS)
        self.assertEqual(windows.shape, (passes * self.trainer.POSITIVE_ENDS, 16, 32))
        long_negative = negative(rng, 8.0)
        every = self.trainer.negative_embed_windows(long_negative, pooled_embed, stride=1)
        sparse = self.trainer.negative_embed_windows(long_negative, pooled_embed, stride=2)
        self.assertEqual(len(sparse), (len(every) + 1) // 2)
        short = self.trainer.negative_embed_windows(negative(rng, 0.6), pooled_embed)
        self.assertGreater(len(short), 0)  # a short clip is padded to stream length, not dropped


if __name__ == "__main__":
    unittest.main()
