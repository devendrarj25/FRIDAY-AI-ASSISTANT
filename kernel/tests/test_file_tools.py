"""File, archive and container abilities: contained, bounded and approval-tiered."""

import asyncio
import sys
import tarfile
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import file_tools  # noqa: E402
import toolchain_gate  # noqa: E402
from authority import Authority  # noqa: E402

pytest.importorskip("httpx", reason="tool registry needs the kernel runtime deps")
from tools import MODEL_TOOL_PARAMS, RISK, SUMMARY, ToolRegistry  # noqa: E402


class _Storage:
    def enabled_tools(self):
        return {}


def run(coro):
    return asyncio.run(coro)


def registry(tmp_path):
    authority = Authority("test-secret")
    return ToolRegistry(_Storage(), tmp_path, authority), authority


def approved(reg, authority, name, args):
    return run(reg.execute(name, args, authority.issue(name, args, RISK[name])))


def test_every_new_tool_has_a_tier_and_a_summary():
    names = [n for n in RISK if n.startswith(("fs.", "archive.", "docker."))]
    assert {"fs.list", "fs.identify", "fs.extract", "archive.list", "archive.extract", "archive.create"} <= set(names)
    for name in names:
        assert SUMMARY[name]
    assert RISK["fs.delete"] == "write" and RISK["archive.extract"] == "write"
    assert RISK["docker.status"] == "safe" and RISK["docker.pull"] == "write" and RISK["docker.run"] == "exec"


def test_only_read_only_file_tools_are_offered_to_a_model():
    offered = {n for n in MODEL_TOOL_PARAMS if n.startswith(("fs.", "archive.", "docker."))}
    assert offered == {"fs.read", "fs.list", "fs.identify", "fs.extract", "archive.list"}
    assert all(RISK[n] == "safe" for n in offered)


def test_identify_reads_bytes_not_the_name(tmp_path):
    (tmp_path / "pic.txt").write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 32)
    (tmp_path / "notes.bin").write_text("hello", encoding="utf-8")
    (tmp_path / "data.json").write_text('{"a": 1}', encoding="utf-8")
    assert file_tools.identify(tmp_path / "pic.txt")["kind"] == "png"
    assert file_tools.identify(tmp_path / "notes.bin")["kind"] == "text"
    assert file_tools.identify(tmp_path / "data.json")["kind"] == "json"
    assert file_tools.identify(tmp_path / "missing")["ok"] is False


def test_zip_round_trip_through_the_registry(tmp_path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "a.txt").write_text("alpha", encoding="utf-8")
    (tmp_path / "src" / "b.txt").write_text("beta", encoding="utf-8")
    reg, authority = registry(tmp_path)
    made = approved(reg, authority, "archive.create", {"sources": ["src"], "to": "out.zip"})
    assert made["ok"] and made["files"] == 2
    listing = run(reg.execute("archive.list", {"path": "out.zip"}))
    assert listing["count"] == 2
    unpacked = approved(reg, authority, "archive.extract", {"path": "out.zip", "to": "back"})
    assert unpacked["ok"] and (tmp_path / "back" / "src" / "a.txt").read_text(encoding="utf-8") == "alpha"
    again = approved(reg, authority, "archive.extract", {"path": "out.zip", "to": "back"})
    assert again["ok"] is False and "already exists" in again["error"]


@pytest.mark.parametrize("suffix", [".tar", ".tar.gz", ".tar.bz2", ".tar.xz"])
def test_tar_family_round_trip(tmp_path, suffix):
    (tmp_path / "f.txt").write_text("data", encoding="utf-8")
    made = file_tools.create_archive([tmp_path / "f.txt"], tmp_path / f"pack{suffix}", tmp_path)
    assert made["ok"]
    out = file_tools.extract_archive(tmp_path / f"pack{suffix}", tmp_path / "x")
    assert out["ok"] and (tmp_path / "x" / "f.txt").read_text(encoding="utf-8") == "data"


def test_zip_slip_and_absolute_names_are_refused_before_writing(tmp_path):
    evil = tmp_path / "evil.zip"
    with zipfile.ZipFile(evil, "w") as archive:
        archive.writestr("ok.txt", "fine")
        archive.writestr("../escaped.txt", "bad")
    out = file_tools.extract_archive(evil, tmp_path / "dest")
    assert out["ok"] is False and out["cause"] == "refused"
    assert not (tmp_path / "escaped.txt").exists()
    drive = tmp_path / "drive.zip"
    with zipfile.ZipFile(drive, "w") as archive:
        archive.writestr("C:/Windows/x.txt", "bad")
    assert file_tools.extract_archive(drive, tmp_path / "d2")["ok"] is False


def test_tar_links_and_devices_are_refused(tmp_path):
    bomb = tmp_path / "link.tar"
    with tarfile.open(bomb, "w") as archive:
        info = tarfile.TarInfo("link")
        info.type = tarfile.SYMTYPE
        info.linkname = "/etc/passwd"
        archive.addfile(info)
    out = file_tools.extract_archive(bomb, tmp_path / "dest")
    assert out["ok"] is False and "not a plain file" in out["error"]


def test_an_archive_with_too_many_entries_is_refused(tmp_path, monkeypatch):
    monkeypatch.setattr(file_tools, "MAX_MEMBERS", 3)
    many = tmp_path / "many.zip"
    with zipfile.ZipFile(many, "w") as archive:
        for i in range(5):
            archive.writestr(f"{i}.txt", "x")
    out = file_tools.extract_archive(many, tmp_path / "dest")
    assert out["ok"] is False and "entries" in out["error"]


def test_a_corrupt_archive_is_reported_not_raised(tmp_path):
    broken = tmp_path / "broken.zip"
    broken.write_bytes(b"PK\x03\x04 not really a zip")
    out = file_tools.extract_archive(broken, tmp_path / "dest")
    assert out["ok"] is False and out["cause"] == "corrupt"


def test_paths_cannot_leave_the_workspace(tmp_path):
    reg, authority = registry(tmp_path / "ws")
    out = run(reg.execute("fs.list", {"path": ".."}))
    assert out["ok"] is False and "escapes" in out["error"]
    out = approved(reg, authority, "fs.copy", {"from": "../x", "to": "y"})
    assert out["ok"] is False


def test_a_write_tool_needs_an_authorization(tmp_path):
    reg, _ = registry(tmp_path)
    out = run(reg.execute("fs.delete", {"path": "a.txt"}))
    assert out["ok"] is False and out["risk"] == "write"


def test_delete_moves_to_trash_and_can_be_put_back(tmp_path):
    (tmp_path / "a.txt").write_text("keep me", encoding="utf-8")
    reg, authority = registry(tmp_path)
    out = approved(reg, authority, "fs.delete", {"path": "a.txt"})
    assert out["ok"] and not (tmp_path / "a.txt").exists()
    assert (tmp_path / out["trashedTo"]).read_text(encoding="utf-8") == "keep me"
    assert approved(reg, authority, "fs.delete", {"path": "."})["ok"] is False


def test_copy_move_and_find(tmp_path):
    (tmp_path / "a.txt").write_text("needle in a haystack", encoding="utf-8")
    reg, authority = registry(tmp_path)
    assert approved(reg, authority, "fs.copy", {"from": "a.txt", "to": "sub/b.txt"})["ok"]
    assert approved(reg, authority, "fs.copy", {"from": "a.txt", "to": "sub/b.txt"})["ok"] is False
    assert approved(reg, authority, "fs.move", {"from": "sub/b.txt", "to": "c.txt"})["ok"]
    hits = run(reg.execute("fs.find", {"contains": "NEEDLE", "pattern": "*.txt"}))
    assert sorted(row["path"] for row in hits["matches"]) == ["a.txt", "c.txt"]
    assert hits["matches"][0]["line"] == 1


def test_extract_text_reads_office_files_and_csv(tmp_path):
    docx = tmp_path / "d.docx"
    with zipfile.ZipFile(docx, "w") as archive:
        archive.writestr(
            "word/document.xml",
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            "<w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p><w:p><w:r><w:t>World</w:t></w:r></w:p></w:body></w:document>",
        )
    assert file_tools.identify(docx)["kind"] == "docx"
    assert file_tools.extract_text(docx)["text"] == "Hello\nWorld"
    xlsx = tmp_path / "s.xlsx"
    ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    with zipfile.ZipFile(xlsx, "w") as archive:
        archive.writestr("xl/workbook.xml", f"<workbook {ns}/>")
        archive.writestr("xl/sharedStrings.xml", f"<sst {ns}><si><t>name</t></si></sst>")
        archive.writestr(
            "xl/worksheets/sheet1.xml",
            f'<worksheet {ns}><sheetData><row><c t="s"><v>0</v></c><c><v>7</v></c></row></sheetData></worksheet>',
        )
    assert "name\t7" in file_tools.extract_text(xlsx)["text"]
    csv_file = tmp_path / "t.csv"
    csv_file.write_text("a,b\n1,2\n", encoding="utf-8")
    assert file_tools.extract_text(csv_file)["text"] == "a\tb\n1\t2"
    binary = tmp_path / "x.exe"
    binary.write_bytes(b"MZ" + b"\x00" * 64)
    assert file_tools.extract_text(binary)["ok"] is False


def test_docker_plan_is_scoped_and_validated(tmp_path):
    missing = toolchain_gate.plan_docker("status", {"docker": ""}, tmp_path)
    if not missing["ok"]:
        assert missing["cause"] == "missing" and "Install Manager" in missing["error"]
    plan = toolchain_gate.plan_docker(
        "run", {"docker": "docker", "image": "python:3.12-slim", "command": ["python", "-V"]}, tmp_path
    )
    argv = plan["argv"]
    assert argv[:3] == ["docker", "run", "--rm"]
    assert argv[argv.index("--network") + 1] == "none"
    assert "ALL" in argv and "no-new-privileges" in argv
    assert any(part.startswith("type=bind,src=") and part.endswith("dst=/work") for part in argv)
    assert argv[-3:] == ["python:3.12-slim", "python", "-V"]
    online = toolchain_gate.plan_docker("run", {"docker": "docker", "image": "alpine", "network": True}, tmp_path)
    assert online["argv"][online["argv"].index("--network") + 1] == "bridge"
    for bad in ("", "-v /:/h", "alpine; rm -rf /", "UPPER case"):
        assert toolchain_gate.plan_docker("pull", {"docker": "docker", "image": bad}, tmp_path)["ok"] is False
    assert (
        toolchain_gate.plan_docker("run", {"docker": "docker", "image": "alpine", "memory": "lots"}, tmp_path)["ok"]
        is False
    )
    long = toolchain_gate.plan_docker("run", {"docker": "docker", "image": "alpine", "timeout": 99999}, tmp_path)
    assert long["timeout"] == 1800


def test_docker_run_is_refused_without_authorization(tmp_path):
    reg, _ = registry(tmp_path)
    out = run(reg.execute("docker.run", {"image": "alpine"}))
    assert out["ok"] is False and out["risk"] == "exec"
