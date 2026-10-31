import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import folder_access  # noqa: E402


def test_good_folders_are_resolved_and_deduplicated(tmp_path):
    a = tmp_path / "a"
    a.mkdir()
    out = folder_access.normalise("write_roots", [str(a), str(a), "  ", str(a / ".")])
    assert out == [str(a.resolve())]


@pytest.mark.parametrize(
    "bad",
    [["relative/path"], ["/definitely/not/here"], [str(Path.home())], [Path(Path.home().anchor).as_posix()]],
)
def test_unsafe_or_missing_folders_are_refused(bad):
    with pytest.raises(ValueError):
        folder_access.normalise("write_roots", bad)


def test_only_the_three_folder_lists_and_only_lists(tmp_path):
    with pytest.raises(ValueError, match="not a folder list"):
        folder_access.normalise("theme", [])
    with pytest.raises(ValueError, match="list"):
        folder_access.normalise("read_roots", str(tmp_path))


def test_the_list_is_capped(tmp_path):
    folders = []
    for i in range(folder_access.MAX_FOLDERS + 1):
        d = tmp_path / f"f{i}"
        d.mkdir()
        folders.append(str(d))
    with pytest.raises(ValueError, match="at most"):
        folder_access.normalise("read_roots", folders)
