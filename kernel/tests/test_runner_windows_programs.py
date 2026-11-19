"""The project runner on Windows: npm, npx, mvn, gradle, composer and bundle are .cmd or .bat files that
CreateProcess cannot start by their bare name, and MinGW's GNU make is called mingw32-make."""

import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import runner  # noqa: E402


def _which(table):
    return lambda name: table.get(name)


def test_a_cmd_shim_is_found_by_its_full_path_on_windows():
    which = _which({"npm": r"C:\Program Files\nodejs\npm.cmd"})
    assert runner.find_program("npm", which, windows=True) == r"C:\Program Files\nodejs\npm.cmd"
    assert runner.resolve_command(["npm", "start"], which, windows=True) == [
        r"C:\Program Files\nodejs\npm.cmd",
        "start",
    ]


def test_make_falls_back_to_mingw32_make_only_on_windows():
    which = _which({"mingw32-make": r"C:\gcc\bin\mingw32-make.exe"})
    assert runner.find_program("make", which, windows=True) == r"C:\gcc\bin\mingw32-make.exe"
    assert runner.find_program("make", which, windows=False) is None
    both = _which({"make": "/usr/bin/make", "mingw32-make": "x"})
    assert runner.find_program("make", both, windows=True) == "/usr/bin/make"


def test_a_missing_program_is_left_alone_so_the_error_names_it():
    assert runner.resolve_command(["gradle", "run"], _which({}), windows=True) == ["gradle", "run"]
    assert runner.resolve_command([], _which({}), windows=True) == []


def test_the_command_that_runs_is_resolved_and_the_command_shown_is_the_one_asked_for(monkeypatch, tmp_path):
    seen = {}

    def fake_run(command, **kwargs):
        seen["command"] = command
        return subprocess.CompletedProcess(command, 0, stdout="ok", stderr="")

    monkeypatch.setattr(runner.shutil, "which", lambda name: f"/opt/bin/{name}.cmd")
    monkeypatch.setattr(runner.subprocess, "run", fake_run)
    result = runner.ProjectRunner([tmp_path])._spawn(["mvn", "-q", "package"], str(tmp_path), 5)
    assert seen["command"] == ["/opt/bin/mvn.cmd", "-q", "package"]
    assert result["ok"] is True
    assert result["command"] == "mvn -q package"


def test_detection_counts_a_runtime_that_is_only_a_cmd_shim(monkeypatch, tmp_path):
    project = tmp_path / "app"
    project.mkdir()
    (project / "pom.xml").write_text("<project/>", encoding="utf-8")
    monkeypatch.setattr(runner.shutil, "which", lambda name: "C:/jdk/bin/java.exe" if name == "java" else None)
    found = runner.ProjectRunner([tmp_path]).detect()
    assert found[0]["runtime"] == "java"
    assert found[0]["runtimeInstalled"] is True
