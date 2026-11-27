"""FRIDAY's own streaming wake front end: the mel stream, the embedding stream and the head.

No model file and no network are needed: the embedding model is replaced by a small fake with the same shape
contract, and the mel numbers are checked against a fixture taken once from the reference mel front end. Two
parity checks against the real reference run only where its files exist (FRIDAY_WAKE_REF_DIR) and say why they skip.
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

import numpy as np

KERNEL = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(KERNEL))

import wake_features as wf  # noqa: E402
import wake_word  # noqa: E402

# 8 frames x 32 bands of the reference mel front end (then x / 10 + 2) for reference_signal(), 4 decimals.
REFERENCE_TEXT = """
4.7028 5.4433 6.2734 8.6012 10.5623 10.7184 9.2875 6.5025 5.5784 4.7131 4.2419 4.1616 4.1616 4.1616 4.1616 4.1616
4.1616 4.1616 4.1616 4.6809 7.9913 9.9388 9.5430 5.7063 4.1616 4.1616 4.1616 4.1616 4.1616 4.1616 4.1616 4.1616
4.9061 5.7966 6.4818 8.8789 10.9703 11.1292 9.6439 6.6465 5.9506 4.9431 4.6194 4.1616 4.1616 4.1616 4.1616 4.1616
4.1616 4.1616 4.1616 4.9933 8.3406 10.3480 9.9499 6.0413 4.1616 4.1616 4.1616 4.1616 4.1616 4.1616 4.1616 4.1616
4.9685 6.0201 6.6657 9.1082 11.2487 11.4085 9.9054 6.7975 6.2207 5.1350 4.8766 4.1616 4.1616 4.1616 4.1616 4.1616
4.1616 4.1616 4.1616 5.2101 8.5993 10.6268 10.2280 6.2975 4.3508 4.1616 4.1616 4.1616 4.1616 4.1616 4.1616 4.1616
5.0392 6.1991 6.8274 9.2962 11.4598 11.6199 10.1090 6.9428 6.4339 5.3246 5.1269 4.3561 4.3411 4.1616 4.1616 4.1616
4.1616 4.1616 4.4696 5.4328 8.8018 10.8381 10.4389 6.4946 4.5231 4.1616 4.1616 4.1616 4.1616 4.1616 4.1616 4.1616
5.3057 6.3943 6.9806 9.4541 11.6296 11.7900 10.2749 7.0662 6.5948 5.4488 5.2534 4.4123 4.3852 4.1616 4.1616 4.1616
4.1616 4.1616 4.5279 5.5691 8.9670 11.0080 10.6087 6.6613 4.7069 4.1616 4.1616 4.1616 4.1616 4.1616 4.1616 4.1616
5.5649 6.5705 7.1193 9.5894 11.7717 11.9322 10.4147 7.1809 6.7290 5.5647 5.3794 4.5304 4.5193 4.1616 4.1616 4.1616
4.1616 4.1616 4.7032 5.7170 9.1065 11.1502 10.7507 6.7990 4.8341 4.1616 4.1616 4.1616 4.1616 4.1616 4.1616 4.1616
5.6656 6.6865 7.2309 9.7068 11.8939 12.0545 10.5354 7.2866 6.8535 5.6894 5.5171 4.6802 4.6986 4.1616 4.1616 4.1616
4.1616 4.3385 4.8617 5.8443 9.2270 11.2723 10.8729 6.9183 4.9499 4.1616 4.1616 4.1616 4.1616 4.1616 4.1616 4.1616
5.6280 6.7548 7.3213 9.8103 12.0010 12.1616 10.6415 7.3843 6.9622 5.7910 5.6168 4.7473 4.7224 4.1616 4.1616 4.1616
4.1616 4.1616 4.8628 5.9234 9.3328 11.3794 10.9799 7.0261 5.0739 4.1616 4.1616 4.1616 4.1616 4.1616 4.1616 4.1616
"""
REFERENCE = np.array(REFERENCE_TEXT.split(), dtype=np.float64).reshape(8, 32)


def reference_file(name: str) -> Path | None:
    """A reference model file named by FRIDAY_WAKE_REF_DIR, or None (the live checks then skip, saying so)."""
    folder = os.environ.get("FRIDAY_WAKE_REF_DIR")
    path = Path(folder) / name if folder else None
    return path if path is not None and path.is_file() else None


def all_embeddings(stream: wf.EmbeddingStream) -> np.ndarray:
    window = stream.window(stream.embeddings)
    assert window is not None
    return window


def reference_signal() -> np.ndarray:
    t = np.arange(1760) / wf.RATE
    ramp = np.linspace(5, 12000, 1760)
    return np.round(ramp * (np.sin(2 * np.pi * 440 * t) + 0.5 * np.sin(2 * np.pi * 1800 * t)))


def fake_embed(windows: np.ndarray) -> np.ndarray:
    """A stand-in embedding model: the time average of each mel window, (n, 76, 32) -> (n, 32)."""
    return np.asarray(windows, dtype=np.float32).mean(axis=1)


def speechlike(seed: int, seconds: float) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = int(seconds * wf.RATE)
    t = np.arange(n) / wf.RATE
    return np.round(2500 * np.sin(2 * np.pi * (300 + 150 * np.sin(2 * np.pi * 0.8 * t)) * t) + rng.normal(0, 300, n))


class MelFrontEndTests(unittest.TestCase):
    def test_the_numpy_melspec_matches_the_reference_within_1e_3(self):
        got = wf.scaled_melspec(reference_signal())
        self.assertEqual(got.shape, (8, 32))
        self.assertLess(float(np.abs(got - REFERENCE).max()), 1e-3)

    def test_a_step_of_1280_samples_with_480_of_context_gives_8_frames(self):
        self.assertEqual(wf.embed_melspec(np.zeros(wf.CHUNK + wf.CHUNK_CONTEXT)).shape, (8, 32))
        self.assertEqual(wf.embed_melspec(np.zeros(512)).shape, (1, 32))
        self.assertEqual(wf.embed_melspec(np.zeros(511)).shape, (0, 32))

    def test_silence_sits_on_the_power_floor_and_never_makes_nan(self):
        mel = wf.embed_melspec(np.zeros(1760))
        self.assertTrue(np.isfinite(mel).all())
        self.assertTrue(np.allclose(mel, -100.0))  # 10 * log10(1e-10)

    def test_the_dynamic_range_is_80_db_below_the_loudest_cell(self):
        mel = wf.embed_melspec(reference_signal())
        self.assertGreaterEqual(float(mel.min()), float(mel.max()) - wf.EMBED_FLOOR_DB - 1e-3)

    def test_the_filterbank_covers_60_to_3800_hz_in_32_bands(self):
        bank = wf.embed_filterbank()
        self.assertEqual(bank.shape, (257, 32))
        self.assertTrue((bank >= 0).all())
        used = np.nonzero(bank.sum(axis=1))[0]
        self.assertEqual(int(used[0]), 2)  # 62.5 Hz
        self.assertLessEqual(int(used[-1]) * wf.RATE / wf.EMBED_FFT, wf.EMBED_FMAX)

    @unittest.skipUnless(
        reference_file("melspectrogram.onnx"),
        "set FRIDAY_WAKE_REF_DIR to a folder holding the reference melspectrogram.onnx to run the live parity check",
    )
    def test_parity_with_the_reference_mel_model_on_noise_and_tones(self):
        import onnxruntime as ort  # type: ignore

        session = ort.InferenceSession(str(reference_file("melspectrogram.onnx")), providers=["CPUExecutionProvider"])
        rng = np.random.default_rng(5)
        for signal in (reference_signal(), np.round(rng.normal(0, 3000, 1760)), np.round(rng.normal(0, 2, 1760))):
            raw = session.run(None, {"input": signal.astype(np.float32)[None, :]})[0]
            ref = np.asarray(raw).reshape(-1, 32) / 10 + 2
            self.assertLess(float(np.abs(wf.scaled_melspec(signal) - ref).max()), 1e-3)


class EmbeddingStreamTests(unittest.TestCase):
    def test_the_first_embedding_comes_after_ten_steps_and_the_head_window_after_twenty_five(self):
        stream = wf.EmbeddingStream(fake_embed)
        audio = speechlike(1, 3.0)
        made = [stream.feed(audio[i : i + wf.CHUNK]) for i in range(0, 26 * wf.CHUNK, wf.CHUNK)]
        self.assertEqual(sum(made[: wf.PRIME_CHUNKS - 1]), 0)
        self.assertEqual(made[wf.PRIME_CHUNKS - 1], 1)
        probe = wf.EmbeddingStream(fake_embed)
        for index in range(26):
            probe.feed(audio[index * wf.CHUNK : (index + 1) * wf.CHUNK])
            self.assertEqual(probe.window() is not None, index >= wf.PRIME_CHUNKS + wf.HEAD_WINDOW - 2)

    def test_any_chunking_of_the_same_audio_gives_the_same_embeddings(self):
        audio = speechlike(2, 2.5)
        whole = wf.EmbeddingStream(fake_embed, history=200)
        whole.feed(audio)
        odd = wf.EmbeddingStream(fake_embed, history=200)
        position = 0
        for size in (1, 7, 479, 1280, 3001, 17, 5000):
            odd.feed(audio[position : position + size])
            position += size
        odd.feed(audio[position:])
        self.assertEqual(whole.embeddings, odd.embeddings)
        self.assertTrue(np.array_equal(all_embeddings(whole), all_embeddings(odd)))

    def test_a_partial_step_waits_for_the_rest(self):
        stream = wf.EmbeddingStream(fake_embed)
        self.assertEqual(stream.feed(np.zeros(1000)), 0)
        self.assertEqual(stream.steps, 0)
        stream.feed(np.zeros(280))
        self.assertEqual(stream.steps, 1)

    def test_the_stream_and_the_whole_clip_agree_exactly(self):
        audio = speechlike(3, 4.0)
        stream = wf.EmbeddingStream(fake_embed, history=500)
        stream.feed(audio)
        clip = wf.embed_clip(audio, fake_embed)
        self.assertEqual(clip.shape[0], stream.embeddings)
        self.assertTrue(np.array_equal(clip, all_embeddings(stream)))

    def test_reset_returns_to_the_unprimed_state_and_history_is_bounded(self):
        stream = wf.EmbeddingStream(fake_embed, history=20)
        stream.feed(speechlike(4, 4.0))
        self.assertEqual(stream.embeddings, 20)
        stream.reset()
        self.assertEqual((stream.embeddings, stream.steps), (0, 0))
        self.assertIsNone(stream.window())

    def test_a_broken_model_surfaces_instead_of_scoring_zero_silently(self):
        def broken(_windows):
            raise RuntimeError("model gone")

        with self.assertRaises(RuntimeError):
            wf.EmbeddingStream(broken).feed(np.zeros(wf.CHUNK * wf.PRIME_CHUNKS))


class HeadAndScoringTests(unittest.TestCase):
    def head(self, bias=0.0, hidden=0):
        rng = np.random.default_rng(0)
        dim = 32
        if hidden:
            layers = [
                (rng.normal(0, 0.05, (dim * 16, hidden)).astype(np.float32), np.zeros(hidden, np.float32)),
                (np.ones((hidden, 1), np.float32), np.full(1, bias, np.float32)),
            ]
        else:
            layers = [(np.full((dim * 16, 1), 0.01, np.float32), np.full(1, bias, np.float32))]
        return {"mean": np.zeros(dim, np.float32), "std": np.ones(dim, np.float32), "layers": layers, "window": 16}

    def test_tensors_round_trip_through_json_text(self):
        array = np.random.default_rng(1).normal(size=(5, 3)).astype(np.float32)
        self.assertTrue(np.array_equal(wf.decode_tensor(wf.encode_tensor(array)), array))
        with self.assertRaises(ValueError):
            wf.decode_tensor({"shape": [4, 4], "b64": wf.encode_tensor(array)["b64"]})

    def test_a_manifest_head_loads_and_scores_like_the_dict(self):
        head = self.head(bias=-0.5, hidden=4)
        manifest = {
            "head": {
                "window": 16,
                "mean": wf.encode_tensor(head["mean"]),
                "std": wf.encode_tensor(head["std"]),
                "layers": [{"w": wf.encode_tensor(w), "b": wf.encode_tensor(b)} for w, b in head["layers"]],
            }
        }
        loaded = wf.load_head(manifest)
        windows = np.random.default_rng(2).normal(size=(3, 16, 32)).astype(np.float32)
        self.assertTrue(np.allclose(wf.head_scores(windows, loaded), wf.head_scores(windows, head), atol=1e-6))

    def test_a_head_that_does_not_fit_its_window_is_refused(self):
        head = self.head()
        bad = {
            "head": {
                "window": 8,
                "mean": wf.encode_tensor(head["mean"]),
                "std": wf.encode_tensor(head["std"]),
                "layers": [{"w": wf.encode_tensor(w), "b": wf.encode_tensor(b)} for w, b in head["layers"]],
            }
        }
        with self.assertRaises(ValueError):
            wf.load_head(bad)

    def test_scores_are_probabilities_even_for_huge_inputs(self):
        scores = wf.head_scores(np.full((2, 16, 32), 1e6, np.float32), self.head())
        self.assertTrue(np.isfinite(scores).all())
        self.assertTrue(((scores >= 0) & (scores <= 1)).all())

    def test_padding_is_seeded_long_enough_and_keeps_the_clip_at_the_end(self):
        clip = speechlike(5, 1.0)
        first, second = wf.pad_clip(clip), wf.pad_clip(clip)
        self.assertTrue(np.array_equal(first, second))
        self.assertGreaterEqual(first.size, wf.MIN_CLIP_CHUNKS * wf.CHUNK)
        tail = wf.TAIL_CHUNKS * wf.CHUNK
        self.assertTrue(np.array_equal(first[-tail - clip.size : -tail], clip))
        self.assertTrue(np.isfinite(wf.pad_clip(np.zeros(100))).all())
        self.assertTrue(np.isfinite(wf.pad_clip(np.zeros(0))).all())

    def test_a_clip_is_scored_by_its_best_window(self):
        head = self.head(bias=-3.0)
        loud, quiet = speechlike(6, 1.5), speechlike(6, 1.5) * 0.0
        self.assertGreater(wf.score_embed_clip(loud, fake_embed, head), wf.score_embed_clip(quiet, fake_embed, head))
        self.assertEqual(wf.clip_scores(quiet, fake_embed, head).ndim, 1)


class TriggerAndReportTests(unittest.TestCase):
    def test_the_trigger_rule_is_exactly_the_live_wake_scorers(self):
        rng = np.random.default_rng(8)
        scores = [float(v) for v in np.clip(rng.normal(0.4, 0.4, 400), 0, 1)]
        feed = iter(scores)
        live = wake_word.WakeFrameScorer(lambda _frame: next(feed), threshold=0.6, min_frames=2, cooldown_ms=1500)
        live_hits = []
        for index in range(len(scores)):
            if live.feed([0] * wake_word.FRAME_SAMPLES)["detected"]:
                live_hits.append(index)
        self.assertGreater(len(live_hits), 2)
        self.assertEqual(wf.count_triggers(scores, 0.6, min_frames=2, cooldown_frames=18), live_hits)

    def test_false_accepts_are_counted_per_hour_of_negative_audio(self):
        burst = [0.0] * 30 + [0.9] * 3 + [0.0] * 30
        negatives = [burst, burst, burst]  # three clips, one trigger each
        report = wf.embed_report([[0.0, 0.0]], negatives, negative_seconds=1800.0, threshold=0.5)
        self.assertEqual(report["falseAcceptsPerHour"], 6.0)  # 3 triggers in half an hour
        self.assertEqual(report["falseRejectionRate"], 1.0)  # the silent positive never triggered
        self.assertEqual(report["negativeHours"], 0.5)

    def test_a_lone_hot_score_does_not_trigger_and_no_audio_reports_no_rate(self):
        self.assertEqual(wf.count_triggers([0.0, 0.9, 0.0, 0.9, 0.0], 0.5), [])
        report = wf.embed_report([], [], 0.0, 0.5)
        self.assertIsNone(report["falseRejectionRate"])
        self.assertIsNone(report["falseAcceptsPerHour"])

    def test_a_trigger_latches_until_the_score_falls_and_the_cooldown_ends(self):
        scores = [0.9] * 40 + [0.0] * 3 + [0.9] * 3
        hits = wf.count_triggers(scores, 0.5, cooldown_frames=18)
        self.assertEqual(hits[0], 1)
        self.assertEqual(len(hits), 2)  # held through the long run, fires again after the dip and cooldown


@unittest.skipUnless(
    reference_file("embedding_model.onnx"),
    "set FRIDAY_WAKE_REF_DIR to a folder holding the reference embedding_model.onnx to run the live model check",
)
class EmbeddingModelTests(unittest.TestCase):
    def test_the_real_embedding_model_gives_96_numbers_per_step_and_stream_equals_clip(self):
        embed = wf.load_embedder(str(reference_file("embedding_model.onnx")))
        audio = speechlike(9, 3.0)
        stream = wf.EmbeddingStream(embed, history=200)
        stream.feed(audio)
        clip = wf.embed_clip(audio, embed)
        self.assertEqual(clip.shape[1], wf.EMBED_DIM)
        self.assertLess(float(np.abs(clip - all_embeddings(stream)).max()), 1e-4)


if __name__ == "__main__":
    unittest.main()
