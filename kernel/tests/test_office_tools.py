import asyncio
import importlib
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import doc_writer  # noqa: E402
import office_tools  # noqa: E402
from authority import Authority  # noqa: E402

ToolRegistry = importlib.import_module("tools").ToolRegistry


class _S:
    def enabled_tools(self):
        return {}

    def settings(self):
        return {}


def reg(tmp_path):
    (tmp_path / "workspace").mkdir()
    return ToolRegistry(_S(), tmp_path / "workspace", Authority("k"), root=tmp_path)


def run(coro):
    return asyncio.run(coro)


def pdf(tmp_path, name, pages):
    data, _ = doc_writer.render(
        "pdf", {"title": name, "blocks": [{"type": "paragraph", "text": "line " * 4000} for _ in range(pages)]}
    )
    path = tmp_path / name
    path.write_bytes(data)
    return path


# -------- table cleaning (pure, no extra dependency)


def test_cleaning_reports_exactly_what_it_changed():
    rows = [
        ["Name ", "Amount"],
        ["  Asha  Rao", "1,200"],
        ["", ""],
        ["Asha Rao", "1200"],
        ["Asha Rao", "1200"],
        ["Ravi", "x,y"],
    ]
    out, report = office_tools.clean_rows(rows)
    assert out == [["Name", "Amount"], ["Asha Rao", "1200"], ["Ravi", "x,y"]]
    assert report["empty_rows"] == 1 and report["duplicates"] == 2 and report["numbers"] == 1
    assert report["rows_in"] == 6 and report["rows_out"] == 3


def test_the_header_is_never_dropped_as_a_repeat():
    out, _ = office_tools.clean_rows([["A", "B"], ["A", "B"]])
    assert out == [["A", "B"]] or out[0] == ["A", "B"]
    assert len(out) >= 1


def test_clean_a_csv_and_an_xlsx_file(tmp_path):
    src = tmp_path / "in.csv"
    src.write_text('Name,Amt\n Asha ,"1,500"\n,\nAsha,1500\n', encoding="utf-8")
    result = office_tools.clean_table(src, tmp_path / "out.xlsx")
    assert result["ok"] and result["rows_out"] == 2
    again = office_tools.read_rows(tmp_path / "out.xlsx")
    assert again == [["Name", "Amt"], ["Asha", "1500"]]


def test_unknown_table_formats_are_refused(tmp_path):
    bad = tmp_path / "x.txt"
    bad.write_text("a")
    with pytest.raises(office_tools.JobError):
        office_tools.read_rows(bad)
    src = tmp_path / "in.csv"
    src.write_text("a,b\n1,2\n")
    with pytest.raises(office_tools.JobError):
        office_tools.clean_table(src, tmp_path / "out.pdf")


# -------- invoice (totals by code)


def test_invoice_totals_are_computed_not_estimated():
    spec, totals = office_tools.invoice_spec(
        {
            "number": "7",
            "currency": "INR",
            "tax_percent": 18,
            "items": [{"name": "Design", "qty": 3, "price": "1,999.99"}, {"name": "Fonts", "qty": 1, "price": 500}],
        }
    )
    assert totals == {"subtotal": "6499.97", "tax": "1169.99", "total": "7669.96", "currency": "INR"}
    assert spec["blocks"][1]["rows"][1] == ["Design", "3", "1999.99", "5999.97"]


def test_invoice_refuses_nonsense():
    for data in (
        {},
        {"items": []},
        {"items": [{"name": "", "price": 1}]},
        {"items": [{"name": "x", "qty": 0, "price": 1}]},
        {"items": [{"name": "x", "price": "abc"}]},
        {"tax_percent": 200, "items": [{"name": "x", "price": 1}]},
    ):
        with pytest.raises(office_tools.JobError):
            office_tools.invoice_spec(data)


def test_page_ranges():
    assert office_tools.parse_ranges("1-3, 5, 7-", 9) == [(1, 3), (5, 5), (7, 9)]
    for bad in ("0", "3-2", "10", "x", ""):
        with pytest.raises(office_tools.JobError):
            office_tools.parse_ranges(bad, 9)


# -------- through the tool


def test_doc_work_makes_a_verified_invoice_and_refuses_overwrite(tmp_path):
    tools = reg(tmp_path)
    args = {
        "op": "invoice",
        "out": "inv.docx",
        "data": {"number": "1", "items": [{"name": "Work", "qty": 2, "price": 10}], "tax_percent": 10},
    }
    made = run(tools._doc_work(args))
    assert made["ok"] and made["totals"]["total"] == "22.00" and made["verified"] is True
    again = run(tools._doc_work(args))
    assert again["ok"] is False and "already exists" in again["error"]
    assert run(tools._doc_work({**args, "overwrite": True}))["ok"]


def test_doc_work_reports_a_bad_job_as_a_sentence(tmp_path):
    tools = reg(tmp_path)
    assert "op must be" in run(tools._doc_work({"op": "dance"}))["error"]
    assert "where to save" in run(tools._doc_work({"op": "clean", "path": "a.csv"}))["error"]


def test_it_is_a_write_tier_tool_and_needs_an_authorization(tmp_path):
    tools = reg(tmp_path)
    assert tools.risk("doc.work") == "write"
    out = run(tools.execute("doc.work", {"op": "invoice"}))
    assert out["ok"] is False and out["risk"] == "write"


# -------- PDF (needs PyMuPDF, the optional reader the Install Manager offers)


def test_merge_and_split_pdfs(tmp_path):
    pytest.importorskip("pymupdf", reason="PDF merge and split need PyMuPDF")
    a, b = pdf(tmp_path, "a.pdf", 1), pdf(tmp_path, "b.pdf", 2)
    out = tmp_path / "ab.pdf"
    merged = office_tools.pdf_merge([a, b], out)
    assert merged["ok"] and merged["pages"] >= 3
    parts = office_tools.pdf_split(out, "1, 2-3", tmp_path / "parts")
    assert [p["pages"] for p in parts["files"]][0] == 1 and len(parts["files"]) == 2
    with pytest.raises(office_tools.JobError):
        office_tools.pdf_split(out, "9999", tmp_path / "parts")
    with pytest.raises(office_tools.JobError):
        office_tools.pdf_merge([a], tmp_path / "one.pdf")


def test_without_pymupdf_the_error_says_how_to_get_it(tmp_path, monkeypatch):
    monkeypatch.setitem(sys.modules, "pymupdf", None)
    with pytest.raises(office_tools.JobError, match="Install Manager"):
        office_tools.pdf_merge([tmp_path / "a.pdf", tmp_path / "b.pdf"], tmp_path / "o.pdf")
