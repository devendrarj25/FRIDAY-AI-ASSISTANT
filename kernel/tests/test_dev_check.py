"""dev.check tries a diff on a throwaway worktree: refuses protected files, compares before and after, cleans up."""

import subprocess
import sys
from pathlib import Path

import dev_check
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def git(repo: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", *args],
        cwd=repo,
        check=True,
        capture_output=True,
    )


@pytest.fixture()
def repo(tmp_path: Path) -> Path:
    git(tmp_path, "init", "-q")
    (tmp_path / "calc.py").write_text("def add(a, b):\n    return a + b\n", encoding="utf-8")
    (tmp_path / "test_calc.py").write_text(
        "from calc import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n", encoding="utf-8"
    )
    git(tmp_path, "add", "-A")
    git(tmp_path, "commit", "-q", "-m", "base")
    return tmp_path


BREAK = """--- a/calc.py
+++ b/calc.py
@@ -1,2 +1,2 @@
 def add(a, b):
-    return a + b
+    return a - b
"""

HARMLESS = """--- a/calc.py
+++ b/calc.py
@@ -1,2 +1,3 @@
+# adds two numbers
 def add(a, b):
     return a + b
"""


def worktrees(repo: Path) -> int:
    out = subprocess.run(["git", "worktree", "list"], cwd=repo, capture_output=True, text=True, check=True).stdout
    return len(out.strip().splitlines())


def test_regression_is_reported_and_the_repo_is_untouched(repo: Path) -> None:
    result = dev_check.check_proposal(repo, BREAK, "pytest")
    assert result["ok"] and result["verdict"] == "regressed"
    assert result["before"]["ok"] and not result["after"]["ok"]
    assert "return a + b" in (repo / "calc.py").read_text(encoding="utf-8")
    assert worktrees(repo) == 1


def test_harmless_change_passes_before_and_after(repo: Path) -> None:
    result = dev_check.check_proposal(repo, HARMLESS, "pytest")
    assert result["verdict"] == "unchanged-pass"
    assert result["files"] == ["calc.py"]


def test_a_fix_is_reported_as_fixed(repo: Path) -> None:
    (repo / "calc.py").write_text("def add(a, b):\n    return a - b\n", encoding="utf-8")
    git(repo, "commit", "-q", "-am", "bug")
    fix = BREAK.replace("a + b", "TMP").replace("a - b", "a + b").replace("TMP", "a - b")
    result = dev_check.check_proposal(repo, fix, "pytest")
    assert result["verdict"] == "fixed"


@pytest.mark.parametrize(
    "path",
    [
        "AGENTS.md",
        "config/friday-version.json",
        ".github/workflows/x.yml",
        "../escape.txt",
        "/etc/passwd",
        "kernel/authority.py",
    ],
)
def test_protected_paths_are_refused_before_anything_is_made(repo: Path, path: str) -> None:
    diff = f"--- a/{path}\n+++ b/{path}\n@@ -1 +1 @@\n-a\n+b\n"
    result = dev_check.check_proposal(repo, diff, "pytest")
    assert not result["ok"] and result["cause"] == "refused"
    assert worktrees(repo) == 1


def test_a_diff_that_does_not_apply_is_not_run(repo: Path) -> None:
    bad = BREAK.replace("return a + b", "return nothing here")
    result = dev_check.check_proposal(repo, bad, "pytest")
    assert not result["ok"] and result["applied"] is False
    assert worktrees(repo) == 1


def test_unknown_check_and_empty_proposal_are_refused(repo: Path) -> None:
    assert "check must be one of" in dev_check.check_proposal(repo, HARMLESS, "rm -rf /")["error"]
    assert not dev_check.check_proposal(repo, "", "pytest")["ok"]


def test_the_policy_files_are_read_from_governance(repo: Path) -> None:
    gov = repo / "src/lib/friday/self"
    gov.mkdir(parents=True)
    (gov / "governance.ts").write_text(
        'export const PROTECTED_POLICY_FILES: readonly string[] = [\n  "kernel/Secret.py",\n];\n', encoding="utf-8"
    )
    assert "kernel/secret.py" in dev_check.protected_files(repo)
