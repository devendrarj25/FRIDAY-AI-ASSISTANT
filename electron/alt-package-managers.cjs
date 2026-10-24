/**
 * Extra install sources for the Install Manager's fallback chain.
 *
 * The chain for a tool is: its own package manager (winget, npm, pip), then the
 * vendor's release feed (SHA-256 checked), then Chocolatey, then Scoop. The last
 * two are used only when they are already on this PC (FRIDAY never installs a
 * package manager, and never pipes a downloaded script into a shell), and only
 * for the tools named here. A miss is not an error: the next source is tried.
 *
 * Package names are the managers' own (community.chocolatey.org, the Scoop main,
 * extras and java buckets). They were not read from a live catalogue here, so a
 * wrong name only means that source answers "not found" and the job reports the
 * sources it tried.
 */

/** Install Manager tool id -> package name per manager. */
const ALT = Object.freeze({
  ripgrep: { choco: "ripgrep", scoop: "ripgrep" },
  "jq (JSON)": { choco: "jq", scoop: "jq" },
  "yq (YAML)": { choco: "yq", scoop: "yq" },
  Ninja: { choco: "ninja", scoop: "ninja" },
  "uv (Python)": { choco: "uv", scoop: "uv" },
  aria2: { choco: "aria2", scoop: "aria2" },
  FFmpeg: { choco: "ffmpeg", scoop: "ffmpeg" },
  Git: { choco: "git", scoop: "git" },
  "GitHub CLI": { choco: "gh", scoop: "gh" },
  "Git LFS": { choco: "git-lfs", scoop: "git-lfs" },
  CMake: { choco: "cmake", scoop: "cmake" },
  "7-Zip": { choco: "7zip", scoop: "7zip" },
  Pandoc: { choco: "pandoc", scoop: "pandoc" },
  Graphviz: { choco: "graphviz", scoop: "graphviz" },
  "Tesseract OCR": { choco: "tesseract", scoop: "tesseract" },
  "PowerShell 7": { choco: "powershell-core", scoop: "pwsh" },
  Go: { choco: "golang", scoop: "go" },
  Rust: { choco: "rustup.install", scoop: "rustup" },
  "OpenJDK (Temurin)": { choco: "temurin21", scoop: "temurin21-jdk" },
  "Docker Desktop": { choco: "docker-desktop" },
  "WSL 2": { choco: "wsl2" },
  "CUDA Toolkit": { choco: "cuda" },
  Python: { choco: "python", scoop: "python" },
  "Node.js LTS": { choco: "nodejs-lts", scoop: "nodejs-lts" },
  "Visual Studio Code": { choco: "vscode", scoop: "vscode" },
});

const MANAGERS = Object.freeze(["choco", "scoop"]);

/** Which managers know this tool. */
function managersFor(toolId) {
  const row = ALT[toolId];
  return row ? MANAGERS.filter((manager) => row[manager]) : [];
}

/**
 * The [exe, args] for one manager, or null when it does not know the tool.
 * Update uses the manager's own upgrade verb; uninstall is never routed here.
 */
function commandFor(manager, toolId, action) {
  const name = ALT[toolId]?.[manager];
  if (!name || action === "uninstall") return null;
  if (manager === "choco") {
    const verb = action === "update" ? "upgrade" : "install";
    const args = [verb, name, "-y", "--no-progress", "--limit-output"];
    if (action === "repair") args.push("--force");
    return ["choco", args];
  }
  if (manager === "scoop") {
    if (action === "update") return ["scoop", ["update", name]];
    return ["scoop", ["install", name]];
  }
  return null;
}

module.exports = { ALT, MANAGERS, managersFor, commandFor };
