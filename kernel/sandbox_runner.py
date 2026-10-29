"""Run one command inside Windows Sandbox and bring the output back.

Windows Sandbox is a throwaway Windows: it starts from a clean image and is
destroyed when it closes. The workspace is mapped read-only at C:\\work, one
results folder is mapped writable at C:\\out, networking is off unless asked,
and the guest shuts itself down when the command ends. The command's output and
exit code come back through the results folder. Nothing here installs the
feature: when it is missing the caller is told to add it from the Install Manager.
"""

from __future__ import annotations

import os
import subprocess
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from xml.sax.saxutils import escape

SANDBOX_EXE = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "WindowsSandbox.exe"
RESULTS = ".friday-sandbox"
MAX_OUTPUT = 100_000


def available() -> bool:
    return os.name == "nt" and SANDBOX_EXE.exists()


def build_wsb(workspace: Path, results: Path, command: str, network: bool = False, memory_mb: int = 4096) -> str:
    """The .wsb configuration. The command runs under cmd; its output is captured to C:\\out."""
    if not command.strip():
        raise ValueError("command is empty")
    if "\n" in command or "\r" in command or "\x00" in command:
        raise ValueError("command must be a single line")
    memory = max(1024, min(int(memory_mb), 16384))
    inner = f"({command}) > C:\\out\\output.txt 2>&1 & echo %ERRORLEVEL% > C:\\out\\exit.txt & shutdown /s /t 0"
    logon = f'cmd /c "{inner}"'
    return (
        "<Configuration>\n"
        "  <VGpu>Disable</VGpu>\n"
        f"  <Networking>{'Default' if network else 'Disable'}</Networking>\n"
        "  <ProtectedClient>Enable</ProtectedClient>\n"
        f"  <MemoryInMB>{memory}</MemoryInMB>\n"
        "  <MappedFolders>\n"
        f"    <MappedFolder><HostFolder>{escape(str(workspace))}</HostFolder>"
        "<SandboxFolder>C:\\work</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>\n"
        f"    <MappedFolder><HostFolder>{escape(str(results))}</HostFolder>"
        "<SandboxFolder>C:\\out</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>\n"
        "  </MappedFolders>\n"
        f"  <LogonCommand><Command>{escape(logon)}</Command></LogonCommand>\n"
        "</Configuration>\n"
    )


def run(
    workspace: Path,
    command: str,
    network: bool = False,
    timeout: int = 300,
    launch: Callable[[list[str]], object] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    ready: bool | None = None,
) -> dict:
    """Start the sandbox and wait for its result files. `launch` and `ready` are injectable for tests."""
    if not (available() if ready is None else ready):
        return {
            "ok": False,
            "error": "Windows Sandbox is not available: enable it from the Install Manager (Windows Pro or Enterprise)",
            "cause": "missing",
            "fatal": False,
        }
    run_id = uuid.uuid4().hex[:12]
    results = workspace / RESULTS / run_id
    results.mkdir(parents=True, exist_ok=True)
    try:
        config = build_wsb(workspace.resolve(), results.resolve(), command, network)
    except ValueError as exc:
        return {"ok": False, "error": str(exc), "cause": "usage"}
    wsb = results / "run.wsb"
    wsb.write_text(config, encoding="utf-8")
    start = launch or (lambda argv: subprocess.Popen(argv))  # noqa: S603 - fixed executable, our own file
    start([str(SANDBOX_EXE), str(wsb)])
    deadline = time.monotonic() + max(30, min(int(timeout), 1800))
    exit_file = results / "exit.txt"
    while time.monotonic() < deadline:
        if exit_file.exists():
            break
        sleep(2)
    else:
        return {"ok": False, "error": "the sandbox did not finish in time", "cause": "timeout", "runId": run_id}
    output = ""
    out_file = results / "output.txt"
    if out_file.exists():
        output = out_file.read_text(encoding="utf-8", errors="replace")[-MAX_OUTPUT:]
    try:
        code = int(exit_file.read_text(encoding="utf-8", errors="ignore").strip() or "1")
    except ValueError:
        code = 1
    return {
        "ok": code == 0,
        "code": code,
        "stdout": output,
        "stderr": "",
        "error": None if code == 0 else output[-2000:] or f"exit code {code}",
        "runId": run_id,
    }
