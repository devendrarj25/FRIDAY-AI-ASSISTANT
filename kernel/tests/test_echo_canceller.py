"""FRIDAY Echo: the known-reference echo canceller, on synthetic rooms only."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

KERNEL = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(KERNEL))

import echo_canceller  # noqa: E402

np, _aec, _missing = echo_canceller._load()
LIBRARY = np is not None and not _missing
RATE = 16000
FRAME = 160


def _speech_like(seconds: float, seed: int = 7):
    """Smoothed noise with a slow envelope, scaled to a loud 9000 peak."""
    rng = np.random.default_rng(seed)
    n = int(seconds * RATE)
    x = np.convolve(rng.standard_normal(n), np.ones(8) / 8, "same")
    x *= 0.6 + 0.4 * np.sin(2 * np.pi * 3 * np.arange(n) / RATE)
    return x / np.max(np.abs(x)) * 9000


def _room(ref, delay_ms: float, gain: float, reverb: bool = True):
    """The reference after the speaker and room: a delay, an attenuation, two reflections."""
    taps = np.zeros(400)
    taps[0] = gain
    if reverb:
        taps[40] = gain * 0.4
        taps[150] = -gain * 0.2
    echo = np.convolve(ref, taps)[: len(ref)]
    return np.concatenate([np.zeros(int(delay_ms * RATE / 1000)), echo])[: len(ref)]


def _run(canceller, mic, ref, frame: int = FRAME):
    out = [canceller.process(mic[i : i + frame], ref[i : i + frame]) for i in range(0, len(mic), frame)]
    return np.concatenate(out)


def _db(num, den) -> float:
    return float(10 * np.log10(np.mean(num.astype(np.float64) ** 2) / max(np.mean(den.astype(np.float64) ** 2), 1e-9)))


@unittest.skipUnless(LIBRARY, "numpy or pyaec is not installed: the real filter cannot run")
class EchoReductionTests(unittest.TestCase):
    def test_echo_is_reduced_by_at_least_twenty_db_and_the_delay_is_found(self):
        ref = _speech_like(6)
        mic = _room(ref, 60, 0.5).astype(np.int16)
        canceller = echo_canceller.EchoCanceller()
        out = _run(canceller, mic, ref.astype(np.int16))
        settled = slice(len(mic) // 2, None)
        erle = _db(mic[settled], out[settled])
        self.assertGreaterEqual(erle, 20.0, f"echo reduction {erle:.1f} dB")
        self.assertAlmostEqual(canceller.delay_ms or 0.0, 60.0, delta=1.0)
        self.assertTrue(canceller.status()["ready"])
        self.assertGreater(canceller.status()["cancelledFrames"], 0)

    def test_other_speaker_delays_are_found(self):
        for delay_ms in (20, 150, 300):
            ref = _speech_like(6, seed=11)
            mic = _room(ref, delay_ms, 0.4).astype(np.int16)
            canceller = echo_canceller.EchoCanceller()
            out = _run(canceller, mic, ref.astype(np.int16))
            settled = slice(len(mic) // 2, None)
            self.assertAlmostEqual(canceller.delay_ms or 0.0, float(delay_ms), delta=1.0)
            self.assertGreaterEqual(_db(mic[settled], out[settled]), 15.0, f"delay {delay_ms} ms")

    def test_the_owner_voice_survives_while_her_own_is_removed(self):
        ref = _speech_like(6)
        n = len(ref)
        t = np.arange(n) / RATE
        owner = 1000 * np.sin(2 * np.pi * 440 * t)
        echo = _room(ref, 60, 0.5)
        mic = (echo + owner).astype(np.int16)
        out = _run(echo_canceller.EchoCanceller(), mic, ref.astype(np.int16)).astype(np.float64)
        settled = slice(n // 2, None)
        sin, cos = np.sin(2 * np.pi * 440 * t[settled]), np.cos(2 * np.pi * 440 * t[settled])
        a, b = 2 * np.mean(out[settled] * sin), 2 * np.mean(out[settled] * cos)
        kept = float(np.hypot(a, b))
        residual = out[settled] - (a * sin + b * cos)
        self.assertGreater(kept, 0.6 * 1000, f"owner tone kept {kept:.0f} of 1000")
        self.assertGreaterEqual(10 * np.log10((kept**2 / 2) / np.mean(residual**2)), 10.0)
        before = _db(mic[settled].astype(np.float64) - owner[settled], owner[settled])
        self.assertGreater(before, 0.0, "the scene must start with echo louder than the owner")

    def test_bytes_in_bytes_out_matches_the_array_path(self):
        ref = _speech_like(3).astype(np.int16)
        mic = _room(ref.astype(np.float64), 40, 0.5).astype(np.int16)
        as_array = _run(echo_canceller.EchoCanceller(), mic, ref)
        raw = echo_canceller.EchoCanceller()
        chunks = []
        for i in range(0, len(mic), FRAME):
            piece = raw.process(mic[i : i + FRAME].tobytes(), ref[i : i + FRAME].tobytes())
            self.assertIsInstance(piece, bytes)
            chunks.append(np.frombuffer(piece, dtype="<i2"))
        self.assertTrue(np.array_equal(np.concatenate(chunks), as_array))

    def test_reference_that_stops_returns_the_microphone_untouched(self):
        ref = _speech_like(4)
        mic = _room(ref, 60, 0.5).astype(np.int16)
        canceller = echo_canceller.EchoCanceller()
        _run(canceller, mic, ref.astype(np.int16))
        quiet = (np.random.default_rng(3).standard_normal(FRAME * 100) * 400).astype(np.int16)
        # Past the echo tail window nothing plays, so the owner's frames come back byte for byte.
        tail = np.zeros(echo_canceller.MAX_DELAY_SAMPLES + echo_canceller.AEC_FRAME * 2, dtype=np.int16)
        _run(canceller, tail, tail)
        out = _run(canceller, quiet, np.zeros_like(quiet))
        self.assertTrue(np.array_equal(out, quiet))

    def test_reset_forgets_the_delay(self):
        ref = _speech_like(3)
        canceller = echo_canceller.EchoCanceller()
        _run(canceller, _room(ref, 60, 0.5).astype(np.int16), ref.astype(np.int16))
        self.assertIsNotNone(canceller.delay_ms)
        canceller.reset()
        self.assertIsNone(canceller.delay_ms)


@unittest.skipUnless(LIBRARY, "numpy or pyaec is not installed: the real filter cannot run")
class FrameEdgeTests(unittest.TestCase):
    def setUp(self):
        self.canceller = echo_canceller.EchoCanceller()
        ref = _speech_like(3)
        _run(self.canceller, _room(ref, 60, 0.5).astype(np.int16), ref.astype(np.int16))

    def test_every_frame_size_keeps_its_length(self):
        ref = _speech_like(1).astype(np.int16)
        for size in (1, 2, 159, 160, 161, 320, 479, 1000):
            mic = _room(ref.astype(np.float64), 60, 0.5).astype(np.int16)[:size]
            out = self.canceller.process(mic, ref[:size])
            self.assertEqual(len(out), size, f"size {size}")
            self.assertEqual(out.dtype, np.int16)

    def test_empty_frame_comes_back_empty(self):
        empty = np.zeros(0, dtype=np.int16)
        self.assertEqual(len(self.canceller.process(empty, empty)), 0)
        self.assertEqual(self.canceller.process(b"", b""), b"")

    def test_unusable_input_is_returned_unchanged(self):
        odd = b"\x01\x02\x03"
        self.assertIs(self.canceller.process(odd, odd), odd)
        floats = np.ones(FRAME, dtype=np.float32)
        self.assertIs(self.canceller.process(floats, floats), floats)
        text = "not audio"
        self.assertIs(self.canceller.process(text, None), text)

    def test_reference_of_another_length_or_type_does_not_raise(self):
        mic = (np.random.default_rng(1).standard_normal(FRAME) * 1000).astype(np.int16)
        for ref in (None, np.zeros(7, dtype=np.int16), np.ones(FRAME * 3, dtype=np.int16) * 900, b"\x00", "x", 5):
            out = self.canceller.process(mic, ref)
            self.assertEqual(len(out), FRAME)

    def test_a_failing_filter_never_raises_and_turns_itself_off(self):
        ref = _speech_like(1).astype(np.int16)
        mic = _room(ref.astype(np.float64), 60, 0.5).astype(np.int16)
        with mock.patch.object(self.canceller._aec, "cancel_echo", side_effect=RuntimeError("boom")):
            for i in range(0, FRAME * 6, FRAME):
                out = self.canceller.process(mic[i : i + FRAME], ref[i : i + FRAME])
                self.assertTrue(np.array_equal(out, mic[i : i + FRAME]))
        self.assertFalse(self.canceller.ready)
        self.assertIn("turned off", self.canceller.status()["reason"])
        frame = mic[:FRAME]
        self.assertIs(self.canceller.process(frame, ref[:FRAME]), frame)
        self.canceller.reset()
        self.assertTrue(self.canceller.ready)


class RingTests(unittest.TestCase):
    @unittest.skipUnless(LIBRARY, "numpy is not installed")
    def test_ring_reads_across_the_wrap_and_zero_fills_the_past(self):
        ring = echo_canceller._Ring(np, 10)
        ring.write(np.arange(1, 8, dtype=np.int16))
        ring.write(np.arange(8, 15, dtype=np.int16))
        self.assertEqual(ring.read(0, 4).tolist(), [11, 12, 13, 14])
        self.assertEqual(ring.read(5, 3).tolist(), [7, 8, 9])
        self.assertEqual(ring.read(0, 12).tolist(), [0, 0, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
        self.assertEqual(ring.read(20, 3).tolist(), [0, 0, 0])
        ring.write(np.arange(100, 130, dtype=np.int16))
        self.assertEqual(ring.read(0, 3).tolist(), [127, 128, 129])


class PassthroughTests(unittest.TestCase):
    def test_missing_library_returns_the_microphone_unchanged(self):
        with mock.patch.object(echo_canceller, "_load", return_value=(None, None, "pyaec is not installed")):
            canceller = echo_canceller.EchoCanceller()
            frame = b"\x10\x00" * FRAME
            self.assertFalse(canceller.ready)
            self.assertIs(canceller.process(frame, frame), frame)
            self.assertIs(canceller.process(frame, None), frame)
            self.assertEqual(canceller.status()["reason"], "pyaec is not installed")
            self.assertEqual(canceller.status()["engine"], "none")
            report = echo_canceller.echo_status()
        self.assertFalse(report["ready"])
        self.assertTrue(report["optional"])
        self.assertFalse(report["gate"])
        self.assertIn("pyaec is not installed", report["reason"])

    def test_numpy_missing_is_reported_before_pyaec(self):
        with mock.patch.object(echo_canceller, "_load", return_value=(None, None, "numpy is not installed")):
            self.assertEqual(echo_canceller.EchoCanceller().status()["reason"], "numpy is not installed")

    def test_other_sample_rate_is_not_supported_and_passes_through(self):
        canceller = echo_canceller.EchoCanceller(sample_rate=48000)
        frame = b"\x01\x00" * FRAME
        self.assertFalse(canceller.ready)
        self.assertIs(canceller.process(frame, frame), frame)

    def test_filter_that_will_not_start_degrades(self):
        class Broken:
            def __init__(self, *_args):
                raise RuntimeError("no dll")

        with mock.patch.object(echo_canceller, "_load", return_value=(object(), Broken, "")):
            canceller = echo_canceller.EchoCanceller()
        self.assertFalse(canceller.ready)
        self.assertIn("did not start", canceller.status()["reason"])

    @unittest.skipUnless(LIBRARY, "numpy or pyaec is not installed")
    def test_no_reference_means_no_change_and_no_delay(self):
        canceller = echo_canceller.EchoCanceller()
        mic = (np.random.default_rng(5).standard_normal(FRAME * 50) * 2000).astype(np.int16)
        out = np.concatenate([canceller.process(mic[i : i + FRAME]) for i in range(0, len(mic), FRAME)])
        self.assertTrue(np.array_equal(out, mic))
        self.assertIsNone(canceller.delay_ms)

    @unittest.skipUnless(LIBRARY, "numpy or pyaec is not installed")
    def test_voice_runtime_reports_the_optional_canceller(self):
        import voice_runtime

        payload = voice_runtime.status()
        self.assertIn("echoCancellerReady", payload)
        self.assertEqual(payload["echoCancellerReady"], payload["echo"]["ready"])
        self.assertFalse(payload["echo"]["wired"])
        lines = voice_runtime.check_lines()
        self.assertTrue(any(line.split()[1:2] == ["echo-canceller"] for line in lines))
        self.assertFalse(any(line.startswith("FAIL echo") for line in lines))


class VoiceRuntimeDegradeTests(unittest.TestCase):
    def test_voice_runtime_status_when_the_library_is_absent(self):
        import voice_runtime

        with mock.patch.object(echo_canceller, "_load", return_value=(None, None, "pyaec is not installed")):
            payload = voice_runtime.status()
            lines = voice_runtime.check_lines()
        self.assertIs(payload["echoCancellerReady"], False)
        self.assertIn("OPTIONAL echo-canceller optional - pyaec is not installed", lines)
        self.assertFalse(any(line.startswith("FAIL echo") for line in lines))


if __name__ == "__main__":
    unittest.main()
