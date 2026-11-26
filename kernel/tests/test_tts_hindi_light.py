"""The light Hindi voice: optional, only with its pinned files on disk, only for Devanagari, never the default.

No weights and no network: the three ONNX graphs are replaced by a fake engine that speaks the same small
interface. The numpy parts (length regulation, inverse STFT, token ids, the text frontend) run for real.
"""

from __future__ import annotations

import base64
import json
import sys
import types
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "kernel"))

import tts_hindi_light as light  # noqa: E402
import voice_runtime  # noqa: E402

VOCAB = frozenset("अआइईउऊएऐओऔकखगघचछजझटठडढणतथदधनपफबभमयरलवशषसहािीुूेैोौं़्ँः। ,?!.-")


def _stage(root: Path, big: bool = True) -> Path:
    folder = root / "models" / light.MODEL_DIR
    for name in light.REQUIRED:
        file = folder / name
        file.parent.mkdir(parents=True, exist_ok=True)
        with file.open("wb") as handle:
            handle.truncate(light.MIN_GRAPH_BYTES + 1 if big and name.endswith(".onnx") else 10)
    return folder


class FakeEngine:
    sample_rate = 24000
    vocab = VOCAB
    pause_seconds = 0.15

    def __init__(self):
        self.chunks: list[tuple[str, str, float]] = []

    def synth_chunk(self, chunk: str, voice: str, speed: float, rng) -> np.ndarray:
        self.chunks.append((chunk, voice, speed))
        return np.full(2400 * max(1, len(chunk) // 10 + 1), 0.25, dtype=np.float32)


@pytest.fixture(autouse=True)
def _fresh(monkeypatch, tmp_path):
    monkeypatch.setenv("FRIDAY_ROOT", str(tmp_path))
    monkeypatch.setattr(light, "_engine", None)
    monkeypatch.setattr(light, "_engine_dir", "")
    monkeypatch.setattr(light, "_failed_dir", "")


def _use(monkeypatch, engine):
    loads: list[str] = []
    monkeypatch.setattr(light, "_engine", None)

    def load(folder):
        loads.append(str(folder))
        return engine

    monkeypatch.setattr(light, "_load_engine", load)
    return loads


def test_it_is_ready_only_with_every_pinned_file_and_whole_graphs(tmp_path):
    assert light.model_dir() is None and light.ready() is False
    folder = _stage(tmp_path, big=False)
    assert light.ready() is False  # a partial download is not ready
    _stage_over = folder / "onnx" / "vocoder.onnx"
    with _stage_over.open("wb") as handle:
        handle.truncate(light.MIN_GRAPH_BYTES + 1)
    for name in ("text_encoder", "flow_decoder"):
        with (folder / "onnx" / f"{name}.onnx").open("wb") as handle:
            handle.truncate(light.MIN_GRAPH_BYTES + 1)
    assert light.ready() is True
    (folder / "config.json").unlink()
    assert light.ready() is False


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("नमस्ते, आप कैसे हैं?", True),
        ("नमस्ते hello", False),  # an English word would be skipped silently: Supertonic reads it instead
        ("आज 5 बजे", False),  # a digit would be skipped silently
        ("आज ५ बजे", False),
        ("hello there", False),
        ("।।,,", False),  # no letter to speak
        ("", False),
        ("   ", False),
    ],
)
def test_it_speaks_only_text_it_can_say_in_full(text, expected):
    assert light.speakable(text) is expected


def test_the_frontend_keeps_what_the_model_knows_and_never_invents_words():
    vocab = VOCAB
    assert light.frontend("नमस्ते,  आप   कैसे हैं?", vocab) == "नमस्ते, आप कैसे हैं?"
    # NFC, invisible joiners removed, a spoken-style colon or semicolon becomes a comma, an ellipsis a full stop.
    assert light.frontend("नमस्ते‍: आप‌ कैसे…", vocab) == "नमस्ते, आप कैसे."
    # A character the model has no symbol for is a space, never a guess; double danda is one danda.
    assert light.frontend("आप॥ कैसे ॐ हैं", vocab) == "आप। कैसे हैं"
    assert light.frontend("क़ीमत", vocab) == "क़ीमत"  # nukta stays a separate sign


def test_it_cuts_sentences_and_keeps_every_chunk_under_the_model_limit():
    text = "पहला वाक्य है। दूसरा वाक्य है? तीसरा वाक्य है!"
    assert light.chunks(text) == ["पहला वाक्य है।", "दूसरा वाक्य है?", "तीसरा वाक्य है!"]
    long = ", ".join(["शब्द " * 10] * 12)  # one very long sentence
    pieces = light.chunks(long)
    assert len(pieces) > 1 and all(len(piece) <= light.MAX_CHUNK for piece in pieces)
    assert "".join(piece.replace(" ", "") for piece in pieces) == long.replace(" ", "")
    assert light.chunks("।  ,") == []  # nothing to say


def test_token_ids_put_a_blank_around_every_symbol():
    table = {"c:क": 5, "c:ा": 6}
    assert light.token_ids("का", table) == [0, 5, 0, 6, 0]
    with pytest.raises(KeyError):
        light.token_ids("कx", table)


def test_length_regulation_copies_each_token_for_its_duration():
    mu = np.array([[1.0, 2.0, 3.0]], dtype=np.float32)
    w = np.array([2.0, 0.0, 3.0], dtype=np.float32)
    mu_y, mask = light.length_regulate(mu, w, 5, 6)
    assert mu_y.tolist() == [[1.0, 1.0, 3.0, 3.0, 3.0, 0.0]]
    assert mask.tolist() == [1.0, 1.0, 1.0, 1.0, 1.0, 0.0]
    w_ceil, y_len, y_pad = light.durations(np.log(np.array([1.2, 0.2, 2.5], dtype=np.float32)), 1.0, 2)
    assert w_ceil.tolist() == [2.0, 1.0, 3.0] and y_len == 6 and y_pad == 6
    assert light.durations(np.array([-30.0], dtype=np.float32), 1.0, 2)[1:] == (1, 2)  # never fewer than one frame


def test_the_inverse_stft_returns_the_waveform_it_was_made_from():
    n_fft, hop = 1024, 256
    t = np.arange(8192) / 24000.0
    wave = (0.5 * np.sin(2 * np.pi * 220 * t) + 0.2 * np.sin(2 * np.pi * 1330 * t)).astype(np.float64)
    window = 0.5 - 0.5 * np.cos(2.0 * np.pi * np.arange(n_fft) / n_fft)
    padded = np.pad(wave, n_fft // 2, mode="reflect")
    frames = [padded[i : i + n_fft] * window for i in range(0, len(padded) - n_fft + 1, hop)]
    spec = np.fft.rfft(np.stack(frames), axis=1).T
    back = light.istft(spec.real, spec.imag, n_fft, hop)
    assert back.dtype == np.float32
    middle = slice(n_fft, len(wave) - n_fft)
    assert float(np.max(np.abs(back[: len(wave)][middle] - wave[middle]))) < 1e-4


def test_it_speaks_in_sentences_with_a_pause_between_and_picks_the_voice(monkeypatch, tmp_path):
    _stage(tmp_path)
    engine = FakeEngine()
    _use(monkeypatch, engine)
    made = light.synthesize("पहला वाक्य है। दूसरा वाक्य है।", speed=1.0, style="M3", seed=1)
    assert made is not None
    audio, rate = made
    assert rate == 24000 and audio.dtype == np.float32
    assert [voice for _chunk, voice, _speed in engine.chunks] == ["male", "male"]
    pause = int(0.15 * 24000)
    sizes = [2400 * max(1, len(chunk) // 10 + 1) for chunk, _v, _s in engine.chunks]
    assert len(audio) == sum(sizes) + pause
    assert float(np.max(np.abs(audio))) <= 1.0
    light.synthesize("एक वाक्य है।", speed=1.0, style="F2", seed=1)
    assert engine.chunks[-1][1] == "female"
    light.synthesize("एक वाक्य है।", speed=1.0, style="", seed=1)
    assert engine.chunks[-1][1] == "female"  # the default voice
    light.synthesize("एक वाक्य है।", speed=9.0, style="F1", seed=1)
    assert engine.chunks[-1][2] == 2.0  # speed is held inside the range the voice sounds right at
    light.synthesize("एक वाक्य है।", speed=0.1, style="F1", seed=1)
    assert engine.chunks[-1][2] == 0.7


def test_it_says_nothing_it_cannot_say_in_full_and_never_when_missing(monkeypatch, tmp_path):
    assert light.synthesize("नमस्ते", 1.0, "F1") is None  # not installed
    _stage(tmp_path)
    engine = FakeEngine()
    loads = _use(monkeypatch, engine)
    assert light.synthesize("नमस्ते hello", 1.0, "F1") is None  # a Latin word: the caller's own voice reads it
    assert light.synthesize("आज 5 बजे", 1.0, "F1") is None
    assert light.synthesize("", 1.0, "F1") is None
    assert loads == []  # none of these even opened the model


def test_a_model_that_will_not_open_or_run_is_not_retried_and_gives_no_audio(monkeypatch, tmp_path):
    _stage(tmp_path)
    attempts: list[str] = []

    def boom(folder):
        attempts.append(str(folder))
        raise RuntimeError("the runtime failed to open")

    monkeypatch.setattr(light, "_load_engine", boom)
    assert light.synthesize("नमस्ते", 1.0, "F1") is None
    assert light.synthesize("नमस्ते", 1.0, "F1") is None
    assert len(attempts) == 1  # remembered for the session

    class Broken(FakeEngine):
        def synth_chunk(self, chunk, voice, speed, rng):
            raise RuntimeError("bad run")

    _use(monkeypatch, Broken())
    monkeypatch.setattr(light, "_failed_dir", "")
    assert light.synthesize("नमस्ते", 1.0, "F1") is None  # a failing run is the caller's fallback, not a crash


# ------------------------------------------------------------------ the engine around the three graphs


def _stage_real_shape(root: Path) -> Path:
    """A folder with the real file names and a small but complete config, for the engine with fake graphs."""
    folder = _stage(root)
    symbols = ["<blank>", "<unk>"] + [f"c:{char}" for char in " नमस्ते,।"]
    config = {
        "sample_rate": 24000,
        "voices": {"female": "hi_F", "male": "hi_M"},
        "ids": {"language": 1, "speakers": {"hi_F": 2, "hi_M": 3}, "styles": {"read": 0}},
        "vocab": {"mode": "chr", "add_blank": True, "symbols": symbols},
        "synthesis": {"n_timesteps": 4, "temperature": 0.5, "style": "read", "sentence_pause_s": 0.1,
                      "length_scale": {"hi_F": 1.0, "hi_M": 2.0}},
        "mel_stats": [-1.0, 2.0],
        "vocoder": {"head": {"n_fft": 1024, "hop_length": 256, "padding": "center"}},
    }  # fmt: skip
    (folder / "config.json").write_text(json.dumps(config), encoding="utf-8")
    manifest = {"frame_multiple": 2, "max_tokens": 2048}
    (folder / "onnx" / "onnx_manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return folder


class _Session:
    """One fake graph: records what it was fed and answers with arrays of the shapes the real one returns."""

    def __init__(self, name: str, log: list):
        self.name, self.log = name, log

    def run(self, _outputs, feeds):
        self.log.append((self.name, feeds))
        if self.name == "text_encoder":
            tokens = feeds["tokens"].shape[1]
            return [
                np.zeros((1, 100, tokens), np.float32),
                np.full((1, 1, tokens), np.log(2.0), np.float32),  # two frames per token
                np.zeros((1, 112), np.float32),
            ]
        if self.name == "flow_decoder":
            return [np.ones_like(feeds["x"]) * 0.1]
        frames = feeds["mel"].shape[2]
        real = np.zeros((1, 513, frames), np.float32)
        real[:, 0, :] = 1.0
        return [real, np.zeros_like(real)]


class _Options:
    def __init__(self):
        self.entries: dict[str, str] = {}

    def add_session_config_entry(self, key, value):
        self.entries[key] = value


def _fake_onnxruntime(monkeypatch, log: list):
    module = types.ModuleType("onnxruntime")
    module.SessionOptions = _Options  # type: ignore[attr-defined]
    module.GraphOptimizationLevel = types.SimpleNamespace(ORT_ENABLE_ALL=99)  # type: ignore[attr-defined]

    def session(path, options, providers=None):
        assert providers == ["CPUExecutionProvider"]
        module.opened.append(options)  # type: ignore[attr-defined]
        return _Session(Path(path).stem, log)

    module.InferenceSession = session  # type: ignore[attr-defined]
    module.opened = []  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "onnxruntime", module)
    return module


def test_the_engine_feeds_the_graphs_the_way_the_model_was_trained(monkeypatch, tmp_path):
    log: list = []
    _fake_onnxruntime(monkeypatch, log)
    engine = light._OnnxEngine(_stage_real_shape(tmp_path))
    assert engine.vocab == frozenset(" नमस्ते,।") and engine.sample_rate == 24000

    draws: list = []

    class Rng:
        def standard_normal(self, shape, dtype=None):
            draws.append(dtype)
            return np.ones(shape, dtype=dtype or np.float64)

    audio = engine.synth_chunk("नमस्ते", "male", 2.0, Rng())
    encoder = log[0][1]
    assert encoder["tokens"][0, ::2].tolist() == [0] * 7  # a blank before, between and after every symbol
    assert encoder["tokens"].dtype == np.int64 and encoder["tokens"].shape == (1, 13)
    assert encoder["token_lengths"].tolist() == [13]
    assert (encoder["language"].tolist(), encoder["speaker"].tolist(), encoder["style"].tolist()) == ([1], [3], [0])
    flows = [feeds for name, feeds in log if name == "flow_decoder"]
    assert len(flows) == 4  # one Euler step per timestep
    assert [round(float(feeds["t"][0]), 2) for feeds in flows] == [0.0, 0.25, 0.5, 0.75]
    frames = 13 * 2 * 1  # two frames a token; length scale 2.0 for the male voice and speed 2.0 cancel out
    assert flows[0]["x"].shape == (1, 100, frames) and flows[0]["x"].dtype == np.float32
    assert float(flows[0]["x"][0, 0, 0]) == pytest.approx(0.5)  # the noise is scaled by the temperature
    assert draws == [np.float32]  # drawn as float32, the way the upstream runtime draws it
    mel = [feeds["mel"] for name, feeds in log if name == "vocoder"][0]
    assert mel.shape == (1, 100, frames)
    # The Euler steps added 4 * 0.25 * 0.1 = 0.1 to the noise; then the mel is un-normalised: x * std + mean.
    assert float(mel[0, 0, 0]) == pytest.approx((0.5 + 0.1) * 2.0 - 1.0, abs=1e-5)
    assert audio.dtype == np.float32 and audio.shape == (256 * (frames - 1),)
    assert float(np.max(np.abs(audio))) <= 1.0 and bool(np.all(np.isfinite(audio)))


def test_a_chunk_with_a_symbol_the_model_lacks_is_refused_not_guessed(monkeypatch, tmp_path):
    _fake_onnxruntime(monkeypatch, [])
    engine = light._OnnxEngine(_stage_real_shape(tmp_path))
    with pytest.raises(KeyError):
        engine.synth_chunk("नमx", "female", 1.0, np.random.default_rng(1))


# ------------------------------------------------------------------ the voice runtime ladder


def _fake_supertonic(monkeypatch):
    seen: list[str] = []

    def made(text, speed=1.0, lang="", style=""):
        seen.append(text)
        return np.full(480, 0.1, dtype=np.float32), 22050

    monkeypatch.setattr(voice_runtime, "_speak_array", made)
    return seen


def test_speak_pcm_keeps_its_old_reply_when_no_engine_is_asked_for(monkeypatch, tmp_path):
    seen = _fake_supertonic(monkeypatch)
    body = voice_runtime.speak_pcm_payload({"text": "नमस्ते दुनिया", "lang": "hi-IN", "seq": 4})
    old_fields = {"ok", "sampleRate", "pcm16", "ms", "seq", "pausedMs"}
    assert set(body) == old_fields | {"engine", "own", "voiceId", "recipeVersion"}  # no fallback: nothing said so
    assert body["engine"] == "supertonic-3" and body["own"] is False and body["recipeVersion"] == 0
    assert body["pausedMs"] == 0
    assert seen == ["नमस्ते दुनिया"] and body["sampleRate"] == 22050


def test_speak_pcm_uses_the_light_voice_only_when_asked_installed_hindi_and_whole(monkeypatch, tmp_path):
    seen = _fake_supertonic(monkeypatch)
    ask = {"text": "नमस्ते दुनिया", "lang": "hi-IN", "engine": "hindi-light"}
    body = voice_runtime.speak_pcm_payload(ask)
    assert body["ok"] is True and body["engine"] == "supertonic-3" and body["fallback"] == "hindi-light-not-installed"
    assert seen == ["नमस्ते दुनिया"]

    _stage(tmp_path)
    engine = FakeEngine()
    _use(monkeypatch, engine)
    body = voice_runtime.speak_pcm_payload({**ask, "id": 9, "seq": 2, "style": "M1"})
    assert body["ok"] is True and body["engine"] == "hindi-light" and "fallback" not in body
    assert body["sampleRate"] == 24000 and body["seq"] == 2
    raw = base64.b64decode(body["pcm16"])
    assert len(raw) > 0 and len(raw) % 2 == 0
    assert np.frombuffer(raw, dtype="<i2").max() == int(np.floor(0.25 * 32768))
    assert engine.chunks[-1][1] == "male"
    assert len(seen) == 1  # Supertonic did not speak this one

    # An English line, or a Hindi line with an English word, stays with Supertonic.
    english = voice_runtime.speak_pcm_payload({"text": "Open the calendar", "lang": "en-IN", "engine": "hindi-light"})
    assert english["engine"] == "supertonic-3" and english["fallback"] == "hindi-light-needs-hindi"
    mixed = voice_runtime.speak_pcm_payload({"text": "नमस्ते hello", "lang": "hi-IN", "engine": "hindi-light"})
    assert mixed["engine"] == "supertonic-3" and mixed["fallback"] == "hindi-light-needs-devanagari-only"
    # Another engine name is the default engine.
    other = voice_runtime.speak_pcm_payload({"text": "नमस्ते", "lang": "hi-IN", "engine": "something-else"})
    assert other["engine"] == "supertonic-3" and other["fallback"] == "unknown-engine"


def test_a_failing_light_voice_falls_back_to_supertonic_not_to_silence(monkeypatch, tmp_path):
    seen = _fake_supertonic(monkeypatch)
    _stage(tmp_path)

    class Broken(FakeEngine):
        def synth_chunk(self, chunk, voice, speed, rng):
            raise RuntimeError("bad run")

    _use(monkeypatch, Broken())
    body = voice_runtime.speak_pcm_payload({"text": "नमस्ते दुनिया", "lang": "hi", "engine": "hindi-light"})
    assert body["ok"] is True and body["engine"] == "supertonic-3" and body["fallback"] == "hindi-light-failed"
    assert seen == ["नमस्ते दुनिया"]


def test_the_worker_op_and_status_report_the_light_voice(monkeypatch, tmp_path):
    import io

    _fake_supertonic(monkeypatch)
    _stage(tmp_path)
    _use(monkeypatch, FakeEngine())
    lines = [
        {"id": 1, "op": "speak-pcm", "text": "नमस्ते दुनिया", "lang": "hi-IN", "engine": "hindi-light"},
        {"id": 2, "op": "status"},
        {"id": 3, "op": "shutdown"},
    ]
    monkeypatch.setattr(sys, "stdin", io.StringIO("".join(json.dumps(item) + "\n" for item in lines)))
    out = io.StringIO()
    monkeypatch.setattr(sys, "stdout", out)
    assert voice_runtime.serve() == 0
    replies = [json.loads(line) for line in out.getvalue().splitlines() if line.strip()]
    assert replies[0]["id"] == 1 and replies[0]["engine"] == "hindi-light" and replies[0]["ok"] is True
    assert replies[1]["hindiLight"]["ready"] is True
    assert replies[1]["hindiLight"]["engine"] == "hindi-light"
    assert "CC-BY-4.0" in replies[1]["hindiLight"]["license"]


def test_the_voice_check_line_says_installed_missing_or_broken(monkeypatch, tmp_path):
    assert voice_runtime._hindi_light_line() == "OPTIONAL hindi-light-tts optional - not installed"
    _stage(tmp_path)
    monkeypatch.setattr("importlib.util.find_spec", lambda name, *a, **k: None if name == "onnxruntime" else object())
    assert voice_runtime._hindi_light_line().startswith("FAIL hindi-light-tts the weights are on disk but")
    monkeypatch.setattr("importlib.util.find_spec", lambda name, *a, **k: object())
    assert voice_runtime._hindi_light_line() == "PASS hindi-light-tts pinned weights present"


def test_the_light_voice_graphs_open_on_the_speaker_budget_without_spinning_threads(monkeypatch, tmp_path):
    import voice_budget

    monkeypatch.delenv("FRIDAY_VOICE_THREADS", raising=False)
    monkeypatch.setattr(voice_budget, "cpu_count", lambda: 4)
    module = _fake_onnxruntime(monkeypatch, [])
    light._OnnxEngine(_stage_real_shape(tmp_path))
    assert module.opened
    for options in module.opened:
        assert options.intra_op_num_threads == voice_budget.steady("tts", 4) == 2
        assert options.inter_op_num_threads == 1
        assert options.entries == {"session.intra_op.allow_spinning": "0"}
