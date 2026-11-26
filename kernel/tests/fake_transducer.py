"""Fake onnxruntime sessions for the streaming ear: the same tensor names, ranks and types as the pinned export, tiny
sizes, and a scripted joint so a run is exact. Used by test_transducer_loop.py and test_stream_ear.py. No model file."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

WORD = "▁"
BLANK = 11


@dataclass
class Dims:
    """The recorded contract of the real export is (n_mels 128, chunk 32, pre 9, prompts 128, layers 24, attn 56,
    hidden 1024, conv 8, dec 2 x 640, vocab 13088). The default here is small; REAL_DIMS is the recorded one."""

    n_mels: int = 8
    chunk: int = 16
    pre: int = 3
    prompts: int = 16
    layers: int = 2
    attn: int = 4
    hidden: int = 8
    conv: int = 3
    dec_layers: int = 1
    dec_hidden: int = 5
    vocab: int = 12  # logits width, the blank (the last id) included
    out_frames: int = 2  # encoder frames per chunk (chunk // 8)


REAL_DIMS = Dims(128, 32, 9, 128, 24, 56, 1024, 8, 2, 640, 13088, 4)

PIECES = {
    0: "<unk>",
    1: f"{WORD}Open",
    2: f"{WORD}Chro",
    3: "me",
    4: ",",
    5: f"{WORD}please",
    6: f"{WORD}आज",
    7: f"{WORD}मौसम",
    8: f"{WORD}अच्छा",
    9: f"{WORD}है",
    10: WORD,
}


class Tensor:
    def __init__(self, name: str, shape: list[Any], type_: str) -> None:
        self.name, self.shape, self.type = name, shape, type_


def _np(type_: str) -> Any:
    return {"tensor(float)": np.float32, "tensor(int32)": np.int32, "tensor(int64)": np.int64}[type_]


class FakeSession:
    def __init__(self, ins: list[Tensor], outs: list[Tensor], fn: Any, providers: list[str]) -> None:
        self._ins, self._outs, self._fn = ins, outs, fn
        self._providers = list(providers)
        self.calls: list[dict[str, Any]] = []

    def get_inputs(self) -> list[Tensor]:
        return self._ins

    def get_outputs(self) -> list[Tensor]:
        return self._outs

    def get_providers(self) -> list[str]:
        return list(self._providers)

    def run(self, names: list[str] | None, feeds: dict[str, Any]) -> list[Any]:
        assert set(feeds) == {t.name for t in self._ins}, f"inputs {sorted(feeds)}"
        for t in self._ins:
            arr = feeds[t.name]
            assert arr.dtype == _np(t.type), f"{t.name} dtype {arr.dtype} != {t.type}"
            assert list(arr.shape) == t.shape, f"{t.name} shape {list(arr.shape)} != {t.shape}"
        self.calls.append({k: v.copy() for k, v in feeds.items()})
        produced = self._fn(feeds, len(self.calls) - 1, self._providers)
        wanted = names or [t.name for t in self._outs]
        return [produced[n] for n in wanted]


@dataclass
class FakeModel:
    """``factory`` is what ``NemotronStream(session_factory=...)`` takes. ``script`` is a list of (frame, token)."""

    dims: Dims = field(default_factory=Dims)
    script: list[tuple[int, int]] = field(default_factory=list)
    time_major: bool = True
    fail_run_on: dict[str, int] = field(default_factory=dict)  # file -> call number that raises on a GPU provider
    refuse: set[str] = field(default_factory=set)  # providers whose sessions cannot open
    opened: list[tuple[str, list[str]]] = field(default_factory=list)
    sessions: dict[str, FakeSession] = field(default_factory=dict)

    def factory(self, path: str, providers: list[str], threads: int) -> FakeSession:
        name = Path(path).name
        if any(p in self.refuse for p in providers):
            raise RuntimeError(f"cannot open {name} on {providers}")
        self.opened.append((name, list(providers)))
        build = {"encoder.onnx": self._encoder, "decoder.onnx": self._decoder, "joint.onnx": self._joint}[name]
        session = build(providers)
        self.sessions[name] = session
        return session

    def _guard(self, name: str, call: int, providers: list[str]) -> None:
        if self.fail_run_on.get(name) == call and any(p != "CPUExecutionProvider" for p in providers):
            raise RuntimeError("the GPU run failed")

    def _encoder(self, providers: list[str]) -> FakeSession:
        d = self.dims
        f = "tensor(float)"
        i32 = "tensor(int32)"
        ins = [
            Tensor("audio_signal", [1, d.n_mels, d.chunk], f),
            Tensor("audio_length", [1], i32),
            Tensor("language_mask", [1, d.prompts], f),
            Tensor("pre_cache", [1, d.n_mels, d.pre], f),
            Tensor("cache_last_channel", [d.layers, 1, d.attn, d.hidden], f),
            Tensor("cache_last_time", [d.layers, 1, d.hidden, d.conv], f),
            Tensor("cache_last_channel_len", [1], i32),
        ]
        shape = [1, d.out_frames, d.hidden] if self.time_major else [1, d.hidden, d.out_frames]
        outs = [
            Tensor("encoded_output", shape, f),
            Tensor("encoded_length", [1], i32),
            Tensor("new_pre_cache", [1, d.n_mels, d.pre], f),
            Tensor("new_cache_last_channel", [d.layers, 1, d.attn, d.hidden], f),
            Tensor("new_cache_last_time", [d.layers, 1, d.hidden, d.conv], f),
            Tensor("new_cache_last_channel_len", [1], i32),
        ]

        def run(feeds: dict[str, Any], call: int, provs: list[str]) -> dict[str, Any]:
            self._guard("encoder.onnx", call, provs)
            frames = np.zeros((d.out_frames, d.hidden), np.float32)
            seen = int(feeds["cache_last_channel_len"][0])  # chunks since the caches were zero
            frames[:, 0] = np.arange(d.out_frames) + seen * d.out_frames  # column 0 is the frame number
            out = frames[None] if self.time_major else frames.T[None]
            return {
                "encoded_output": out.copy(),
                "encoded_length": np.array([d.out_frames], np.int32),
                "new_pre_cache": feeds["audio_signal"][:, :, -d.pre :].copy(),
                "new_cache_last_channel": feeds["cache_last_channel"] + 1.0,
                "new_cache_last_time": feeds["cache_last_time"] + 1.0,
                "new_cache_last_channel_len": feeds["cache_last_channel_len"] + 1,
            }

        return FakeSession(ins, outs, run, providers)

    def _decoder(self, providers: list[str]) -> FakeSession:
        d = self.dims
        f = "tensor(float)"
        ins = [
            Tensor("token", [1, 1], "tensor(int64)"),
            Tensor("h", [d.dec_layers, 1, d.dec_hidden], f),
            Tensor("c", [d.dec_layers, 1, d.dec_hidden], f),
        ]
        outs = [
            Tensor("decoder_output", [1, 1, d.dec_hidden], f),
            Tensor("h_out", [d.dec_layers, 1, d.dec_hidden], f),
            Tensor("c_out", [d.dec_layers, 1, d.dec_hidden], f),
        ]

        def run(feeds: dict[str, Any], call: int, provs: list[str]) -> dict[str, Any]:
            self._guard("decoder.onnx", call, provs)
            moved = 0.0 if int(feeds["token"][0, 0]) == d.vocab - 1 else 1.0  # the blank id moves nothing
            h = feeds["h"] + moved
            out = np.zeros((1, 1, d.dec_hidden), np.float32)
            out[0, 0, 0] = h[0, 0, 0]  # how many tokens were emitted so far
            return {"decoder_output": out, "h_out": h, "c_out": feeds["c"] + moved}

        return FakeSession(ins, outs, run, providers)

    def _joint(self, providers: list[str]) -> FakeSession:
        d = self.dims
        f = "tensor(float)"
        ins = [Tensor("encoder_output", [1, 1, d.hidden], f), Tensor("decoder_output", [1, 1, d.dec_hidden], f)]
        outs = [Tensor("logits", [1, 1, d.vocab], f)]

        def run(feeds: dict[str, Any], call: int, provs: list[str]) -> dict[str, Any]:
            self._guard("joint.onnx", call, provs)
            frame = int(round(float(feeds["encoder_output"][0, 0, 0])))
            emitted = int(round(float(feeds["decoder_output"][0, 0, 0])))
            logits = np.full((1, 1, d.vocab), -5.0, np.float32)
            want = d.vocab - 1
            if emitted < len(self.script) and self.script[emitted][0] == frame:
                want = self.script[emitted][1]
            logits[0, 0, want] = 5.0
            return {"logits": logits}

        return FakeSession(ins, outs, run, providers)


def config_json(dims: Dims) -> dict[str, Any]:
    return {
        "numMelBins": dims.n_mels,
        "sampleRate": 16000,
        "nFFT": 512,
        "hopLength": 160,
        "winLength": 400,
        "preEmphasis": 0.97,
        "encoderHidden": dims.hidden,
        "encoderLayers": dims.layers,
        "attentionLeftContext": dims.attn,
        "convCacheSize": dims.conv,
        "decoderHidden": dims.dec_hidden,
        "decoderLayers": dims.dec_layers,
        "vocabSize": dims.vocab - 1,
        "blankTokenId": dims.vocab - 1,
        "numPrompts": dims.prompts,
        "streaming": {"melFrames": dims.chunk, "preCacheSize": dims.pre, "outputFrames": dims.out_frames},
    }


LANGUAGES = {
    "promptDictionary": {"en-US": 0, "en": 0, "hi-IN": 6, "hi": 6, "fr-FR": 8, "auto": 15},
    "autoSlot": 15,
}


def write_model_dir(folder: Path, dims: Dims | None = None, *, vocab: dict[int, str] | None = None) -> Path:
    """Empty ``.onnx`` stubs (the fake factory never reads them) plus the real-shaped tables."""
    dims = dims or Dims()
    folder.mkdir(parents=True, exist_ok=True)
    for name in ("encoder.onnx", "decoder.onnx", "joint.onnx"):
        (folder / name).write_bytes(b"")
    (folder / "vocab.json").write_text(
        json.dumps({str(k): v for k, v in (vocab or PIECES).items()}, ensure_ascii=False), encoding="utf-8"
    )
    (folder / "languages.json").write_text(json.dumps(LANGUAGES), encoding="utf-8")
    (folder / "config.json").write_text(json.dumps(config_json(dims)), encoding="utf-8")
    return folder


def pcm_bytes(seconds: float, level: float = 0.0, rate: int = 16000) -> bytes:
    """Little-endian int16 audio: silence, or a loud 220 Hz tone at ``level`` (0 to 1)."""
    n = int(seconds * rate)
    if level <= 0:
        return b"\x00\x00" * n
    t = np.arange(n) / rate
    return (np.sin(2 * np.pi * 220 * t) * level * 32767).astype("<i2").tobytes()


def install_fake_engine(monkeypatch: Any, root: Path, script: list[tuple[int, int]] | None = None) -> FakeModel:
    """Register the fake model as the only streaming engine, living in <root>/models/stream-ear-fake, and point
    FRIDAY_ROOT at ``root`` so ``choose_tier`` finds its files. Returns the model (its ``opened`` and ``sessions``)."""
    import stream_ear
    from transducer_loop import NemotronStream

    monkeypatch.setenv("FRIDAY_ROOT", str(root))
    model = FakeModel(script=list(script if script is not None else [(1, 1), (3, 2), (3, 3), (3, 4), (6, 5)]))
    folder = write_model_dir(root / "models" / "stream-ear-fake", model.dims)
    spec = stream_ear.EngineSpec(
        stream_ear.ENGINE_NAME,
        folder.name,
        {p.name: p.stat().st_size for p in folder.iterdir()},
        lambda: stream_ear.TransducerEngine(NemotronStream(model.factory, threads=1)),
        aliases=("nemotron",),
        languages=stream_ear._nemotron_languages,
        priority=10,
    )
    monkeypatch.setattr(stream_ear, "_REGISTRY", {stream_ear.ENGINE_NAME: spec})
    return model
