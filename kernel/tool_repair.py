"""What to try next when a tool call fails.

A model that is told only ``{"ok": false, "error": ...}`` often repeats the same call. This adds one short
``hint`` to a failed result: a deterministic next step chosen from the error text and the tool, never from the
model. The hint is data for the model's next turn; it cannot run anything and does not widen any permission.
A refusal by policy or by the owner's approval gate is never turned into a way around it: its hint says to ask
the owner in plain words.
"""

from __future__ import annotations

import re
from typing import Any

# (tool prefix or None, error pattern, hint). First match wins; more specific rows first.
_RULES: list[tuple[str | None, re.Pattern[str], str]] = [
    (
        None,
        re.compile(r"^refused:", re.I),
        "This is blocked by policy. Do not retry it; tell the owner what you wanted and why.",
    ),
    (
        None,
        re.compile(r"authoriz|approval|signed|token", re.I),
        "This needs the owner's approval. Ask him in plain words; do not retry on your own.",
    ),
    (
        None,
        re.compile(r"credentials|holds secrets", re.I),
        "That file is never opened. Work from what the owner pastes or describes instead.",
    ),
    (
        "fs.",
        re.compile(r"outside the (folders|workspace)|escapes the workspace", re.I),
        "Use a path inside the workspace, or ask the owner to add the folder to his readable or writable folders.",
    ),
    (
        "fs.make",
        re.compile(r"already exists", re.I),
        "Pick a new file name, or say overwrite if the owner wants it replaced.",
    ),
    (
        "fs.make",
        re.compile(r"spec|blocks|must be", re.I),
        "Check the spec shape for this kind (fs.make lists an example) and send it again with the fixed field.",
    ),
    (
        "fs.",
        re.compile(r"no such file|not found|does not exist|missing", re.I),
        "List the folder first (fs.list or fs.find) to get the exact name, then retry.",
    ),
    (
        "fs.",
        re.compile(r"too large|too big|exceeds", re.I),
        "Read it in parts or ask for a summary of one section instead of the whole file.",
    ),
    (
        "sqlite",
        re.compile(r"locked|busy", re.I),
        "The database is in use. Wait a moment and retry once; if it stays locked, ask the owner to close the app.",
    ),
    (
        "http.fetch",
        re.compile(r"private|loopback|metadata|ssrf", re.I),
        "Only public web addresses can be fetched. Use a public URL.",
    ),
    (
        "http.fetch",
        re.compile(r"timed? ?out|timeout", re.I),
        "The site was slow. Retry once; if it fails again, say the site is not answering.",
    ),
    (
        "http.fetch",
        re.compile(r"40[34]|forbidden|not found", re.I),
        "The site refused or has no such page. Try the site's main page or another source.",
    ),
    (
        "pip.",
        re.compile(r"no matching distribution|could not find a version", re.I),
        "Check the package name and the Python version, then retry with the exact name.",
    ),
    (
        "npm.",
        re.compile(r"e404|not found|enoent", re.I),
        "Check the package name, then retry. Look at package.json for the exact script name.",
    ),
    (
        None,
        re.compile(r"not recognized|command not found|no such command", re.I),
        "That program is not installed or not on the PATH. Check with where/which, or offer to install it.",
    ),
    (None, re.compile(r"timed? ?out|timeout", re.I), "It ran too long. Retry on a smaller input, or split the work."),
    (
        None,
        re.compile(r"permission denied|access is denied", re.I),
        "The system refused access. Tell the owner which path and what you needed.",
    ),
    (None, re.compile(r"unknown tool", re.I), "That tool does not exist. Use one from the tool list."),
]


def hint_for(tool: str, result: dict[str, Any]) -> str | None:
    if result.get("ok") is not False:
        return None
    error = str(result.get("error") or "")
    if not error:
        return None
    for prefix, pattern, hint in _RULES:
        if prefix is not None and not tool.startswith(prefix):
            continue
        if pattern.search(error):
            return hint
    return None


def with_hint(tool: str, result: dict[str, Any]) -> dict[str, Any]:
    if "hint" in result:
        return result
    hint = hint_for(tool, result)
    return {**result, "hint": hint} if hint else result
