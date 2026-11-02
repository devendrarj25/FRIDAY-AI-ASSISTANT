import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import workspace  # noqa: E402


def _make(root: Path) -> None:
    (root / "docs").mkdir(parents=True)
    (root / "docs" / "plan.md").write_text("plan", "utf8")
    (root / "models").mkdir()
    (root / "models" / "tiny.gguf").write_text("x", "utf8")
    # FRIDAY's own heavy folders and Windows system folders: none of these may be walked.
    for name in ("runtime", "Cache", "SANDBOX", "temporary", "$RECYCLE.BIN", "node_modules", ".git"):
        (root / name / "lib").mkdir(parents=True)
        for i in range(5):
            (root / name / "lib" / f"f{i}.py").write_text("x", "utf8")


def test_scan_skips_machine_folders_in_any_case_and_keeps_the_owners_folders(tmp_path):
    root = tmp_path / "friday"
    _make(root)
    ws = workspace.Workspace(data_dir=tmp_path / "data")
    ws.set_root(str(root))
    out = ws.scan()
    assert out["files"] == 2  # docs/plan.md and models/tiny.gguf, nothing under the machine folders
    kinds = {Path(f["path"]).name: f["kind"] for f in out["detected"]}
    assert kinds.get("docs") == "docs"
    assert kinds.get("models") == "models"


def test_index_is_written_whole_and_only_when_something_changed(tmp_path):
    root = tmp_path / "friday"
    _make(root)
    ws = workspace.Workspace(data_dir=tmp_path / "data")
    ws.set_root(str(root))
    ws.scan()
    index = ws.state_file
    assert index.exists()
    assert not list(index.parent.glob("*.tmp"))
    first = index.stat().st_mtime_ns
    ws.scan()  # nothing changed: no rewrite
    assert index.stat().st_mtime_ns == first
    (root / "docs" / "new.md").write_text("n", "utf8")
    out = ws.scan()
    assert out["changedSinceLastRun"] == 1
    assert index.stat().st_mtime_ns != first


def test_a_damaged_index_is_a_fresh_start_not_a_crash(tmp_path):
    root = tmp_path / "friday"
    _make(root)
    ws = workspace.Workspace(data_dir=tmp_path / "data")
    ws.set_root(str(root))
    ws.state_file.parent.mkdir(parents=True, exist_ok=True)
    ws.state_file.write_text('{"half', "utf8")
    out = ws.scan()
    assert out["files"] == 2
