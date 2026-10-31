"""Tool selection and argument validity, scored deterministically with no model.

Selection: for each request the tool a person would want must be in the planner's short list.
Arguments: every declared schema accepts a well-formed call and rejects the broken ones, and a model's bad
arguments come back as a plain message it can act on.
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402

pytest.importorskip("httpx", reason="tool registry needs the kernel runtime deps")
from authority import Authority  # noqa: E402

tools = pytest.importorskip("tools")


class _Storage:
    def enabled_tools(self):
        return {}


def _registry(tmp_path):
    return tools.ToolRegistry(_Storage(), workspace=tmp_path, authority=Authority("s"))


#: (request, tool that must be in the short list). English and Hinglish, read and write.
SELECTION = [
    ("read the sqlite database and list its tables", "sqlite.query"),
    ("how long is this video and which codec does it use", "media.probe"),
    ("turn this recording into text", "media.transcribe"),
    ("take a few still pictures out of the video", "media.frames"),
    ("make a word document from my notes", "fs.make"),
    ("extract the text from this pdf", "fs.extract"),
    ("convert the mp4 to mp3", "media.convert"),
    ("try this patch on a copy and run the tests", "dev.check"),
    ("map the code in this project", "code.map"),
    ("delete the old file", "fs.delete"),
    ("unzip the archive", "archive.extract"),
]


def test_the_right_tool_is_in_the_short_list(tmp_path):
    registry = _registry(tmp_path)
    misses = [
        f"{request!r} wanted {want}"
        for request, want in SELECTION
        if want not in [tool["name"] for tool in registry.shortlist(request, limit=5)]
    ]
    rate = 1 - len(misses) / len(SELECTION)
    assert rate >= 0.9, misses


def test_every_model_tool_declares_a_usable_schema():
    for tool, schema in tools.MODEL_TOOL_PARAMS.items():
        assert tool in tools.RISK, tool
        assert schema.get("type") == "object", tool
        props = schema.get("properties", {})
        assert set(schema.get("required", [])) <= set(props), tool
        for key, spec in props.items():
            assert spec.get("type") in {"string", "integer", "number", "boolean", "array", "object"}, (tool, key)


def _sample(spec):
    return {"string": "x", "integer": 3, "number": 1.5, "boolean": True, "array": ["x"], "object": {"a": 1}}[
        spec["type"]
    ]


def test_a_well_formed_call_passes_and_each_broken_one_is_named():
    for tool, schema in tools.MODEL_TOOL_PARAMS.items():
        props = schema.get("properties", {})
        good = {key: _sample(spec) for key, spec in props.items() if "enum" not in spec}
        for key, spec in props.items():
            if "enum" in spec:
                good[key] = spec["enum"][0]
        assert tools.validate_args(tool, good) == [], tool
        for key in schema.get("required", []):
            broken = {k: v for k, v in good.items() if k != key}
            assert any(key in problem for problem in tools.validate_args(tool, broken)), (tool, key)
        assert tools.validate_args(tool, "not an object") == ["arguments must be an object"]


def test_digit_strings_and_extra_keys_are_tolerated_but_wrong_types_are_not():
    assert tools.validate_args("sqlite.query", {"path": "a.db", "limit": "6", "extra": 1}) == []
    assert tools.validate_args("sqlite.query", {"path": "a.db", "limit": "many"})
    assert tools.validate_args("sqlite.query", {"path": 5})
    assert tools.validate_args("sqlite.query", {"path": "a.db", "limit": True})
    assert tools.validate_args("unknown.tool", {"anything": 1}) == []


def test_bad_arguments_from_a_model_come_back_as_a_message(tmp_path):
    registry = _registry(tmp_path)
    result = asyncio.run(registry.execute_for_model("sqlite_query", {"sql": "select 1"}))
    assert result["ok"] is False and "path is required" in result["error"]
