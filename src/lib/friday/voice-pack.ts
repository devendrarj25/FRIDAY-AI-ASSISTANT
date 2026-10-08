/** Paths a packaged app is expected to resolve. Existence is injected. */

export function voicePackPaths(root: string): { id: string; path: string }[] {
  const base = String(root || "").replace(/[\\/]+$/, "");
  return [
    { id: "python", path: `${base}/runtime/.venv` },
    { id: "python-managed", path: `${base}/runtime/py312` },
    { id: "cpython", path: `${base}/runtime/FRIDAY_Python/python/python.exe` },
    { id: "cache", path: `${base}/cache/stt` },
    { id: "models", path: `${base}/models` },
    { id: "wake", path: `${base}/resources/wake/friday.onnx` },
    { id: "wake-meta", path: `${base}/resources/wake/friday-wake.json` },
  ];
}

export function voicePackReport(
  root: string,
  exists: (path: string) => boolean,
): { id: string; ok: boolean; path: string }[] {
  return voicePackPaths(root).map((row) => ({ ...row, ok: exists(row.path) }));
}
