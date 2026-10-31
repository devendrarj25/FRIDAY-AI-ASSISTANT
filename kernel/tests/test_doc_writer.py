"""Documents FRIDAY makes must read back through the same extractor she uses on files she is given."""

from __future__ import annotations

import importlib
import json
import zipfile
from pathlib import Path

import doc_writer
import file_tools
import pytest


def make(tmp_path: Path, name: str, spec: dict, **kw) -> dict:
    return doc_writer.write_document(tmp_path / name, tmp_path, spec, **kw)


def test_docx_reads_back_with_every_block(tmp_path: Path) -> None:
    spec = {
        "title": "Quarterly report",
        "blocks": [
            {"type": "heading", "level": 1, "text": "Summary"},
            {"type": "paragraph", "text": "Sales rose.\nSecond line."},
            {"type": "bullets", "items": ["alpha", "beta"]},
            {"type": "numbered", "items": ["one", "two"]},
            {"type": "table", "rows": [["Item", "Qty"], ["Pens", 3]], "header": True},
            {"type": "code", "text": "print('x < y')"},
            {"type": "paragraph", "text": "हिन्दी और English साथ में"},
        ],
    }
    result = make(tmp_path, "r.docx", spec)
    assert result["ok"], result
    meta = file_tools.identify(tmp_path / "r.docx")
    assert meta["kind"] == "docx"
    text = file_tools.extract_text(tmp_path / "r.docx")["text"]
    for needle in ["Quarterly report", "Summary", "Sales rose.", "alpha", "two", "Pens", "x < y", "हिन्दी"]:
        assert needle in text, needle
    with zipfile.ZipFile(tmp_path / "r.docx") as z:
        assert z.testzip() is None
        assert z.namelist()[0] == "[Content_Types].xml"


def test_xlsx_keeps_numbers_and_never_evaluates_text(tmp_path: Path) -> None:
    spec = {
        "sheets": [
            {"name": "Data", "rows": [["Name", "Qty"], ["Pens", 3], ["=1+1", 2.5], ["a<b&c", True]]},
            {"name": "Data", "rows": [["x"]]},
        ]
    }
    assert make(tmp_path, "d.xlsx", spec)["ok"]
    assert file_tools.identify(tmp_path / "d.xlsx")["kind"] == "xlsx"
    text = file_tools.extract_text(tmp_path / "d.xlsx")["text"]
    assert "Pens\t3" in text and "=1+1\t2.5" in text and "a<b&c" in text
    with zipfile.ZipFile(tmp_path / "d.xlsx") as z:
        sheet = z.read("xl/worksheets/sheet1.xml").decode()
        assert "<f>" not in sheet  # no formula is ever written
        names = z.read("xl/workbook.xml").decode()
        assert "Data 2" in names  # a repeated sheet name is made unique


def test_pptx_reads_back(tmp_path: Path) -> None:
    spec = {"title": "Deck", "slides": [{"title": "Intro", "bullets": ["one", "two & three"]}, {"title": "End"}]}
    assert make(tmp_path, "d.pptx", spec)["ok"]
    assert file_tools.identify(tmp_path / "d.pptx")["kind"] == "pptx"
    text = file_tools.extract_text(tmp_path / "d.pptx")["text"]
    assert "Intro" in text and "two & three" in text and "End" in text


def test_pdf_is_a_valid_pdf_and_says_what_it_could_not_keep(tmp_path: Path) -> None:
    spec = {
        "title": "Plan",
        "blocks": [{"type": "paragraph", "text": "word " * 4000}, {"type": "paragraph", "text": "नमस्ते"}],
    }
    result = make(tmp_path, "p.pdf", spec)
    assert result["ok"] and result["warnings"] and "Latin-1" in result["warnings"][0]
    data = (tmp_path / "p.pdf").read_bytes()
    assert data.startswith(b"%PDF-1.4") and data.rstrip().endswith(b"%%EOF")
    assert file_tools.identify(tmp_path / "p.pdf")["kind"] == "pdf"
    assert data.count(b"/Type /Page ") >= 2  # long text flows onto more than one page
    # every xref offset points at its object
    start = int(data.rsplit(b"startxref\n", 1)[1].split(b"\n")[0])
    table = data[start:].split(b"\n")[2:]
    for number, row in enumerate(table[1:], 1):
        if not row.endswith(b" n "):
            break
        offset = int(row[:10])
        assert data[offset:].startswith(f"{number} 0 obj".encode())
    pytest.importorskip("pymupdf")
    assert "Plan" in file_tools.extract_text(tmp_path / "p.pdf")["text"]


def test_html_md_txt_csv_json(tmp_path: Path) -> None:
    spec = {
        "title": "T <x>",
        "blocks": [
            {"type": "paragraph", "text": "<script>alert(1)</script>"},
            {"type": "table", "rows": [["a", "b|c"], [1, 2]]},
        ],
    }
    assert make(tmp_path, "a.html", spec)["ok"]
    html = (tmp_path / "a.html").read_text(encoding="utf-8")
    assert "<script>" not in html and "&lt;script&gt;" in html and "<title>T &lt;x&gt;</title>" in html
    assert make(tmp_path, "a.md", spec)["ok"] and "b\\|c" in (tmp_path / "a.md").read_text(encoding="utf-8")
    assert make(tmp_path, "a.txt", spec)["ok"]
    assert make(tmp_path, "a.csv", {"rows": [["name", "note"], ["=cmd|' /C calc'!A0", "ok, fine"], ["-5", "x"]]})["ok"]
    csv_text = (tmp_path / "a.csv").read_bytes().decode("utf-8")
    assert "'=cmd" in csv_text and "\r\n-5," in csv_text  # a formula is defanged, a plain number is not
    assert make(tmp_path, "a.json", {"data": {"k": [1, "हिन्दी"]}})["ok"]
    assert json.loads((tmp_path / "a.json").read_text(encoding="utf-8")) == {"k": [1, "हिन्दी"]}


def test_refusals(tmp_path: Path) -> None:
    assert not make(tmp_path, "x.exe", {"blocks": [{"type": "paragraph", "text": "a"}]})["ok"]
    assert not make(tmp_path, "x.docx", {"blocks": []})["ok"]
    assert not make(tmp_path, "x.docx", {"blocks": [{"type": "video", "text": "a"}]})["ok"]
    assert not make(tmp_path, "x.xlsx", {"sheets": [{"rows": [["a"], "bad"]}]})["ok"]
    assert not make(tmp_path, "x.json", {})["ok"]
    assert not make(tmp_path, "x.docx", {"blocks": [{"type": "paragraph", "text": "a"}]}, kind="pdf")["ok"]
    assert make(tmp_path, "y.docx", {"blocks": [{"type": "paragraph", "text": "a"}]})["ok"]
    again = make(tmp_path, "y.docx", {"blocks": [{"type": "paragraph", "text": "b"}]})
    assert not again["ok"] and "overwrite" in again["error"]
    assert make(tmp_path, "y.docx", {"blocks": [{"type": "paragraph", "text": "b"}]}, overwrite=True)["ok"]


def test_control_characters_cannot_break_the_xml(tmp_path: Path) -> None:
    assert make(tmp_path, "c.docx", {"blocks": [{"type": "paragraph", "text": "a\x00b\x0bc"}]})["ok"]
    assert "abc" in file_tools.extract_text(tmp_path / "c.docx")["text"]


def test_the_planner_can_find_the_new_tools(tmp_path: Path) -> None:
    import asyncio  # noqa: F401  (the registry needs no loop here)

    from authority import Authority

    ToolRegistry = importlib.import_module("tools").ToolRegistry

    class Storage:
        def enabled_tools(self) -> dict:
            return {}

    registry = ToolRegistry(Storage(), workspace=tmp_path, authority=Authority("s"))
    assert "fs.make" in [t["name"] for t in registry.shortlist("make a Word document report")]
    assert "media.convert" in [t["name"] for t in registry.shortlist("convert this video to webm")]
    assert "media.probe" in [t["name"] for t in registry.shortlist("how long is this video")]


HINDI = {
    "title": "रिपोर्ट Report",
    "blocks": [
        {"type": "heading", "level": 1, "text": "सारांश"},
        {"type": "paragraph", "text": "यह एक हिंदी paragraph है. Brace { and \\ slash stay."},
        {"type": "bullets", "items": ["पहला", "second"]},
        {"type": "numbered", "items": ["एक", "two"]},
        {"type": "table", "rows": [["नाम", "Qty"], ["पेन", 3]], "header": True},
        {"type": "code", "text": "print('hi')"},
    ],
}


@pytest.mark.parametrize("name", ["note.odt", "note.epub"])
def test_odf_and_epub_keep_every_character_and_are_well_formed(tmp_path: Path, name: str) -> None:
    out = make(tmp_path, name, HINDI)
    assert out["ok"] and out["warnings"] == []
    path = tmp_path / name
    with zipfile.ZipFile(path) as archive:
        first = archive.infolist()[0]
        assert first.filename == "mimetype" and first.compress_type == zipfile.ZIP_STORED
        import xml.etree.ElementTree as ET

        for part in archive.namelist():
            if part.endswith((".xml", ".opf", ".xhtml")):
                ET.fromstring(archive.read(part))  # noqa: S314 - bytes this test just made
    text = file_tools.extract_text(path)["text"]
    for word in ("रिपोर्ट", "सारांश", "हिंदी", "पहला", "पेन", "second"):
        assert word in text


def test_rtf_escapes_unicode_and_control_characters(tmp_path: Path) -> None:
    out = make(tmp_path, "note.rtf", HINDI)
    assert out["ok"]
    raw = (tmp_path / "note.rtf").read_bytes()
    assert raw.isascii() and raw.startswith(b"{\\rtf1")
    body = raw.decode("ascii")
    assert "\\u2352?" in body  # र
    assert "Brace \\{ and \\\\ slash" in body
    assert body.count("{") - body.count("\\{") == body.count("}") - body.count("\\}")
    emoji = make(tmp_path, "emoji.rtf", {"blocks": [{"type": "paragraph", "text": "ok 😀"}]})
    assert emoji["ok"] and "\\u-10179?\\u-8704?" in (tmp_path / "emoji.rtf").read_text()


def test_the_new_kinds_are_listed_and_checked() -> None:
    for kind in ("rtf", "odt", "epub"):
        assert kind in doc_writer.KINDS
    assert doc_writer.render("epub", {"blocks": [{"type": "paragraph", "text": "x"}], "language": "hi"})[0][:2] == b"PK"


def test_rtf_reads_back_through_the_same_extractor(tmp_path: Path) -> None:
    make(tmp_path, "note.rtf", HINDI)
    got = file_tools.extract_text(tmp_path / "note.rtf")
    assert got["ok"] and got["kind"] == "rtf"
    for word in ("रिपोर्ट", "सारांश", "हिंदी", "पेन", "Brace { and \\ slash stay."):
        assert word in got["text"], word
    assert "Calibri" not in got["text"] and "fonttbl" not in got["text"]
    make(tmp_path, "emoji.rtf", {"blocks": [{"type": "paragraph", "text": "ok 😀"}]})
    assert "😀" in file_tools.extract_text(tmp_path / "emoji.rtf")["text"]


def test_identify_names_the_new_kinds(tmp_path: Path) -> None:
    for name, kind in (("a.odt", "odt"), ("a.epub", "epub"), ("a.rtf", "rtf")):
        make(tmp_path, name, HINDI)
        assert file_tools.identify(tmp_path / name)["kind"] == kind
