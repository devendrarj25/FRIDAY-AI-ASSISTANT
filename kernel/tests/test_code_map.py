"""The code map reads many languages offline, ranks by use, and says how it read each file."""

import asyncio
import importlib
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import code_map  # noqa: E402
from authority import Authority  # noqa: E402

pytest.importorskip("httpx", reason="tool registry needs the kernel runtime deps")
# Loaded by name: the repository root also has a ``tools`` folder that a static checker prefers.
_tools = importlib.import_module("tools")
MODEL_TOOL_PARAMS, RISK, SUMMARY, ToolRegistry = (
    _tools.MODEL_TOOL_PARAMS,
    _tools.RISK,
    _tools.SUMMARY,
    _tools.ToolRegistry,
)

FILES = {
    "core.py": "class Engine:\n    def run(self):\n        return 1\n\ndef helper_function():\n    return Engine()\n",
    "app.py": (
        "from core import Engine\n\ndef main():\n    engine = Engine()\n    return engine.run() + helper_function()\n"
    ),
    "cli.py": "from core import helper_function\n\ndef cli():\n    return helper_function()\n",
    "broken.py": "class Half:\n    def go(self):\n        if True:\n    def other(self):\n        pass\n",
    "web/index.ts": (
        "export interface Panel { id: string }\n"
        "export function renderPanel(p: Panel) { return p.id }\n"
        "export const showPanel = (p: Panel) => renderPanel(p)\n"
    ),
    "web/app.tsx": (
        "import { renderPanel } from './index'\nexport default function App() { return renderPanel({ id: 'a' }) }\n"
    ),
    "svc/main.go": "package main\n\nfunc Serve() {}\n\ntype Server struct{}\n",
    "svc/lib.rs": "pub struct Cache {}\npub fn warm_up() {}\nimpl Cache {}\n",
    "svc/App.cs": "namespace Demo {\n  public class Worker {\n    public void Execute() { }\n  }\n}\n",
    "svc/Job.java": "public class Job {\n  public void perform() { }\n}\n",
    "svc/engine.cpp": "#include <vector>\nclass Renderer {\n};\nint compute_total(int a) {\n  return a;\n}\n",
    "scripts/setup.ps1": "function Install-Thing {\n  Write-Output 'x'\n}\n",
    "scripts/run.cmd": "@echo off\n:build\necho hi\n",
    "scripts/deploy.sh": "deploy_now() {\n  echo hi\n}\n",
    "db/schema.sql": "CREATE TABLE users (id int);\nCREATE VIEW active_users AS SELECT 1;\n",
    "config/app.yaml": "server:\n  port: 1\nlogging:\n  level: info\n",
    "config/pyproject.toml": "[tool.ruff]\nline-length = 120\n",
    "Dockerfile": "FROM node:22 AS build\nFROM nginx\n",
    "Makefile": "build:\n\techo hi\n",
    "README.md": "# Title\n\n## Usage\n",
    "notes.xyz": "unknown extension\n",
    "image.dat": "binary\x00data",
    "blob.py": "x\x00y",
    ".env": "SECRET=abc\n",
    "server.pem": "-----BEGIN-----\n",
}


@pytest.fixture
def repo(tmp_path):
    for name, body in FILES.items():
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "dep.js").write_text("function ignored() {}\n")
    return tmp_path


def by_path(files):
    return {entry["path"]: entry for entry in files}


def names(entry):
    return [(row["kind"], row["name"]) for row in entry["symbols"]]


def test_every_listed_language_is_read_for_symbols(repo):
    found = by_path(code_map.scan(repo)["files"])
    assert ("class", "Engine") in names(found["core.py"])
    assert ("method", "run") in names(found["core.py"])
    assert ("interface", "Panel") in names(found["web/index.ts"])
    assert ("function", "renderPanel") in names(found["web/index.ts"])
    assert ("const", "showPanel") in names(found["web/index.ts"])
    assert ("func", "Serve") in names(found["svc/main.go"])
    assert ("type", "Server") in names(found["svc/main.go"])
    assert ("struct", "Cache") in names(found["svc/lib.rs"])
    assert ("fn", "warm_up") in names(found["svc/lib.rs"])
    assert ("class", "Worker") in names(found["svc/App.cs"])
    assert ("method", "Execute") in names(found["svc/App.cs"])
    assert ("class", "Job") in names(found["svc/Job.java"])
    assert ("class", "Renderer") in names(found["svc/engine.cpp"])
    assert ("function", "compute_total") in names(found["svc/engine.cpp"])
    assert ("function", "Install-Thing") in names(found["scripts/setup.ps1"])
    assert ("label", "build") in names(found["scripts/run.cmd"])
    assert ("function", "deploy_now") in names(found["scripts/deploy.sh"])
    assert ("table", "users") in names(found["db/schema.sql"])
    assert ("view", "active_users") in names(found["db/schema.sql"])
    assert ("key", "server") in names(found["config/app.yaml"])
    assert ("section", "tool.ruff") in names(found["config/pyproject.toml"])
    assert ("stage", "build") in names(found["Dockerfile"])
    assert ("target", "build") in names(found["Makefile"])
    assert ("heading", "Title") in names(found["README.md"])


def test_python_is_parsed_and_the_other_languages_are_labelled_as_an_outline(repo):
    found = by_path(code_map.scan(repo)["files"])
    assert found["core.py"]["reading"] == "parsed"
    assert found["web/index.ts"]["reading"] == "outline"
    assert found["svc/main.go"]["reading"] == "outline"


def test_a_python_file_that_does_not_compile_still_gives_its_symbols_and_says_partial(repo):
    broken = by_path(code_map.scan(repo)["files"])["broken.py"]
    assert broken["partial"] is True
    assert broken["reading"] == "outline"
    assert ("class", "Half") in names(broken)
    assert ("def", "other") in names(broken)


def test_credential_files_binaries_links_and_dependency_folders_are_not_read(repo):
    result = code_map.scan(repo)
    paths = set(by_path(result["files"]))
    assert ".env" not in paths and "server.pem" not in paths
    assert "image.dat" not in paths and "blob.py" not in paths
    assert not any(path.startswith("node_modules") for path in paths)
    assert result["skipped"]["credential file"] == 2
    assert result["skipped"]["skipped folder"] >= 1
    assert result["skipped"]["binary file"] == 1
    assert result["unsupported"] == {".dat": 1, ".xyz": 1}


def test_the_file_everything_uses_ranks_first(repo):
    result = code_map.build_map(repo, budget=4000)
    order = [line.split(" (")[0] for line in result["text"].splitlines() if " (" in line and not line.startswith(" ")]
    assert order[0] == "core.py"
    assert result["files"] >= 20
    assert result["languages"]["Python"] == 4


def test_a_focus_pulls_the_ranking_toward_it(repo):
    result = code_map.build_map(repo, budget=4000, focus=["web/"])
    first = next(line for line in result["text"].splitlines() if line.startswith("web/"))
    assert first.startswith("web/")
    top = [line.split(" (")[0] for line in result["text"].splitlines() if " (" in line and not line.startswith(" ")]
    assert top[0].startswith("web/")


def test_the_map_stays_inside_its_token_budget_and_says_what_it_left_out(repo):
    small = code_map.build_map(repo, budget=200)
    assert len(small["text"]) // 4 <= 200
    assert small["shown"] < small["files"]
    assert "more file(s) not shown" in small["text"]
    assert "Outline only" in small["text"]
    assert "Not read (no language entry): .dat x1, .xyz x1." in small["text"]
    assert "'partial' Python file" in small["text"]


def test_impact_walks_from_a_file_to_what_uses_it(repo):
    result = code_map.impact(repo, "core.py")
    reached = {row["path"]: row for row in result["reaches"]}
    assert set(reached) >= {"app.py", "cli.py"}
    assert reached["app.py"]["distance"] == 1
    assert "Engine" in reached["app.py"]["uses"]
    assert "names, not by a type checker" in result["note"]
    assert code_map.impact(repo, "svc/main.go")["reaches"] == []
    assert code_map.impact(repo, "nope.py")["ok"] is False


def test_a_data_format_never_joins_the_reference_graph(repo):
    files = code_map.scan(repo)["files"]
    edges = code_map.reference_graph(files)
    assert edges["config/app.yaml"] == {}
    assert all("config/app.yaml" not in out for out in edges.values())


def test_the_registry_loads_and_one_bad_entry_does_not_break_it(tmp_path):
    registry_file = tmp_path / "langs.json"
    registry_file.write_text(
        '{"languages": [{"id": "good", "name": "Good", "extensions": [".g"], "symbols": '
        '[{"kind": "thing", "pattern": "^thing (\\\\w+)"}]}, '
        '{"id": "bad", "name": "Bad", "extensions": [".b"], "symbols": [{"kind": "x", "pattern": "("}]}, '
        '{"missing": "id"}]}'
    )
    registry = code_map.load_registry(registry_file)
    assert [lang.id for lang in registry.languages] == ["good"]
    matched = registry.for_path(Path("a.G"))
    assert matched is not None and matched.id == "good"
    assert registry.for_path(Path("a.b")) is None
    shipped = code_map.load_registry()
    assert {"python", "typescript", "c", "csharp", "java", "go", "rust", "powershell", "sql"} <= {
        lang.id for lang in shipped.languages
    }


def test_the_map_tools_are_read_only_and_follow_the_read_scope(repo, tmp_path_factory):
    class Store:
        def enabled_tools(self):
            return {}

        def settings(self):
            return {}

    workspace = tmp_path_factory.mktemp("friday") / "workspace"
    reg = ToolRegistry(Store(), workspace, Authority("s"))
    for tool in ("code.map", "code.impact"):
        assert RISK[tool] == "safe" and tool in SUMMARY and tool in MODEL_TOOL_PARAMS
    outside = asyncio.run(reg.execute("code.map", {"path": str(repo)}))
    assert outside["ok"] is False and "outside the folders" in outside["error"]
    (workspace / "proj").mkdir()
    (workspace / "proj" / "a.py").write_text("def alpha():\n    return 1\n")
    (workspace / "proj" / "b.py").write_text("from a import alpha\n\ndef beta():\n    return alpha()\n")
    mapped = asyncio.run(reg.execute("code.map", {"path": "proj", "budget": 500}))
    assert mapped["ok"] is True and "a.py" in mapped["text"]
    hit = asyncio.run(reg.execute("code.impact", {"path": "proj", "file": "a.py"}))
    assert [row["path"] for row in hit["reaches"]] == ["b.py"]
