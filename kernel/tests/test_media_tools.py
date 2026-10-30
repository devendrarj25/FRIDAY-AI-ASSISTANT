"""Media tools run only where ffmpeg exists; the plan and the refusals are checked everywhere."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import media_tools
import pytest

needs_ffmpeg = pytest.mark.skipif(
    not (shutil.which("ffmpeg") and shutil.which("ffprobe")), reason="ffmpeg not installed"
)


def clip(tmp_path: Path) -> Path:
    out = tmp_path / "in.mp4"
    subprocess.run(  # noqa: S603
        [
            shutil.which("ffmpeg") or "ffmpeg",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=320x240:rate=10:duration=2",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=2",
            "-shortest",
            "-pix_fmt",
            "yuv420p",
            str(out),
        ],
        check=True,
    )
    return out


def test_plan_builds_checked_arguments_with_absolute_inputs(tmp_path: Path) -> None:
    src = tmp_path / "a.mp4"
    args = media_tools.plan("convert", [src], tmp_path / "a.webm", {})
    assert args[args.index("-i") + 1] == str(src.resolve())
    assert "-n" in args  # never replaces on its own
    assert media_tools.plan("trim", [src], tmp_path / "t.mp4", {"start": 1, "duration": 0.5})[-1].endswith("t.mp4")


def test_plan_refuses_what_it_should(tmp_path: Path) -> None:
    src = tmp_path / "a.mp4"
    for operation, target, options in [
        ("rm", "x.mp4", {}),
        ("convert", "x.exe", {}),
        ("extract_audio", "x.mp4", {}),
        ("frame", "x.mp3", {}),
        ("frame", "x.png", {"at": "1; rm -rf /"}),
        ("trim", "x.mp4", {"start": "-5"}),
        ("slideshow", "x.gif", {}),
        ("slideshow", "x.mp4", {"seconds_each": 0}),
    ]:
        with pytest.raises(ValueError):
            media_tools.plan(operation, [src], tmp_path / target, options)
    with pytest.raises(ValueError):
        media_tools.plan("convert", [], tmp_path / "x.mp4", {})


def test_missing_ffmpeg_is_said_not_guessed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(media_tools, "_binary", lambda name: None)
    assert media_tools.probe(tmp_path / "a.mp4")["cause"] == "missing-tool"
    assert (
        media_tools.convert("convert", [tmp_path / "a.mp4"], tmp_path / "b.webm", tmp_path, {})["cause"]
        == "missing-tool"
    )


@needs_ffmpeg
def test_probe_convert_and_friends(tmp_path: Path) -> None:
    src = clip(tmp_path)
    info = media_tools.probe(src)
    assert info["ok"] and abs(info["duration_seconds"] - 2) < 0.5
    kinds = {s["type"] for s in info["streams"]}
    assert kinds == {"video", "audio"}
    video = next(s for s in info["streams"] if s["type"] == "video")
    assert (video["width"], video["height"]) == (320, 240)

    out = media_tools.convert("extract_audio", [src], tmp_path / "a.mp3", tmp_path, {})
    assert out["ok"] and media_tools.probe(tmp_path / "a.mp3")["streams"][0]["type"] == "audio"
    frame = media_tools.convert("frame", [src], tmp_path / "f.png", tmp_path, {"at": 1})
    assert frame["ok"] and (tmp_path / "f.png").read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"
    cut = media_tools.convert("trim", [src], tmp_path / "cut.mp4", tmp_path, {"start": 0.5, "duration": 1})
    assert cut["ok"] and media_tools.probe(tmp_path / "cut.mp4")["duration_seconds"] < 1.6
    shutil.copy(tmp_path / "f.png", tmp_path / "g.png")
    show = media_tools.convert(
        "slideshow", [tmp_path / "f.png", tmp_path / "g.png"], tmp_path / "s.mp4", tmp_path, {"seconds_each": 1}
    )
    assert show["ok"], show
    assert 1.5 < media_tools.probe(tmp_path / "s.mp4")["duration_seconds"] < 2.6


@needs_ffmpeg
def test_existing_output_and_non_media_are_refused(tmp_path: Path) -> None:
    src = clip(tmp_path)
    assert media_tools.convert("convert", [src], tmp_path / "o.webm", tmp_path, {})["ok"]
    again = media_tools.convert("convert", [src], tmp_path / "o.webm", tmp_path, {})
    assert not again["ok"] and "overwrite" in again["error"]
    assert media_tools.convert("convert", [src], tmp_path / "o.webm", tmp_path, {}, overwrite=True)["ok"]
    (tmp_path / "x.txt").write_text("hello", encoding="utf-8")
    assert not media_tools.probe(tmp_path / "x.txt")["ok"]
    bad = media_tools.convert("convert", [tmp_path / "x.txt"], tmp_path / "n.mp4", tmp_path, {})
    assert not bad["ok"] and not (tmp_path / "n.mp4").exists()
