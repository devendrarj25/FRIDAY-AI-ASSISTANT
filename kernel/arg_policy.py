"""Per-tool argument policy.

A signed authorization says the owner approved *a* call of a tool. It does not say the arguments are sane: a
model that was talked into it (by a web page, a file, a screen) can still ask an approved ``shell.cmd`` to wipe a
drive. This module is a deterministic, model-free check of the arguments themselves, run in
``Tools.execute`` before the authorization token is spent. A refusal here is final for the call and explains
itself; it cannot be switched off by the autonomy dial, because these are commands no everyday task needs.

The rules are data (``RULES``), one list per tool, so adding one is a line and a test, not new control flow.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

Rule = tuple[str, re.Pattern[str]]


def _rules(*pairs: tuple[str, str]) -> list[Rule]:
    return [(why, re.compile(pattern, re.IGNORECASE)) for why, pattern in pairs]


# Commands no ordinary task needs, whatever the approval says.
_SHELL = _rules(
    (
        "recursive delete of a drive or system root",
        r"\b(rm\s+-[a-z]*r[a-z]*f?|rmdir\s+/s|rd\s+/s|del\s+/[a-z]*s[a-z]*)\b[^\n]*(\s|^)(/|[a-z]:\\?|%systemroot%|c:\\windows)(\s|$)",
    ),
    ("formatting or wiping a disk", r"\b(format\s+[a-z]:|diskpart|cipher\s+/w|mkfs\.|dd\s+if=[^\n]*of=/dev/)"),
    (
        "piping a download straight into a shell",
        r"(curl|wget|iwr|invoke-webrequest)[^\n|]*\|\s*(sh|bash|iex|invoke-expression|powershell|cmd)",
    ),
    (
        "running a downloaded string as code",
        r"invoke-expression\s*\(\s*(new-object\s+net\.webclient|iwr|invoke-webrequest)|iex\s*\(\s*(new-object|iwr)",
    ),
    ("encoded PowerShell, which hides what runs", r"powershell[^\n]*\s-(enc|encodedcommand)\b"),
    ("editing the boot configuration", r"\bbcdedit\b"),
    (
        "changing accounts or the registry hive of the machine",
        r"\bnet\s+user\b[^\n]*\s/add|reg\s+(delete|add)\s+hk(lm|ey_local_machine)",
    ),
    (
        "disabling the firewall or antivirus",
        r"netsh\s+advfirewall\s+set[^\n]*state\s+off|set-mppreference[^\n]*disable|sc\s+(stop|delete)\s+(windefend|mpssvc)",
    ),
    ("reading credential stores", r"\b(mimikatz|lsass|sekurlsa|reg\s+save\s+hk\w+\\sam)\b"),
)

_PYTHON = _rules(
    ("deleting a whole tree from the root", r"shutil\.rmtree\(\s*['\"](/|[a-z]:\\?)['\"]"),
    ("running a downloaded string as code", r"exec\(\s*(requests|urllib|httpx)[^\n]*\.(text|read\(\))"),
    ("reading credential stores", r"\b(mimikatz|sekurlsa)\b"),
)

_GIT_PUSH = _rules(
    ("a force push rewrites published history", r"(^|\s)(--force|-f|--force-with-lease|\+[\w/.-]+)(\s|$)"),
    ("main is never pushed to from here", r"(^|[\s:/])(main|master)(\s|$)"),
)

_SECRET_FILE = re.compile(
    r"(^|[\\/])(\.env(\.[\w-]+)?|id_(rsa|ed25519|ecdsa)|authorized_keys|known_hosts|\.npmrc|\.pypirc|credentials(\.json)?"
    r"|\.git[\\/]hooks[\\/][^\\/]+|safeStorage[^\\/]*)$",
    re.IGNORECASE,
)

RULES: dict[str, dict[str, list[Rule]]] = {
    "shell.cmd": {"command": _SHELL},
    "shell.powershell": {"command": _SHELL},
    "python.exec": {"code": _PYTHON, "script": _PYTHON},
    "git.push": {"branch": _GIT_PUSH, "args": _GIT_PUSH, "ref": _GIT_PUSH, "refspec": _GIT_PUSH},
}

# Tools whose path argument must not be a place secrets or hooks live.
_PATH_WRITERS = {"fs.write": ("path",), "fs.copy": ("dest", "to", "target"), "fs.move": ("dest", "to", "target")}


def _text(value: Any) -> str:
    if isinstance(value, (list, tuple)):
        return " ".join(str(item) for item in value)
    return str(value)


def _url_problem(url: str) -> str | None:
    if not re.match(r"^https?://", url, re.IGNORECASE):
        return "only http and https addresses can be fetched"
    if re.match(r"^https?://[^/?#]*@", url, re.IGNORECASE):
        return "an address with a user name or password inside it is refused"
    return None


def check(tool: str, args: dict[str, Any]) -> str | None:
    """Return why the call must not run, or ``None`` when its arguments are acceptable."""
    for field, rules in RULES.get(tool, {}).items():
        if field not in args:
            continue
        text = _text(args[field])
        for why, pattern in rules:
            if pattern.search(text):
                return f"refused: {why}"
    for field in _PATH_WRITERS.get(tool, ()):
        if field in args and _SECRET_FILE.search(_text(args[field])):
            return "refused: that path holds secrets or runs code on its own (a key file, .env or a git hook)"
    if tool == "http.fetch" and "url" in args:
        problem = _url_problem(_text(args["url"]))
        if problem:
            return f"refused: {problem}"
    return None


def explain() -> list[dict[str, Any]]:
    """The policy as data, for the Doctor page and the tests: tool, field, number of rules."""
    rows = [
        {"tool": tool, "field": field, "rules": [why for why, _ in rules]}
        for tool, fields in RULES.items()
        for field, rules in fields.items()
    ]
    rows += [
        {"tool": tool, "field": ",".join(fields), "rules": ["no key files, .env or git hooks"]}
        for tool, fields in _PATH_WRITERS.items()
    ]
    rows.append({"tool": "http.fetch", "field": "url", "rules": ["http(s) only, no inline credentials"]})
    return rows


Checker = Callable[[str, dict[str, Any]], str | None]
