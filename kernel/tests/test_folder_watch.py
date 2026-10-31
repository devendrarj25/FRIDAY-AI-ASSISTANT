import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import folder_watch  # noqa: E402


def test_the_first_look_only_records_and_the_next_reports_new_files(tmp_path):
    folder = tmp_path / "Downloads"
    folder.mkdir()
    (folder / "old.pdf").write_text("x")
    state = tmp_path / "state.json"
    first = folder_watch.scan([folder], state)
    assert first["files"] == [] and first["baseline"] == [str(folder)]
    (folder / "invoice.pdf").write_text("x")
    second = folder_watch.scan([folder], state)
    assert [row["name"] for row in second["files"]] == ["invoice.pdf"]
    assert folder_watch.scan([folder], state)["files"] == []


def test_credential_and_hidden_files_are_never_listed(tmp_path):
    folder = tmp_path / "proj"
    folder.mkdir()
    state = tmp_path / "state.json"
    folder_watch.scan([folder], state)
    (folder / ".env").write_text("TOKEN=1")
    (folder / "server.pem").write_text("-----BEGIN-----")
    (folder / ".hidden").write_text("x")
    (folder / "notes.txt").write_text("x")
    assert [row["name"] for row in folder_watch.scan([folder], state)["files"]] == ["notes.txt"]


def test_a_missing_folder_is_not_an_error(tmp_path):
    out = folder_watch.scan([tmp_path / "gone"], tmp_path / "s.json")
    assert out["ok"] and out["files"] == []
