"""The utterance stash keeps a rolling window of the newest five raw/denoised pairs."""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import pytest

np = pytest.importorskip("numpy")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import stt  # noqa: E402


def _stash(folder: Path, count: int) -> None:
    for i in range(count):
        audio = np.full(160, 0.01 * (i + 1), dtype=np.float32)
        stt._stash_utterance_wavs(folder, audio, audio)


def _stamps(folder: Path) -> list[str]:
    return sorted({p.name.split("-")[0] for p in folder.glob("*.wav")})


def test_nine_utterances_leave_the_newest_five_pairs():
    with tempfile.TemporaryDirectory() as tmp:
        folder = Path(tmp) / "utterances"
        _stash(folder, 9)
        names = sorted(p.name for p in folder.glob("*.wav"))
        assert len(names) == 10
        assert _stamps(folder) == ["00004", "00005", "00006", "00007", "00008"]
        for stamp in _stamps(folder):
            assert (folder / f"{stamp}-raw.wav").is_file() and (folder / f"{stamp}-denoised.wav").is_file()


def test_the_newest_utterance_is_never_overwritten_by_the_next_one():
    with tempfile.TemporaryDirectory() as tmp:
        folder = Path(tmp) / "utterances"
        _stash(folder, 7)
        before = (folder / "00006-raw.wav").read_bytes()
        _stash(folder, 1)
        assert (folder / "00006-raw.wav").read_bytes() == before
        assert (folder / "00007-raw.wav").is_file()


def test_numbering_continues_after_old_files_are_trimmed_and_ignores_stray_names():
    with tempfile.TemporaryDirectory() as tmp:
        folder = Path(tmp) / "utterances"
        folder.mkdir()
        (folder / "notes.wav").write_bytes(b"x")
        _stash(folder, 1)
        assert (folder / "00000-raw.wav").is_file()
        (folder / "00041-raw.wav").write_bytes(b"x")
        _stash(folder, 1)
        assert (folder / "00042-raw.wav").is_file()
