"""FRIDAY · code map (read-only).

A ranked, token-budgeted map of a code folder: the symbols each file defines, which files use
which, and what a change to one file would reach. It works offline, on code that does not compile,
and for any language the registry (``code_languages.json``) names; a file in a language it does
not know is counted and listed, never guessed at.

Python is read with ``ast``. Everything else uses the line patterns in the registry, which is an
outline and not a parse: the answer says which kind of reading each language got. Nothing here
runs, imports or executes the code it looks at, never follows a link, and never opens a
credential file.
"""

from __future__ import annotations

import ast
import json
import math
import re
from collections import Counter, defaultdict, deque
from pathlib import Path

import file_tools

REGISTRY_FILE = Path(__file__).with_name("code_languages.json")
MAX_FILE_BYTES = 1_000_000
MAX_FILES = 3_000
MAX_SYMBOLS_PER_FILE = 400
SKIP_DIRS = {
    ".git",
    "node_modules",
    "venv",
    ".venv",
    "__pycache__",
    "dist",
    "build",
    "target",
    ".next",
    ".turbo",
    ".cache",
    "bin",
    "obj",
    ".idea",
    ".vs",
    "release",
    ".friday-trash",
    ".friday-sandbox",
}
IDENT = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]{2,}")
# A name defined in many files ("main", "init") says nothing about who uses which file.
COMMON_LIMIT = 3
STOP = {"self", "this", "None", "True", "False", "null", "undefined", "return", "const", "else", "from", "import"}
DAMPING = 0.85


class _Language:
    """One registry entry with its patterns compiled once."""

    def __init__(self, raw: dict) -> None:
        self.id: str = raw["id"]
        self.name: str = raw["name"]
        self.support: str = raw.get("support", "outline")
        self.graph: bool = bool(raw.get("graph", True))
        self.comment: tuple[str, ...] = tuple(raw.get("comment", ()))
        self.symbols = [(row["kind"], re.compile(row["pattern"])) for row in raw.get("symbols", ())]
        self.imports = [re.compile(pattern) for pattern in raw.get("imports", ())]
        self.extensions = {ext.lower() for ext in raw.get("extensions", ())}
        self.filenames = set(raw.get("filenames", ()))


class Registry:
    def __init__(self, languages: list[_Language]) -> None:
        self.languages = languages
        self._by_ext = {ext: lang for lang in languages for ext in lang.extensions}
        self._by_name = {name: lang for lang in languages for name in lang.filenames}

    def for_path(self, path: Path) -> _Language | None:
        return self._by_name.get(path.name) or self._by_ext.get(path.suffix.lower())


_cached: Registry | None = None


def load_registry(path: Path | None = None) -> Registry:
    """The language registry. A bad pattern in one entry drops that entry, not the whole map."""
    global _cached
    if path is None and _cached is not None:
        return _cached
    data = json.loads((path or REGISTRY_FILE).read_text(encoding="utf-8"))
    languages: list[_Language] = []
    for raw in data.get("languages", ()):
        try:
            languages.append(_Language(raw))
        except (KeyError, re.error):
            continue
    registry = Registry(languages)
    if path is None:
        _cached = registry
    return registry


# ------------------------------------------------------------------ reading a file


def _python_symbols(text: str) -> list[dict] | None:
    """Classes, functions and methods through ``ast``; None when the file does not parse."""
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError):
        return None
    rows: list[dict] = []

    def visit(node: ast.AST, scope: str) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.ClassDef):
                rows.append({"kind": "class", "name": child.name, "line": child.lineno})
                visit(child, child.name)
            elif isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                kind = "method" if scope else "def"
                rows.append({"kind": kind, "name": child.name, "line": child.lineno})
                visit(child, "")
            else:
                visit(child, scope)

    visit(tree, "")
    return rows


def _pattern_symbols(lang: _Language, lines: list[str]) -> list[dict]:
    rows: list[dict] = []
    for number, line in enumerate(lines, 1):
        stripped = line.lstrip()
        if lang.comment and any(stripped.startswith(marker) for marker in lang.comment):
            continue
        for kind, pattern in lang.symbols:
            match = pattern.search(line)
            if match:
                rows.append({"kind": kind, "name": match.group(1).strip(), "line": number})
                break
        if len(rows) >= MAX_SYMBOLS_PER_FILE:
            break
    return rows


def _imports(lang: _Language, lines: list[str]) -> list[str]:
    found: list[str] = []
    for line in lines:
        for pattern in lang.imports:
            match = pattern.search(line)
            if match:
                found.append(match.group(1))
    return sorted(set(found))[:100]


def read_file(path: Path, lang: _Language, relative: str) -> dict:
    """Symbols and imports of one file. ``reading`` says how the file was understood."""
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    symbols: list[dict] | None = None
    reading = "outline"
    partial = False
    if lang.id == "python":
        symbols = _python_symbols(text)
        if symbols is not None:
            reading = "parsed"
        else:
            partial = True  # a half-written file: fall back to patterns and say so
    if symbols is None:
        symbols = _pattern_symbols(lang, lines)
    return {
        "path": relative,
        "language": lang.name,
        "languageId": lang.id,
        "reading": reading,
        "partial": partial,
        "lines": len(lines),
        "symbols": symbols[:MAX_SYMBOLS_PER_FILE],
        "imports": _imports(lang, lines),
        "tokens": Counter(IDENT.findall(text)) if lang.graph else Counter(),
        "graph": lang.graph,
    }


# --------------------------------------------------------------------- the folder


def _walk(root: Path) -> tuple[list[Path], dict[str, int], bool]:
    files: list[Path] = []
    skipped: Counter[str] = Counter()
    truncated = False
    stack = [root]
    while stack:
        folder = stack.pop()
        try:
            entries = sorted(folder.iterdir(), key=lambda item: item.name.lower())
        except OSError:
            skipped["unreadable folder"] += 1
            continue
        for item in entries:
            if item.is_symlink():
                skipped["link"] += 1
            elif item.is_dir():
                if item.name in SKIP_DIRS:
                    skipped["skipped folder"] += 1
                else:
                    stack.append(item)
            elif item.is_file():
                if file_tools.is_sensitive(item):
                    skipped["credential file"] += 1
                elif len(files) >= MAX_FILES:
                    truncated = True
                else:
                    files.append(item)
    return files, dict(skipped), truncated


def _looks_binary(path: Path) -> bool:
    with path.open("rb") as handle:
        return b"\x00" in handle.read(4096)


def scan(root: Path) -> dict:
    """Read every known file under ``root`` once. The rest is counted, not read."""
    registry = load_registry()
    paths, skipped, truncated = _walk(root)
    files: list[dict] = []
    unsupported: Counter[str] = Counter()
    for path in paths:
        relative = path.relative_to(root).as_posix()
        lang = registry.for_path(path)
        if lang is None:
            unsupported[path.suffix.lower() or path.name] += 1
            continue
        try:
            size = path.stat().st_size
            if size > MAX_FILE_BYTES:
                skipped["file over 1 MB"] = skipped.get("file over 1 MB", 0) + 1
                continue
            if _looks_binary(path):
                skipped["binary file"] = skipped.get("binary file", 0) + 1
                continue
            files.append(read_file(path, lang, relative))
        except OSError:
            skipped["unreadable file"] = skipped.get("unreadable file", 0) + 1
    return {"files": files, "unsupported": dict(unsupported), "skipped": skipped, "truncated": truncated}


# -------------------------------------------------------------------------- graph


def reference_graph(files: list[dict]) -> dict[str, dict[str, float]]:
    """file -> {file it uses: weight}, from names one file defines and another mentions."""
    defined: dict[str, set[str]] = defaultdict(set)
    for entry in files:
        if not entry["graph"]:
            continue
        for symbol in entry["symbols"]:
            name = symbol["name"]
            if len(name) >= 3 and name not in STOP:
                defined[name].add(entry["path"])
    edges: dict[str, dict[str, float]] = {entry["path"]: {} for entry in files}
    for entry in files:
        if not entry["graph"]:
            continue
        for token, count in entry["tokens"].items():
            owners = defined.get(token)
            if not owners or len(owners) > COMMON_LIMIT or entry["path"] in owners:
                continue
            for owner in owners:
                edges[entry["path"]][owner] = edges[entry["path"]].get(owner, 0.0) + math.log1p(count)
    return edges


def rank(files: list[dict], edges: dict[str, dict[str, float]], focus: list[str] | None = None) -> dict[str, float]:
    """PageRank over the reference graph; a ``focus`` (paths or symbol names) pulls the rank its way."""
    paths = [entry["path"] for entry in files]
    if not paths:
        return {}
    wanted = [item.lower() for item in (focus or []) if item]
    personal = {path: 0.0 for path in paths}
    for entry in files:
        names = {symbol["name"].lower() for symbol in entry["symbols"]}
        if any(item in entry["path"].lower() or item in names for item in wanted):
            personal[entry["path"]] = 1.0
    total = sum(personal.values())
    base = {path: (personal[path] / total if total else 1.0 / len(paths)) for path in paths}
    score = dict(base)
    for _ in range(25):
        nxt = {path: (1 - DAMPING) * base[path] for path in paths}
        for source in paths:
            out = edges.get(source, {})
            weight = sum(out.values())
            if weight <= 0:
                for path in paths:  # a file that uses nothing hands its rank back evenly
                    nxt[path] += DAMPING * score[source] / len(paths)
                continue
            for target, value in out.items():
                nxt[target] += DAMPING * score[source] * value / weight
        score = nxt
    return score


# ---------------------------------------------------------------------- the answers


def _cost(text: str) -> int:
    return max(1, len(text) // 4)


def build_map(root: Path, budget: int = 2000, focus: list[str] | None = None) -> dict:
    """The ranked repo map as text that fits ``budget`` tokens, plus what was and was not read."""
    budget = max(200, min(int(budget), 20_000))
    scanned = scan(root)
    files = scanned["files"]
    if not files:
        return {
            "ok": True,
            "text": "No source files in a language this map knows were found.",
            "files": 0,
            "languages": {},
            "unsupported": scanned["unsupported"],
            "skipped": scanned["skipped"],
            "truncated": scanned["truncated"],
            "shown": 0,
        }
    edges = reference_graph(files)
    score = rank(files, edges, focus)
    ordered = sorted(files, key=lambda entry: (-score.get(entry["path"], 0.0), entry["path"]))
    languages: Counter[str] = Counter(entry["language"] for entry in files)
    header = f"Code map of {root.name or str(root)}: {len(files)} files, {len(languages)} languages."

    notes: list[str] = []
    outline = sorted({entry["language"] for entry in files if entry["reading"] == "outline"})
    if outline:
        notes.append("Outline only (line patterns, not a parser): " + ", ".join(outline) + ".")
    if any(entry["partial"] for entry in files):
        notes.append("A 'partial' Python file did not parse; its symbols come from line patterns.")
    if scanned["unsupported"]:
        common = sorted(scanned["unsupported"].items(), key=lambda item: -item[1])[:6]
        notes.append("Not read (no language entry): " + ", ".join(f"{ext} x{n}" for ext, n in common) + ".")

    # The header, the notes and the "more files" line are part of the budget, not extra to it.
    room = budget - _cost(header) - sum(_cost(note) for note in notes) - 20
    lines = [header]
    shown = 0
    for entry in ordered:
        title = f"{entry['path']} ({entry['language']}, {entry['reading']}{', partial' if entry['partial'] else ''})"
        rows = [f"  {symbol['kind']} {symbol['name']}  :{symbol['line']}" for symbol in entry["symbols"]]
        keep = min(12, len(rows))
        while True:
            block = [title, *rows[:keep]]
            if len(rows) > keep:
                block.append(f"  … {len(rows) - keep} more")
            text = "\n".join(block)
            if _cost(text) <= room or keep == 0:
                break
            keep = keep // 2
        if _cost(text) > room and shown:
            break
        lines.append(text)
        room -= _cost(text)
        shown += 1
    if shown < len(ordered):
        lines.append(f"… {len(ordered) - shown} more file(s) not shown (budget {budget} tokens).")
    lines.extend(notes)
    return {
        "ok": True,
        "text": "\n".join(lines),
        "files": len(files),
        "languages": dict(languages),
        "unsupported": scanned["unsupported"],
        "skipped": scanned["skipped"],
        "truncated": scanned["truncated"],
        "shown": shown,
    }


def impact(root: Path, target: str, depth: int = 3) -> dict:
    """The files that use ``target``, directly and through other files, nearest first."""
    scanned = scan(root)
    files = scanned["files"]
    wanted = target.replace("\\", "/").lstrip("./")
    known = {entry["path"] for entry in files}
    if wanted not in known:
        return {"ok": False, "error": f"{target} is not a file this map read under {root.name}"}
    edges = reference_graph(files)
    reverse: dict[str, dict[str, float]] = defaultdict(dict)
    for source, out in edges.items():
        for owner, value in out.items():
            reverse[owner][source] = value
    seen = {wanted: 0}
    queue: deque[str] = deque([wanted])
    while queue:
        current = queue.popleft()
        if seen[current] >= max(1, min(int(depth), 6)):
            continue
        for user in sorted(reverse.get(current, ())):
            if user not in seen:
                seen[user] = seen[current] + 1
                queue.append(user)
    defined = {symbol["name"] for entry in files if entry["path"] == wanted for symbol in entry["symbols"]}
    rows = []
    for path, distance in sorted(seen.items(), key=lambda item: (item[1], item[0])):
        if path == wanted:
            continue
        users = next(entry for entry in files if entry["path"] == path)
        via = sorted(name for name in defined if users["tokens"].get(name))[:5]
        rows.append({"path": path, "distance": distance, "uses": via if distance == 1 else []})
    return {
        "ok": True,
        "file": wanted,
        "reaches": rows,
        "text": (
            f"{wanted} is used by {len(rows)} file(s)." if rows else f"No other file in this folder uses {wanted}."
        ),
        "note": "Found by names, not by a type checker: a shared name can link files that are unrelated.",
    }
