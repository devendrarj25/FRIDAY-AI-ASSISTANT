"""Example FRIDAY module.

`register` runs at kernel startup. Modules receive their own manifest and may
only request tools listed in `permissions`.
"""

MANIFEST = None


def register(manifest: dict) -> None:
    global MANIFEST
    MANIFEST = manifest
    print(f"[repo-import] registered v{manifest['version']}")


async def run(tools, url: str, folder: str) -> dict:
    """Clone a repository and report the detected stack."""
    clone = await tools.execute("git", {"args": ["clone", url, folder]}, approved=True)
    if not clone.get("ok"):
        return clone
    listing = await tools.execute("fs.read", {"path": folder})
    entries = set(listing.get("entries", []))
    stack = []
    if "package.json" in entries:
        stack.append("node")
    if "requirements.txt" in entries or "pyproject.toml" in entries:
        stack.append("python")
    if "Cargo.toml" in entries:
        stack.append("rust")
    return {"ok": True, "folder": folder, "stack": stack}
