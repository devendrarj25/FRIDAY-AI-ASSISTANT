"""Persistent STT worker: status/ping without loading weights; shutdown reaps."""

from __future__ import annotations

import importlib.abc
import importlib.machinery
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

KERNEL = Path(__file__).resolve().parent.parent
SCRIPT = KERNEL / "stt.py"
sys.path.insert(0, str(KERNEL))


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
            self.assertIn("moonshineReady", first)
            self.assertIs(first.get("windowsSpeech"), False)
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

    def test_probe_reports_ladder_facts_before_a_missing_whisper_exit(self):
        text = SCRIPT.read_text(encoding="utf-8")
        self.assertLess(text.index("if args.probe:"), text.index("if _import_whisper() is None:"))
        proc = subprocess.run(
            [sys.executable, str(SCRIPT), "--probe"],
            cwd=str(KERNEL),
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        payload = json.loads(proc.stdout)
        self.assertIn("moonshineReady", payload)
        self.assertIs(payload.get("windowsSpeech"), False)
        self.assertTrue(payload["ladder"]["local"])


class SttAudioGuardTests(unittest.TestCase):
    def test_av_range_accepts_17_and_18_and_rejects_19(self):
        import stt

        self.assertTrue(stt.av_in_range("17.0.0"))
        self.assertTrue(stt.av_in_range("18.0.0"))
        self.assertTrue(stt.av_in_range("18.1.0"))
        self.assertFalse(stt.av_in_range("16.1.0"))
        self.assertFalse(stt.av_in_range("19.0.0"))
        self.assertFalse(stt.av_in_range("19.0.2"))
        guard = stt.av_guard()
        if guard["installed"] and not guard["ok"]:
            self.assertIn("dependency-incompatible", guard["reason"])
            self.assertIn("av>=17.0.0,<19", guard["fix"])
        elif not guard["installed"]:
            self.assertTrue(guard["skipped"])
            self.assertIn("skipped", guard["reason"])

    def test_native_wav_becomes_a_float_array_without_pyav(self):
        import stt

        try:
            import numpy  # noqa: F401
        except ImportError:
            self.skipTest("numpy is not installed")
        with tempfile.TemporaryDirectory() as tmp:
            wav = stt.write_probe_wav(str(Path(tmp) / "clip.wav"))
            audio = stt.read_pcm16_wav(wav)
            self.assertIsNotNone(audio)
            assert audio is not None
            self.assertEqual(int(audio.shape[0]), int(1.5 * 16000))
            self.assertLess(float(audio.dtype.itemsize), 8)
            text = SCRIPT.read_text(encoding="utf-8")
            prepare = text.split("def prepare_audio", 1)[1].split("def transcribe_moonshine", 1)[0]
            self.assertNotIn("decode_audio", prepare)
            self.assertNotIn("metadata_errors", prepare)

    def test_metadata_errors_becomes_a_typed_dependency_fault(self):
        import stt

        fault = stt.classify_stt_exception(TypeError("open() got an unexpected keyword argument 'metadata_errors'"))
        self.assertEqual(fault.kind, "dependency-incompatible")
        self.assertIn("dependency-incompatible: av", str(fault))
        self.assertIn("av>=17.0.0,<19", fault.fix)
        self.assertEqual(stt.classify_stt_exception(MemoryError("CUDA out of memory")).kind, "oom")
        self.assertEqual(stt.classify_stt_exception(TimeoutError("timed out")).kind, "timeout")
        self.assertEqual(stt.classify_stt_exception(RuntimeError("not a wav")).kind, "audio-invalid")
        missing = stt.classify_stt_exception(FileNotFoundError("model not found"))
        self.assertEqual(missing.kind, "model-missing")

    def test_self_test_fails_when_transcription_raises(self):
        import stt

        def boom(_samples):
            raise TypeError("open() got an unexpected keyword argument 'metadata_errors'")

        result = stt.run_speech_self_test(transcribe=boom)
        self.assertFalse(result["ok"])
        self.assertFalse(result["skipped"])
        self.assertEqual(result["sttClass"], "dependency-incompatible")
        self.assertTrue(result["local"])

    def test_self_test_skip_is_visible_without_faster_whisper(self):
        import stt

        try:
            import faster_whisper  # noqa: F401
        except ImportError:
            result = stt.run_speech_self_test()
            self.assertTrue(result["ok"])
            self.assertTrue(result["skipped"])
            self.assertTrue(result.get("reason"))
            self.assertTrue(result["local"])
            return
        result = stt.run_speech_self_test()
        if result.get("skipped"):
            self.skipTest(result.get("reason") or "speech model is not on disk")
        self.assertTrue(result["ok"], result)
        self.assertIn("transcribeMs", result)
        self.assertIn("loadMs", result)
        self.assertGreaterEqual(result["transcribeMs"], 0)
        self.assertTrue(result["local"])

    def test_ladder_moves_to_the_next_local_engine(self):
        import stt

        moon = stt.live_ladder(
            {
                "whisperReady": False,
                "weightsReady": False,
                "english": True,
                "moonshineReady": True,
                "windowsSpeech": True,
            }
        )
        self.assertEqual(moon["engine"], "moonshine")
        windows = stt.live_ladder(
            {
                "whisperReady": False,
                "weightsReady": False,
                "english": False,
                "moonshineReady": True,
                "windowsSpeech": True,
            }
        )
        self.assertEqual(windows["engine"], "windows-speech")


if __name__ == "__main__":
    unittest.main()


def test_self_test_runs_under_the_embeddable_python_rules(tmp_path):
    """The packaged self-check uses the bundled embeddable Python, whose ._pth
    keeps the script folder off sys.path. `-I` reproduces that: the sibling
    voice_runtime import must still resolve and the self-test must answer JSON."""
    import json
    import subprocess
    import sys
    from pathlib import Path

    script = Path(__file__).resolve().parents[1] / "stt.py"
    proc = subprocess.run(
        [sys.executable, "-I", str(script), "--self-test"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=300,
    )
    assert "ModuleNotFoundError" not in proc.stderr, proc.stderr[-400:]
    # The script ran to its JSON answer, so the sibling import resolved. Whether
    # a speech model is present depends on the machine, not on this import.
    payload = json.loads(proc.stdout.strip().splitlines()[-1])
    assert "voice_runtime" not in json.dumps(payload), payload
    assert payload.get("ok") is True or payload.get("sttClass"), payload


class SttUtf8OutputTests(unittest.TestCase):
    def test_probe_prints_valid_json_with_a_devanagari_data_root_on_a_cp1252_console(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw) / "\u092b\u094d\u0930\u093e\u0907\u0921\u0947"
            root.mkdir()
            env = {k: v for k, v in os.environ.items() if k not in ("PYTHONUTF8", "PYTHONIOENCODING")}
            env.update({"FRIDAY_ROOT": str(root), "PYTHONIOENCODING": "cp1252"})
            proc = subprocess.run(
                [sys.executable, str(SCRIPT), "--probe"],
                cwd=str(KERNEL),
                capture_output=True,
                timeout=30,
                check=False,
                env=env,
            )
        self.assertEqual(proc.returncode, 0, proc.stderr.decode("utf-8", "replace")[-400:])
        payload = json.loads(proc.stdout.decode("ascii"))
        self.assertIn("moonshineReady", payload)

    def test_a_non_ascii_path_in_a_probe_result_survives_a_cp1252_console(self):
        code = (
            "import sys; sys.path.insert(0, sys.argv[1]); import stt; "
            "stt._utf8_streams(); "
            "stt.emit({'path': '/\u092b\u094d\u0930/x', 'text': '\u0928\u092e\u0938\u094d\u0924\u0947'})"
        )
        env = {k: v for k, v in os.environ.items() if k != "PYTHONUTF8"}
        env["PYTHONIOENCODING"] = "cp1252"
        proc = subprocess.run(
            [sys.executable, "-c", code, str(KERNEL)], capture_output=True, timeout=30, check=False, env=env
        )
        self.assertEqual(proc.returncode, 0, proc.stderr.decode("utf-8", "replace")[-400:])
        got = json.loads(proc.stdout.decode("ascii"))
        self.assertEqual(got["text"], "\u0928\u092e\u0938\u094d\u0924\u0947")

    def test_a_350_kb_devanagari_result_round_trips_through_emit(self):
        import io

        import stt

        text = "\u0928\u092e\u0938\u094d\u0924\u0947 \u0926\u0941\u0928\u093f\u092f\u093e " * 10000
        self.assertGreater(len(text.encode("utf-8")), 350_000)
        raw = io.BytesIO()
        wrapper = io.TextIOWrapper(raw, encoding="cp1252", errors="strict", write_through=True)
        real = sys.stdout
        sys.stdout = wrapper
        try:
            stt.emit({"ok": True, "text": text})
        finally:
            sys.stdout = real
        self.assertEqual(json.loads(raw.getvalue().decode("ascii"))["text"], text)


# ---- the light status, the lazy probe, the safe reply line ---------------------------------------------------------


class _RaisingLoader(importlib.abc.Loader):
    def create_module(self, spec):  # noqa: ARG002
        return None

    def exec_module(self, module):  # noqa: ARG002
        raise AssertionError("the status op imported faster_whisper")


class _BlockedImport:
    """A meta-path finder: looking the package up is allowed, importing it fails the test."""

    def find_spec(self, name, path=None, target=None):  # noqa: ARG002
        if name == "faster_whisper" or name.startswith("faster_whisper."):
            return importlib.machinery.ModuleSpec(name, _RaisingLoader())
        return None


def _block_heavy(monkeypatch):
    import stt

    calls = {"probe": 0}

    def no_probe():
        calls["probe"] += 1
        raise AssertionError("the status op ran the Windows speech probe")

    monkeypatch.setattr(stt, "_whisper_cls", None)
    monkeypatch.setattr(stt, "_whisper_error", "")
    monkeypatch.setattr(stt, "_windows_speech", None)
    monkeypatch.setattr(stt, "windows_speech_ready", no_probe)
    monkeypatch.delitem(sys.modules, "faster_whisper", raising=False)
    monkeypatch.setattr(sys, "meta_path", [_BlockedImport(), *sys.meta_path])
    return calls


def test_the_status_op_never_imports_faster_whisper_nor_runs_the_speech_probe(monkeypatch):
    import time

    import stt

    calls = _block_heavy(monkeypatch)
    started = time.perf_counter()
    reply = stt.handle_request({"op": "status"})
    elapsed = time.perf_counter() - started
    assert reply["ok"] is True and calls["probe"] == 0
    assert "faster_whisper" not in sys.modules
    assert elapsed < 0.2, elapsed
    # The old fields stay: the app reads available, dependency, error, modelLoaded and the ladder from this ping.
    for key in ("available", "dependency", "modelLoaded", "loadCount", "ladder", "streamEar", "cudaRuntimeReady"):
        assert key in reply, key
    if sys.platform == "win32":
        assert "windowsSpeech" not in reply  # unprobed: the app keeps the value its own probe found
    else:
        assert reply["windowsSpeech"] is False


def test_the_probe_op_runs_the_heavy_checks_once_and_the_status_then_reports_them(monkeypatch):
    import stt

    seen = {"import": 0, "speech": 0}

    def fake_import():
        seen["import"] += 1
        return None

    def fake_speech():
        seen["speech"] += 1
        stt._windows_speech = True
        return True

    monkeypatch.setattr(stt, "_import_whisper", fake_import)
    monkeypatch.setattr(stt, "_windows_speech", None)
    monkeypatch.setattr(stt, "windows_speech_ready", fake_speech)
    probed = stt.handle_request({"op": "probe"})
    assert seen == {"import": 1, "speech": 1} and probed["windowsSpeech"] is True
    status = stt.handle_request({"op": "status"})
    assert seen == {"import": 1, "speech": 1} and status["windowsSpeech"] is True


def test_emit_writes_numpy_scalars_and_arrays_as_plain_json(monkeypatch, capsys):
    np = __import__("pytest").importorskip("numpy")
    import stt

    stt.emit({"id": 4, "ok": True, "p": np.float32(0.5), "n": np.int64(3), "v": np.arange(3)})
    got = json.loads(capsys.readouterr().out)
    assert got == {"id": 4, "ok": True, "p": 0.5, "n": 3, "v": [0, 1, 2]}


def test_a_reply_that_cannot_be_written_becomes_an_error_envelope_and_the_loop_lives(monkeypatch, capsys):
    import io

    import stt

    real = stt._handle_op

    def odd(req):
        if req.get("op") == "odd":
            return {"ok": True, "thing": object()}
        return real(req)

    monkeypatch.setattr(stt, "_handle_op", odd)
    monkeypatch.setattr(stt, "start_idle_watch", lambda *a, **k: None)
    lines = [{"id": 1, "op": "odd"}, {"id": 2, "op": "bogus"}, {"id": 3, "op": "shutdown"}]
    monkeypatch.setattr(sys, "stdin", io.StringIO("".join(json.dumps(x) + "\n" for x in lines)))
    assert stt.serve() == 0
    replies = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.startswith("{")]
    assert [r["id"] for r in replies] == [1, 2, 3]
    assert replies[0]["ok"] is False and replies[0]["reason"] == "serialise-error"
    assert replies[1]["reason"] == "unknown-op" and replies[2]["ok"] is True


SECRET_PATH = "C:\\Users\\owner\\AppData\\FRIDAY\\models\\x.onnx"


def test_a_worker_error_reply_carries_no_path(monkeypatch, capsys):
    import io

    import stt

    def boom(_req):
        raise RuntimeError(f"could not open {SECRET_PATH} for reading")

    monkeypatch.setattr(stt, "_handle_op", boom)
    monkeypatch.setattr(stt, "start_idle_watch", lambda *a, **k: None)
    lines = [{"id": 1, "op": "status"}, {"id": 2, "op": "shutdown"}]
    monkeypatch.setattr(sys, "stdin", io.StringIO("".join(json.dumps(x) + "\n" for x in lines)))
    stt.serve()
    first = json.loads(capsys.readouterr().out.splitlines()[0])
    assert first["reason"] == "worker-error" and "RuntimeError" in first["error"]
    assert "Users" not in first["error"] and "owner" not in first["error"]


def test_the_vad_and_turn_scorers_scrub_paths_from_their_reasons(monkeypatch):
    import vad_onnx
    import voice_runtime

    def bad(*_a, **_k):
        raise OSError(f"cannot load {SECRET_PATH}")

    monkeypatch.setattr(voice_runtime, "find_named", lambda _n: Path("silero.onnx"))
    monkeypatch.setattr(vad_onnx, "score_window", bad)
    vad = voice_runtime.score_vad([0.0] * 512)
    assert vad["ready"] is False and "owner" not in vad["reason"] and "OSError" in vad["reason"]
    np = __import__("pytest").importorskip("numpy")
    monkeypatch.setattr(voice_runtime, "smart_turn_path", lambda: Path("smart-turn.onnx"))
    monkeypatch.setattr(voice_runtime, "_turn_session", bad)
    turn = voice_runtime.score_turn(np.zeros(16000, dtype=np.float32))
    assert turn["ready"] is False and "owner" not in turn["reason"] and "OSError" in turn["reason"]


def test_a_stream_error_reply_carries_no_path(monkeypatch):
    import stream_ear

    host = stream_ear.StreamHost()

    def bad(_req):
        raise RuntimeError(f"decoder failed at {SECRET_PATH}")

    monkeypatch.setattr(host, "_open", bad)
    reply = host.handle({"op": "stream-open"})
    assert reply["ok"] is False and "RuntimeError" in reply["error"] and "owner" not in reply["error"]
