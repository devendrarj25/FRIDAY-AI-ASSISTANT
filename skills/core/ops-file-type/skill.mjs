// FRIDAY · skill: ops-file-type
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// What a file name or extension is, whether it can run code on Windows, and the double-extension trick.

// ext: [kind, risk, note]
const T = {
  exe: ["Windows program", "high", "Runs code the moment you open it."],
  msi: ["Windows installer", "high", "Installs software with admin rights."],
  bat: ["Batch script", "high", "Runs commands."],
  cmd: ["Command script", "high", "Runs commands."],
  com: ["DOS program", "high", "Runs code; also the ending of web domain names."],
  scr: ["Screen saver program", "high", "Really an executable."],
  pif: ["Program shortcut", "high", "Really an executable."],
  ps1: ["PowerShell script", "high", "Runs commands."],
  vbs: ["VBScript", "high", "Runs commands through Windows Script Host."],
  vbe: ["Encoded VBScript", "high", "Runs hidden commands."],
  js: ["JavaScript", "high", "Opened from Explorer it runs under Windows Script Host."],
  jse: ["Encoded JavaScript", "high", "Runs hidden commands."],
  wsf: ["Windows Script File", "high", "Runs commands."],
  hta: ["HTML application", "high", "Runs with full local rights."],
  jar: ["Java program", "high", "Runs code if Java is installed."],
  reg: ["Registry file", "high", "Changes Windows settings when merged."],
  lnk: ["Shortcut", "high", "Can launch any command; common in phishing."],
  dll: ["Program library", "high", "Code that other programs load."],
  cpl: ["Control Panel item", "high", "Runs code."],
  msc: ["Management console", "medium", "Opens an admin tool."],
  docm: ["Word document with macros", "medium", "Macros can run code."],
  xlsm: ["Excel workbook with macros", "medium", "Macros can run code."],
  pptm: ["PowerPoint with macros", "medium", "Macros can run code."],
  zip: ["ZIP archive", "medium", "Look inside before running anything it holds."],
  rar: ["RAR archive", "medium", "Look inside before running anything it holds."],
  "7z": ["7-Zip archive", "medium", "Look inside before running anything it holds."],
  iso: ["Disc image", "medium", "Mounts like a drive and can hold programs."],
  img: ["Disc image", "medium", "Mounts like a drive and can hold programs."],
  html: ["Web page", "medium", "Local pages can still show fake login forms."],
  htm: ["Web page", "medium", "Local pages can still show fake login forms."],
  svg: ["Vector image", "medium", "Can contain scripts."],
  pdf: ["PDF document", "low", "Opens in a reader; keep the reader updated."],
  doc: ["Word document", "low", "Old format that may hold macros."],
  docx: ["Word document", "low", "No macros in this format."],
  xls: ["Excel workbook", "low", "Old format that may hold macros."],
  xlsx: ["Excel workbook", "low", "No macros in this format."],
  ppt: ["PowerPoint", "low", "Old format."],
  pptx: ["PowerPoint", "low", "No macros in this format."],
  txt: ["Plain text", "low", "Only text."],
  md: ["Markdown text", "low", "Only text."],
  csv: ["Comma-separated table", "low", "Only text; Excel may treat =formulas as live."],
  json: ["JSON data", "low", "Only text."],
  xml: ["XML data", "low", "Only text."],
  log: ["Log file", "low", "Only text."],
  png: ["PNG image", "low", "Picture."],
  jpg: ["JPEG image", "low", "Picture."],
  jpeg: ["JPEG image", "low", "Picture."],
  gif: ["GIF image", "low", "Picture."],
  webp: ["WebP image", "low", "Picture."],
  bmp: ["Bitmap image", "low", "Picture."],
  mp3: ["MP3 audio", "low", "Sound."],
  wav: ["WAV audio", "low", "Sound."],
  m4a: ["AAC audio", "low", "Sound."],
  mp4: ["MP4 video", "low", "Video."],
  mkv: ["Matroska video", "low", "Video."],
  mov: ["QuickTime video", "low", "Video."],
  py: ["Python script", "medium", "Runs code if Python opens it."],
  sh: ["Shell script", "medium", "Runs commands in WSL or Git Bash."],
  gguf: ["Local model weights", "low", "Data for a local model runner."],
  onnx: ["ONNX model", "low", "Data for a model runner."],
};
const RUNNABLE = new Set(Object.keys(T).filter((k) => T[k][1] === "high"));
const DOCLIKE = new Set([
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "txt",
  "jpg",
  "jpeg",
  "png",
  "gif",
  "mp3",
  "mp4",
  "csv",
]);

export async function run(input = {}) {
  const text = String(input?.file ?? input?.prompt ?? input?.text ?? "");
  const tokens = text
    .split(/[\s,;"'`()<>]+/)
    .map((s) => s.replace(/[?!]+$/, "").replace(/^[.:]+(?=\.)/, ""))
    .filter((s) => /\.[a-z0-9]{1,5}$/i.test(s) && !/^https?:\/\//i.test(s));
  const items = [];
  for (const raw of [...new Set(tokens)].slice(0, 20)) {
    const parts = raw.toLowerCase().split(".");
    const ext = parts[parts.length - 1];
    const known = T[ext];
    if (!known) continue;
    const earlier = parts.length > 2 ? parts.slice(1, -1) : [];
    const doubleTrick = RUNNABLE.has(ext) && earlier.some((e) => DOCLIKE.has(e));
    items.push({
      name: raw,
      extension: ext,
      kind: known[0],
      risk: doubleTrick ? "high" : known[1],
      note: doubleTrick
        ? `Looks like a .${earlier[earlier.length - 1]} file but really ends in .${ext}: a classic disguise.`
        : known[2],
      canRunCode: RUNNABLE.has(ext),
    });
  }
  if (!items.length) {
    const bare = /(?:^|\s)\.?([a-z0-9]{1,5})\s+file/i.exec(text);
    if (bare && T[bare[1].toLowerCase()]) {
      const e = bare[1].toLowerCase();
      items.push({
        name: "." + e,
        extension: e,
        kind: T[e][0],
        risk: T[e][1],
        note: T[e][2],
        canRunCode: RUNNABLE.has(e),
      });
    }
  }
  if (!items.length)
    return { ok: false, error: "No known file type found; give a file name like report.pdf.exe." };
  return {
    ok: true,
    items,
    answer: items.map((i) => `${i.name}: ${i.kind}, risk ${i.risk}. ${i.note}`).join("\n"),
  };
}

export default run;
