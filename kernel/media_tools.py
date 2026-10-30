"""Look inside and convert audio, video and images with ffmpeg, never through a shell.

``probe`` reads the facts of a media file with ffprobe. ``convert`` runs one of a small closed set of
operations; every argument is built here from checked values, the input is always an absolute path (so
it can never be read as an option or as a protocol such as ``concat:``), and an existing output is
never replaced unless the caller says so. Without ffmpeg installed both say so instead of guessing.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

from env_guard import child_env

OUT_VIDEO = {"mp4", "webm", "mkv", "mov", "gif"}
OUT_AUDIO = {"mp3", "wav", "m4a", "ogg", "flac", "opus"}
OUT_IMAGE = {"png", "jpg", "jpeg", "webp"}
OPERATIONS = ("convert", "extract_audio", "frame", "trim", "slideshow")
TIMEOUT = 600
_TIME = re.compile(r"^\d{1,5}(\.\d{1,3})?$")


def _binary(name: str) -> str | None:
    return shutil.which(name)


def missing_tool() -> dict:
    return {
        "ok": False,
        "error": "ffmpeg is not installed: add it from the Install Manager (agent toolkit)",
        "cause": "missing-tool",
    }


def probe(path: Path) -> dict:
    ffprobe = _binary("ffprobe")
    if not ffprobe:
        return missing_tool()
    if not path.is_file():
        return {"ok": False, "error": f"{path.name} is not a file"}
    run = subprocess.run(  # noqa: S603 - argv form, absolute input path
        [ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path.resolve())],
        capture_output=True,
        text=True,
        timeout=60,
        env=child_env(),
        check=False,
    )
    if run.returncode != 0:
        return {"ok": False, "error": f"{path.name} is not media FRIDAY can read", "detail": run.stderr.strip()[:300]}
    try:
        data = json.loads(run.stdout)
    except ValueError:
        return {"ok": False, "error": "ffprobe gave an answer FRIDAY cannot read"}
    fmt = data.get("format", {})
    streams = []
    for stream in data.get("streams", []):
        row = {"type": stream.get("codec_type"), "codec": stream.get("codec_name")}
        if stream.get("codec_type") == "video":
            row.update(width=stream.get("width"), height=stream.get("height"), fps=_fps(stream.get("avg_frame_rate")))
        if stream.get("codec_type") == "audio":
            row.update(channels=stream.get("channels"), sample_rate=stream.get("sample_rate"))
        streams.append(row)
    return {
        "ok": True,
        "format": fmt.get("format_name"),
        "duration_seconds": _number(fmt.get("duration")),
        "bytes": _number(fmt.get("size")),
        "bit_rate": _number(fmt.get("bit_rate")),
        "streams": streams,
    }


def _number(value: object) -> float | None:
    try:
        return round(float(value), 3)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _fps(raw: object) -> float | None:
    try:
        top, bottom = str(raw).split("/")
        return round(int(top) / int(bottom), 3) if int(bottom) else None
    except ValueError:
        return None


def _time(value: object, label: str) -> str:
    text = str(value if value is not None else "0")
    if not _TIME.match(text):
        raise ValueError(f"{label} must be a number of seconds")
    return text


def plan(operation: str, sources: list[Path], target: Path, options: dict) -> list[str]:
    """The ffmpeg arguments (after the binary) for one operation. Raises ValueError for a bad request."""
    if operation not in OPERATIONS:
        raise ValueError(f"operation must be one of: {', '.join(OPERATIONS)}")
    if not sources:
        raise ValueError("name at least one input file")
    ext = target.suffix.lstrip(".").lower()
    base = ["-nostdin", "-hide_banner", "-loglevel", "error", "-n"]
    first = str(sources[0].resolve())
    if operation == "convert":
        if ext not in OUT_VIDEO | OUT_AUDIO | OUT_IMAGE:
            raise ValueError(f"cannot write a .{ext} file")
        return [*base, "-i", first, str(target)]
    if operation == "extract_audio":
        if ext not in OUT_AUDIO:
            raise ValueError(f"audio output must be one of: {', '.join(sorted(OUT_AUDIO))}")
        return [*base, "-i", first, "-vn", str(target)]
    if operation == "frame":
        if ext not in OUT_IMAGE:
            raise ValueError(f"a frame must be saved as one of: {', '.join(sorted(OUT_IMAGE))}")
        return [*base, "-ss", _time(options.get("at"), "at"), "-i", first, "-frames:v", "1", str(target)]
    if operation == "trim":
        if ext not in OUT_VIDEO | OUT_AUDIO:
            raise ValueError(f"cannot write a .{ext} file")
        args = [*base, "-ss", _time(options.get("start"), "start"), "-i", first]
        if options.get("duration") is not None:
            args += ["-t", _time(options.get("duration"), "duration")]
        return [*args, str(target)]
    # slideshow: the images, in order, one after another, as a silent video (or with the first audio file)
    if ext not in {"mp4", "webm", "mkv", "mov"}:
        raise ValueError("a slideshow is saved as mp4, webm, mkv or mov")
    seconds = _time(options.get("seconds_each", 3), "seconds_each")
    if float(seconds) <= 0 or len(sources) > 200:
        raise ValueError("seconds_each must be above 0 and there can be at most 200 images")
    args = list(base)
    for image in sources:
        args += ["-loop", "1", "-t", seconds, "-i", str(image.resolve())]
    chain = "".join(
        f"[{n}:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1[v{n}];"
        for n in range(len(sources))
    )
    joined = "".join(f"[v{n}]" for n in range(len(sources)))
    return [
        *args,
        "-filter_complex",
        f"{chain}{joined}concat=n={len(sources)}:v=1:a=0[out]",
        "-map",
        "[out]",
        "-pix_fmt",
        "yuv420p",
        str(target),
    ]


def convert(
    operation: str, sources: list[Path], target: Path, root: Path, options: dict, overwrite: bool = False
) -> dict:
    ffmpeg = _binary("ffmpeg")
    if not ffmpeg:
        return missing_tool()
    for source in sources:
        if not source.is_file():
            return {"ok": False, "error": f"{source.name} is not a file"}
    try:
        args = plan(operation, sources, target, options)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    if target.exists():
        if not overwrite:
            return {"ok": False, "error": f"{target.name} already exists; say overwrite to replace it"}
        target.unlink()
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        run = subprocess.run(  # noqa: S603 - argv form, every value was checked in plan()
            [ffmpeg, *args], capture_output=True, text=True, timeout=TIMEOUT, env=child_env(), check=False
        )
    except subprocess.TimeoutExpired:
        target.unlink(missing_ok=True)
        return {"ok": False, "error": f"ffmpeg did not finish within {TIMEOUT} seconds", "cause": "timeout"}
    if run.returncode != 0 or not target.is_file() or target.stat().st_size == 0:
        target.unlink(missing_ok=True)
        return {"ok": False, "error": "ffmpeg could not make that file", "detail": run.stderr.strip()[-400:]}
    return {
        "ok": True,
        "operation": operation,
        "path": target.relative_to(root).as_posix() if root in target.parents else target.name,
        "bytes": target.stat().st_size,
    }


def sample_frames(source: Path, folder: Path, root: Path, count: int = 6, overwrite: bool = False) -> dict:
    """Save up to ``count`` still pictures spread evenly through a video, so a vision model can look at them."""
    ffmpeg = _binary("ffmpeg")
    if not ffmpeg:
        return missing_tool()
    if not source.is_file():
        return {"ok": False, "error": f"{source.name} is not a file"}
    count = max(1, min(int(count), 12))
    info = probe(source)
    if not info.get("ok"):
        return info
    length = info.get("duration_seconds") or 0
    if not any(s.get("type") == "video" for s in info.get("streams", [])):
        return {"ok": False, "error": f"{source.name} has no picture to sample"}
    folder.mkdir(parents=True, exist_ok=True)
    saved: list[str] = []
    for n in range(count):
        # Stay a little inside the end: a seek past the last decoded picture gives no frame at all.
        at = 0 if count == 1 or not length else round(min(length * (n + 0.5) / count, max(length - 0.2, 0)), 3)
        target = folder / f"{source.stem}-frame{n + 1:02d}.png"
        out = convert("frame", [source], target, root, {"at": at}, overwrite=overwrite)
        if not out.get("ok"):
            if saved and "already exists" not in str(out.get("error")):
                break
            return out
        saved.append(out["path"])
    return {"ok": True, "frames": saved, "duration_seconds": length}
