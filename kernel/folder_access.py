"""The folder lists the owner can set: readable, writable and kept read-only.

Three settings carry folder paths: ``read_roots`` (extra folders the read tools may open), ``write_roots``
(folders where file tools may write by absolute path) and ``read_only_roots`` (folders that are never written,
even inside the workspace or a writable folder). A path comes from a Settings screen, so it is checked before it
is saved: it must be an absolute path to a folder that exists, never a drive root or the home folder, and the
list is capped. A folder that is later removed or renamed is simply skipped when the lists are read.
"""

from __future__ import annotations

from pathlib import Path

KEYS = ("read_roots", "write_roots", "read_only_roots")
MAX_FOLDERS = 12


def normalise(key: str, value: object) -> list[str]:
    """The cleaned list for ``key``, or a ``ValueError`` saying what is wrong."""
    if key not in KEYS:
        raise ValueError(f"{key} is not a folder list")
    if not isinstance(value, list):
        raise ValueError("give a list of folders")
    out: list[str] = []
    for item in value:
        text = str(item or "").strip()
        if not text:
            continue
        path = Path(text)
        if not path.is_absolute():
            raise ValueError(f"{text} is not a full path")
        resolved = path.resolve()
        if not resolved.is_dir():
            raise ValueError(f"{text} is not a folder that exists")
        if resolved == Path(resolved.anchor) or resolved == Path.home().resolve():
            raise ValueError(
                f"{text} is too broad: pick a project or documents folder, not a drive or your home folder"
            )
        as_text = str(resolved)
        if as_text not in out:
            out.append(as_text)
    if len(out) > MAX_FOLDERS:
        raise ValueError(f"at most {MAX_FOLDERS} folders per list")
    return out
