"""Identifying a file from its bytes, its name and its content: with the basis, never by running it."""

import json
import struct
import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import file_tools  # noqa: E402


def write(tmp_path, name, data):
    path = tmp_path / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data if isinstance(data, bytes) else data.encode("utf-8"))
    return path


def pe_bytes(*, machine=0x8664, dll=False, subsystem=3, signature=0, stamp=1_700_000_000):
    """A minimal PE32+ file: DOS header, PE signature, COFF header, optional header with data dirs."""
    optional = bytearray(240)
    struct.pack_into("<H", optional, 0, 0x20B)
    struct.pack_into("<H", optional, 68, subsystem)
    struct.pack_into("<I", optional, 112 + 4 * 8 + 4, signature)
    coff = struct.pack("<HHIIIHH", machine, 4, stamp, 0, 0, 240, 0x2022 if dll else 0x0022)
    dos = bytearray(128)
    dos[:2] = b"MZ"
    struct.pack_into("<I", dos, 0x3C, 128)
    return bytes(dos) + b"PE\x00\x00" + coff + bytes(optional)


def test_the_old_keys_are_unchanged_for_common_files(tmp_path):
    png = write(tmp_path, "a.png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 8 + struct.pack(">II", 640, 480) + b"\x00" * 20)
    got = file_tools.identify(png)
    assert (got["ok"], got["kind"], got["mime"], got["text"]) == (True, "png", "image/png", False)
    assert got["bytes"] == png.stat().st_size


def test_the_basis_and_confidence_say_how_sure_the_answer_is(tmp_path):
    magic = file_tools.identify(write(tmp_path, "x.pdf", b"%PDF-1.7\n"))
    assert (magic["basis"], magic["confidence"]) == ("magic", 0.95)
    by_name = file_tools.identify(write(tmp_path, "data.csv", "a,b\n1,2\n"))
    assert (by_name["basis"], by_name["kind"]) == ("extension", "csv")
    assert by_name["confidence"] < magic["confidence"]
    plain = file_tools.identify(write(tmp_path, "readme", "just some words\n"))
    assert (plain["kind"], plain["basis"]) == ("text", "content")
    blob = file_tools.identify(write(tmp_path, "mystery", b"\x00\x01\x02\xff" * 40))
    assert (blob["kind"], blob["confidence"]) == ("binary", 0.3)


def test_a_windows_program_is_described_from_its_headers_only(tmp_path):
    exe = file_tools.identify(write(tmp_path, "tool.exe", pe_bytes(signature=4096)))
    assert exe["kind"] == "windows-executable"
    details = exe["details"]
    assert details["format"] == "PE32+" and details["machine"] == "x64"
    assert details["kind"] == "program" and details["subsystem"] == "console"
    assert details["sections"] == 4 and details["linkerTime"] == "2023-11-14"
    assert details["signatureBlock"] is True
    assert "not verified" in details["note"]
    dll = file_tools.identify(write(tmp_path, "lib.dll", pe_bytes(dll=True, machine=0xAA64, subsystem=2)))
    assert dll["details"]["kind"] == "DLL" and dll["details"]["machine"] == "ARM64"
    assert dll["details"]["signatureBlock"] is False
    assert "warnings" not in exe


def test_a_program_wearing_another_name_is_flagged(tmp_path):
    got = file_tools.identify(write(tmp_path, "invoice.pdf", pe_bytes()))
    assert got["kind"] == "windows-executable"
    assert "disguised" in got["warnings"][0]
    bare = file_tools.identify(write(tmp_path, "report", pe_bytes()))
    assert "warnings" not in bare


def test_an_extension_that_disagrees_with_the_content_is_noted(tmp_path):
    got = file_tools.identify(write(tmp_path, "photo.png", b"%PDF-1.4\n"))
    assert got["kind"] == "pdf"
    assert got["warnings"] == ["the extension says .png but the content looks like pdf"]
    fine = file_tools.identify(write(tmp_path, "book.docx", b"PK\x03\x04" + b"\x00" * 30))
    assert "warnings" not in fine


def test_a_sqlite_file_is_summarised_from_its_header_without_opening_it(tmp_path):
    head = bytearray(100)
    head[:16] = b"SQLite format 3\x00"
    struct.pack_into(">H", head, 16, 4096)
    struct.pack_into(">I", head, 28, 12)
    struct.pack_into(">I", head, 56, 1)
    got = file_tools.identify(write(tmp_path, "friday.sqlite3", bytes(head) + b"\x00" * 4000))
    assert got["kind"] == "sqlite"
    assert got["details"] == {
        "pageSize": 4096,
        "pages": 12,
        "encoding": "UTF-8",
        "note": "header only; the database was not opened",
    }


def test_image_sizes_and_audio_length(tmp_path):
    gif = file_tools.identify(write(tmp_path, "a.gif", b"GIF89a" + struct.pack("<HH", 32, 16) + b"\x00" * 8))
    assert gif["details"] == {"width": 32, "height": 16}
    jpeg_body = b"\xff\xd8\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00" + b"\x00" * 9
    jpeg_body += b"\xff\xc0" + struct.pack(">H", 17) + b"\x08" + struct.pack(">HH", 200, 300) + b"\x00" * 10
    jpeg = file_tools.identify(write(tmp_path, "a.jpg", jpeg_body))
    assert jpeg["details"] == {"width": 300, "height": 200}
    fmt = struct.pack("<HHIIHH", 1, 2, 8000, 32000, 4, 16)
    wav_body = b"RIFF" + struct.pack("<I", 4 + 8 + 16 + 8 + 64000) + b"WAVE"
    wav_body += b"fmt " + struct.pack("<I", 16) + fmt + b"data" + struct.pack("<I", 64000) + b"\x00" * 64
    wav = file_tools.identify(write(tmp_path, "a.wav", wav_body))
    assert wav["details"] == {"channels": 2, "sampleRate": 8000, "bitsPerSample": 16, "seconds": 2.0}
    mp4 = file_tools.identify(write(tmp_path, "a.mp4", b"\x00\x00\x00\x18ftypisom" + b"\x00" * 20))
    assert mp4["details"] == {"brand": "isom"}
    mp3 = file_tools.identify(write(tmp_path, "a.mp3", b"ID3\x04\x00" + b"\x00" * 20))
    assert mp3["details"] == {"id3Version": "2.4.0"}


def test_notebooks_logs_certificates_and_keys(tmp_path):
    notebook = {
        "nbformat": 4,
        "metadata": {"kernelspec": {"language": "python"}},
        "cells": [{"cell_type": "code"}, {"cell_type": "code"}, {"cell_type": "markdown"}],
    }
    nb = file_tools.identify(write(tmp_path, "a.ipynb", json.dumps(notebook)))
    assert nb["kind"] == "jupyter-notebook"
    assert nb["details"] == {"nbformat": 4, "cells": {"code": 2, "markdown": 1}, "language": "python"}
    fake = file_tools.identify(write(tmp_path, "b.ipynb", '{"not": "a notebook"}'))
    assert fake["kind"] == "json"
    log = file_tools.identify(
        write(
            tmp_path,
            "svc.txt",
            "2026-01-01 10:00:00 INFO start\n2026-01-01 10:00:01 ERROR boom\n2026-01-01 10:00:02 INFO end\n",
        )
    )
    assert log["kind"] == "log"
    cert = file_tools.identify(
        write(tmp_path, "site.crt", "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n")
    )
    assert cert["kind"] == "certificate"
    key = file_tools.identify(
        write(tmp_path, "id.pem", "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n")
    )
    assert key["kind"] == "private-key"
    assert "does not open it" in key["warnings"][0]


def test_source_files_carry_their_language_from_the_registry(tmp_path):
    for name, language in (
        ("a.py", "Python"),
        ("a.ts", "TypeScript / JavaScript"),
        ("run.ps1", "PowerShell"),
        ("q.sql", "SQL"),
    ):
        got = file_tools.identify(write(tmp_path, name, "x\n"))
        assert got["language"] == language, name
    docker = file_tools.identify(write(tmp_path, "Dockerfile", "FROM node:22\n"))
    assert docker["language"] == "Dockerfile"


def test_an_office_zip_is_still_told_apart(tmp_path):
    path = tmp_path / "a.docx"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("word/document.xml", "<w/>")
    assert file_tools.identify(path)["kind"] == "docx"


def test_a_missing_file_and_a_folder(tmp_path):
    assert file_tools.identify(tmp_path / "nope")["ok"] is False
    folder = file_tools.identify(tmp_path)
    assert folder["kind"] == "folder" and folder["basis"] == "filesystem"


def test_a_truncated_pe_does_not_raise(tmp_path):
    for body in (b"MZ" + b"\x00" * 10, b"MZ" + b"\x00" * 62 + b"\xff\xff\xff\x7f", pe_bytes()[:140]):
        got = file_tools.identify(write(tmp_path, "t.exe", body))
        assert got["ok"] is True
        assert got["kind"] == "windows-executable"


@pytest.mark.parametrize("name", ["empty.bin", "empty.txt", "empty.py"])
def test_an_empty_file_is_fine(tmp_path, name):
    assert file_tools.identify(write(tmp_path, name, b""))["ok"] is True
