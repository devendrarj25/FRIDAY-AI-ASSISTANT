"""Everyday document jobs that need no model: merge or split PDFs, clean a table, make an invoice.

Each job is arithmetic or file handling, so it is done by code: a total is summed with ``Decimal`` here, never
estimated by a model, and a cleaned table reports exactly what was changed. Inputs are read from the folders
FRIDAY may read and results are written only where the write tools may write; the caller (``doc.work`` in
``tools.py``) resolves and contains every path before it reaches this module.
"""

from __future__ import annotations

import csv
import re
import zipfile
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from pathlib import Path
from xml.etree import ElementTree as ET

import doc_writer

MAX_ROWS = 100_000
MAX_PDF_PAGES = 5_000


class JobError(ValueError):
    """A job that cannot be done, with a sentence the owner can act on."""


# ------------------------------------------------------------------ PDF


def _pymupdf():
    try:
        import pymupdf  # type: ignore
    except ImportError as exc:
        raise JobError("PDF merge and split need PyMuPDF: install it from the Install Manager") from exc
    return pymupdf


def pdf_merge(sources: list[Path], out: Path) -> dict:
    if len(sources) < 2:
        raise JobError("give at least two PDF files to merge")
    pymupdf = _pymupdf()
    merged = pymupdf.open()
    pages = 0
    try:
        for source in sources:
            with pymupdf.open(source) as part:
                if part.needs_pass:
                    raise JobError(f"{source.name} is password protected")
                pages += part.page_count
                if pages > MAX_PDF_PAGES:
                    raise JobError(f"that would be more than {MAX_PDF_PAGES} pages")
                merged.insert_pdf(part)
        out.parent.mkdir(parents=True, exist_ok=True)
        merged.save(out)
    except JobError:
        raise
    except Exception as exc:
        raise JobError(f"a PDF could not be read ({type(exc).__name__})") from exc
    finally:
        merged.close()
    return {"ok": True, "pages": pages, "files": len(sources), "bytes": out.stat().st_size}


def parse_ranges(text: str, pages: int) -> list[tuple[int, int]]:
    """'1-3, 5, 7-' -> [(1,3),(5,5),(7,pages)], 1-based and inclusive, checked against the page count."""
    out: list[tuple[int, int]] = []
    for part in re.split(r"\s*,\s*", str(text).strip()):
        if not part:
            continue
        m = re.fullmatch(r"(\d+)?\s*-\s*(\d+)?|(\d+)", part)
        if not m:
            raise JobError(f"'{part}' is not a page or a range like 2-4")
        if m.group(3):
            low = high = int(m.group(3))
        else:
            low = int(m.group(1) or 1)
            high = int(m.group(2) or pages)
        if low < 1 or high < low or high > pages:
            raise JobError(f"pages {part} are outside this file, which has {pages}")
        out.append((low, high))
    if not out:
        raise JobError("say which pages to keep, for example 1-3, 5")
    return out


def pdf_split(source: Path, ranges_text: str, out_dir: Path) -> dict:
    pymupdf = _pymupdf()
    made: list[dict] = []
    try:
        with pymupdf.open(source) as doc:
            if doc.needs_pass:
                raise JobError(f"{source.name} is password protected")
            ranges = parse_ranges(ranges_text, doc.page_count)
            out_dir.mkdir(parents=True, exist_ok=True)
            for low, high in ranges:
                part = pymupdf.open()
                part.insert_pdf(doc, from_page=low - 1, to_page=high - 1)
                target = out_dir / f"{source.stem}-p{low}{f'-{high}' if high != low else ''}.pdf"
                part.save(target)
                part.close()
                made.append({"name": target.name, "pages": high - low + 1})
    except JobError:
        raise
    except Exception as exc:
        raise JobError(f"the PDF could not be read ({type(exc).__name__})") from exc
    return {"ok": True, "files": made}


# ------------------------------------------------------------------ tables


def _col(ref: str) -> int:
    letters = re.match(r"[A-Z]+", ref or "")
    n = 0
    for ch in letters.group(0) if letters else "A":
        n = n * 26 + ord(ch) - 64
    return n - 1


def read_rows(path: Path) -> list[list[str]]:
    suffix = path.suffix.lower()
    if suffix == ".csv":
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            rows = [row for _, row in zip(range(MAX_ROWS + 1), csv.reader(handle), strict=False)]
    elif suffix == ".xlsx":
        rows = _xlsx_rows(path)
    else:
        raise JobError("tables can be cleaned from .csv or .xlsx files")
    if len(rows) > MAX_ROWS:
        raise JobError(f"more than {MAX_ROWS} rows")
    return rows


def _xlsx_rows(path: Path) -> list[list[str]]:
    try:
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            shared: list[str] = []
            if "xl/sharedStrings.xml" in names:
                for si in ET.fromstring(archive.read("xl/sharedStrings.xml")):  # noqa: S314
                    shared.append("".join(t.text or "" for t in si.iter() if t.tag.endswith("}t") or t.tag == "t"))
            sheets = sorted(n for n in names if re.match(r"xl/worksheets/sheet\d+\.xml$", n))
            if not sheets:
                raise JobError("the workbook has no sheets")
            rows: list[list[str]] = []
            for row in ET.fromstring(archive.read(sheets[0])).iter():  # noqa: S314
                if not row.tag.endswith("}row"):
                    continue
                cells: dict[int, str] = {}
                for cell in row:
                    value = ""
                    kind = cell.get("t")
                    for part in cell:
                        tag = part.tag.rsplit("}", 1)[-1]
                        if tag == "v":
                            value = part.text or ""
                        elif tag == "is":
                            value = "".join(t.text or "" for t in part.iter() if t.tag.endswith("}t"))
                    if kind == "s" and value.isdigit() and int(value) < len(shared):
                        value = shared[int(value)]
                    cells[_col(cell.get("r", ""))] = value
                rows.append([cells.get(i, "") for i in range(max(cells) + 1)] if cells else [])
            return rows
    except (zipfile.BadZipFile, ET.ParseError, KeyError) as exc:
        raise JobError(f"the workbook could not be read ({type(exc).__name__})") from exc


_NUMBER = re.compile(r"^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$|^[+-]?\d+(\.\d+)?$")


def clean_rows(rows: list[list[str]]) -> tuple[list[list[str]], dict]:
    """Trim and collapse spaces, drop empty rows and exact repeats, and strip thousands commas from numbers.

    The first row is kept as the header and never dropped as a repeat. Nothing is guessed: a cell is changed only
    by one of these rules, and the report counts each."""
    report = {"trimmed": 0, "empty_rows": 0, "duplicates": 0, "numbers": 0, "rows_in": len(rows)}
    seen: set[tuple[str, ...]] = set()
    out: list[list[str]] = []
    for index, row in enumerate(rows):
        cleaned: list[str] = []
        for cell in row:
            text = re.sub(r"\s+", " ", str(cell)).strip()
            if text != str(cell):
                report["trimmed"] += 1
            if index and _NUMBER.match(text) and "," in text:
                text = text.replace(",", "")
                report["numbers"] += 1
            cleaned.append(text)
        while cleaned and cleaned[-1] == "":
            cleaned.pop()
        if not any(cleaned):
            report["empty_rows"] += 1
            continue
        key = tuple(cleaned)
        if index and key in seen:
            report["duplicates"] += 1
            continue
        seen.add(key)
        out.append(cleaned)
    report["rows_out"] = len(out)
    return out, report


def clean_table(source: Path, out: Path) -> dict:
    rows, report = clean_rows(read_rows(source))
    if not rows:
        raise JobError("nothing was left after cleaning")
    kind = out.suffix.lower().lstrip(".")
    if kind == "csv":
        data, _ = doc_writer.render("csv", {"rows": rows})
    elif kind == "xlsx":
        data, _ = doc_writer.render("xlsx", {"sheets": [{"name": "Cleaned", "rows": rows}]})
    else:
        raise JobError("save the cleaned table as .csv or .xlsx")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(data)
    return {"ok": True, **report}


# ------------------------------------------------------------------ invoice


def _money(value: object) -> Decimal:
    try:
        return Decimal(str(value).replace(",", "").strip()).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError) as exc:
        raise JobError(f"'{value}' is not an amount") from exc


def invoice_spec(data: dict) -> tuple[dict, dict]:
    """A document spec for an invoice, with every figure computed here. Returns (spec, totals)."""
    items = data.get("items")
    if not isinstance(items, list) or not items:
        raise JobError("an invoice needs a list of items")
    currency = str(data.get("currency") or "").strip()[:6]
    tax_rate = Decimal(str(data.get("tax_percent") or 0))
    if tax_rate < 0 or tax_rate > 100:
        raise JobError("tax_percent must be between 0 and 100")
    rows: list[list[object]] = [["Item", "Qty", "Price", "Amount"]]
    subtotal = Decimal("0.00")
    for item in items[:500]:
        if not isinstance(item, dict) or not str(item.get("name") or "").strip():
            raise JobError("each item needs a name")
        qty = Decimal(str(item.get("qty", 1)))
        if qty <= 0:
            raise JobError(f"{item.get('name')}: quantity must be above zero")
        price = _money(item.get("price", 0))
        amount = (qty * price).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        subtotal += amount
        rows.append([str(item["name"]).strip(), f"{qty.normalize():f}", f"{price}", f"{amount}"])
    tax = (subtotal * tax_rate / Decimal(100)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    total = subtotal + tax
    totals = {"subtotal": str(subtotal), "tax": str(tax), "total": str(total), "currency": currency}
    blocks: list[dict] = []
    head = [f"Invoice {data.get('number', '')}".strip(), f"Date: {data.get('date', '')}".strip()]
    if data.get("from"):
        head.append(f"From: {data['from']}")
    if data.get("to"):
        head.append(f"To: {data['to']}")
    blocks.append({"type": "paragraph", "text": "\n".join(part for part in head if part.strip(": "))})
    blocks.append({"type": "table", "header": True, "rows": rows})
    unit = f" {currency}" if currency else ""
    summary = [f"Subtotal: {subtotal}{unit}"]
    if tax_rate:
        summary.append(f"Tax ({tax_rate.normalize():f}%): {tax}{unit}")
    summary.append(f"Total: {total}{unit}")
    blocks.append({"type": "paragraph", "text": "\n".join(summary)})
    if data.get("notes"):
        blocks.append({"type": "paragraph", "text": str(data["notes"])})
    return {"title": "Invoice", "blocks": blocks}, totals
