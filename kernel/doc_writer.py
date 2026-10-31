"""Make documents from a plain description, with the standard library only.

``write_document`` turns a small, typed ``spec`` into a real file: Word (.docx), Excel (.xlsx),
PowerPoint (.pptx), PDF, HTML, Markdown, CSV, JSON or plain text. Nothing here runs a macro,
evaluates a formula or opens a network connection, and every Office part is built from fixed
templates with the text escaped, so a spec that came from a web page cannot add anything but words.

Spec shapes (the ``kind`` comes from the file name):

* docx, pdf, html, md, txt: ``{"title": str, "blocks": [block, ...]}`` where a block is
  ``{"type": "heading", "level": 1-3, "text": str}``, ``{"type": "paragraph", "text": str}``,
  ``{"type": "bullets", "items": [str]}``, ``{"type": "numbered", "items": [str]}``,
  ``{"type": "table", "rows": [[cell]], "header": bool}`` or ``{"type": "code", "text": str}``.
* rtf, odt, epub: the same ``blocks`` as docx. They keep every character, so they are the way to make a
  Hindi or Hinglish document that opens in Word, LibreOffice or a reader (a PDF made here is Latin-1 only).
  An epub may carry ``"language"`` (default ``en``).
* xlsx: ``{"sheets": [{"name": str, "rows": [[cell]]}]}``. A cell is a string, number or bool.
  Strings are always stored as text, so ``=1+1`` stays text and is never evaluated.
* pptx: ``{"title": str, "slides": [{"title": str, "bullets": [str]}]}``.
* csv: ``{"rows": [[cell]]}``. A text cell that starts with ``= + - @`` gets a leading quote.
* json: ``{"data": any}``. It is written exactly as valid JSON.

The PDF writer uses the built-in Helvetica and Courier fonts, which hold Latin-1 only. Other
characters (Devanagari, for one) become ``?`` and the result says how many; Word, HTML and
Markdown keep every character.
"""

from __future__ import annotations

import csv
import io
import json
import re
import textwrap
import zipfile
from html import escape as _html_escape
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape as _xml_escape

KINDS = ("docx", "xlsx", "pptx", "pdf", "html", "md", "txt", "csv", "json", "rtf", "odt", "epub")
MAX_BLOCKS = 5000
MAX_CHARS = 2_000_000
MAX_ROWS = 100_000
MAX_SLIDES = 500
_BAD_XML = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")


class SpecError(ValueError):
    """The description is not something a document can be made from."""


def _x(value: object) -> str:
    return _xml_escape(_BAD_XML.sub("", str(value)))


def _text(value: object) -> str:
    return "" if value is None else str(value)


# ------------------------------------------------------------------ validation


def _blocks(spec: dict) -> list[dict]:
    raw = spec.get("blocks")
    if raw is None and spec.get("text") is not None:
        raw = [{"type": "paragraph", "text": spec["text"]}]
    if not isinstance(raw, list) or not raw:
        raise SpecError("blocks must be a non-empty list")
    if len(raw) > MAX_BLOCKS:
        raise SpecError(f"more than {MAX_BLOCKS} blocks")
    out: list[dict] = []
    chars = len(_text(spec.get("title")))
    for index, block in enumerate(raw):
        if not isinstance(block, dict):
            raise SpecError(f"block {index + 1} is not an object")
        kind = block.get("type", "paragraph")
        if kind in {"paragraph", "code"}:
            text = _text(block.get("text"))
            chars += len(text)
            out.append({"type": kind, "text": text})
        elif kind == "heading":
            level = block.get("level", 1)
            level = level if isinstance(level, int) and 1 <= level <= 3 else 1
            text = _text(block.get("text"))
            chars += len(text)
            out.append({"type": kind, "level": level, "text": text})
        elif kind in {"bullets", "numbered"}:
            items = block.get("items")
            if not isinstance(items, list) or not items:
                raise SpecError(f"block {index + 1}: items must be a non-empty list")
            items = [_text(item) for item in items]
            chars += sum(len(item) for item in items)
            out.append({"type": kind, "items": items})
        elif kind == "table":
            rows = _rows(block.get("rows"), f"block {index + 1}")
            chars += sum(len(_text(cell)) for row in rows for cell in row)
            out.append({"type": kind, "rows": rows, "header": bool(block.get("header", True))})
        else:
            raise SpecError(f"block {index + 1}: unknown type {kind!r}")
        if chars > MAX_CHARS:
            raise SpecError("the document is larger than 2 million characters")
    return out


def _rows(raw: object, where: str) -> list[list[object]]:
    if not isinstance(raw, list) or not raw:
        raise SpecError(f"{where}: rows must be a non-empty list")
    if len(raw) > MAX_ROWS:
        raise SpecError(f"{where}: more than {MAX_ROWS} rows")
    rows = []
    for row in raw:
        if not isinstance(row, list):
            raise SpecError(f"{where}: every row must be a list")
        rows.append([cell if isinstance(cell, (int, float, bool)) or cell is None else str(cell) for cell in row])
    return rows


# ------------------------------------------------------------------ text kinds


def _markdown(spec: dict, blocks: list[dict]) -> str:
    lines: list[str] = []
    if spec.get("title"):
        lines += [f"# {_text(spec['title'])}", ""]
    for block in blocks:
        kind = block["type"]
        if kind == "heading":
            lines += [f"{'#' * (block['level'] + 1)} {block['text']}", ""]
        elif kind == "paragraph":
            lines += [block["text"], ""]
        elif kind == "bullets":
            lines += [f"- {item}" for item in block["items"]] + [""]
        elif kind == "numbered":
            lines += [f"{n}. {item}" for n, item in enumerate(block["items"], 1)] + [""]
        elif kind == "code":
            lines += ["```", block["text"], "```", ""]
        elif kind == "table":
            rows = [[_text(c).replace("|", "\\|") for c in row] for row in block["rows"]]
            width = max(len(r) for r in rows)
            rows = [r + [""] * (width - len(r)) for r in rows]
            head, body = (rows[0], rows[1:]) if block["header"] else ([""] * width, rows)
            lines += ["| " + " | ".join(head) + " |", "|" + " --- |" * width]
            lines += ["| " + " | ".join(r) + " |" for r in body] + [""]
    return "\n".join(lines).rstrip() + "\n"


def _plain(spec: dict, blocks: list[dict]) -> str:
    lines: list[str] = []
    if spec.get("title"):
        lines += [_text(spec["title"]), "=" * min(len(_text(spec["title"])), 72), ""]
    for block in blocks:
        kind = block["type"]
        if kind == "heading":
            lines += [block["text"], ("=-~"[block["level"] - 1]) * min(len(block["text"]), 72), ""]
        elif kind in {"paragraph", "code"}:
            lines += [block["text"], ""]
        elif kind == "bullets":
            lines += [f"* {item}" for item in block["items"]] + [""]
        elif kind == "numbered":
            lines += [f"{n}. {item}" for n, item in enumerate(block["items"], 1)] + [""]
        elif kind == "table":
            lines += ["\t".join(_text(c) for c in row) for row in block["rows"]] + [""]
    return "\n".join(lines).rstrip() + "\n"


def _html(spec: dict, blocks: list[dict]) -> str:
    title = _html_escape(_text(spec.get("title")) or "Document")
    out = [
        "<!doctype html>",
        '<html lang="en">',
        f'<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{title}</title></head>',
        "<body>",
    ]
    if spec.get("title"):
        out.append(f"<h1>{title}</h1>")
    for block in blocks:
        kind = block["type"]
        if kind == "heading":
            level = block["level"] + 1
            out.append(f"<h{level}>{_html_escape(block['text'])}</h{level}>")
        elif kind == "paragraph":
            out.append(f"<p>{_html_escape(block['text'])}</p>")
        elif kind in {"bullets", "numbered"}:
            tag = "ul" if kind == "bullets" else "ol"
            items = "".join(f"<li>{_html_escape(i)}</li>" for i in block["items"])
            out.append(f"<{tag}>{items}</{tag}>")
        elif kind == "code":
            out.append(f"<pre><code>{_html_escape(block['text'])}</code></pre>")
        elif kind == "table":
            rows = block["rows"]
            html_rows = []
            for n, row in enumerate(rows):
                tag = "th" if block["header"] and n == 0 else "td"
                html_rows.append("<tr>" + "".join(f"<{tag}>{_html_escape(_text(c))}</{tag}>" for c in row) + "</tr>")
            out.append("<table>" + "".join(html_rows) + "</table>")
    out += ["</body>", "</html>", ""]
    return "\n".join(out)


def _csv(spec: dict) -> str:
    rows = _rows(spec.get("rows"), "csv")
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    for row in rows:
        writer.writerow([_csv_cell(cell) for cell in row])
    return buffer.getvalue()


def _csv_cell(cell: object) -> object:
    if isinstance(cell, str) and cell[:1] in {"=", "+", "-", "@", "\t", "\r"}:
        try:
            float(cell)
            return cell
        except ValueError:
            return "'" + cell
    return "" if cell is None else cell


# ------------------------------------------------------------------ docx

_CT_DOCX = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    "</Types>"
)
_RELS_ROOT = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="{target}"/>'
    "</Relationships>"
)
_W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
_STYLES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    f"<w:styles {_W}>"
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Mangal"/>'
    '<w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>'
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>'
    '<w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="48"/></w:rPr></w:style>'
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>'
    '<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr>'
    '<w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>'
    '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/>'
    '<w:pPr><w:keepNext/><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr>'
    '<w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style>'
    '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/>'
    '<w:pPr><w:keepNext/><w:spacing w:before="160" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr>'
    '<w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>'
    '<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/>'
    '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>'
    "</w:styles>"
)


def _w_para(text: str, style: str | None = None, indent: int = 0) -> str:
    props = ""
    if style or indent:
        props = "<w:pPr>"
        if style:
            props += f'<w:pStyle w:val="{style}"/>'
        if indent:
            props += f'<w:ind w:left="{indent}" w:hanging="360"/>'
        props += "</w:pPr>"
    runs = []
    for number, line in enumerate(text.split("\n")):
        runs.append(("<w:r><w:br/></w:r>" if number else "") + f'<w:r><w:t xml:space="preserve">{_x(line)}</w:t></w:r>')
    return f"<w:p>{props}{''.join(runs)}</w:p>"


def _docx_body(spec: dict, blocks: list[dict]) -> str:
    out = []
    if spec.get("title"):
        out.append(_w_para(_text(spec["title"]), "Title"))
    for block in blocks:
        kind = block["type"]
        if kind == "heading":
            out.append(_w_para(block["text"], f"Heading{block['level']}"))
        elif kind == "paragraph":
            out.append(_w_para(block["text"]))
        elif kind == "code":
            out.append(_w_para(block["text"], "Code"))
        elif kind == "bullets":
            out += [_w_para(f"•\t{item}", indent=720) for item in block["items"]]
        elif kind == "numbered":
            out += [_w_para(f"{n}.\t{item}", indent=720) for n, item in enumerate(block["items"], 1)]
        elif kind == "table":
            border = "".join(
                f'<w:{side} w:val="single" w:sz="4" w:space="0" w:color="808080"/>'
                for side in ("top", "left", "bottom", "right", "insideH", "insideV")
            )
            rows = []
            for n, row in enumerate(block["rows"]):
                bold = block["header"] and n == 0
                cells = "".join(
                    '<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>'
                    + (
                        f'<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">{_x(_text(c))}</w:t></w:r></w:p>'
                        if bold
                        else _w_para(_text(c))
                    )
                    + "</w:tc>"
                    for c in row
                )
                rows.append(f"<w:tr>{cells}</w:tr>")
            out.append(
                f'<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>{border}</w:tblBorders></w:tblPr>'
                + "".join(rows)
                + "</w:tbl>"
            )
            out.append(_w_para(""))
    return "".join(out)


def _docx(spec: dict, blocks: list[dict]) -> bytes:
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f"<w:document {_W}><w:body>{_docx_body(spec, blocks)}"
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>'
        "</w:body></w:document>"
    )
    return _zip(
        {
            "[Content_Types].xml": _CT_DOCX,
            "_rels/.rels": _RELS_ROOT.format(target="word/document.xml"),
            "word/document.xml": document,
            "word/styles.xml": _STYLES,
        }
    )


# ------------------------------------------------------------------ xlsx


def _col(index: int) -> str:
    name = ""
    index += 1
    while index:
        index, rem = divmod(index - 1, 26)
        name = chr(65 + rem) + name
    return name


def _sheet_name(raw: object, taken: set[str], number: int) -> str:
    name = re.sub(r"[\\/*?:\[\]]", " ", _text(raw)).strip().strip("'")[:31] or f"Sheet{number}"
    base, copy = name, 2
    while name.lower() in taken:
        suffix = f" {copy}"
        name = base[: 31 - len(suffix)] + suffix
        copy += 1
    taken.add(name.lower())
    return name


def _xlsx(spec: dict) -> bytes:
    sheets = spec.get("sheets")
    if sheets is None and spec.get("rows") is not None:
        sheets = [{"name": spec.get("title") or "Sheet1", "rows": spec["rows"]}]
    if not isinstance(sheets, list) or not sheets:
        raise SpecError("sheets must be a non-empty list")
    shared: list[str] = []
    index: dict[str, int] = {}

    def string_id(value: str) -> int:
        if value not in index:
            index[value] = len(shared)
            shared.append(value)
        return index[value]

    taken: set[str] = set()
    names: list[str] = []
    xmls: list[str] = []
    for number, sheet in enumerate(sheets, 1):
        if not isinstance(sheet, dict):
            raise SpecError(f"sheet {number} is not an object")
        rows = _rows(sheet.get("rows"), f"sheet {number}")
        names.append(_sheet_name(sheet.get("name"), taken, number))
        body = []
        for r, row in enumerate(rows, 1):
            cells = []
            for c, value in enumerate(row):
                ref = f"{_col(c)}{r}"
                if value is None or value == "":
                    continue
                if isinstance(value, bool):
                    cells.append(f'<c r="{ref}" t="b"><v>{int(value)}</v></c>')
                elif isinstance(value, (int, float)):
                    cells.append(f'<c r="{ref}"><v>{value!r}</v></c>')
                else:
                    cells.append(f'<c r="{ref}" t="s"><v>{string_id(str(value))}</v></c>')
            body.append(f'<row r="{r}">{"".join(cells)}</row>')
        xmls.append(
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            f"<sheetData>{''.join(body)}</sheetData></worksheet>"
        )
    ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    rel_ns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    workbook = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<workbook xmlns="{ns}" xmlns:r="{rel_ns}"><sheets>'
        + "".join(f'<sheet name="{_x(n)}" sheetId="{i}" r:id="rId{i}"/>' for i, n in enumerate(names, 1))
        + "</sheets></workbook>"
    )
    count = len(names)
    wb_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + "".join(
            f'<Relationship Id="rId{i}" Type="{rel_ns}/worksheet" Target="worksheets/sheet{i}.xml"/>'
            for i in range(1, count + 1)
        )
        + f'<Relationship Id="rId{count + 1}" Type="{rel_ns}/sharedStrings" Target="sharedStrings.xml"/>'
        + f'<Relationship Id="rId{count + 2}" Type="{rel_ns}/styles" Target="styles.xml"/>'
        + "</Relationships>"
    )
    shared_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<sst xmlns="{ns}" count="{len(shared)}" uniqueCount="{len(shared)}">'
        + "".join(f'<si><t xml:space="preserve">{_x(s)}</t></si>' for s in shared)
        + "</sst>"
    )
    styles = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<styleSheet xmlns="{ns}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>'
    )
    ct = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + "".join(
            f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            for i in range(1, count + 1)
        )
        + '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
        + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        + "</Types>"
    )
    parts = {
        "[Content_Types].xml": ct,
        "_rels/.rels": _RELS_ROOT.format(target="xl/workbook.xml"),
        "xl/workbook.xml": workbook,
        "xl/_rels/workbook.xml.rels": wb_rels,
        "xl/sharedStrings.xml": shared_xml,
        "xl/styles.xml": styles,
    }
    for i, xml in enumerate(xmls, 1):
        parts[f"xl/worksheets/sheet{i}.xml"] = xml
    return _zip(parts)


# ------------------------------------------------------------------ pptx

_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
_P = "http://schemas.openxmlformats.org/presentationml/2006/main"
_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_PKG = "http://schemas.openxmlformats.org/package/2006/relationships"


def _rels(items: list[tuple[str, str, str]]) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<Relationships xmlns="{_PKG}">'
        + "".join(f'<Relationship Id="{i}" Type="{_R}/{t}" Target="{target}"/>' for i, t, target in items)
        + "</Relationships>"
    )


def _shape(
    ident: int, name: str, x: int, y: int, cx: int, cy: int, paragraphs: list[str], size: int, bold: bool
) -> str:
    paras = (
        "".join(
            f'<a:p><a:r><a:rPr lang="en-US" sz="{size}"{' b="1"' if bold else ""}/><a:t>{_x(p)}</a:t></a:r></a:p>'
            for p in paragraphs
        )
        or '<a:p><a:endParaRPr lang="en-US"/></a:p>'
    )
    return (
        f'<p:sp><p:nvSpPr><p:cNvPr id="{ident}" name="{_x(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
        f'<p:spPr><a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
        f'<p:txBody><a:bodyPr wrap="square"><a:normAutofit/></a:bodyPr><a:lstStyle/>{paras}</p:txBody></p:sp>'
    )


def _pptx(spec: dict) -> bytes:
    slides = spec.get("slides")
    if not isinstance(slides, list) or not slides:
        raise SpecError("slides must be a non-empty list")
    if len(slides) > MAX_SLIDES:
        raise SpecError(f"more than {MAX_SLIDES} slides")
    parts: dict[str, str] = {}
    slide_xml = []
    for number, slide in enumerate(slides, 1):
        if not isinstance(slide, dict):
            raise SpecError(f"slide {number} is not an object")
        bullets = slide.get("bullets") or []
        if not isinstance(bullets, list):
            raise SpecError(f"slide {number}: bullets must be a list")
        title = _text(slide.get("title")) or (_text(spec.get("title")) if number == 1 else "")
        body = [f"• {_text(b)}" for b in bullets]
        shapes = _shape(2, "Title", 609600, 304800, 10972800, 1066800, [title], 3600, True)
        shapes += _shape(3, "Content", 609600, 1524000, 10972800, 4572000, body, 2400, False)
        slide_xml.append(
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<p:sld xmlns:a="{_A}" xmlns:r="{_R}" xmlns:p="{_P}"><p:cSld><p:spTree>'
            '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
            '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
            f"{shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"
        )
    count = len(slide_xml)
    for i, xml in enumerate(slide_xml, 1):
        parts[f"ppt/slides/slide{i}.xml"] = xml
        parts[f"ppt/slides/_rels/slide{i}.xml.rels"] = _rels(
            [("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml")]
        )
    parts["ppt/presentation.xml"] = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<p:presentation xmlns:a="{_A}" xmlns:r="{_R}" xmlns:p="{_P}">'
        '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
        "<p:sldIdLst>"
        + "".join(f'<p:sldId id="{255 + i}" r:id="rId{i + 1}"/>' for i in range(1, count + 1))
        + '</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>'
    )
    parts["ppt/_rels/presentation.xml.rels"] = _rels(
        [("rId1", "slideMaster", "slideMasters/slideMaster1.xml")]
        + [(f"rId{i + 1}", "slide", f"slides/slide{i}.xml") for i in range(1, count + 1)]
    )
    empty_tree = (
        '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
        '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
        "</p:spTree></p:cSld>"
    )
    parts["ppt/slideMasters/slideMaster1.xml"] = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<p:sldMaster xmlns:a="{_A}" xmlns:r="{_R}" xmlns:p="{_P}">{empty_tree}'
        '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" '
        'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
        '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>'
    )
    parts["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = _rels(
        [("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"), ("rId2", "theme", "../theme/theme1.xml")]
    )
    parts["ppt/slideLayouts/slideLayout1.xml"] = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<p:sldLayout xmlns:a="{_A}" xmlns:r="{_R}" xmlns:p="{_P}" type="blank" preserve="1">{empty_tree}'
        "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"
    )
    parts["ppt/slideLayouts/_rels/slideLayout1.xml.rels"] = _rels(
        [("rId1", "slideMaster", "../slideMasters/slideMaster1.xml")]
    )
    parts["ppt/theme/theme1.xml"] = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<a:theme xmlns:a="{_A}" name="FRIDAY"><a:themeElements>'
        '<a:clrScheme name="FRIDAY"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>'
        '<a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2>'
        + "".join(
            f'<a:accent{n}><a:srgbClr val="{c}"/></a:accent{n}>'
            for n, c in enumerate(("2563EB", "7C3AED", "059669", "D97706", "DC2626", "0891B2"), 1)
        )
        + '<a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme>'
        '<a:fontScheme name="FRIDAY"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>'
        '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>'
        '<a:fmtScheme name="FRIDAY"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
        '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>'
        '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'
        '<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'
        '<a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>'
        "<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle>"
        "<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>"
        '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
        '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>'
    )
    parts["_rels/.rels"] = _RELS_ROOT.format(target="ppt/presentation.xml")
    overrides = [
        ("/ppt/presentation.xml", "presentationml.presentation.main"),
        ("/ppt/slideMasters/slideMaster1.xml", "presentationml.slideMaster"),
        ("/ppt/slideLayouts/slideLayout1.xml", "presentationml.slideLayout"),
    ] + [(f"/ppt/slides/slide{i}.xml", "presentationml.slide") for i in range(1, count + 1)]
    parts["[Content_Types].xml"] = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        + "".join(
            f'<Override PartName="{p}" ContentType="application/vnd.openxmlformats-officedocument.{t}+xml"/>'
            for p, t in overrides
        )
        + '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
        + "</Types>"
    )
    return _zip(parts)


# ------------------------------------------------------------------ pdf

_PAGE_W, _PAGE_H, _MARGIN = 595, 842, 56


def _latin(value: str) -> tuple[str, int]:
    out, lost = [], 0
    for ch in value.replace("\t", "    "):
        if ch == "\n" or " " <= ch <= "~" or "¡" <= ch <= "ÿ":
            out.append(ch)
        elif ch in "‘’":
            out.append("'")
        elif ch in "“”":
            out.append('"')
        elif ch in "–—":
            out.append("-")
        elif ch == "•":
            out.append("*")
        else:
            out.append("?")
            lost += 1
    return "".join(out), lost


def _pdf_escape(line: str) -> bytes:
    raw = line.encode("latin-1", "replace")
    return raw.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")


def _pdf(spec: dict, blocks: list[dict]) -> tuple[bytes, int]:
    lost_total = 0
    # (font, size, text) lines in reading order; font F1 body, F2 bold, F3 mono.
    lines: list[tuple[str, int, str]] = []

    def add(font: str, size: int, text: str, indent: int = 0, gap: int = 0) -> None:
        nonlocal lost_total
        text, lost = _latin(text)
        lost_total += lost
        width = (_PAGE_W - 2 * _MARGIN - indent) / (size * (0.6 if font == "F3" else 0.52))
        for raw in text.split("\n") or [""]:
            wrapped = textwrap.wrap(raw, max(8, int(width)), drop_whitespace=False, replace_whitespace=False) or [""]
            for piece in wrapped:
                lines.append((font, size, " " * (indent // 4) + piece))
        for _ in range(gap):
            lines.append(("F1", 6, ""))

    if spec.get("title"):
        add("F2", 22, _text(spec["title"]), gap=1)
    for block in blocks:
        kind = block["type"]
        if kind == "heading":
            add("F2", {1: 16, 2: 13, 3: 11}[block["level"]], block["text"], gap=1)
        elif kind == "paragraph":
            add("F1", 11, block["text"], gap=1)
        elif kind == "code":
            add("F3", 9, block["text"], gap=1)
        elif kind == "bullets":
            for item in block["items"]:
                add("F1", 11, f"* {item}", indent=16)
            add("F1", 11, "", gap=0)
        elif kind == "numbered":
            for n, item in enumerate(block["items"], 1):
                add("F1", 11, f"{n}. {item}", indent=16)
            add("F1", 11, "", gap=0)
        elif kind == "table":
            for n, row in enumerate(block["rows"]):
                add("F2" if block["header"] and n == 0 else "F1", 10, "  |  ".join(_text(c) for c in row))
            add("F1", 11, "", gap=0)

    pages: list[list[tuple[str, int, str, float]]] = [[]]
    y = _PAGE_H - _MARGIN
    for font, size, text in lines:
        leading = size * 1.35
        if y - leading < _MARGIN:
            pages.append([])
            y = _PAGE_H - _MARGIN
        y -= leading
        pages[-1].append((font, size, text, y))

    objects: list[bytes] = []

    def new(body: bytes) -> int:
        objects.append(body)
        return len(objects)

    new(b"")  # 1 catalog, filled below
    new(b"")  # 2 pages, filled below
    fonts = [
        new(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"),
        new(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"),
        new(b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>"),
    ]
    page_ids: list[int] = []
    for page in pages:
        stream = bytearray()
        for font, size, text, ypos in page:
            if not text.strip():
                continue
            stream += (
                b"BT /"
                + font.encode()
                + f" {size} Tf {_MARGIN} {ypos:.2f} Td (".encode()
                + _pdf_escape(text)
                + b") Tj ET\n"
            )
        content = new(b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + bytes(stream) + b"\nendstream")
        page_ids.append(
            new(
                f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {_PAGE_W} {_PAGE_H}] "
                f"/Resources << /Font << /F1 {fonts[0]} 0 R /F2 {fonts[1]} 0 R /F3 {fonts[2]} 0 R >> >> "
                f"/Contents {content} 0 R >>".encode()
            )
        )
    objects[0] = b"<< /Type /Catalog /Pages 2 0 R >>"
    kids = " ".join(f"{i} 0 R" for i in page_ids)
    objects[1] = f"<< /Type /Pages /Kids [{kids}] /Count {len(page_ids)} >>".encode()
    info = new(b"<< /Producer (FRIDAY) >>")
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode() + b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R /Info {info} 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out), lost_total


# ------------------------------------------------------------------ plumbing


def _zip(parts: dict[str, str]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        # [Content_Types].xml first, as the Open Packaging Conventions expect.
        for name in sorted(parts, key=lambda n: (n != "[Content_Types].xml", n)):
            info = zipfile.ZipInfo(name, date_time=(2000, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, parts[name].encode("utf-8"))
    return buffer.getvalue()


def _zip_mimetype_first(mimetype: str, parts: dict[str, str]) -> bytes:
    """ODF and EPUB want `mimetype` first and stored without compression so readers can sniff the type."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        first = zipfile.ZipInfo("mimetype", date_time=(2000, 1, 1, 0, 0, 0))
        first.compress_type = zipfile.ZIP_STORED
        archive.writestr(first, mimetype.encode("ascii"))
        for name in sorted(parts):
            info = zipfile.ZipInfo(name, date_time=(2000, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, parts[name].encode("utf-8"))
    return buffer.getvalue()


def _rtf_text(value: object) -> str:
    out: list[str] = []
    for ch in _BAD_XML.sub("", _text(value)):
        code = ord(ch)
        if ch in "\\{}":
            out.append("\\" + ch)
        elif ch == "\n":
            out.append("\\line ")
        elif ch == "\t":
            out.append("\\tab ")
        elif code < 128:
            out.append(ch)
        elif code <= 0xFFFF:
            out.append(f"\\u{code - 65536 if code > 32767 else code}?")
        else:
            high, low = divmod(code - 0x10000, 0x400)
            for unit in (0xD800 + high, 0xDC00 + low):
                out.append(f"\\u{unit - 65536 if unit > 32767 else unit}?")
    return "".join(out)


def _rtf(spec: dict, blocks: list[dict]) -> str:
    sizes = {1: 40, 2: 32, 3: 28}
    out = ["{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fswiss Calibri;}{\\f1\\fmodern Courier New;}}\\f0\\fs22"]
    if spec.get("title"):
        out.append(f"{{\\pard\\b\\fs48 {_rtf_text(spec['title'])}\\par}}")
    for block in blocks:
        kind = block["type"]
        if kind == "heading":
            out.append(f"{{\\pard\\b\\fs{sizes[block['level']]} {_rtf_text(block['text'])}\\par}}")
        elif kind == "paragraph":
            out.append(f"{{\\pard {_rtf_text(block['text'])}\\par}}")
        elif kind == "code":
            out.append(f"{{\\pard\\f1 {_rtf_text(block['text'])}\\par}}")
        elif kind in {"bullets", "numbered"}:
            for n, item in enumerate(block["items"], 1):
                mark = "\\u8226?\\tab " if kind == "bullets" else f"{n}.\\tab "
                out.append(f"{{\\pard\\li360\\fi-360 {mark}{_rtf_text(item)}\\par}}")
        elif kind == "table":
            for row in block["rows"]:
                out.append("{\\pard " + "\\tab ".join(_rtf_text(c) for c in row) + "\\par}")
    out.append("}")
    return "\n".join(out) + "\n"


_ODF_NS = (
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
    'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" office:version="1.2"'
)


def _odt(spec: dict, blocks: list[dict]) -> bytes:
    body: list[str] = []
    if spec.get("title"):
        body.append(f'<text:h text:outline-level="1">{_x(spec["title"])}</text:h>')
    for block in blocks:
        kind = block["type"]
        if kind == "heading":
            level = min(block["level"] + 1, 4)
            body.append(f'<text:h text:outline-level="{level}">{_x(block["text"])}</text:h>')
        elif kind in {"paragraph", "code"}:
            body.append(f"<text:p>{_x(block['text'])}</text:p>")
        elif kind == "bullets":
            items = "".join(f"<text:list-item><text:p>{_x(i)}</text:p></text:list-item>" for i in block["items"])
            body.append(f"<text:list>{items}</text:list>")
        elif kind == "numbered":
            for n, item in enumerate(block["items"], 1):
                body.append(f"<text:p>{n}. {_x(item)}</text:p>")
        elif kind == "table":
            rows = block["rows"]
            width = max((len(r) for r in rows), default=1)
            cells = lambda row: "".join(  # noqa: E731 - tiny local helper
                f'<table:table-cell office:value-type="string"><text:p>{_x(_text(c))}</text:p></table:table-cell>'
                for c in row
            )
            body.append(
                f'<table:table table:name="T{len(body) + 1}"><table:table-column table:number-columns-repeated="{width}"/>'
                + "".join(f"<table:table-row>{cells(r)}</table:table-row>" for r in rows)
                + "</table:table>"
            )
    content = (
        f'<?xml version="1.0" encoding="UTF-8"?><office:document-content {_ODF_NS}>'
        f"<office:body><office:text>{''.join(body)}</office:text></office:body></office:document-content>"
    )
    mime = "application/vnd.oasis.opendocument.text"
    manifest = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">'
        f'<manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="{mime}"/>'
        '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>'
        "</manifest:manifest>"
    )
    return _zip_mimetype_first(mime, {"content.xml": content, "META-INF/manifest.xml": manifest})


def _epub(spec: dict, blocks: list[dict]) -> bytes:
    import hashlib

    title = _x(_text(spec.get("title")) or "Document")
    language = re.sub(r"[^A-Za-z-]", "", _text(spec.get("language")) or "en")[:12] or "en"
    chapter = _html(spec, blocks)
    inner = chapter[chapter.index("<body>") + 6 : chapter.index("</body>")]
    xhtml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f'<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="{language}"><head><title>{title}</title></head>'
        f"<body>{inner}</body></html>"
    )
    nav = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">'
        f'<head><title>{title}</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">{title}</a></li></ol></nav></body></html>'
    )
    ident = "urn:uuid:" + hashlib.sha256(xhtml.encode("utf-8")).hexdigest()[:32]
    opf = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">'
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
        f'<dc:identifier id="id">{ident}</dc:identifier><dc:title>{title}</dc:title><dc:language>{language}</dc:language>'
        '<meta property="dcterms:modified">2000-01-01T00:00:00Z</meta></metadata>'
        '<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
        '<item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest>'
        '<spine><itemref idref="c1"/></spine></package>'
    )
    container = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
        '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
    )
    return _zip_mimetype_first(
        "application/epub+zip",
        {
            "META-INF/container.xml": container,
            "OEBPS/content.opf": opf,
            "OEBPS/nav.xhtml": nav,
            "OEBPS/chapter.xhtml": xhtml,
        },
    )


def kind_of(path: Path, kind: str | None = None) -> str:
    chosen = (kind or path.suffix.lstrip(".")).lower()
    chosen = {"markdown": "md", "htm": "html", "text": "txt"}.get(chosen, chosen)
    if chosen not in KINDS:
        raise SpecError(f"cannot make a .{chosen or '?'} file; choose one of: {', '.join(KINDS)}")
    return chosen


def render(kind: str, spec: dict) -> tuple[bytes, list[str]]:
    """The bytes of the document and any warnings. Raises SpecError for a spec that cannot be used."""
    if not isinstance(spec, dict):
        raise SpecError("spec must be an object")
    warnings: list[str] = []
    if kind in {"docx", "pdf", "html", "md", "txt", "rtf", "odt", "epub"}:
        blocks = _blocks(spec)
        if kind == "docx":
            return _docx(spec, blocks), warnings
        if kind == "rtf":
            return _rtf(spec, blocks).encode("ascii"), warnings
        if kind == "odt":
            return _odt(spec, blocks), warnings
        if kind == "epub":
            return _epub(spec, blocks), warnings
        if kind == "pdf":
            data, lost = _pdf(spec, blocks)
            if lost:
                warnings.append(
                    f"{lost} character(s) outside Latin-1 became '?': a PDF made here keeps Latin text only; "
                    "use .docx or .html to keep every character"
                )
            return data, warnings
        if kind == "html":
            return _html(spec, blocks).encode("utf-8"), warnings
        if kind == "md":
            return _markdown(spec, blocks).encode("utf-8"), warnings
        return _plain(spec, blocks).encode("utf-8"), warnings
    if kind == "xlsx":
        return _xlsx(spec), warnings
    if kind == "pptx":
        return _pptx(spec), warnings
    if kind == "csv":
        return _csv(spec).encode("utf-8"), warnings
    if kind == "json":
        if "data" not in spec:
            raise SpecError("a json file needs a data value")
        return (json.dumps(spec["data"], indent=2, ensure_ascii=False) + "\n").encode("utf-8"), warnings
    raise SpecError(f"cannot make a .{kind} file")


def write_document(path: Path, root: Path, spec: dict, kind: str | None = None, overwrite: bool = False) -> dict:
    """Make ``path`` (already contained in the workspace by the caller) from ``spec``."""
    try:
        chosen = kind_of(path, kind)
        if path.suffix.lstrip(".").lower() != chosen and not (chosen == "md" and path.suffix.lower() == ".markdown"):
            if path.suffix:
                raise SpecError(f"the file name ends in {path.suffix} but the kind is {chosen}")
            path = path.with_suffix(f".{chosen}")
        data, warnings = render(chosen, spec)
    except SpecError as exc:
        return {"ok": False, "error": str(exc)}
    if path.exists() and not overwrite:
        return {"ok": False, "error": f"{path.name} already exists; say overwrite to replace it"}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return {
        "ok": True,
        "kind": chosen,
        "path": path.relative_to(root).as_posix() if root in path.parents else path.name,
        "bytes": len(data),
        "warnings": warnings,
    }


def spec_example(kind: str) -> Any:
    """A tiny valid spec, used in the tool's help so a model can see the shape."""
    return {
        "docx": {
            "title": "Report",
            "blocks": [{"type": "heading", "level": 1, "text": "Summary"}, {"type": "paragraph", "text": "..."}],
        },
        "xlsx": {"sheets": [{"name": "Data", "rows": [["Name", "Qty"], ["Pens", 3]]}]},
        "pptx": {"title": "Deck", "slides": [{"title": "Intro", "bullets": ["one", "two"]}]},
    }.get(kind)
