"""The wake soak evaluator streams a long bed and reports honest, scorer-only numbers.

The audio made here is synthetic noise with loud bursts a stand-in predictor can see. Nothing in this file says a
real wake model is good: it proves the streaming, the exact trigger bookkeeping, the statistical bounds and that
`meetsTargets` stays false unless the bed and the positives are large enough.
"""

from __future__ import annotations

import importlib.util
import json
import math
import sys
import tempfile
import tracemalloc
import unittest
import wave
from pathlib import Path
from typing import Any

import numpy as np

KERNEL = Path(__file__).resolve().parent.parent
ROOT = KERNEL.parent
SCRIPT = ROOT / "scripts" / "wake-soak-eval.py"
sys.path.insert(0, str(KERNEL))

import wake_word  # noqa: E402

FRAME = wake_word.FRAME_SAMPLES
RATE = 16000
BIG = 20000


def load_soak() -> Any:
    spec = importlib.util.spec_from_file_location("wake_soak_eval", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["wake_soak_eval"] = module
    spec.loader.exec_module(module)
    return module


def loud(frame) -> float:
    """Stand-in predictor: a frame with a big sample is the wake word."""
    return 1.0 if max(frame) > 10000 else 0.0


def mean_high(frame) -> float:
    """Stand-in predictor for mixed clips: a clearly positive mean level is the wake word."""
    return 1.0 if sum(frame) > 50 * len(frame) else 0.0


def write_bed(path: Path, total_frames: int, bursts=(), noise: int = 200, burst_frames: int = 4, channels: int = 1):
    """A 16 kHz mono bed of seeded noise; each burst is `burst_frames` frames of a constant big level."""
    rng = np.random.default_rng(7)
    starts = set(bursts)
    with wave.open(str(path), "wb") as out:
        out.setnchannels(channels)
        out.setsampwidth(2)
        out.setframerate(RATE)
        block = 100
        for first in range(0, total_frames, block):
            count = min(block, total_frames - first)
            chunk = rng.integers(-noise, noise + 1, size=count * FRAME * channels, dtype=np.int16)
            for f in starts:
                if first <= f < first + count or first <= f + burst_frames - 1 < first + count:
                    lo = max(f, first) - first
                    hi = min(f + burst_frames, first + count) - first
                    chunk[lo * FRAME * channels : hi * FRAME * channels] = BIG
            out.writeframes(chunk.tobytes())


def write_clip(path: Path, seconds: float, level: int = 1) -> None:
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes(np.full(int(seconds * RATE), level, dtype=np.int16).tobytes())


def poisson_cdf(k: int, lam: float) -> float:
    return sum(math.exp(-lam) * lam**i / math.factorial(i) for i in range(k + 1))


def binom_cdf(k: int, n: int, p: float) -> float:
    return sum(math.comb(n, i) * p**i * (1 - p) ** (n - i) for i in range(k + 1))


class StatisticsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.soak = load_soak()

    def test_zero_events_use_the_rule_of_three(self):
        self.assertEqual(self.soak.poisson_upper95(0, 6.0), 0.5)
        self.assertEqual(self.soak.poisson_upper95(0, 2.0), 1.5)

    def test_events_use_the_exact_poisson_limit(self):
        for k in (1, 5, 13):
            rate = self.soak.poisson_upper95(k, 1.0)
            self.assertAlmostEqual(poisson_cdf(k, rate), 0.05, places=6)
        self.assertAlmostEqual(self.soak.poisson_upper95(1, 1.0), 4.7439, places=3)

    def test_miss_bound_is_clopper_pearson(self):
        for misses, n in ((0, 60), (1, 80), (3, 200)):
            bound = self.soak.binomial_upper95(misses, n)
            self.assertAlmostEqual(binom_cdf(misses, n, bound), 0.05, places=6)
        self.assertAlmostEqual(self.soak.binomial_upper95(0, 60), 1 - 0.05 ** (1 / 60), places=9)
        self.assertLessEqual(self.soak.binomial_upper95(0, 60), 0.05)
        self.assertGreater(self.soak.binomial_upper95(0, 59), 0.0)

    def test_no_positives_gives_no_miss_claim(self):
        self.assertIsNone(self.soak.binomial_upper95(0, 0))

    def test_targets_need_six_hours_sixty_positives_and_both_bounds(self):
        soak = self.soak
        hour = 57_600_000  # samples in one hour

        def meets(hours, positives=60, fa=0, misses=0):
            return soak.summarize(
                bed_samples=int(hours * hour),
                false_accept_times=[float(i) for i in range(fa)],
                all_trigger_times=[float(i) for i in range(fa)],
                positives=positives,
                misses=misses,
                threshold=0.9,
            )["meetsTargets"]

        self.assertTrue(meets(6))
        self.assertFalse(meets(1))  # a 1 h bed can never prove 0.5 per hour
        self.assertFalse(meets(5.99))
        self.assertFalse(meets(6, positives=59))
        self.assertFalse(meets(6, fa=1))  # one false accept in 6 h: upper bound 0.79 per hour
        self.assertFalse(meets(6, misses=1))  # 1 miss in 60: upper bound is far above 5 %
        self.assertTrue(meets(24, fa=1, positives=200))  # 4.74 / 24 = 0.20 per hour, 0 misses in 200


class StreamingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.soak = load_soak()
        cls.tmp = tempfile.TemporaryDirectory()
        cls.dir = Path(cls.tmp.name)
        cls.frames = 90_000  # exactly two hours
        cls.bursts = [1000 + 7000 * i for i in range(13)]
        cls.bed = cls.dir / "bed-2h.wav"
        write_bed(cls.bed, cls.frames, cls.bursts)
        tracemalloc.start()
        try:
            cls.report = cls.soak.soak_eval(str(cls.bed), loud, threshold=0.5)
            cls.peak = tracemalloc.get_traced_memory()[1]
        finally:
            tracemalloc.stop()

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_two_hour_bed_returns_the_exact_count_and_bounds(self):
        report = self.report
        self.assertEqual(report["bedHours"], 2.0)
        self.assertEqual(report["falseAccepts"], 13)
        self.assertEqual(report["falseAcceptsPerHour"], 6.5)
        expected = [round((f + 2) * 0.08, 3) for f in self.bursts]
        self.assertEqual(report["triggerTimesSec"], expected)
        self.assertAlmostEqual(report["upper95PerHour"], self.soak.poisson_upper95(13, 2.0), places=3)
        self.assertGreater(report["upper95PerHour"], report["falseAcceptsPerHour"])
        self.assertEqual(report["positives"], 0)
        self.assertEqual(report["misses"], 0)
        self.assertIsNone(report["missRate"])
        self.assertIsNone(report["missUpper95"])
        self.assertEqual(report["thresholdUsed"], 0.5)
        self.assertEqual(report["scope"], "scorer-only")
        self.assertIs(report["meetsTargets"], False)

    def test_peak_memory_stays_under_200_mb_on_the_two_hour_bed(self):
        # a Python list of this bed would need about 2 GB
        self.assertLess(self.peak, 200 * 1024 * 1024)
        self.assertLess(self.peak, 50 * 1024 * 1024)

    def test_report_holds_no_path_and_serialises(self):
        text = json.dumps(self.report)
        self.assertNotIn(str(self.dir), text)
        self.assertNotIn("bed-2h", text)


class MixingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.soak = load_soak()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.bed = self.dir / "bed.wav"
        write_bed(self.bed, 2250, noise=20)  # three minutes of quiet noise
        self.clips = []
        for i in range(4):
            clip = self.dir / f"wake{i}.wav"
            write_clip(clip, 0.5)
            self.clips.append(str(clip))

    def tearDown(self):
        self.tmp.cleanup()

    def test_wake_samples_are_mixed_at_each_snr_and_misses_counted(self):
        report = self.soak.soak_eval(
            str(self.bed), mean_high, threshold=0.5, wake_paths=self.clips, snrs_db=[20.0, 0.0]
        )
        self.assertEqual(report["positives"], 4)
        self.assertEqual(report["misses"], 2)  # the 20 dB ones are heard, the 0 dB ones are not
        self.assertEqual(report["missRate"], 0.5)
        self.assertEqual(report["falseAccepts"], 0)
        self.assertEqual(report["triggerTimesSec"], report["hitTimesSec"])
        self.assertEqual(len(report["hitTimesSec"]), 2)
        self.assertAlmostEqual(report["missUpper95"], self.soak.binomial_upper95(2, 4), places=3)
        self.assertEqual(report["snrDb"], [20.0, 0.0])
        self.assertIs(report["meetsTargets"], False)  # three minutes and four positives

    def test_every_positive_is_found_when_all_are_loud(self):
        report = self.soak.soak_eval(str(self.bed), mean_high, threshold=0.5, wake_paths=self.clips, snrs_db=[30.0])
        self.assertEqual((report["positives"], report["misses"]), (4, 0))
        self.assertEqual(report["missRate"], 0.0)
        self.assertEqual(report["falseAccepts"], 0)

    def test_the_bed_file_is_never_modified(self):
        before = self.bed.read_bytes()
        self.soak.soak_eval(str(self.bed), mean_high, threshold=0.5, wake_paths=self.clips, snrs_db=[30.0])
        self.assertEqual(self.bed.read_bytes(), before)
        self.assertEqual(
            sorted(p.name for p in self.dir.iterdir()), sorted(["bed.wav", *[f"wake{i}.wav" for i in range(4)]])
        )

    def test_too_many_positives_for_the_bed_is_refused(self):
        with self.assertRaises(ValueError):
            self.soak.soak_eval(str(self.bed), mean_high, threshold=0.5, wake_paths=self.clips * 60, snrs_db=[10.0])


class CliTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.soak = load_soak()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_cli_writes_json_and_prints_a_labelled_table(self):
        bed = self.dir / "bed.wav"
        write_bed(bed, 1000, bursts=[100, 500])
        out = self.dir / "report.json"
        import contextlib
        import io

        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = self.soak.main(["--bed", str(bed), "--threshold", "0.5", "--out", str(out)], predict=loud)
        self.assertEqual(code, 0)
        report = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(report["falseAccepts"], 2)
        self.assertEqual(report["scope"], "scorer-only")
        self.assertIs(report["meetsTargets"], False)
        table = buffer.getvalue()
        self.assertIn("scorer-only", table)
        self.assertIn("meetsTargets", table)
        self.assertNotIn(str(bed), table)

    def test_a_stereo_bed_is_refused_with_a_clear_message(self):
        bed = self.dir / "stereo.wav"
        write_bed(bed, 10, channels=2)
        import contextlib
        import io

        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code = self.soak.main(["--bed", str(bed)], predict=loud)
        self.assertEqual(code, 2)
        self.assertIn("16 kHz mono", err.getvalue())

    def test_a_missing_bed_is_refused(self):
        import contextlib
        import io

        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.soak.main(["--bed", str(self.dir / "none.wav")], predict=loud), 2)


class ScorerFeedTests(unittest.TestCase):
    def test_a_numpy_frame_scores_the_same_as_a_list(self):
        rng = np.random.default_rng(3)
        data = rng.integers(-3000, 3000, size=FRAME * 6, dtype=np.int16)
        data[FRAME * 2 : FRAME * 5] = BIG
        results = []
        for chunks in ([data[i : i + FRAME] for i in range(0, len(data), FRAME)], [data.tolist()]):
            scorer = wake_word.WakeFrameScorer(loud, threshold=0.5)
            results.append([scorer.feed(c) for c in chunks])
        self.assertEqual(sum(r["detected"] for r in results[0]), 1)
        self.assertEqual(sum(r["detected"] for r in results[1]), 1)
        self.assertEqual(sum(r["frames"] for r in results[0]), sum(r["frames"] for r in results[1]))


if __name__ == "__main__":
    unittest.main()
