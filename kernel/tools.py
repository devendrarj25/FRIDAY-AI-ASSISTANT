"""Tool registry. Every tool declares a risk level; anything above `safe`
requires explicit approval from the desktop UI before it executes."""

from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path

import httpx

import control
import devices_android
import devices_bluetooth
import devices_network
import toolchain_gate
from authority import Authority

# Subprocess environment scrubbing and SSRF screening live in one shared
# module so every spawner and fetcher in the kernel enforces the same rule.
from env_guard import child_env, guard_public_url  # noqa: F401  (re-exported)

RISK = {
    "fs.read": "safe",
    # Fetching a URL is an outbound download. Owner rules require a fresh ask
    # before anything is pulled from the internet — planner/tool.exec mint a
    # token; models cannot call this mid-answer.
    "http.fetch": "write",
    "fs.write": "write",
    "git": "write",
    "shell.cmd": "exec",
    "shell.powershell": "exec",
    "python.exec": "exec",
    "test.run": "exec",
    # PC / application control — same tier as shell.cmd: always approved first.
    "app.launch": "exec",
    "app.focus": "exec",
    "app.close": "exec",
    "app.list_windows": "exec",
    "input.type": "exec",
    "input.hotkey": "exec",
    "input.click": "exec",
    "input.scroll": "exec",
    "input.drag": "exec",
    "clipboard.read": "exec",
    "clipboard.write": "exec",
    "screen.read_text": "exec",
    "screen.perceive": "exec",
    # Other devices (cable / Bluetooth / same-WiFi). Listing is read-only;
    # anything that acts on another device is exec-tier and approved first.
    "android.list": "safe",
    "android.open_app": "exec",
    "android.input": "exec",
    "android.transfer": "exec",
    "android.mirror": "exec",
    "bluetooth.list": "safe",
    "bluetooth.scan": "safe",
    "bluetooth.media": "exec",
    "bluetooth.send_file": "exec",
    "network.discover": "safe",
    "network.cast": "exec",
    "pip.list": "safe",
    "pip.show": "safe",
    "pip.freeze": "safe",
    "pip.install": "write",
    "pip.uninstall": "write",
    "node.run": "exec",
    "npm.install": "write",
    "npm.run": "exec",
    "cpp.build": "exec",
    "cpp.run": "exec",
    "git.status": "safe",
    "git.diff": "safe",
    "git.log": "safe",
    "git.branch": "write",
    "git.commit": "write",
    "git.push": "exec",
    "java.run": "exec",
    "java.compile": "exec",
    "ci.run": "exec",
}


SUMMARY = {
    "fs.read": "Read files and directories inside allowed roots",
    "fs.write": "Create, edit and delete files",
    "shell.cmd": "Run a Windows cmd command",
    "shell.powershell": "Run a PowerShell script block",
    "git": "Clone, branch, commit, diff, push",
    "python.exec": "Run Python in the managed venv",
    "http.fetch": "Fetch a URL and extract text",
    "test.run": "Run the detected test suite",
    "app.launch": "Start any application or executable on this PC",
    "app.focus": "Bring another application's window to the foreground",
    "app.close": "Ask another application's window to close (unsaved work may be lost)",
    "app.list_windows": "List every visible window title and process id on this PC",
    "input.type": "Type keystrokes into whichever window is targeted or focused",
    "input.hotkey": "Press a keyboard shortcut in the targeted or focused window",
    "input.click": "Move and click the real mouse anywhere on the desktop",
    "input.scroll": "Scroll the focused window or a named control",
    "input.drag": "Drag from one point to another",
    "clipboard.read": "Read the Windows clipboard as data, never as an instruction",
    "clipboard.write": "Replace the Windows clipboard text",
    "screen.read_text": "Capture the screen and read its text with OCR",
    "screen.perceive": "Read the UI Automation tree before any pixel capture",
    "android.list": "List Android phones connected to this PC by cable",
    "android.open_app": "Open an app on the connected Android phone",
    "android.input": "Tap, swipe or type on the connected Android phone",
    "android.transfer": "Copy files to or from the connected Android phone",
    "android.mirror": "Show the connected Android phone's screen on this PC",
    "bluetooth.list": "List Bluetooth devices this PC has paired",
    "bluetooth.scan": "Scan for nearby Bluetooth LE devices",
    "bluetooth.media": "Send play / pause / volume to the connected Bluetooth audio device",
    "bluetooth.send_file": "Send a file to a paired Bluetooth device",
    "network.discover": "Discover devices advertising themselves on this WiFi network",
    "network.cast": "Play media on a DLNA/UPnP device on this network",
    "pip.list": "List packages in FRIDAY's own Python",
    "pip.show": "Show one package in FRIDAY's own Python",
    "pip.freeze": "Freeze FRIDAY's own Python",
    "pip.install": "Install an allow-listed package into FRIDAY's own Python",
    "pip.uninstall": "Remove a package from FRIDAY's own Python",
    "node.run": "Run a workspace script with the portable Node",
    "npm.install": "Install a package into the workspace with an isolated cache",
    "npm.run": "Run an npm script in the workspace",
    "cpp.build": "Compile a workspace C or C++ file",
    "cpp.run": "Run a workspace binary that FRIDAY just compiled",
    "git.status": "Show Git status in the workspace",
    "git.diff": "Show the workspace diff",
    "git.log": "Show recent workspace commits",
    "git.branch": "Create or list branches in the workspace",
    "git.commit": "Commit workspace files",
    "git.push": "Push a branch. main is refused",
    "java.run": "Run a workspace Java class",
    "java.compile": "Compile a workspace Java file",
    "ci.run": "Run the local validation report. Hosted workflows are not dispatched",
}



#: JSON-Schema arguments for the tools a MODEL is allowed to call on its own.
#: Only "safe" (read-only) tools live here: anything that writes, executes or
#: touches another device stays with the planner, which mints an owner-approved
#: authorization first. A model can therefore look things up by itself, but it
#: can never act on the PC without the owner's approval.
MODEL_TOOL_PARAMS: dict[str, dict] = {
    "fs.read": {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Path relative to the FRIDAY workspace root.",
            }
        },
        "required": ["path"],
    },
    "android.list": {"type": "object", "properties": {}},
    "bluetooth.list": {"type": "object", "properties": {}},
    "bluetooth.scan": {
        "type": "object",
        "properties": {"seconds": {"type": "number", "description": "Scan duration."}},
    },
    "network.discover": {"type": "object", "properties": {}},
}

#: OpenAI/Anthropic tool names allow [A-Za-z0-9_-] only, so the dotted FRIDAY
#: id is flattened on the wire and mapped back before execution.
def wire_name(tool: str) -> str:
    return tool.replace(".", "_")


def from_wire_name(name: str) -> str:
    for tool in MODEL_TOOL_PARAMS:
        if wire_name(tool) == name:
            return tool
    return name.replace("_", ".", 1)


class ToolRegistry:
    def __init__(self, storage, workspace: Path, authority: Authority | None = None) -> None:
        self.storage = storage
        self.authority = authority or Authority()
        self.workspace = Path(workspace)
        self.workspace.mkdir(parents=True, exist_ok=True)

    def describe(self) -> list[dict]:
        enabled = self.storage.enabled_tools()
        return [
            {"name": n, "summary": SUMMARY[n], "risk": RISK[n], "enabled": enabled.get(n, RISK[n] != "exec")}
            for n in RISK
        ]

    def model_schemas(self) -> list[dict]:
        """OpenAI-shaped function tools the model may call during a chat turn.

        Disabled tools are left out, so the owner's Settings switches decide
        what a model can reach exactly as they do for the planner.
        """
        enabled = self.storage.enabled_tools()
        out: list[dict] = []
        for tool, params in MODEL_TOOL_PARAMS.items():
            if not enabled.get(tool, RISK.get(tool) != "exec"):
                continue
            out.append(
                {
                    "type": "function",
                    "function": {
                        "name": wire_name(tool),
                        "description": SUMMARY.get(tool, tool),
                        "parameters": params,
                    },
                }
            )
        return out

    async def execute_for_model(self, wire: str, args: dict) -> dict:
        """Run one model-requested tool. Read-only tools only, fail-closed."""
        tool = from_wire_name(str(wire))
        if tool not in MODEL_TOOL_PARAMS or self.risk(tool) != "safe":
            return {
                "ok": False,
                "error": (
                    f"{tool} needs the owner's approval — ask him to run it, "
                    "or use a read-only tool instead"
                ),
            }
        return await self.execute(tool, args if isinstance(args, dict) else {})

    def risk(self, name: str) -> str:
        return RISK.get(name, "exec")

    def _resolve(self, rel: str) -> Path:
        """Contain a path inside the workspace.

        A string prefix test is not containment: "<root>-evil" starts with
        "<root>". Real containment compares resolved path COMPONENTS.
        """
        root = self.workspace.resolve()
        target = (root / rel).resolve()
        if target != root and root not in target.parents:
            raise PermissionError("path escapes the workspace root")
        return target

    async def execute(self, name: str, args: dict, authorization: str | None = None) -> dict:
        """Run one tool.

        Anything above the "safe" tier needs a signed, single-use
        authorization. A caller can no longer approve itself: the token is
        minted by the desktop main process (owner policy / approval prompt) or
        by the planner after the owner approved that exact step.
        """
        if self.risk(name) != "safe":
            ok, reason = self.authority.verify(authorization, name, args)
            if not ok:
                return {"ok": False, "error": reason, "risk": self.risk(name)}
        try:
            handler = getattr(self, "_" + name.replace(".", "_"))
        except AttributeError:
            return {"ok": False, "error": f"unknown tool {name}"}
        try:
            return await handler(args)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    async def _fs_read(self, args: dict) -> dict:
        path = self._resolve(args["path"])
        if path.is_dir():
            return {"ok": True, "entries": sorted(p.name for p in path.iterdir())}
        return {"ok": True, "content": path.read_text(encoding="utf-8", errors="replace")}

    async def _fs_write(self, args: dict) -> dict:
        path = self._resolve(args["path"])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(args["content"], encoding="utf-8")
        return {"ok": True, "bytes": len(args["content"])}

    async def _http_fetch(self, args: dict) -> dict:
        """Fetch a page. Write-tier: needs a signed owner authorization.
        Every hop is still screened for SSRF (loopback, private, metadata)."""
        url = str(args["url"])
        guard_public_url(url)
        async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
            resp = await client.get(url)
            for _ in range(5):
                if not resp.is_redirect:
                    break
                target = str(resp.next_request.url) if resp.next_request else ""
                if not target:
                    break
                guard_public_url(target)  # a redirect is a fresh request
                resp = await client.get(target)
        return {"ok": resp.is_success, "status": resp.status_code, "text": resp.text[:200_000]}

    async def _run(
        self,
        cmd: list[str] | str,
        shell: bool = False,
        cwd: Path | None = None,
        timeout: int = 900,
    ) -> dict:
        proc = await asyncio.to_thread(
            subprocess.run,
            cmd,
            shell=shell,
            cwd=str(cwd or self.workspace),
            capture_output=True,
            text=True,
            timeout=timeout,
            env=child_env(),
        )
        return {
            "ok": proc.returncode == 0,
            "code": proc.returncode,
            "stdout": proc.stdout[-100_000:],
            "stderr": proc.stderr[-100_000:],
            "error": None if proc.returncode == 0 else proc.stderr[-2_000:],
        }

    async def _shell_cmd(self, args: dict) -> dict:
        return await self._run(args["command"], shell=True)

    async def _shell_powershell(self, args: dict) -> dict:
        return await self._run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", args["command"]]
        )

    async def _git(self, args: dict) -> dict:
        return await self._run(["git", *args["args"]])

    async def _python_exec(self, args: dict) -> dict:
        return await self._run(["python", "-c", args["code"]])

    async def _test_run(self, args: dict) -> dict:
        return await self._run(args.get("command", "npm test"), shell=True)

    # ---------------------------------------------------------- PC control
    # All of these are "exec" risk in RISK above, so `execute()` refuses to run
    # them until the desktop approval prompt returns approved=True.

    async def _app_launch(self, args: dict) -> dict:
        return await asyncio.to_thread(
            control.launch_app, args.get("app", ""), args.get("args"), args.get("cwd")
        )

    async def _app_focus(self, args: dict) -> dict:
        return await asyncio.to_thread(control.focus_window, args.get("title"), args.get("hwnd"))

    async def _app_close(self, args: dict) -> dict:
        return await asyncio.to_thread(control.close_window, args.get("title"), args.get("hwnd"))

    async def _app_list_windows(self, args: dict) -> dict:
        return await asyncio.to_thread(control.list_windows)

    async def _input_type(self, args: dict) -> dict:
        return await asyncio.to_thread(
            control.type_text,
            args.get("text", ""),
            args.get("target"),
            args.get("hwnd"),
            float(args.get("interval", 0.01)),
        )

    async def _input_hotkey(self, args: dict) -> dict:
        return await asyncio.to_thread(
            control.hotkey, args.get("keys") or [], args.get("target"), args.get("hwnd")
        )

    async def _input_click(self, args: dict) -> dict:
        return await asyncio.to_thread(
            control.click,
            args.get("x"),
            args.get("y"),
            args.get("button", "left"),
            int(args.get("clicks", 1)),
            args.get("target"),
            args.get("hwnd"),
        )

    async def _input_scroll(self, args: dict) -> dict:
        return await asyncio.to_thread(
            control.scroll,
            int(args.get("amount", args.get("clicks", -3))),
            args.get("x"),
            args.get("y"),
            args.get("target"),
            args.get("hwnd"),
        )

    async def _input_drag(self, args: dict) -> dict:
        return await asyncio.to_thread(
            control.drag,
            int(args.get("x", 0)),
            int(args.get("y", 0)),
            int(args.get("x2", args.get("toX", 0))),
            int(args.get("y2", args.get("toY", 0))),
            args.get("target"),
            args.get("hwnd"),
        )

    async def _clipboard_read(self, args: dict) -> dict:
        return await asyncio.to_thread(control.clipboard_read)

    async def _clipboard_write(self, args: dict) -> dict:
        return await asyncio.to_thread(control.clipboard_write, args.get("text", ""))

    async def _screen_perceive(self, args: dict) -> dict:
        return await asyncio.to_thread(control.perceive)

    async def _screen_read_text(self, args: dict) -> dict:
        return await asyncio.to_thread(
            control.read_text, args.get("region"), args.get("lang", "eng")
        )

    # ------------------------------------------------- other devices (A1–A3)
    # Cable / Bluetooth / same-WiFi. FRIDAY never stores or replays another
    # device's unlock credential: platform trust (adb authorization, OS
    # pairing) is the only thing that grants access.

    async def _android_list(self, args: dict) -> dict:
        return await asyncio.to_thread(devices_android.list_devices)

    async def _android_open_app(self, args: dict) -> dict:
        return await asyncio.to_thread(
            devices_android.open_app, args.get("app", ""), args.get("serial")
        )

    async def _android_input(self, args: dict) -> dict:
        action = args.get("action", "tap")
        serial = args.get("serial")
        if action == "text":
            return await asyncio.to_thread(devices_android.type_text, args.get("text", ""), serial)
        if action == "swipe":
            return await asyncio.to_thread(
                devices_android.swipe,
                int(args.get("x1", 0)), int(args.get("y1", 0)),
                int(args.get("x2", 0)), int(args.get("y2", 0)),
                int(args.get("ms", 300)), serial,
            )
        return await asyncio.to_thread(
            devices_android.tap, int(args.get("x", 0)), int(args.get("y", 0)), serial
        )

    async def _android_transfer(self, args: dict) -> dict:
        if args.get("direction") == "pull":
            return await asyncio.to_thread(
                devices_android.pull, args["remote"], args["local"], args.get("serial")
            )
        return await asyncio.to_thread(
            devices_android.push, args["local"], args["remote"], args.get("serial")
        )

    async def _android_mirror(self, args: dict) -> dict:
        return await asyncio.to_thread(devices_android.mirror, args.get("serial"))

    async def _bluetooth_list(self, args: dict) -> dict:
        return await asyncio.to_thread(devices_bluetooth.paired_devices)

    async def _bluetooth_scan(self, args: dict) -> dict:
        return await asyncio.to_thread(devices_bluetooth.scan, float(args.get("seconds", 6)))

    async def _bluetooth_media(self, args: dict) -> dict:
        return await asyncio.to_thread(devices_bluetooth.media, args.get("command", "play"))

    async def _bluetooth_send_file(self, args: dict) -> dict:
        return await asyncio.to_thread(
            devices_bluetooth.send_file, args["path"], args.get("device", "")
        )

    async def _network_discover(self, args: dict) -> dict:
        kind = args.get("kind", "all")
        result: dict = {"ok": True, "mdns": [], "dlna": [], "self": devices_network.lan_address()}
        if kind in ("all", "mdns"):
            found = await asyncio.to_thread(devices_network.discover_mdns, float(args.get("seconds", 4)))
            result["mdns"] = found.get("devices", [])
            if not found.get("ok"):
                result["mdnsError"] = found.get("error")
        if kind in ("all", "dlna"):
            found = await asyncio.to_thread(devices_network.discover_dlna, float(args.get("seconds", 3)))
            result["dlna"] = found.get("devices", [])
            if not found.get("ok"):
                result["dlnaError"] = found.get("error")
        return result

    async def _network_cast(self, args: dict) -> dict:
        if args.get("stop"):
            return await asyncio.to_thread(devices_network.stop, args["controlUrl"])
        return await asyncio.to_thread(
            devices_network.cast, args["controlUrl"], args.get("mediaUrl", "")
        )

    async def _planned(self, plan: dict) -> dict:
        if not plan.get("ok") or plan.get("dryRun") or not plan.get("argv"):
            return plan
        timeout = int(plan.get("timeout") or 900)
        return await self._run(plan["argv"], cwd=Path(plan["cwd"]) if plan.get("cwd") else None, timeout=timeout)

    async def _pip_list(self, args: dict) -> dict:
        return await self._planned(toolchain_gate.plan_pip("list", args, self.workspace))

    async def _pip_show(self, args: dict) -> dict:
        return await self._planned(toolchain_gate.plan_pip("show", args, self.workspace))

    async def _pip_freeze(self, args: dict) -> dict:
        return await self._planned(toolchain_gate.plan_pip("freeze", args, self.workspace))

    async def _pip_install(self, args: dict) -> dict:
        return await self._planned(toolchain_gate.plan_pip("install", args, self.workspace))

    async def _pip_uninstall(self, args: dict) -> dict:
        return await self._planned(toolchain_gate.plan_pip("uninstall", args, self.workspace))

    async def _node_run(self, args: dict) -> dict:
        return await self._planned(toolchain_gate.plan_node("script", args, self.workspace))

    async def _npm_install(self, args: dict) -> dict:
        return await self._planned(toolchain_gate.plan_node("install", args, self.workspace))

    async def _npm_run(self, args: dict) -> dict:
        return await self._planned(toolchain_gate.plan_node("npm-run", args, self.workspace))

    async def _cpp_build(self, args: dict) -> dict:
        return await self._planned(toolchain_gate.plan_cpp("build", args, self.workspace))

    async def _cpp_run(self, args: dict) -> dict:
        return await self._planned(toolchain_gate.plan_cpp("run", args, self.workspace))

    async def _git_status(self, args: dict) -> dict:
        return await self._planned(toolchain_gate.plan_git("status", args, self.workspace))

    async def _git_diff(self, args: dict) -> dict:
        return await self._planned(toolchain_gate.plan_git("diff", args, self.workspace))

    async def _git_log(self, args: dict) -> dict:
        return await self._planned(toolchain_gate.plan_git("log", args, self.workspace))

    async def _git_branch(self, args: dict) -> dict:
        return await self._planned(toolchain_gate.plan_git("branch", args, self.workspace))

    async def _git_commit(self, args: dict) -> dict:
        return await self._planned(toolchain_gate.plan_git("commit", args, self.workspace))

    async def _git_push(self, args: dict) -> dict:
        return await self._planned(toolchain_gate.plan_git("push", args, self.workspace))

    async def _java_run(self, args: dict) -> dict:
        return await self._planned(toolchain_gate.plan_java("run", args, self.workspace))

    async def _java_compile(self, args: dict) -> dict:
        return await self._planned(toolchain_gate.plan_java("compile", args, self.workspace))

    async def _ci_run(self, args: dict) -> dict:
        return await self._planned(toolchain_gate.plan_ci(args, self.workspace))
