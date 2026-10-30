"""File and archive abilities for the tool registry.

Every function takes already-resolved, workspace-contained paths (the registry
resolves them) and returns a plain dict. Nothing here reaches the network or
runs a program. Archives are unpacked member by member so a hostile name
(`../x`, an absolute path, a drive letter), a link, a device node, or a bomb
(too many members, too many bytes) is refused before anything is written.
"""

from __future__ import annotations

import bz2
import csv
import fnmatch
import gzip
import io
import json
import lzma
import re
import shutil
import tarfile
import time
import zipfile
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree as ET

MAX_MEMBERS = 20_000
MAX_UNPACKED_BYTES = 2 * 1024**3
MAX_TEXT_BYTES = 2 * 1024**2
LIST_LIMIT = 2_000
FIND_LIMIT = 200
TRASH = ".friday-trash"
HIDDEN = {TRASH, ".friday-sandbox"}

# Folders and file names that hold credentials. A read tool never opens these,
# whatever root it was pointed at: the model sees tool output as data and a
# cloud model may be the one asking.
SENSITIVE_FOLDERS = {".ssh", ".gnupg", ".aws", ".azure", ".kube"}
SENSITIVE_NAMES = (
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "*.pfx",
    "*.p12",
    "*.kdbx",
    "*.keystore",
    "*.token",
    "id_rsa*",
    "id_ed25519*",
    "id_ecdsa*",
    "credentials",
    "credentials.*",
    "secrets.*",
    "provider-keys*",
)


def is_sensitive(path: Path) -> bool:
    """True for a credential folder or file name; the content is never read."""
    if SENSITIVE_FOLDERS & {part.lower() for part in path.parts}:
        return True
    name = path.name.lower()
    return any(fnmatch.fnmatch(name, pattern) for pattern in SENSITIVE_NAMES)


ZIP_EXT = {".zip", ".jar", ".apk", ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp", ".epub", ".whl", ".nupkg"}
TAR_MODES = {
    ".tar": "",
    ".tar.gz": "gz",
    ".tgz": "gz",
    ".tar.bz2": "bz2",
    ".tbz2": "bz2",
    ".tar.xz": "xz",
    ".txz": "xz",
}
SINGLE = {".gz": gzip.open, ".bz2": bz2.open, ".xz": lzma.open}

# (magic bytes at offset 0, kind, mime)
MAGIC: list[tuple[bytes, str, str]] = [
    (b"\x89PNG\r\n\x1a\n", "png", "image/png"),
    (b"\xff\xd8\xff", "jpeg", "image/jpeg"),
    (b"GIF87a", "gif", "image/gif"),
    (b"GIF89a", "gif", "image/gif"),
    (b"%PDF-", "pdf", "application/pdf"),
    (b"PK\x03\x04", "zip", "application/zip"),
    (b"PK\x05\x06", "zip", "application/zip"),
    (b"7z\xbc\xaf\x27\x1c", "7z", "application/x-7z-compressed"),
    (b"Rar!\x1a\x07", "rar", "application/vnd.rar"),
    (b"\x1f\x8b", "gzip", "application/gzip"),
    (b"BZh", "bzip2", "application/x-bzip2"),
    (b"\xfd7zXZ\x00", "xz", "application/x-xz"),
    (b"SQLite format 3\x00", "sqlite", "application/vnd.sqlite3"),
    (b"MZ", "windows-executable", "application/vnd.microsoft.portable-executable"),
    (b"\x7fELF", "elf-executable", "application/x-elf"),
    (b"OggS", "ogg", "audio/ogg"),
    (b"fLaC", "flac", "audio/flac"),
    (b"ID3", "mp3", "audio/mpeg"),
    (b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", "ole-document", "application/x-ole-storage"),
]

OFFICE = {
    "word/document.xml": ("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    "xl/workbook.xml": ("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    "ppt/presentation.xml": ("pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
}


class ArchiveRefused(ValueError):
    """The archive would write outside the destination or is too large."""


# --------------------------------------------------------------- identify


def identify(path: Path) -> dict:
    if not path.exists():
        return {"ok": False, "error": f"{path.name} does not exist"}
    if path.is_dir():
        return {"ok": True, "kind": "folder", "mime": "inode/directory", "text": False}
    with path.open("rb") as handle:
        head = handle.read(4096)
    size = path.stat().st_size
    kind, mime = "", ""
    for magic, name, content_type in MAGIC:
        if head.startswith(magic):
            kind, mime = name, content_type
            break
    if not kind and head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        kind, mime = "wav", "audio/wav"
    if not kind and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        kind, mime = "webp", "image/webp"
    if not kind and head[4:8] == b"ftyp":
        kind, mime = "mp4", "video/mp4"
    if not kind and len(head) > 262 and head[257:262] == b"ustar":
        kind, mime = "tar", "application/x-tar"
    if kind == "zip":
        kind, mime = _zip_flavour(path, kind, mime)
    if kind:
        return {"ok": True, "kind": kind, "mime": mime, "text": False, "bytes": size}
    text_kind = _text_kind(head, path.suffix.lower())
    if text_kind:
        return {"ok": True, "kind": text_kind[0], "mime": text_kind[1], "text": True, "bytes": size}
    return {"ok": True, "kind": "binary", "mime": "application/octet-stream", "text": False, "bytes": size}


def _zip_flavour(path: Path, kind: str, mime: str) -> tuple[str, str]:
    try:
        with zipfile.ZipFile(path) as archive:
            names = set(archive.namelist())
    except (zipfile.BadZipFile, OSError):
        return kind, mime
    for marker, flavour in OFFICE.items():
        if marker in names:
            return flavour
    if "META-INF/MANIFEST.MF" in names:
        return "jar", "application/java-archive"
    return kind, mime


def _text_kind(head: bytes, suffix: str) -> tuple[str, str] | None:
    if b"\x00" in head:
        return None
    try:
        sample = head.decode("utf-8")
    except UnicodeDecodeError:
        try:
            sample = head.decode("utf-16") if head[:2] in (b"\xff\xfe", b"\xfe\xff") else head.decode("cp1252")
        except UnicodeDecodeError:
            return None
    stripped = sample.lstrip()
    by_suffix = {
        ".json": ("json", "application/json"),
        ".csv": ("csv", "text/csv"),
        ".md": ("markdown", "text/markdown"),
        ".html": ("html", "text/html"),
        ".htm": ("html", "text/html"),
        ".xml": ("xml", "application/xml"),
        ".yaml": ("yaml", "application/yaml"),
        ".yml": ("yaml", "application/yaml"),
        ".py": ("python", "text/x-python"),
        ".js": ("javascript", "text/javascript"),
        ".ts": ("typescript", "text/typescript"),
    }
    if suffix in by_suffix:
        return by_suffix[suffix]
    if stripped.startswith("<?xml"):
        return "xml", "application/xml"
    if stripped[:15].lower().startswith(("<!doctype html", "<html")):
        return "html", "text/html"
    if stripped[:1] in "{[":
        return "json", "application/json"
    return "text", "text/plain"


# ------------------------------------------------------------------ list / info / find


def info(path: Path) -> dict:
    if not path.exists():
        return {"ok": False, "error": f"{path.name} does not exist"}
    stat = path.stat()
    out = {
        "ok": True,
        "name": path.name,
        "isDir": path.is_dir(),
        "bytes": stat.st_size if path.is_file() else _tree_bytes(path),
        "modified": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(stat.st_mtime)),
    }
    if path.is_file():
        out["kind"] = identify(path).get("kind")
    return out


def _tree_bytes(path: Path) -> int:
    total = 0
    for item in path.rglob("*"):
        if item.is_file() and not item.is_symlink():
            total += item.stat().st_size
    return total


def list_dir(path: Path, root: Path, depth: int = 1) -> dict:
    if not path.is_dir():
        return {"ok": False, "error": f"{path.name} is not a folder"}
    rows: list[dict] = []
    limit = max(1, min(int(depth), 6))

    def walk(folder: Path, level: int) -> None:
        for item in sorted(folder.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
            if len(rows) >= LIST_LIMIT:
                return
            if item.name in HIDDEN or item.is_symlink():
                continue
            rows.append(
                {
                    "path": item.relative_to(root).as_posix(),
                    "isDir": item.is_dir(),
                    "bytes": 0 if item.is_dir() else item.stat().st_size,
                }
            )
            if item.is_dir() and level < limit:
                walk(item, level + 1)

    walk(path, 1)
    return {"ok": True, "entries": rows, "truncated": len(rows) >= LIST_LIMIT}


def find(path: Path, root: Path, pattern: str = "*", contains: str = "") -> dict:
    """Names matching a glob, and (when asked) files whose text holds a phrase."""
    if not path.is_dir():
        return {"ok": False, "error": f"{path.name} is not a folder"}
    needle = contains.lower()
    hits: list[dict] = []
    for item in path.rglob("*"):
        if len(hits) >= FIND_LIMIT:
            break
        if not item.is_file() or item.is_symlink() or HIDDEN & set(item.parts):
            continue
        if not fnmatch.fnmatch(item.name.lower(), pattern.lower()):
            continue
        row = {"path": item.relative_to(root).as_posix(), "bytes": item.stat().st_size}
        if needle:
            if item.stat().st_size > MAX_TEXT_BYTES or is_sensitive(item):
                continue
            try:
                text = item.read_text(encoding="utf-8", errors="ignore").lower()
            except OSError:
                continue
            at = text.find(needle)
            if at < 0:
                continue
            row["line"] = text.count("\n", 0, at) + 1
        hits.append(row)
    return {"ok": True, "matches": hits, "truncated": len(hits) >= FIND_LIMIT}


# ---------------------------------------------------------------- copy / move / delete


def make_dir(path: Path) -> dict:
    path.mkdir(parents=True, exist_ok=True)
    return {"ok": True}


def copy(source: Path, target: Path, overwrite: bool = False) -> dict:
    if not source.exists():
        return {"ok": False, "error": f"{source.name} does not exist"}
    if target.exists() and not overwrite:
        return {"ok": False, "error": f"{target.name} already exists"}
    target.parent.mkdir(parents=True, exist_ok=True)
    if source.is_dir():
        shutil.copytree(source, target, dirs_exist_ok=overwrite, symlinks=False)
    else:
        shutil.copy2(source, target)
    return {"ok": True}


def move(source: Path, target: Path, overwrite: bool = False) -> dict:
    if not source.exists():
        return {"ok": False, "error": f"{source.name} does not exist"}
    if target.exists() and not overwrite:
        return {"ok": False, "error": f"{target.name} already exists"}
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(source), str(target))
    return {"ok": True}


def trash(path: Path, root: Path) -> dict:
    """Delete means move into <workspace>/.friday-trash, so it can be put back."""
    if not path.exists():
        return {"ok": False, "error": f"{path.name} does not exist"}
    if path == root:
        return {"ok": False, "error": "the workspace root is not deleted"}
    bin_dir = root / TRASH
    bin_dir.mkdir(exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    target = bin_dir / f"{stamp}-{path.name}"
    counter = 1
    while target.exists():
        counter += 1
        target = bin_dir / f"{stamp}-{counter}-{path.name}"
    shutil.move(str(path), str(target))
    return {"ok": True, "trashedTo": target.relative_to(root).as_posix()}


# ------------------------------------------------------------------- archives


def archive_kind(path: Path) -> str:
    name = path.name.lower()
    for ext in sorted(TAR_MODES, key=len, reverse=True):
        if name.endswith(ext):
            return "tar"
    if path.suffix.lower() in ZIP_EXT:
        return "zip"
    if path.suffix.lower() == ".7z":
        return "7z"
    if path.suffix.lower() in SINGLE:
        return "single"
    if path.suffix.lower() == ".rar":
        return "rar"
    return "unknown"


def _safe_member(name: str) -> PurePosixPath:
    clean = name.replace("\\", "/")
    member = PurePosixPath(clean)
    if not clean or member.is_absolute() or re.match(r"^[A-Za-z]:", clean) or ".." in member.parts or "\x00" in clean:
        raise ArchiveRefused(f"unsafe name in archive: {name!r}")
    return member


def list_archive(path: Path) -> dict:
    kind = archive_kind(path)
    members: list[dict] = []
    if kind == "zip":
        with zipfile.ZipFile(path) as archive:
            for item in archive.infolist():
                members.append({"name": item.filename, "bytes": item.file_size, "isDir": item.is_dir()})
    elif kind == "tar":
        with tarfile.open(path) as archive:
            for item in archive.getmembers():
                members.append({"name": item.name, "bytes": item.size, "isDir": item.isdir()})
    elif kind == "7z":
        py7zr = _py7zr()
        if isinstance(py7zr, dict):
            return py7zr
        with py7zr.SevenZipFile(path) as archive:
            for item in archive.list():
                members.append({"name": item.filename, "bytes": item.uncompressed or 0, "isDir": item.is_directory})
    elif kind == "single":
        members.append({"name": path.stem, "bytes": 0, "isDir": False})
    elif kind == "rar":
        return {"ok": False, "error": "RAR is read-only in FRIDAY: install it from the Install Manager (rarfile)"}
    else:
        return {"ok": False, "error": f"{path.name} is not a supported archive"}
    return {
        "ok": True,
        "format": kind,
        "count": len(members),
        "bytes": sum(row["bytes"] for row in members),
        "members": members[:LIST_LIMIT],
        "truncated": len(members) > LIST_LIMIT,
    }


def _py7zr():
    try:
        import py7zr  # type: ignore[import-not-found]
    except ImportError:
        return {"ok": False, "error": "7z needs py7zr: install it from the Install Manager"}
    return py7zr


def _guard_totals(count: int, total: int) -> None:
    if count > MAX_MEMBERS:
        raise ArchiveRefused(f"archive has {count} entries (limit {MAX_MEMBERS})")
    if total > MAX_UNPACKED_BYTES:
        raise ArchiveRefused(f"archive unpacks to {total} bytes (limit {MAX_UNPACKED_BYTES})")


def extract_archive(path: Path, dest: Path, overwrite: bool = False) -> dict:
    kind = archive_kind(path)
    dest.mkdir(parents=True, exist_ok=True)
    base = dest.resolve()
    written: list[str] = []

    def target_for(name: str) -> Path:
        member = _safe_member(name)
        target = (base / Path(*member.parts)).resolve()
        if target != base and base not in target.parents:
            raise ArchiveRefused(f"unsafe name in archive: {name!r}")
        if target.exists() and target.is_file() and not overwrite:
            raise ArchiveRefused(f"{member.as_posix()} already exists (pass overwrite to replace it)")
        return target

    try:
        if kind == "zip":
            with zipfile.ZipFile(path) as archive:
                items = archive.infolist()
                _guard_totals(len(items), sum(i.file_size for i in items))
                # Check every name before the first byte is written, so a bad member leaves nothing behind.
                for item in items:
                    if ((item.external_attr >> 16) & 0o170000) == 0o120000:
                        raise ArchiveRefused(f"{item.filename!r} is a link; links are not unpacked")
                    target_for(item.filename)
                for item in items:
                    target = target_for(item.filename)
                    if item.is_dir():
                        target.mkdir(parents=True, exist_ok=True)
                        continue
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(item) as source, target.open("wb") as out:
                        shutil.copyfileobj(source, out)
                    written.append(target.relative_to(base).as_posix())
        elif kind == "tar":
            with tarfile.open(path) as archive:
                items = archive.getmembers()
                _guard_totals(len(items), sum(i.size for i in items))
                for item in items:
                    if item.issym() or item.islnk() or item.isdev() or item.isfifo():
                        raise ArchiveRefused(f"{item.name!r} is not a plain file or folder")
                    target_for(item.name)
                for item in items:
                    target = target_for(item.name)
                    if item.isdir():
                        target.mkdir(parents=True, exist_ok=True)
                        continue
                    target.parent.mkdir(parents=True, exist_ok=True)
                    source = archive.extractfile(item)
                    if source is None:
                        continue
                    with source, target.open("wb") as out:
                        shutil.copyfileobj(source, out)
                    written.append(target.relative_to(base).as_posix())
        elif kind == "single":
            target = target_for(path.stem)
            opener = SINGLE[path.suffix.lower()]
            total = 0
            with opener(path, "rb") as source, target.open("wb") as out:
                while chunk := source.read(1024 * 1024):
                    total += len(chunk)
                    _guard_totals(1, total)
                    out.write(chunk)
            written.append(target.relative_to(base).as_posix())
        elif kind == "7z":
            py7zr = _py7zr()
            if isinstance(py7zr, dict):
                return py7zr
            with py7zr.SevenZipFile(path) as archive:
                entries = archive.list()
                _guard_totals(len(entries), sum((e.uncompressed or 0) for e in entries))
                for entry in entries:
                    target_for(entry.filename)
                archive.extractall(path=base)  # noqa: S202 - every name was checked by target_for above
                written.extend(entry.filename for entry in entries if not entry.is_directory)
        elif kind == "rar":
            return {"ok": False, "error": "RAR is read-only in FRIDAY: install it from the Install Manager (rarfile)"}
        else:
            return {"ok": False, "error": f"{path.name} is not a supported archive"}
    except ArchiveRefused as exc:
        return {"ok": False, "error": str(exc), "cause": "refused"}
    except (zipfile.BadZipFile, tarfile.TarError, OSError, EOFError, RuntimeError) as exc:
        return {"ok": False, "error": f"{path.name} could not be read: {exc}", "cause": "corrupt"}
    return {"ok": True, "format": kind, "files": len(written), "extracted": written[:LIST_LIMIT]}


def create_archive(sources: list[Path], target: Path, root: Path, overwrite: bool = False) -> dict:
    kind = archive_kind(target)
    if kind not in {"zip", "tar", "single"}:
        return {"ok": False, "error": "create a .zip, .tar, .tar.gz, .tar.bz2 or .tar.xz"}
    if target.exists() and not overwrite:
        return {"ok": False, "error": f"{target.name} already exists"}
    files: list[tuple[Path, str]] = []
    for source in sources:
        if not source.exists():
            return {"ok": False, "error": f"{source.name} does not exist"}
        if source.is_dir():
            for item in sorted(source.rglob("*")):
                if item.is_file() and not item.is_symlink() and not HIDDEN & set(item.parts) and item != target:
                    files.append((item, (Path(source.name) / item.relative_to(source)).as_posix()))
        elif source != target:
            files.append((source, source.name))
    if not files:
        return {"ok": False, "error": "there is nothing to put in the archive"}
    total = sum(item.stat().st_size for item, _ in files)
    try:
        _guard_totals(len(files), total)
    except ArchiveRefused as exc:
        return {"ok": False, "error": str(exc), "cause": "refused"}
    target.parent.mkdir(parents=True, exist_ok=True)
    if kind == "single":
        return {"ok": False, "error": "a single-file .gz, .bz2 or .xz holds one file; use .tar.gz for several"}
    if kind == "zip":
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
            for item, name in files:
                archive.write(item, name)
    else:
        compression = next((m for ext, m in TAR_MODES.items() if target.name.lower().endswith(ext)), "")
        with tarfile.open(target, f"w:{compression}" if compression else "w") as archive:  # type: ignore[call-overload]
            for item, name in files:
                archive.add(item, arcname=name, recursive=False)
    return {
        "ok": True,
        "format": kind,
        "files": len(files),
        "bytes": total,
        "archive": target.relative_to(root).as_posix(),
    }


# ------------------------------------------------------------- read any file


def extract_text(path: Path, max_chars: int = 200_000) -> dict:
    """The words in a document, as data. PDF uses PyMuPDF when it is installed."""
    meta = identify(path)
    if not meta.get("ok"):
        return meta
    kind = meta["kind"]
    try:
        if kind == "docx":
            text = _docx_text(path)
        elif kind == "xlsx":
            text = _xlsx_text(path)
        elif kind == "pptx":
            text = _pptx_text(path)
        elif kind == "pdf":
            text = _pdf_text(path)
            if isinstance(text, dict):
                return text
        elif kind == "csv":
            text = _csv_text(path)
        elif meta.get("text"):
            if path.stat().st_size > 50 * 1024**2:
                return {"ok": False, "error": "the file is larger than 50 MB"}
            text = path.read_text(encoding="utf-8", errors="replace")
            if kind == "json":
                try:
                    text = json.dumps(json.loads(text), indent=2, ensure_ascii=False)
                except ValueError:
                    pass
        else:
            return {"ok": False, "error": f"{kind} is not a document FRIDAY can read as text", "kind": kind}
    except (zipfile.BadZipFile, ET.ParseError, OSError, KeyError) as exc:
        return {"ok": False, "error": f"{path.name} could not be read: {exc}", "kind": kind}
    clipped = len(text) > max_chars
    return {"ok": True, "kind": kind, "text": text[:max_chars], "truncated": clipped}


def _xml_words(data: bytes, tag: str) -> list[str]:
    root = ET.fromstring(data)  # noqa: S314 - Office parts inside an archive FRIDAY already size-checked
    return [node.text or "" for node in root.iter() if node.tag.rsplit("}", 1)[-1] == tag]


def _docx_text(path: Path) -> str:
    with zipfile.ZipFile(path) as archive:
        root = ET.fromstring(archive.read("word/document.xml"))  # noqa: S314
    paragraphs = []
    for para in root.iter():
        if para.tag.rsplit("}", 1)[-1] == "p":
            paragraphs.append("".join(n.text or "" for n in para.iter() if n.tag.rsplit("}", 1)[-1] == "t"))
    return "\n".join(paragraphs)


def _xlsx_text(path: Path) -> str:
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        shared = _xml_words(archive.read("xl/sharedStrings.xml"), "t") if "xl/sharedStrings.xml" in names else []
        out = []
        for name in sorted(n for n in names if re.match(r"xl/worksheets/sheet\d+\.xml$", n)):
            out.append(f"# {name.rsplit('/', 1)[-1]}")
            root = ET.fromstring(archive.read(name))  # noqa: S314
            for row in root.iter():
                if row.tag.rsplit("}", 1)[-1] != "row":
                    continue
                cells = []
                for cell in row:
                    value = ""
                    for part in cell:
                        if part.tag.rsplit("}", 1)[-1] == "v":
                            value = part.text or ""
                    if cell.get("t") == "s" and value.isdigit() and int(value) < len(shared):
                        value = shared[int(value)]
                    cells.append(value)
                out.append("\t".join(cells))
    return "\n".join(out)


def _pptx_text(path: Path) -> str:
    with zipfile.ZipFile(path) as archive:
        slides = sorted(
            (n for n in archive.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)),
            key=lambda n: int(re.findall(r"\d+", n)[-1]),
        )
        return "\n\n".join(
            f"# slide {i}\n" + "\n".join(_xml_words(archive.read(name), "t")) for i, name in enumerate(slides, 1)
        )


def _pdf_text(path: Path):
    try:
        import pymupdf  # type: ignore[import-not-found]
    except ImportError:
        try:
            import fitz as pymupdf  # type: ignore[import-not-found,no-redef]
        except ImportError:
            return {"ok": False, "error": "PDF reading needs PyMuPDF: install it from the Install Manager"}
    with pymupdf.open(path) as document:
        return "\n\n".join(page.get_text() for page in document)


def _csv_text(path: Path) -> str:
    raw = path.read_text(encoding="utf-8", errors="replace")
    rows = csv.reader(io.StringIO(raw))
    return "\n".join("\t".join(row) for row in rows)
